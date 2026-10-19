import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('importer', Path(__file__).with_name('import.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConnectorTests(unittest.TestCase):
    def test_rclone_is_copy_with_partial_exclusion(self):
        command = module.command({'type': 'rclone', 'source': 'nas:TeslaCam'}, Path('/imports/nas'))
        self.assertEqual(command[:3], ['rclone', 'copy', 'nas:TeslaCam'])
        self.assertNotIn('sync', command)
        self.assertIn('*.partial', command)

    def test_rsync_has_no_delete_and_enforces_host_keys(self):
        command = module.command({'type': 'rsync', 'source': 'nas:/TeslaCam/'}, Path('/imports/nas'))
        self.assertFalse(any(arg.startswith('--delete') for arg in command))
        self.assertIn('StrictHostKeyChecking=yes', command[command.index('-e') + 1])

    def test_invalid_names_and_options_rejected_before_any_process(self):
        with patch.object(module.subprocess, 'run') as run:
            for name in ['../escape', '/absolute', '', 'two words']:
                with self.assertRaises(ValueError):
                    module.run_once([{'name': name, 'type': 'rclone', 'source': 'remote:path'}])
            with self.assertRaises(ValueError):
                module.command({'type': 'rclone', 'source': '--delete'}, Path('/imports/x'))
            with self.assertRaises(ValueError):
                module.run_once([{'name': 'same', 'type': 'rclone', 'source': 'a:path'}] * 2)
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
