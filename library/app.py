"""Local organization and durable original-file retention for TeslaCam archives."""
import hashlib
from datetime import datetime, timedelta
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import zipfile
from urllib.parse import urlsplit, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from flask import Flask, Response, abort, jsonify, render_template, request, send_file, stream_with_context

app = Flask(__name__, root_path=str(Path(__file__).resolve().parent))
app.config['MAX_CONTENT_LENGTH'] = 16384
SOURCES = Path(os.environ.get('SOURCES', '/sources')).resolve()
RETAINED = Path(os.environ.get('RETAINED', '/retained')).resolve()
DATA = Path(os.environ.get('DATA', '/data')).resolve()
SETTLE = int(os.environ.get('SETTLE_SECONDS', '120'))
# Recent minutes join one drive until the car stops recording this long.
DRIVE_GAP = int(os.environ.get('DRIVE_GAP_SECONDS', '300'))
CLIP = re.compile(r'^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(.+)\.mp4$', re.I)
KINDS = {'RecentClips', 'SavedClips', 'SentryClips', 'ArchivedClips'}
copy_lock = threading.Lock()
scan_lock = threading.Lock()
cache = {'at': 0, 'events': {}, 'scanning': False}
EVENT_ID = re.compile(r'^[0-9a-f]{64}$')
RECORDING_SERVER = os.environ.get('RECORDING_SERVER', '')
preview_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='previews')
preview_lock = threading.Lock()
preview_jobs = {}


@contextmanager
def database():
    DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATA / 'library.sqlite', timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            conn.execute('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, tags TEXT, note TEXT)')
            yield conn
    finally:
        conn.close()


def inside(path, root):
    resolved = path.resolve()
    if not resolved.is_relative_to(root) or path.is_symlink():
        raise ValueError('Unsafe file path')
    return resolved


def scan_sources():
    events = {}
    # Do not follow symlink directories, and ignore in-progress transfer files.
    for folder, dirs, names in os.walk(SOURCES, followlinks=False):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d.casefold() != 'encryptedclips' and not (Path(folder) / d).is_symlink()]
        parent = Path(folder)
        relative = parent.relative_to(SOURCES)
        parts = relative.parts
        kind_index = next((i for i, p in enumerate(parts) if p in KINDS), None)
        if kind_index is None:
            continue
        kind = parts[kind_index]
        for name in names:
            match = CLIP.fullmatch(name)
            if not match:
                continue
            path = parent / name
            try:
                inside(path, SOURCES)
                size = path.stat().st_size
            except (OSError, ValueError):
                continue
            # Recent driving is retained as a minute across all available cameras.
            # Saved/Sentry retain the complete event directory.
            event_parts = parts[:kind_index + 2] if kind in {'SavedClips', 'SentryClips'} else parts
            event_path = Path(*event_parts).as_posix()
            key = event_path if len(parts) > kind_index + 1 and kind in {'SavedClips', 'SentryClips'} else relative.as_posix() + '/' + match[1]
            event_id = hashlib.sha256(key.encode()).hexdigest()
            event = events.setdefault(event_id, {
                'id': event_id, 'path': key, 'kind': kind,
                'date': event_parts[-1] if kind in {'SavedClips', 'SentryClips'} and len(event_parts) > kind_index + 1 else match[1],
                'source': '/'.join(parts[:kind_index]), 'size': 0,
                'kept': False, '_files': [], '_videos': [],
            })
            event['size'] += size
            event['_videos'].append(path)
    for event in events.values():
        videos = sorted(event['_videos'])
        sidecars = set()
        for parent in {v.parent for v in videos}:
            try:
                sidecars.update(p for p in parent.iterdir()
                                if p.suffix.lower() in {'.json', '.jpg', '.jpeg', '.png'} and p.is_file() and not p.is_symlink())
            except OSError:
                pass  # A source cleanup/upload can race discovery.
        event['encrypted'] = 'EncryptedClips' in videos[0].parts
        try:
            with videos[0].open('rb') as handle:
                event['encrypted'] = handle.read(8)[4:8] != b'ftyp'
        except OSError:
            pass
        event['_videos'] = videos
        event['_files'] = sorted(set(videos) | sidecars)
    return group_drives({key: event for key, event in events.items() if not event['encrypted']})


