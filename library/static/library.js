'use strict';
// Archive integration for the GPL Glovebox player. See NOTICE.md.
let records = [], current = '', busy = false, listPage = 0;
let search = '', sourceFilter = '';
let previewObserver;
const kinds = {sentry: 'SentryClips', saved: 'SavedClips', recent: 'RecentClips'};
const names = {'': 'Overview', sentry: 'Sentry', saved: 'Saved', recent: 'Recent', kept: 'Kept', sources: 'Sources'};
const status = text => { $('#status').textContent = text; };

async function api(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = 'Request failed (' + response.status + ')';
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response.json();
}

function page(name, title, ...nodes) {
  player.stop();
  current = name;
  document.title = title + ' · Glovebox Archive';
  $('#title').textContent = title;
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('active', a.dataset.nav === (name.split(':')[0] || 'overview'));
  }
  document.body.classList.toggle('viewer-active', nodes.some(node => node?.classList?.contains('cinema-viewer')));
  $('.content').classList.toggle('viewer-open', document.body.classList.contains('viewer-active'));
  $('#view').replaceChildren(...nodes);
  window.scrollTo(0, 0);
  $('.content').scrollTop = 0;
}

function clipTime(stamp) { return stamp.replace('_', 'T').replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3'); }
function timeOf(event) { return carTime(clipTime(event.date)); }
// A drive's time span: from its first minute to the end of its last.
function spanOf(event) {
  if (!event.end) return fmtTime(timeOf(event));
  const end = new Date(carTime(clipTime(event.end)).getTime() + 60000);
  return fmtTime(timeOf(event)) + ' – ' + fmtTime(end);
}
function kindOf(event) { return Object.keys(kinds).find(k => kinds[k] === event.kind) || 'recent'; }
function empty(title, text) {
  return el('div', {class: 'empty'}, icon('film'), el('h3', {}, title), el('p', {class: 'muted'}, text));
}

async function refresh() {
  status('Reading archive…');
  try {
    records = await api('/api/events?refresh=1');
    status('');
    route();
  } catch (error) { status(error.message); }
}

function eventCard(event) {
  const locked = event.encrypted;
  const thumb = el('div', {class: 'thumb'},
    locked ? el('span', {class: 'lock-mark'}, icon('lock')) : null,
    el('span', {class: 'when'}, spanOf(event)),
    el('span', {class: 'badge' + (event.kept ? ' kept' : ' ' + kindOf(event))},
      icon(event.kept ? 'check' : locked ? 'lock' : kindOf(event) === 'sentry' ? 'shield' : 'film'),
      event.kept ? 'Kept' : locked ? 'Encrypted' : event.kind.replace('Clips', '')));
  const state = el('span', {class: 'preview-state', role: 'status'}, 'Preview waiting');
  thumb.append(state, el('span', {class: 'play'}, icon('play')));
  thumb.classList.add('preview-pending');
  const retry = el('button', {type: 'button', class: 'preview-retry', hidden: true, 'aria-label': 'Retry preview'}, 'Retry preview');
  const card = el('article', {class: 'card archive-card'}, el('a', {class: 'card-link', href: '#/event/' + event.id}, thumb,
    el('div', {class: 'card-body'},
      el('div', {class: 'card-title'}, event.tags || (event.minutes ? 'Drive · ' + event.minutes + ' min' : event.kind.replace('Clips', '') + ' recording')),
      el('div', {class: 'card-sub'}, event.source + ' · ' + gb(event.size)),
      event.note ? el('div', {class: 'card-sub'}, event.note.slice(0, 100)) : null)), retry);
  async function loadPreview(again=false) {
    if (!card.isConnected) return;
    retry.hidden = true; thumb.classList.add('preview-pending');
    state.textContent = again ? 'Retrying preview…' : 'Loading preview…';
    try {
      const result = await api('/api/events/' + event.id + '/preview' + (again ? '?retry=1' : ''));
      if (!card.isConnected) return;
      if (result.state === 'ready') {
        const image = el('img', {src: result.url, alt: '', class: 'preview-image'});
        image.onload = () => { thumb.classList.remove('preview-pending'); state.remove(); };
        image.onerror = () => { image.remove(); failed(); };
        thumb.prepend(image);
      } else if (result.state === 'unavailable') failed();
      else {
        state.textContent = result.state === 'queued' ? 'Preview queued…' : 'Generating preview…';
        setTimeout(() => loadPreview(), 1200);
      }
    } catch { failed(); }
  }
  function failed() { thumb.classList.remove('preview-pending'); state.textContent = 'Preview unavailable'; retry.hidden = false; }
  retry.onclick = () => loadPreview(true);
  card.loadPreview = loadPreview;
  previewObserver?.observe(card);
  return card;
}

function showList(kind) {
  const input = el('input', {type: 'text', placeholder: 'Search dates, tags or notes…', 'aria-label': 'Search recordings'});
  input.value = search;
  const sources = el('select', {'aria-label': 'Archive source'}, el('option', {value: ''}, 'All sources'),
    [...new Set(records.map(e => e.source))].sort().map(s => el('option', {value: s}, s)));
  sources.value = sourceFilter;
  const results = el('div');
  const filters = el('div', {class: 'archive-filters'}, input, sources,
    el('button', {type: 'button', onclick: refresh}, icon('refresh'), 'Refresh'));
  page(kind, names[kind] || 'Overview', filters, results);
  function render() {
    previewObserver?.disconnect();
    previewObserver = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) {
      previewObserver.unobserve(entry.target); entry.target.loadPreview();
    } }, {rootMargin: '200px'});
    const query = search.toLowerCase();
    const matches = records.filter(event => (!sourceFilter || event.source === sourceFilter) &&
      (!kind || (kind === 'kept' ? event.kept : event.kind === kinds[kind] || kind === 'recent' && event.kind === 'ArchivedClips')) &&
      [event.date, event.tags, event.note, event.source].join(' ').toLowerCase().includes(query));
    results.replaceChildren(el('p', {class: 'muted archive-summary'},
      matches.length + ' recordings · ' + matches.filter(e => e.kept).length + ' kept'));
    if (!matches.length) {
      results.append(empty('No recordings here', 'Choose another filter, or refresh after a backup or remote import.'));
      return;
    }
    const pageCount = Math.ceil(matches.length / 60);
    listPage = Math.max(0, Math.min(listPage, pageCount - 1));
    let day = '', grid;
    for (const event of matches.slice(listPage * 60, (listPage + 1) * 60)) {
      const label = fmtDay(timeOf(event));
      if (label !== day) { day = label; grid = el('div', {class: 'grid'}); results.append(el('h3', {class: 'day'}, label), grid); }
      grid.append(eventCard(event));
    }
    if (pageCount > 1) results.append(el('div', {class: 'archive-pager'},
      el('button', {disabled: listPage === 0, onclick: () => { listPage--; render(); }}, 'Previous'),
      el('span', {class: 'muted'}, (listPage + 1) + ' / ' + pageCount),
      el('button', {disabled: listPage === pageCount - 1, onclick: () => { listPage++; render(); }}, 'Next')));
  }
  input.oninput = () => { search = input.value; listPage = 0; render(); };
  sources.onchange = () => { sourceFilter = sources.value; listPage = 0; render(); };
  render();
}

