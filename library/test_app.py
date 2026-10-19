import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('library_app', Path(__file__).with_name('app.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TEST_TMPDIR'))
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.settings = patch.multiple(module, SOURCES=root / 'sources',
                                      RETAINED=root / 'retained', DATA=root / 'data', SETTLE=120, RECORDING_SERVER='')
        self.settings.start()
        self.addCleanup(self.settings.stop)
        module.cache.update(at=0, events={})
        self.client = module.app.test_client()

    def clip(self, path, content=b'origftyp-video'):
        full = module.SOURCES / path
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_bytes(content)
        os.utime(full, (1000, 1000))
        return full

    def events(self):
        response = self.client.get('/api/events?refresh=1')
        self.assertEqual(response.status_code, 200)
        return response.json

    def test_event_all_cameras_sidecars_and_survives_source_deletion(self):
        folder = 'local/SentryClips/2026-10-15_12-00-00/'
        for camera in ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar']:
            self.clip(folder + '2026-10-15_11-59-00-' + camera + '.mp4')
        self.clip(folder + 'event.json', b'{"reason":"sentry"}')
        self.clip(folder + 'unfinished.partial', b'incomplete')
        event = self.events()[0]
        result = self.client.post('/api/events/' + event['id'], json={'keep': True, 'tags': 'incident, parking', 'note': 'Review this'})
        self.assertEqual(result.status_code, 200, result.data)
        manifest = json.loads((module.RETAINED / event['id'] / 'manifest.json').read_text())
        self.assertEqual(len(manifest['files']), 7)
        for name, digest in manifest['sha256'].items():
            copied = module.RETAINED / event['id'] / 'footage' / name
            self.assertEqual(hashlib.sha256(copied.read_bytes()).hexdigest(), digest)
        shutil.rmtree(module.SOURCES)
        kept = self.events()[0]
        self.assertTrue(kept['kept'])
        self.assertEqual(kept['tags'], 'incident, parking')
        self.assertEqual(kept['note'], 'Review this')
        videos = self.client.get('/api/events/' + event['id'] + '/videos').json
        self.assertEqual(len(videos), 6)
        media = self.client.get(videos[0]['url'], headers={'Range': 'bytes=0-3'})
        self.assertEqual(media.status_code, 206)
        self.assertEqual(media.data, b'orig')
        media.close()

    def test_recent_minutes_grouped_into_drives_per_source(self):
        for source in ['local', 'imports/cloud']:
            for minute in ['00', '01']:
                for camera in ['front', 'back']:
                    self.clip(f'{source}/RecentClips/2026-10-15_12-{minute}-00-{camera}.mp4')
        events = self.events()
        self.assertEqual(len(events), 2)
        self.assertEqual(len({e['id'] for e in events}), 2)
        for event in events:
            self.assertEqual(event['minutes'], 2)
            self.assertEqual(event['end'], '2026-10-15_12-01-00')
            self.assertEqual(len(module.catalog()[event['id']]['_videos']), 4)

    def test_five_minute_gap_starts_a_new_drive(self):
        # 12:04 starts 3 min after 12:00 ends; 12:10 starts 5 min after 12:04 ends.
        for stamp in ['12-00-00', '12-04-00', '12-10-00', '12-11-01']:
            self.clip(f'local/RecentClips/2026-10-15_{stamp}-front.mp4')
        self.clip('local/SavedClips/2026-10-15_12-05-00/2026-10-15_12-04-00-front.mp4')
        drives = sorted((e['date'], e.get('minutes')) for e in self.events() if e['kind'] == 'RecentClips')
        self.assertEqual(drives, [('2026-10-15_12-00-00', 2), ('2026-10-15_12-10-00', 2)])
        later = self.events()[0]
        self.assertEqual(len(self.client.get('/api/events/' + later['id'] + '/videos').json), 2)

    def test_saved_minutes_rejoin_their_drive(self):
        # Saving at 12:02:30 moved 12:00:10-12:01:10 out of RecentClips.
        saved = 'local/SavedClips/2026-10-15_12-02-30/'
        for stamp in ['12-00-10', '12-01-10']:
            self.clip(saved + f'2026-10-15_{stamp}-front.mp4')
        self.clip(saved + 'event.json', b'{}')
        for stamp in ['12-01-40', '12-02-40']:
            self.clip(f'local/RecentClips/2026-10-15_{stamp}-front.mp4')
        self.clip('local/SavedClips/2026-10-15_14-00-00/2026-10-15_13-59-00-front.mp4')  # no drive nearby
        events = self.events()
        drives = [e for e in events if e['kind'] == 'RecentClips']
        self.assertEqual(len(drives), 1)
        self.assertEqual((drives[0]['date'], drives[0]['end'], drives[0]['minutes']), ('2026-10-15_12-00-10', '2026-10-15_12-02-40', 4))
        self.assertEqual(len(self.client.get('/api/events/' + drives[0]['id'] + '/videos').json), 4)
        self.assertEqual(sum(e['kind'] == 'SavedClips' for e in events), 2)  # still listed themselves
        recent_only = hashlib.sha256(b'drive:local/RecentClips/2026-10-15_12-01-40').hexdigest()
        self.assertEqual(drives[0]['id'], recent_only)  # notes survive the Saved minutes joining

    def test_drive_is_kept_whole(self):
        for minute in ['00', '01', '02']:
            self.clip(f'local/RecentClips/2026-10-15_12-{minute}-00-front.mp4')
        drive = self.events()[0]
        self.assertEqual(self.client.post('/api/events/' + drive['id'], json={'keep': True}).status_code, 200)
        manifest = json.loads((module.RETAINED / drive['id'] / 'manifest.json').read_text())
        self.assertEqual(len(manifest['files']), 3)
        self.assertEqual(manifest['minutes'], 3)

    def test_fresh_upload_not_marked_kept(self):
        path = self.clip('local/RecentClips/2026-10-15_12-00-00-front.mp4')
        os.utime(path, None)
        event = self.events()[0]
        result = self.client.post('/api/events/' + event['id'], json={'keep': True})
        self.assertEqual(result.status_code, 409)
        self.assertFalse(self.events()[0]['kept'])

    def test_failure_publishes_no_bundle(self):
        self.clip('local/SavedClips/2026-10-15_12-00-00/2026-10-15_12-00-00-front.mp4')
        event = self.events()[0]
        with patch.object(module.os, 'replace', side_effect=OSError('disk full')), patch.object(module.app.logger, 'exception'):
            result = self.client.post('/api/events/' + event['id'], json={'keep': True})
        self.assertEqual(result.status_code, 409)
        self.assertFalse(self.events()[0]['kept'])
        self.assertEqual(list((module.RETAINED / '.incoming').iterdir()), [])

    def test_upload_added_during_copy_rejected(self):
        self.clip('local/RecentClips/2026-10-15_12-00-00-front.mp4')
        event = self.events()[0]
        with patch.object(module, 'scan_sources', return_value={}):
            result = self.client.post('/api/events/' + event['id'], json={'keep': True})
        self.assertEqual(result.status_code, 409)
        self.assertFalse(self.events()[0]['kept'])

    def test_repeat_keep_does_not_recopy(self):
        self.clip('local/RecentClips/2026-10-15_12-00-00-front.mp4')
        event = self.events()[0]
        url = '/api/events/' + event['id']
        self.assertEqual(self.client.post(url, json={'keep': True}).status_code, 200)
        with patch.object(module, 'retain', side_effect=AssertionError('recopied')):
            self.assertEqual(self.client.post(url, json={'keep': True}).status_code, 200)

    def test_existing_incomplete_bundle_is_not_reported_as_kept(self):
        self.clip('local/RecentClips/2026-10-15_12-00-00-front.mp4')
        event = self.events()[0]
        (module.RETAINED / event['id']).mkdir(parents=True)
        result = self.client.post('/api/events/' + event['id'], json={'keep': True})
        self.assertEqual(result.status_code, 409)
        self.assertFalse(self.events()[0]['kept'])

    def test_cross_site_write_and_unknown_file_rejected(self):
        self.assertEqual(self.client.post('/api/events/anything', json={}, headers={'Origin': 'https://evil.example'}).status_code, 403)
        self.assertEqual(self.client.post('/api/events/anything', data='{}').status_code, 415)
        self.assertEqual(self.client.get('/media/unknown/0').status_code, 404)

    def test_glovebox_shell_and_corresponding_source(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'player-tpl', response.data)
        self.assertIn(b'glovebox-player.js', response.data)
        with self.client.get('/static/glovebox.css') as stylesheet:
            self.assertEqual(stylesheet.status_code, 200)
        import io
        import zipfile
        with zipfile.ZipFile(io.BytesIO(self.client.get('/source.zip').data)) as archive:
            self.assertIn('LICENSE', archive.namelist())
            self.assertIn('static/library.js', archive.namelist())

    def test_encrypted_folder_and_payload_are_hidden_from_every_route(self):
        self.clip('local/RecentClips/2026-10-15_12-00-00-front.mp4')
        self.clip('local/EncryptedClips/RecentClips/2026-10-15_12-00-00-front.mp4')
        self.clip('imports/remote/encryptedclips/SavedClips/2026-10-15_12-00-00/2026-10-15_12-00-00-front.mp4')
        self.clip('local/SavedClips/2026-10-15_12-00-00/2026-10-15_12-00-00-front.mp4', b'encryptedbytes')
        self.assertEqual(len(self.events()), 1)
        encrypted_id = hashlib.sha256(b'local/EncryptedClips/RecentClips/2026-10-15_12-00-00').hexdigest()
        for route in [f'/media/{encrypted_id}/0', f'/api/telemetry/{encrypted_id}/0', f'/api/events/{encrypted_id}/videos', f'/api/events/{encrypted_id}/preview']:
            self.assertEqual(self.client.get(route).status_code, 404)

    def test_preview_generation_exposes_loading_then_cached_image(self):
        self.clip('local/RecentClips/2026-10-15_12-00-00-front.mp4')
        event = self.events()[0]
        from concurrent.futures import Future
        pending = Future()
        module.preview_jobs.clear()
        with patch.object(module.preview_pool, 'submit', return_value=pending):
            url = '/api/events/' + event['id'] + '/preview'
            self.assertEqual(self.client.get(url).json['state'], 'queued')
            pending.set_running_or_notify_cancel()
            self.assertEqual(self.client.get(url).json['state'], 'loading')
            target, _ = module.preview_file(module.catalog()[event['id']])
            target.parent.mkdir(parents=True)
            target.write_bytes(b'jpeg-preview')
            pending.set_result(True)
            result = self.client.get(url)
            self.assertEqual(result.json['state'], 'ready')
            with self.client.get(result.json['url']) as image:
                self.assertEqual(image.data, b'jpeg-preview')
        module.preview_jobs.clear()

    def test_preview_failure_is_visible_and_retryable(self):
        self.clip('local/RecentClips/2026-10-15_12-00-00-front.mp4')
        event = self.events()[0]
        from concurrent.futures import Future
        failed = Future(); failed.set_result(False)
        module.preview_jobs.clear()
        with patch.object(module.preview_pool, 'submit', return_value=failed) as submit:
            url = '/api/events/' + event['id'] + '/preview'
            self.assertEqual(self.client.get(url).json['state'], 'unavailable')
            self.client.get(url + '?retry=1')
            self.assertEqual(submit.call_count, 2)
        module.preview_jobs.clear()

    def test_bad_sidecar_falls_back_to_generated_preview(self):
        self.clip('local/RecentClips/2026-10-15_12-00-00-front.mp4')
        self.clip('local/RecentClips/thumb.png', b'not an image')
        event = next(iter(module.catalog(True).values()))
        target, video = module.preview_file(event)
        self.assertEqual(target.suffix, '.jpg')
        self.assertIsNotNone(video)


if __name__ == '__main__':
    unittest.main()