def minute_start(event):
    try:
        return datetime.strptime(event['date'], '%Y-%m-%d_%H-%M-%S')
    except ValueError:
        return None


def saved_minutes(event):
    """A Saved event's camera files, one entry per recorded minute."""
    minutes = {}
    for video in event['_videos']:
        stamp = CLIP.fullmatch(video.name)[1]
        minute = minutes.setdefault(stamp, {'date': stamp, 'path': event['path'] + '/' + stamp,
                                            'saved': True, 'size': 0, '_videos': [], '_files': []})
        minute['_videos'].append(video)
        minute['_files'].append(video)
        try:
            minute['size'] += video.stat().st_size
        except OSError:
            pass
    return list(minutes.values())


def group_drives(events):
    """Join the car's one-minute Recent/Archived clips into drives.

    A minute starting DRIVE_GAP or more after the previous one ended begins a
    new drive. Saving a clip moves the last minutes of a drive out of
    RecentClips into the Saved event, so drives take those minutes back in;
    the Saved event is still listed by itself too. Sentry events are parked
    recordings, not driving."""
    grouped, runs = {}, {}
    for key, event in events.items():
        if event['kind'] in {'SavedClips', 'SentryClips'} or minute_start(event) is None:
            grouped[key] = event
            if event['kind'] == 'SavedClips':
                runs.setdefault(event['source'], []).extend(m for m in saved_minutes(event) if minute_start(m))
        else:
            runs.setdefault(event['source'], []).append(event)
    for minutes in runs.values():
        minutes.sort(key=lambda e: e['date'])
        drives, end = [], None
        for minute in minutes:
            start = minute_start(minute)
            if end is None or start - end >= timedelta(seconds=DRIVE_GAP):
                drives.append([])
            drives[-1].append(minute)
            end = max(end or start, start + timedelta(seconds=60))
        for drive in drives:
            recorded = [m for m in drive if not m.get('saved')]
            if not recorded:
                continue  # only Saved footage: that is the Saved event itself
            # Named after its first RecentClips minute, so the drive keeps its
            # notes when Saved minutes are added in front; once that minute is
            # pruned the remainder is a new drive.
            drive_id = hashlib.sha256(('drive:' + recorded[0]['path']).encode()).hexdigest()
            grouped[drive_id] = {
                **recorded[0], 'id': drive_id, 'date': drive[0]['date'], 'end': drive[-1]['date'],
                'minutes': len({m['date'] for m in drive}),
                'size': sum(m['size'] for m in drive),
                '_videos': sorted({v for m in drive for v in m['_videos']}),
                '_files': sorted({f for m in drive for f in m['_files']}),
            }
    return grouped


def rescan():
    try:
        events = scan_sources()
    except OSError:
        app.logger.exception('Archive scan failed')
        events = None
    with scan_lock:
        if events is not None:
            cache.update(events=events, at=time.monotonic())
        cache['scanning'] = False


def scanned(refresh=False):
    """Discovered source events. After the first scan a stale cache refreshes
    in the background, so video requests never wait on a walk of the archive."""
    with scan_lock:
        if refresh or not cache['at']:
            cache.update(events=scan_sources(), at=time.monotonic())
        elif time.monotonic() - cache['at'] > 60 and not cache['scanning']:
            cache['scanning'] = True
            threading.Thread(target=rescan, daemon=True).start()
        return cache['events']


