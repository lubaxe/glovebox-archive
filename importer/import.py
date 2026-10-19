"""Pull configured archives to separate local namespaces; never mirror deletions."""
import json
import os
from pathlib import Path
import re
import subprocess
import time


def command(source, destination):
    kind, remote = source['type'], source['source']
    if not isinstance(remote, str) or not remote or remote.startswith('-'):
        raise ValueError('Invalid source address')
    if kind == 'rclone':
        return ['rclone', 'copy', remote, str(destination),
                '--config', '/config/rclone/rclone.conf', '--min-age', '2m',
                '--exclude', '*.partial', '--exclude', '*.tmp',
                '--transfers', '2', '--stats', '1m', '--log-level', 'NOTICE']
    if kind == 'rsync':
        return ['rsync', '-rt', '--safe-links', '--exclude=*.partial',
                '--exclude=*.tmp', '--timeout=120',
                '-e', 'ssh -F /ssh/config -o BatchMode=yes -o StrictHostKeyChecking=yes',
                '--', remote, str(destination) + '/']
    raise ValueError('Unknown source type: ' + str(kind))


def run_once(sources):
    names = set()
    for source in sources:
        name = source.get('name', '')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', name) or name in names:
            raise ValueError('Source names must be unique simple directory names')
        names.add(name)
        command(source, Path('/imports') / name)  # Validate the entire config first.
    for source in sources:
        destination = Path('/imports') / source['name']
        destination.mkdir(parents=True, exist_ok=True)
        print('Importing', source['name'], flush=True)
        try:
            result = subprocess.run(command(source, destination), timeout=6 * 3600)
            print(source['name'], 'exit status', result.returncode, flush=True)
        except (OSError, subprocess.TimeoutExpired) as exc:
            print(source['name'], 'failed:', type(exc).__name__, flush=True)


if __name__ == '__main__':
    interval = max(60, int(os.environ.get('IMPORT_INTERVAL', '900')))
    while True:
        try:
            sources = json.loads(Path('/settings/sources.json').read_text())
            if not isinstance(sources, list):
                raise ValueError('sources.json must contain a list')
            run_once(sources)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            print('Import configuration failed:', str(exc), flush=True)
        time.sleep(interval)
