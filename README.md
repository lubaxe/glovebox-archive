# Glovebox Archive

Browse, play and keep the TeslaCam footage that [Glovebox](https://github.com/lubaxe/glovebox) backs up to your NAS. It runs as one Docker container next to your footage, with no cloud and no account.

- **Drives, not minutes.** The car records driving one minute at a time. The archive joins them into drives, including the minutes a Saved clip moved out of RecentClips, and plays each one straight through, all six cameras in sync.
- **All six cameras.** Watch one camera full screen or all six in a grid, with live thumbnails of every camera.
- **Recorded telemetry.** Speed (MPH or km/h), gear, steering, pedals, turn signals and Self Driving / Autosteer, read from the video (firmware 2025.44.25+, HW3+).
- **Keep what matters.** Copy a drive or Sentry event to a separate folder that your normal cleanup never touches, with notes and tags.
- **Read-only.** Your TeslaCam folder is mounted read-only. Nothing in it is changed or deleted.

## Install

You need Docker with Compose, and the folder your Glovebox uploads to (the one holding `RecentClips`, `SavedClips` and `SentryClips`).

```bash
mkdir glovebox-archive && cd glovebox-archive
curl -fsSLO https://raw.githubusercontent.com/lubaxe/glovebox-archive/main/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/lubaxe/glovebox-archive/main/.env.example
```

Edit `.env` and set `TESLACAM_PATH` to that folder. Then:

```bash
docker compose up -d
```

Open **http://&lt;your server&gt;:5500**.

The app runs as `PUID:PGID` (default `1000:1000`), which must be able to read your footage. On **Unraid** set `PUID=99` and `PGID=100`, and put the files somewhere persistent, for example `/mnt/user/appdata/glovebox-archive`, with `TESLACAM_PATH=/mnt/user/TeslaCam` and `KEEP_PATH=/mnt/user/TeslaCamKeep`.

To update:

```bash
docker compose pull && docker compose up -d
```

Set `VERSION` in `.env` (for example `VERSION=1.0.0`) to stay on a release instead of following `latest`. Images are published for amd64 and arm64.

> **There is no login.** Run it on your home network only. To reach it from outside, use a VPN or a reverse proxy with authentication. Never forward the port to the internet. Your footage includes GPS locations.

## Settings

All settings live in `.env`; see [`.env.example`](.env.example).

| Setting | Default | |
|---|---|---|
| `TESLACAM_PATH` | (required) | Your TeslaCam folder, mounted read-only |
| `PORT` | `5500` | Web port |
| `KEEP_PATH` | `./keep` | Kept original footage |
| `DATA_PATH` | `./data` | Notes, tags and preview images |
| `IMPORT_PATH` | `./imports` | Footage copied by the optional importer |
| `PUID` / `PGID` | `1000` | The user the app runs as |
| `TZ` | `UTC` | Time zone for logs |
| `DRIVE_GAP_SECONDS` | `300` | A break this long between minutes starts a new drive |
| `VERSION` | `latest` | Image version |

## Keep and organize

Open a recording, add tags such as `incident, insurance` and a note, then choose **Save notes** or **Keep original footage**. The **Kept** page lists kept recordings even after the originals are cleaned up.

- Saved and Sentry events keep every camera file in the event, plus its JSON and images.
- Drives keep every minute and camera of the drive.
- Files must have been untouched for two minutes, so a recording still uploading can't be kept half-finished. A copy that fails is never shown as kept.
- Copies are byte-for-byte, with SHA-256 checksums in a manifest.
- **Kept footage never expires and has no size limit.** Remove bundles from `KEEP_PATH` by hand when you no longer need them, while the app is stopped. Back up `KEEP_PATH` and `DATA_PATH`.

A drive whose first minute is cleaned up becomes a new drive with its own notes. Encrypted recordings (`EncryptedClips`) are not shown.

## Footage elsewhere

### NFS

To read the footage straight from an NFS export, set `NFS_HOST` and `NFS_EXPORT` in `.env`, download [`compose.nfs.yaml`](compose.nfs.yaml) too, and start with:

```bash
docker compose -f compose.yaml -f compose.nfs.yaml up -d
```

### Copying from SMB, SFTP, cloud storage or rsync

The optional importer copies footage from other places into `IMPORT_PATH` every 15 minutes. It never deletes anything, either locally or on the remote.

1. Create `sources.json` next to `compose.yaml`, following [`sources.example.json`](sources.example.json). `source` is the folder holding `RecentClips`, `SavedClips` and `SentryClips`; `name` is the local folder it's copied into and must be unique.
2. For SMB, SFTP or cloud storage, set up an [rclone](https://rclone.org/overview/) remote:

   ```bash
   docker compose --profile remote run --rm --entrypoint rclone importer config --config /config/rclone/rclone.conf
   ```

   Then use it as a source, for example `"source": "nas:TeslaCam"` or `"source": "s3:car-backups/TeslaCam"`.
3. For rsync over SSH, put the key, `known_hosts` and an SSH `config` in `DATA_PATH/ssh`, and use a source such as `archive-nas:/srv/TeslaCam/`. Verify the server's fingerprint before trusting it.
4. Start it:

   ```bash
   docker compose --profile remote up -d
   docker compose logs -f importer
   ```

## Build from source

```bash
git clone https://github.com/lubaxe/glovebox-archive.git && cd glovebox-archive
cp .env.example .env   # set TESLACAM_PATH
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

Tests:

```bash
pip install -r library/requirements.txt
(cd library && python -m unittest test_app)
(cd importer && python -m unittest test_import)
node --test library/static/player.test.mjs
(cd library/recording && go test ./...)
```

How playback and telemetry work: [`library/VIEWER.md`](library/VIEWER.md).

## License

GPL-3.0; see [LICENSE](LICENSE). The viewer is adapted from Glovebox; see [`library/NOTICE.md`](library/NOTICE.md). Glovebox is not affiliated with Tesla.