def kept_event(manifest):
    # A completed bundle, including its manifest, is the authority for Keep.
    # Kept footage remains browsable when its source disappears or is pruned.
    try:
        saved = json.loads(manifest.read_text())
        if saved.get('encrypted') or any('encryptedclips' in Path(p).as_posix().casefold().split('/') for p in saved.get('files', [])):
            return None
        if saved['id'] != manifest.parent.name:
            return None
        files = [inside(manifest.parent / 'footage' / p, RETAINED) for p in saved['files']]
        saved.pop('files')
        if not all(p.is_file() for p in files):
            return None
        saved.update(kept=True, _files=files, _videos=sorted(p for p in files if p.suffix.lower() == '.mp4'))
        return saved
    except (OSError, ValueError, KeyError, TypeError):
        app.logger.warning('Unreadable retained manifest: %s', manifest.parent.name)
        return None


def find_event(event_id):
    """One event, without notes: cheap enough for every range request."""
    if not EVENT_ID.fullmatch(event_id):
        return None
    manifest = RETAINED / event_id / 'manifest.json'
    if manifest.is_file() and (saved := kept_event(manifest)):
        return saved
    return scanned().get(event_id)


def catalog(refresh=False):
    events = {key: dict(value) for key, value in scanned(refresh).items()}
    for manifest in RETAINED.glob('*/manifest.json'):
        if saved := kept_event(manifest):
            events[saved['id']] = saved
    with database() as conn:
        notes = {row['id']: dict(row) for row in conn.execute('SELECT * FROM notes')}
    for key, event in events.items():
        event.update(tags=notes.get(key, {}).get('tags', ''), note=notes.get(key, {}).get('note', ''))
    return events


def retain(event):
    with copy_lock:
        destination = RETAINED / event['id']
        if destination.exists():
            if catalog().get(event['id'], {}).get('kept'):
                return  # Another request completed while this one waited.
            raise ValueError('An incomplete retained bundle already exists. Check retained storage before retrying.')
        files = event['_files']
        stats = {p: (p.stat().st_size, p.stat().st_mtime_ns) for p in files}
        if any(time.time() - p.stat().st_mtime < SETTLE for p in files):
            raise ValueError('This recording is still settling after upload. Try again in two minutes.')
        RETAINED.mkdir(parents=True, exist_ok=True)
        incoming = RETAINED / '.incoming'
        incoming.mkdir(exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=event['id'][:12] + '-', dir=incoming))
        try:
            copied, checksums = [], {}
            for source in files:
                inside(source, SOURCES)
                relative = source.relative_to(SOURCES).as_posix()
                target = staging / 'footage' / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                with source.open('rb') as src, target.open('xb') as dst:
                    while block := src.read(1024 * 1024):
                        digest.update(block)
                        dst.write(block)
                    dst.flush()
                    os.fsync(dst.fileno())
                if (source.stat().st_size, source.stat().st_mtime_ns) != stats[source] or target.stat().st_size != stats[source][0]:
                    raise ValueError('An upload changed during retention. Retry when the upload finishes.')
                copied.append(relative)
                checksums[relative] = digest.hexdigest()
            current = scan_sources().get(event['id'])
            if current is None or current['_files'] != files:
                raise ValueError('The recording changed during retention. Retry when the upload finishes.')
            if any((p.stat().st_size, p.stat().st_mtime_ns) != stats[p] for p in files):
                raise ValueError('The recording changed during retention. Please retry.')
            manifest = {k: v for k, v in event.items() if not k.startswith('_') and k not in {'tags', 'note'}}
            manifest.update(files=copied, sha256=checksums, retained_at=time.time())
            with (staging / 'manifest.json').open('x') as handle:
                json.dump(manifest, handle)
                handle.flush()
                os.fsync(handle.fileno())
            # Atomic publication: incomplete copies never appear as kept.
            os.replace(staging, destination)
        finally:
            if staging.exists():
                shutil.rmtree(staging)


@app.before_request
def same_origin():
    if request.method == 'POST':
        origin = request.headers.get('Origin')
        if request.headers.get('Sec-Fetch-Site') == 'cross-site' or (origin and urlsplit(origin).netloc != request.host):
            abort(403)
        if not request.is_json:
            abort(415)


