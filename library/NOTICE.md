# Glovebox Archive viewer

This directory is licensed under GNU GPL version 3 (see LICENSE).

The stylesheet (`static/glovebox.css`), logo (`static/logo.svg`), HTML shell,
player template, helper functions and synchronized player
(`static/glovebox-player.js`), telemetry selector (`static/telemetry.js`),
and Go telemetry/MP4 playback packages (`recording/internal/`) are copied
or adapted from **Glovebox**:

- Source: https://github.com/lubaxe/glovebox
- Local main: 874183ffac2ce240cd6dbcabd7bcd7f8469087ee (0.6.0)
- Public main: d4ed18fb64918ee0c76ec1e7318daa223d905992; viewer files match local main exactly.
- License: GPL-3.0
- Copyright belongs to the original Glovebox contributors.

Changes: the standalone archive UI removes Pi hardware/settings screens,
connects the player to archive media URLs, and adds source filtering, notes,
tags and durable local retention. `app.py`, `static/library.js` and
`static/library.css` implement these additions. Glovebox Archive is a
companion to Glovebox, released separately as a Docker image.

Archive-specific playback changes keep all six canonical camera slots visible
when a backup is incomplete. A small internal HTTP adapter connects the copied
Go telemetry and MP4 packages to the archive's existing access checks. Previews
are generated locally using the distribution-provided FFmpeg executable.

Further modifications (2026-10-19) to `static/glovebox-player.js`,
`static/glovebox.css`, `templates/index.html` and `recording/main.go`: one-minute
Recent/Archived clips are grouped into drives and play through without a gap
(a second, hidden video per camera buffers the next minute); cameras stay in
sync by adjusting playback rate rather than seeking; every camera streams in
every view and camera thumbnails redraw on each video frame; open-ended media
range requests are answered in 8 MiB parts; and the telemetry overlay is
restyled as a card after the Tesla app's dashcam overlay.

Corresponding application source and license are available from `/source.zip`
in the running app. Imported cloud credentials and application data are not
included in the source download.