function retentionPanel(event) {
  const tags = el('input', {type: 'text', maxlength: 500}); tags.value = event.tags;
  const note = el('textarea', {maxlength: 8000, rows: 3}); note.value = event.note;
  const save = el('button', {type: 'button'}, 'Save notes');
  const keep = el('button', {type: 'button', class: 'btn-primary', disabled: event.kept},
    icon(event.kept ? 'check' : 'bookmark'), event.kept ? 'Kept permanently' : 'Keep original footage');
  async function persist(retain) {
    busy = true; save.disabled = keep.disabled = true;
    status(retain ? 'Copying original camera files to protected storage…' : 'Saving notes…');
    try {
      await api('/api/events/' + event.id, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({tags: tags.value, note: note.value, keep: retain})});
      records = await api('/api/events');
      await showEvent(event.id);
      status(retain ? 'Kept permanently. The source can now expire without losing this copy.' : 'Notes saved.');
    } catch (error) { status(error.message); }
    finally { busy = false; save.disabled = false; keep.disabled = records.find(e => e.id === event.id)?.kept || false; }
  }
  save.onclick = () => persist(false); keep.onclick = () => persist(true);
  return el('section', {class: 'panel retention-panel'}, el('h3', {}, 'Organization & retention'),
    el('p', {class: event.kept ? 'keep-status' : 'muted'}, event.kept ? 'Original files retained permanently in your Keep folder.' :
      'Keep copies every available camera for this ' + (event.minutes ? 'whole drive' : 'event') + '. Your normal archive cleanup continues.'),
    el('div', {class: 'fields'}, el('label', {}, 'Tags, separated by commas', tags), el('label', {}, 'Notes', note)),
    el('div', {class: 'actions'}, save, keep), el('p', {class: 'muted archive-path'}, event.path));
}