@app.get('/health')
def health():
    with database() as conn:
        conn.execute('SELECT 1')
    if RECORDING_SERVER:
        try:
            with urlopen(RECORDING_SERVER + '/health', timeout=3) as response:
                response.read()
        except (OSError, URLError):
            return jsonify(status='recording helper unavailable'), 503
    return jsonify(status='ok')


@app.get('/')
def home():
    return render_template('index.html')


@app.get('/api/events')
def events():
    records = catalog(request.args.get('refresh') == '1')
    return jsonify(sorted(({k: v for k, v in e.items() if not k.startswith('_')}
                           for e in records.values()), key=lambda e: e['date'], reverse=True))


@app.get('/api/events/<event_id>/videos')
def videos(event_id):
    event = find_event(event_id)
    if event is None:
        abort(404)
    return jsonify([{'name': p.name, 'url': f'/media/{event_id}/{i}', 'snapshot': event_id,
                     'path': str(i), 'size': p.stat().st_size} for i, p in enumerate(event['_videos'])])


def recording_file(event_id, index):
    event = find_event(event_id)
    if event is None or index < 0 or index >= len(event['_videos']):
        abort(404)
    return inside(event['_videos'][index], RETAINED if event['kept'] else SOURCES)


@app.get('/api/telemetry/<event_id>/<int:index>')
def telemetry(event_id, index):
    path = recording_file(event_id, index)
    if not RECORDING_SERVER:
        return jsonify(samples=[], duration=0)
    try:
        with urlopen(RECORDING_SERVER + '/telemetry?' + urlencode({'path': str(path)}), timeout=35) as result:
            return Response(result.read(), mimetype='application/json', headers={'Cache-Control': 'private, max-age=3600'})
    except HTTPError as exc:
        return jsonify(error='No readable recorded telemetry'), exc.code
    except (OSError, URLError):
        return jsonify(error='Recorded telemetry is temporarily unavailable'), 503


