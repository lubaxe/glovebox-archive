# Viewer and recorded vehicle telemetry

## Controls

Opening an unencrypted event or drive enters the cinema viewer. Use the thumbnail rail to select Front, Rear, Left/Right repeaters, Left/Right pillars or Grid. Thumbnails reuse the existing decoded video frames; they do not open duplicate video streams. Camera playback and minute selection continue to use the existing synchronized player. Each camera has a second, hidden video that buffers the next minute during the last 20 seconds of the current one, so a drive plays through without a blank frame; the next minute's telemetry is read ahead at the same time. Cameras that drift from the leading one are corrected by running them up to 5% faster or slower rather than by seeking, which would stall them; seeking is kept for jumps over a second and for paused frames. A camera whose decoder fails is reloaded once at the same moment.

The top controls open clip details, enter/exit fullscreen where supported, download the selected camera's current minute, and close the viewer. Close restores the normal desktop/sidebar or mobile bottom navigation. The details panel contains event information, minute selection and all downloads. Space plays/pauses, left/right arrows seek five seconds, and Escape closes details or the viewer (the browser handles Escape from native fullscreen).

## Recorded overlay

The HUD is a card styled after the Tesla app's dashcam overlay: gear, speed and the steering wheel (turned to the recorded angle) on top; brake pedal (red when applied), speed unit and accelerator pedal (filled to the recorded position) below; turn-signal arrows beside the speed while they're on; and a strip naming the driving aid (Self Driving, Autosteer or Traffic-Aware Cruise), shown only when one is engaged. Click the speed unit to switch MPH / km/h; the browser remembers the choice when storage is available. The exact accelerator percentage is in the details panel. The accelerator is the recorded pedal position, not motor power or the vehicle controller's torque request. In an FSD recording the physical accelerator can remain at zero while the car moves.

The details panel adds GPS latitude/longitude, heading, three acceleration axes, frame sequence and schema version. No external map or telemetry service is loaded. Values are local to the recording; they are not live vehicle data. Missing metadata or a gap longer than one second is shown as unavailable, never fabricated as P, zero speed, or a released brake.

## Source and timing

Tesla publishes the [SEI metadata schema](https://github.com/teslamotors/dashcam/blob/master/dashcam.proto) and [availability notes](https://github.com/teslamotors/dashcam). Its documentation identifies firmware 2025.44.25+ and HW3+ as requirements, and says parked clips may omit telemetry. Encrypted car recordings continue to use the existing external-viewer/download path; Glovebox does not bypass encryption.

The Go reader independently implements that published wire schema. It reads H.264 SEI user data and MP4 sample timing / chunk tables, supports 32/64-bit chunk offsets, variable frame durations, zero-duration samples and ordinary trim/initial-empty edit lists. Decode timestamps match the existing Glovebox media route's composition-offset patch. Nonlinear edit lists, fragmented MP4, unsupported codecs and malformed tables are not guessed at. No third-party parser code or new runtime dependency is bundled.

The browser selects the latest recorded sample at or before displayed media time. Video-frame callbacks drive the HUD when supported; timeupdate is the fallback. Seeking backwards and changing minutes select new data, and abort obsolete requests. The browser caches at most six per-file telemetry responses. All six cameras stream in every view, with the selected one leading, so thumbnails stay live (each redrawn on its own camera's video frames, at full frame rate) and switching cameras needs no rebuffering. The HUD redraws only when the recorded sample changes.

Open-ended range requests are answered 8 MiB at a time, so the six cameras and the next minute behind them share the browser's six connections per host instead of each holding one. Video requests look up only their own recording; the archive is rescanned in the background once the one-minute discovery cache is stale.

## Endpoint and privacy

GET /api/telemetry/{snapshot}/{path...} opens only files already permitted by the clip library and snapshot index. It shares the existing local-network access model of recordings, including sensitive location data. Do not expose the device interface to the public internet. There is no upload to Tesla or an outside telemetry service. Original files are not changed.

Parsing is bounded: MP4 metadata size, table/sample counts, per-frame NAL count and SEI size have limits; concurrent endpoint scans are limited to two and cancellation is checked during extraction. Video pixel data is skipped, not decoded by the server. On-device timing/performance still needs validation on the target board.

## Validation and local previews

- go test ./... runs synthetic parser / timing / path access tests, including malformed input and cancellation.
- node --test scripts/player.test.mjs scripts/web-ui.test.mjs checks timestamp selection, seeking, gaps, units and update notices.
- go test ./internal/telemetry -fuzz FuzzExtract -fuzztime 5s -parallel 2 exercises the binary parser.
- Optionally set GLOVEBOX_TELEMETRY_FIXTURE to a local recording before running go test -v ./internal/telemetry. The private video is not checked into Git.
- go run ./tools/telemetryinspect /path/to/timestamp-front.mp4 prints sample count, time span, speed range and gear counts, without GPS coordinates.
- go run ./tools/uidemo -addr 127.0.0.1:8103 -footage /path/to/isolated-demo -real-clip /path/to/timestamp-front.mp4 -setupdone copies one supplied front recording into an isolated local demo snapshot. Its original timestamp is preserved. Other status in this development server is demo data. The regular multi-camera generated demo remains available without -real-clip.

A locally supplied 60.0827-second, 2,164-frame H.264 recording was used to validate extraction and the real FSD/speed/steering overlay. No private video or telemetry fixture is part of the source changes.