async function showEvent(id) {
  const event = records.find(e => e.id === id);
  if (!event) { page('', 'Recording', empty('Recording unavailable', 'Refresh the library to see current recordings.')); return; }
  const routeAtStart = location.hash;
  page(kindOf(event) + ':loading', names[kindOf(event)],
    el('section', {class: 'cinema-viewer recording-loading', role: 'status'},
      el('span', {class: 'recording-spinner'}), 'Loading recording and camera previews…'));
  status('Loading recording and camera previews…');
  try {
    const files = await api('/api/events/' + id + '/videos');
    if (location.hash !== routeAtStart) return;
    const minutes = new Map();
    for (const file of files) {
      const match = file.name.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(.+)\.mp4$/i);
      if (!match) continue;
      if (!minutes.has(match[1])) minutes.set(match[1], {start: clipTime(match[1]), cameras: {}});
      minutes.get(match[1]).cameras[match[2]] = file;
    }
    const clips = [...minutes.values()].sort((a, b) => a.start.localeCompare(b.start));
    if (!clips.length) throw Error('This recording has no available video files. Refresh the archive.');
    const title = fmtDay(timeOf(event)) + ' · ' + spanOf(event);
    const kind = kindOf(event);
    if (event.encrypted) {
      page(kind + ':event', names[kind], el('div', {class: 'player-head'},
        el('a', {class: 'icon-btn', href: '#/' + kind, title: 'Back'}, icon('back')), el('h2', {}, title)),
        el('div', {class: 'notice'}, el('span', {class: 'stat-icon'}, icon('lock')),
          el('div', {}, el('h3', {}, 'Encrypted by your car'),
            el('p', {}, 'This recording cannot play directly in the browser. You can still download and retain the original files.'),
            el('div', {class: 'actions'}, el('a', {class: 'btn btn-primary', href: 'https://dashcam.tesla.com', target: '_blank', rel: 'noopener'}, 'Open Tesla viewer', icon('external'))))),
        el('div', {class: 'section-head'}, el('h2', {}, 'Original files')),
        el('div', {class: 'minute-files'}, clips.map(c => el('div', {class: 'minute-row'},
          el('span', {class: 't'}, fmtTime(carTime(c.start))), el('div', {class: 'file-chips'},
            Object.entries(c.cameras).map(([camera, file]) => el('a', {href: mediaURL(file, true)}, icon('download'), CAMERA_NAMES[camera] || camera)))))));
    } else {
      player.open(kind + ':event', names[kind], clips, 0, title,
        [clips.length + ' min · ' + event.source + ' · ' + gb(event.size)], '#/' + kind, null);
    }
    ($('#viewer-details') || $('#view')).append(retentionPanel(event));
    status('');
    if (!event.encrypted) watchPlayerLoading();
  } catch (error) {
    if (location.hash !== routeAtStart) return;
    page(kindOf(event), 'Recording unavailable', empty('Could not load recording', error.message),
      el('a', {class:'btn',href:'#/' + kindOf(event)}, 'Back to recordings'));
    status(error.message);
  }
}

function watchPlayerLoading() {
  for (const camera of player.cams) {
    const box = player.videos[camera].parentElement;
    const label = el('span', {class: 'camera-loading', role: 'status'}, 'Loading camera…');
    box.append(label);
    function update() {
      const video = player.videos[camera]; // the showing one; the spare swaps in between minutes
      if (!video) return;
      const loading = !!video.getAttribute('src') && !video.error && video.readyState < 2;
      box.classList.toggle('stream-loading', loading);
      box.classList.toggle('stream-error', !!video.error);
      label.textContent = video.error ? 'Camera file is incomplete or cannot be decoded.' : 'Loading ' + (CAMERA_NAMES[camera] || camera) + '…';
      const choice = $('#camera-rail').querySelector('[data-camera="' + camera + '"]');
      choice?.classList.toggle('loading', loading);
      choice?.setAttribute('aria-busy', String(loading));
    }
    for (const video of [player.videos[camera], player.spares[camera]])
      for (const event of ['loadstart','waiting','playing','loadeddata','canplay','error','emptied']) video.addEventListener(event, update);
    update();
  }
}

function showSources() {
  const groups = new Map();
  for (const event of records) { const count = groups.get(event.source) || {count: 0, size: 0}; count.count++; count.size += event.size; groups.set(event.source, count); }
  page('sources', 'Sources', el('p', {class: 'muted'}, 'Local archives and imported remote destinations.'),
    el('section', {class: 'panel'}, [...groups].map(([source, info]) => el('div', {class: 'source-row'},
      el('strong', {}, source), el('span', {class: 'muted'}, info.count + ' recordings · ' + gb(info.size))))),
    el('p', {class: 'muted'}, 'SMB/NFS mounts and rsync/rclone imports are configured in the Compose project. This page lists sources with discovered recordings.'));
}

function route() {
  if (busy) return;
  const path = location.hash.replace(/^#\/?/, '').split('/');
  status('');
  if (path[0] === 'event') { showEvent(path[1]); return; }
  if (path[0] === 'sources') { showSources(); return; }
  listPage = 0; showList(names[path[0]] ? path[0] : '');
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
refresh();