@app.get('/media/<event_id>/<int:index>')
def media(event_id, index):
    path = recording_file(event_id, index)
    if request.args.get('download') == '1' or not RECORDING_SERVER:
        return send_file(path, conditional=True, as_attachment=request.args.get('download') == '1')
    headers = {key: request.headers[key] for key in ['Range', 'If-Range'] if key in request.headers}
    try:
        upstream = urlopen(Request(RECORDING_SERVER + '/media?' + urlencode({'path': str(path)}), headers=headers), timeout=30)
    except HTTPError as exc:
        return Response(exc.read(), status=exc.code, headers={key: value for key, value in exc.headers.items() if key.lower() in {'content-range', 'accept-ranges', 'content-type'}})
    except (OSError, URLError):
        abort(503)
    def chunks():
        try:
            while block := upstream.read(1024 * 1024):
                yield block
        finally:
            upstream.close()
    allowed = {'content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'cache-control'}
    return Response(stream_with_context(chunks()), status=upstream.status,
                    headers={key: value for key, value in upstream.headers.items() if key.lower() in allowed})


def preview_file(event, regenerate=False):
    fronts = [p for p in event['_videos'] if p.name.endswith('-front.mp4')] or event['_videos']
    video = fronts[len(fronts) // 2]  # mid-drive rather than the parked start
    inside(video, RETAINED if event['kept'] else SOURCES)
    stat = video.stat()
    key = hashlib.sha256(f'{video}:{stat.st_size}:{stat.st_mtime_ns}'.encode()).hexdigest()
    target = DATA / 'previews' / (key + '.jpg')
    if target.is_file() or regenerate:
        return target, video
    for sidecar in event['_files']:
        if sidecar.suffix.lower() not in {'.jpg', '.jpeg', '.png'}:
            continue
        inside(sidecar, RETAINED if event['kept'] else SOURCES)
        try:
            with sidecar.open('rb') as image:
                magic = image.read(8)
            if magic.startswith(b'\xff\xd8') or magic == b'\x89PNG\r\n\x1a\n':
                return sidecar, None
        except OSError:
            continue
    return target, video


def generate_preview(video, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix('.pending.jpg')
    try:
        for offset in ['2', '0']:
            result = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                                     '-ss', offset, '-i', str(video), '-frames:v', '1', '-vf', 'scale=480:-2',
                                     '-threads', '1', '-q:v', '4', '-y', str(temporary)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25)
            if result.returncode == 0 and temporary.is_file() and temporary.stat().st_size > 0:
                os.replace(temporary, target)
                return True
        return False
    except (OSError, subprocess.TimeoutExpired):
        return False
    finally:
        temporary.unlink(missing_ok=True)


@app.get('/api/events/<event_id>/preview')
def preview(event_id):
    event = find_event(event_id)
    if event is None:
        abort(404)
    try:
        target, video = preview_file(event, regenerate=request.args.get('retry') == '1')
    except OSError:
        return jsonify(state='unavailable')
    if target.is_file():
        return jsonify(state='ready', url=f'/api/events/{event_id}/thumbnail')
    with preview_lock:
        # Discard finished jobs from other pages; image files are the durable cache.
        for key, job in list(preview_jobs.items()):
            if key != str(target) and job.done():
                del preview_jobs[key]
        job = preview_jobs.get(str(target))
        if job and job.done() and request.args.get('retry') == '1':
            del preview_jobs[str(target)]
            job = None
        if job is None:
            if len(preview_jobs) >= 64:
                return jsonify(state='queued')
            job = preview_jobs[str(target)] = preview_pool.submit(generate_preview, video, target)
        if job.done():
            if target.is_file():
                return jsonify(state='ready', url=f'/api/events/{event_id}/thumbnail')
            return jsonify(state='unavailable')
        return jsonify(state='loading' if job.running() else 'queued')


@app.get('/api/events/<event_id>/thumbnail')
def thumbnail(event_id):
    event = find_event(event_id)
    if event is None:
        abort(404)
    path, _ = preview_file(event)
    if not path.is_file():
        abort(404)
    return send_file(path, conditional=True)


@app.get('/source.zip')
def source():
    # Corresponding source for the adapted GPL Glovebox viewer; no state/secrets.
    output = io.BytesIO()
    root = Path(__file__).parent
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in ['app.py', 'start.py', 'entrypoint.sh', 'Dockerfile', 'requirements.txt', 'LICENSE', 'NOTICE.md', 'VIEWER.md']:
            archive.write(root / name, name)
        for folder in ['static', 'templates', 'recording']:
            for path in (root / folder).rglob('*'):
                if path.is_file():
                    archive.write(path, path.relative_to(root).as_posix())
    output.seek(0)
    return send_file(output, as_attachment=True, download_name='glovebox-archive-source.zip')


@app.post('/api/events/<event_id>')
def update(event_id):
    event = catalog().get(event_id)
    if event is None:
        abort(404)
    body = request.get_json()
    if not isinstance(body, dict):
        abort(400)
    tags, note = body.get('tags', ''), body.get('note', '')
    if not isinstance(tags, str) or not isinstance(note, str) or len(tags) > 500 or len(note) > 8000:
        abort(400)
    # Save notes even if a subsequent copy cannot complete.
    with database() as conn:
        conn.execute('INSERT INTO notes VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET tags=excluded.tags, note=excluded.note',
                     (event_id, tags, note))
    if body.get('keep') is True and not event['kept']:
        try:
            retain(event)
        except ValueError as exc:
            return jsonify(error=str(exc)), 409
        except OSError:
            app.logger.exception('Retention copy failed')
            return jsonify(error='Copy failed; recording is not marked kept. Check free space, permissions and source availability.'), 409
    return jsonify(status='ok')
