// Adapted from Glovebox main 874183f, GPL-3.0; see NOTICE.md.
'use strict';

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// The car records local time without a zone, e.g. "2026-10-15T00:39:00".
function carTime(s) {
  const [d, t] = s.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se] = t.split(':').map(Number);
  return new Date(y, mo - 1, da, h, mi, se);
}
function fmtDay(d) {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtClock = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function gb(bytes) {
  if (bytes < 2 ** 30) return `${Math.max(1, Math.round(bytes / 2 ** 20))} MB`;
  return `${(bytes / 2 ** 30).toFixed(bytes < 10 * 2 ** 30 ? 1 : 0)} GB`;
}
// "in 40 s", "in 3 min": how long until date.
function inTime(date) {
  const s = Math.max(0, Math.round((date - Date.now()) / 1000));
  if (s < 60) return `in ${s} s`;
  return `in ${Math.round(s / 60)} min`;
}

const CAMERA_ORDER = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
const CAMERA_NAMES = {
  front: 'Front', back: 'Rear', left_repeater: 'Left repeater', right_repeater: 'Right repeater',
  left_pillar: 'Left pillar', right_pillar: 'Right pillar',
};
function sortCameras(set) {
  const known = CAMERA_ORDER.filter((c) => set.has(c));
  const rest = [...set].filter((c) => !CAMERA_ORDER.includes(c)).sort();
  return known.concat(rest);
}


// Stops a video's download and frees its decoder.
function unload(v) {
  v.pause();
  if (!v.getAttribute('src')) return;
  v.removeAttribute('src');
  v.load();
}
const telemetryURL = (file) => '/api/telemetry/' + encodeURIComponent(file.snapshot) + '/' + file.path.split('/').map(encodeURIComponent).join('/');

const clipBytes = clips => clips.reduce((n,c) => n + Object.values(c.cameras).reduce((m,f) => m + f.size,0),0);
function mediaURL(file, download) { return file.url + (download ? "?download=1" : "?layout=3"); }
const player = {
  clips: [],
  i: 0,
  cams: [],
  videos: {},
  master: null,
  playing: false,
  speed: 1,
  scrubbing: false,

  open(name, pageTitle, clips, start, title, sub, backTo, zipURL) {
    const view = $('#player-tpl').content.firstElementChild.cloneNode(true);
    page(name, pageTitle, view);
    this.clips = clips;
    $('#back').href = backTo;
    $('#player-title').textContent = title;
    $('#player-sub').replaceChildren(...sub);
    this.zipURL = zipURL;
    this.speedUnit = 'mph';
    try { this.speedUnit = localStorage.getItem('glovebox-speed-unit') === 'kmh' ? 'kmh' : 'mph'; } catch { /* Optional preference. */ }

    const set = new Set();
    for (const c of clips) for (const cam of Object.keys(c.cameras)) set.add(cam);
    // Archive adaptation: keep the six camera positions stable even for
    // incomplete uploads. Never borrow footage from another minute.
    this.cams = CAMERA_ORDER.slice();
    // Two videos per camera: the one showing, and the spare that buffers the
    // next minute behind it so a drive plays through without a gap.
    this.videos = {};
    this.spares = {};
    this.prepared = null;
    $('#cams').style.setProperty('--camera-columns', Math.min(3, this.cams.length));
    $('#cams').style.setProperty('--camera-rows', Math.ceil(this.cams.length / 3));
    $('#cams').style.setProperty('--camera-mobile-columns', Math.min(2, this.cams.length));
    $('#cams').style.setProperty('--camera-mobile-rows', Math.ceil(this.cams.length / 2));
    const video = (cam) => {
      const v = el('video', { muted: true, playsinline: true, preload: 'auto' });
      v.muted = true;
      v.addEventListener('timeupdate', () => this.onTime(v));
      v.addEventListener('ended', () => this.onEnded(v));
      v.addEventListener('loadedmetadata', () => { v.playbackRate = this.speed; });
      v.addEventListener('loadeddata', () => this.videos[cam] === v && this.drawThumbnails(true));
      v.addEventListener('seeked', () => this.videos[cam] === v && this.drawThumbnails(true));
      v.addEventListener('error', () => this.recover(cam, v));
      // Each thumbnail follows its own camera frame by frame, at the same
      // rate as the picture.
      if (v.requestVideoFrameCallback) {
        const frame = () => {
          if (this.videos[cam] === v) { this.lastFrameThumbnail = performance.now(); this.drawThumbnail(cam); }
          v.requestVideoFrameCallback(frame);
        };
        v.requestVideoFrameCallback(frame);
      }
      return v;
    };
    $('#cams').replaceChildren(...this.cams.map((cam) => {
      this.videos[cam] = video(cam);
      this.spares[cam] = video(cam);
      this.spares[cam].classList.add('spare');
      return el('div', { class: 'cam', 'data-cam': cam, onclick: () => this.focus(cam) },
        this.videos[cam], this.spares[cam], el('span', { class: 'label' }, CAMERA_NAMES[cam] || cam));
    }));
    this.buildCameraRail();
    $('#viewer-info').addEventListener('click', () => {
      const details = $('#viewer-details');
      details.hidden = !details.hidden;
      $('#viewer-info').setAttribute('aria-expanded', String(!details.hidden));
      this.renderTelemetry(this.master?.currentTime || 0);
    });
    $('#hud-unit').addEventListener('click', () => {
      this.speedUnit = this.speedUnit === 'mph' ? 'kmh' : 'mph';
      try { localStorage.setItem('glovebox-speed-unit', this.speedUnit); } catch { /* Optional preference. */ }
      this.renderTelemetry(this.master?.currentTime || 0);
    });
    const fullscreen = $('#viewer-fullscreen');
    fullscreen.hidden = !document.fullscreenEnabled;
    fullscreen.addEventListener('click', async () => {
      try { if (document.fullscreenElement) await document.exitFullscreen(); else await view.requestFullscreen(); }
      catch { fullscreen.title = 'Fullscreen is unavailable in this browser'; }
    });
    view.addEventListener('fullscreenchange', () => { fullscreen.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen'); });
    $('#clip-strip').replaceChildren(...clips.map((c, k) =>
      el('button', { type: 'button', onclick: () => this.load(k, this.playing) }, fmtTime(carTime(c.start)))));

    $('#play').addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    $('#prev').addEventListener('click', () => this.i > 0 && this.load(this.i - 1, this.playing));
    $('#next').addEventListener('click', () => this.i + 1 < this.clips.length && this.load(this.i + 1, this.playing));
    $('#speed').value = String(this.speed);
    $('#speed').addEventListener('change', (e) => {
      this.speed = Number(e.target.value);
      for (const v of [...Object.values(this.videos), ...Object.values(this.spares)]) v.playbackRate = this.speed;
    });
    // The timeline is real time: a drive can include clips shorter than a
    // minute (the pieces a Saved clip was cut from).
    const first = carTime(clips[0].start).getTime();
    this.offsets = clips.map((c) => (carTime(c.start).getTime() - first) / 1000);
    this.duration = this.offsets[this.offsets.length - 1] + 60;
    const scrub = $('#scrub');
    scrub.max = this.duration;
    scrub.value = this.offsets[start];
    scrub.addEventListener('input', () => { this.scrubbing = true; });
    scrub.addEventListener('change', () => { this.scrubbing = false; this.seek(Number(scrub.value)); });
    this.load(start, false);
  },

  load(i, autoplay) {
    this.stopFrameUpdates();
    // The next minute is already buffered in the spares: show those instead
    // of starting over, so the drive continues without a blank frame.
    const swap = this.prepared === i;
    this.prepared = null;
    this.i = i;
    this.clockSecond = null;
    this.lastSample = undefined;
    const clip = this.clips[i];
    this.master = null;
    for (const cam of this.cams) {
      const old = this.videos[cam];
      const box = old.parentElement;
      const file = clip.cameras[cam];
      if (swap) {
        const next = this.spares[cam];
        next.classList.remove('spare');
        old.classList.add('spare');
        this.videos[cam] = next;
        this.spares[cam] = old;
        unload(old);
      } else {
        old.pause();
        if (file) old.src = mediaURL(file);
        else unload(old);
        unload(this.spares[cam]);
      }
      box.classList.toggle('missing', !file);
    }
    this.pickMaster();
    for (const [k, b] of [...$('#clip-strip').children].entries()) b.classList.toggle('current', k === i);
    $('#downloads').replaceChildren(...this.cams.filter((c) => clip.cameras[c]).map((c) =>
      el('a', { href: mediaURL(clip.cameras[c], true) }, icon('download'), CAMERA_NAMES[c] || c)),
      this.zipURL ? el('a', { href: this.zipURL, download: '' }, icon('download'), `Everything (${gb(clipBytes(this.clips))} zip)`) : '');
    this.updateClock(0);
    this.updateCameraDownload();
    this.drawThumbnails(true);
    this.startFrameUpdates();
    this.loadTelemetry(clip);
    $('#prev').disabled = i === 0;
    $('#next').disabled = i + 1 >= this.clips.length;
    if (autoplay) this.play();
  },

  setPlayIcon(name) {
    const b = $('#play');
    if (b) { b.replaceChildren(icon(name)); b.setAttribute('aria-label', name === 'pause' ? 'Pause' : 'Play'); }
  },

  // active is what streams: every camera, with the one on screen first so
  // it leads. Glovebox streamed only the camera on screen, because all six
  // need about 43 Mbit/s, more than the Pi's Wi-Fi gives; this archive is
  // on the LAN, and streaming them all keeps the camera thumbnails live and
  // makes switching cameras instant.
  active() {
    const loaded = this.cams.map((c) => this.videos[c]).filter((v) => v?.getAttribute('src'));
    const main = this.videos[this.selectedCamera];
    return loaded.includes(main) ? [main, ...loaded.filter((v) => v !== main)] : loaded;
  },

  // pickMaster makes the first active video the one the others, the clock
  // and the HUD follow, and lets only the active ones buffer ahead.
  pickMaster() {
    const active = this.active();
    this.master = active[0] || null;
    for (const v of Object.values(this.videos)) v.preload = active.includes(v) ? 'auto' : 'metadata';
  },

  play() {
    this.playing = true;
    this.setPlayIcon('pause');
    const active = this.active();
    for (const v of Object.values(this.videos)) if (!active.includes(v)) v.pause();
    for (const v of active) {
      v.playbackRate = this.speed;
      v.play().catch((e) => {
        // A browser that won't play the main camera (not yet loaded, or a
        // limit on videos playing at once) shouldn't look like it's playing.
        if (v === this.master && e.name !== 'AbortError') {
          this.playing = false;
          this.setPlayIcon('play');
          $('#viewer-time').textContent = `Can't play here: ${e.message || e.name}`;
        }
      });
    }
  },

  pause() {
    this.playing = false;
    this.setPlayIcon('play');
    for (const v of Object.values(this.videos)) v.pause();
  },

  stop() {
    this.stopFrameUpdates();
    this.telemetryController?.abort();
    this.telemetrySamples = [];
    this.playing = false;
    for (const v of [...Object.values(this.videos), ...Object.values(this.spares || {})]) unload(v);
    this.videos = {};
    this.spares = {};
    this.prepared = null;
    this.clips = [];
  },

  // Keeps the other cameras with the master. Small drift is taken up by
  // running them a little faster or slower; seeking stalls a camera while it
  // refills its decoder, so it's only for big jumps or while paused.
  onTime(v) {
    if (v !== this.master) return;
    for (const other of this.active()) {
      if (other === v || other.readyState < 2) continue;
      const drift = other.currentTime - v.currentTime;
      if (v.paused || Math.abs(drift) > 1) {
        if (Math.abs(drift) > 0.1) other.currentTime = v.currentTime;
        other.playbackRate = this.speed;
      } else {
        other.playbackRate = this.speed * (drift > 0.04 ? 0.95 : drift < -0.04 ? 1.05 : 1);
      }
    }
    if (v.duration - v.currentTime < 20) this.prepareNext();
    if (!this.scrubbing) $('#scrub').value = this.offsets[this.i] + v.currentTime;
    // Frame callbacks keep the clock and HUD in step with the picture, but
    // some browsers stop sending them (a hidden or throttled video): then
    // the regular time updates keep the clock moving.
    if (!this.frameVideo || performance.now() - (this.lastFrameAt || 0) > 500) this.updateClock(v.currentTime);
  },

  onEnded(v) {
    if (v !== this.master) return;
    if (this.i + 1 < this.clips.length) this.load(this.i + 1, true);
    else this.pause();
  },

  // Starts the next minute buffering in the spare videos, for the cameras
  // being watched, so the switch at the end of this one is immediate.
  prepareNext() {
    const k = this.i + 1;
    if (this.prepared === k || k >= this.clips.length) return;
    this.prepared = k;
    const clip = this.clips[k];
    const active = this.active();
    for (const cam of this.cams) {
      const v = this.spares[cam], file = clip.cameras[cam];
      v.preload = active.includes(this.videos[cam]) ? 'auto' : 'metadata';
      if (file) v.src = mediaURL(file);
      else unload(v);
    }
    this.prefetchTelemetry(clip);
  },

  // A decoder can fail when the browser runs short of them (six cameras plus
  // the next minute buffering). One reload, at the same moment, recovers;
  // a file that really is damaged keeps its error.
  recover(cam, v) {
    const src = v.getAttribute('src');
    if (this.videos[cam] !== v || v.error?.code !== MediaError.MEDIA_ERR_DECODE || !src || v.dataset.retried === src) return;
    const at = v.currentTime;
    v.dataset.retried = src;
    v.src = src;
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = this.master && this.master !== v ? this.master.currentTime : at;
      if (this.playing && this.active().includes(v)) v.play().catch(() => {});
    }, { once: true });
  },

  // Drops a prepared minute whose cameras no longer match what's watched.
  discardPrepared() {
    this.prepared = null;
    for (const v of Object.values(this.spares)) unload(v);
  },

  // Position in the recording, in seconds of real time from its first clip.
  position() {
    return (this.offsets?.[this.i] || 0) + (this.master?.currentTime || 0);
  },

  seek(seconds) {
    seconds = Math.max(0, Math.min(seconds, this.duration - 0.1));
    let k = 0;
    while (k + 1 < this.clips.length && this.offsets[k + 1] <= seconds) k++;
    const offset = seconds - this.offsets[k];
    // only the cameras streaming; the others catch up when they're shown
    const apply = () => {
      for (const v of this.active()) v.currentTime = Math.min(offset, (v.duration || 60) - 0.1);
    };
    if (k !== this.i) {
      const playing = this.playing;
      this.load(k, false);
      const ready = () => { apply(); if (playing) this.play(); };
      // A prepared minute already has its metadata.
      if (this.master?.readyState >= 1) ready();
      else this.master?.addEventListener('loadedmetadata', ready, { once: true });
    } else {
      apply();
    }
  },

  updateClock(offset) {
    const clip = this.clips[this.i];
    if (clip) {
      const date = new Date(carTime(clip.start).getTime() + offset * 1000);
      const second = Math.floor(date.getTime() / 1000);
      if (this.clockSecond !== second) {
        this.clockSecond = second;
        $('#clock').textContent = fmtClock(date);
        $('#viewer-time').textContent = date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        $('#viewer-time').dateTime = date.toISOString();
      }
      this.renderTelemetry(offset);
      this.drawThumbnails();
    }
  },

  startFrameUpdates() {
    const video = this.master;
    if (!video?.requestVideoFrameCallback) return;
    this.frameVideo = video;
    const draw = (_now, frame) => {
      if (this.frameVideo !== video || !this.clips.length) return;
      this.lastFrameAt = performance.now();
      this.updateClock(frame.mediaTime);
      this.frameRequest = video.requestVideoFrameCallback(draw);
    };
    this.frameRequest = video.requestVideoFrameCallback(draw);
  },

  stopFrameUpdates() {
    if (this.frameVideo && this.frameRequest != null) this.frameVideo.cancelVideoFrameCallback(this.frameRequest);
    this.frameVideo = null;
    this.frameRequest = null;
  },

  buildCameraRail() {
    this.thumbnailCanvases = {};
    const choice = (id, label) => {
      const canvas = el('canvas', { width: '480', height: '270', 'aria-hidden': 'true' });
      this.thumbnailCanvases[id] = canvas;
      return el('button', { type: 'button', class: 'camera-choice', 'data-camera': id,
        'aria-label': label, 'aria-pressed': 'false', onclick: () => this.focus(id) }, canvas, el('span', {}, label));
    };
    $('#camera-rail').replaceChildren(choice('grid', 'Grid'), ...this.cams.map(cam => choice(cam, CAMERA_NAMES[cam] || cam)));
    this.focus(this.clips[0]?.cameras.front ? 'front' : Object.keys(this.clips[0]?.cameras || {})[0]);
    this.lastThumbnailDraw = 0;
  },

  // When frame callbacks aren't arriving (unsupported, or a page the browser
  // isn't rendering), all thumbnails redraw together on the master's time
  // updates, at most ten times a second.
  drawThumbnails(force = false) {
    const now = performance.now();
    if (!force && (now - (this.lastFrameThumbnail || 0) < 500 || now - this.lastThumbnailDraw < 100)) return;
    this.lastThumbnailDraw = performance.now();
    for (const cam of this.cams) this.drawThumbnail(cam);
  },

  // Draws one camera's thumbnail and its tile of the Grid thumbnail.
  drawThumbnail(cam) {
    const canvas = this.thumbnailCanvases?.[cam], video = this.videos[cam];
    if (!canvas) return;
    const mosaic = this.thumbnailCanvases.grid, grid = mosaic?.getContext('2d');
    const index = this.cams.indexOf(cam);
    const columns = Math.min(3, this.cams.length), rows = Math.ceil(this.cams.length / columns);
    const tile = [index % columns * mosaic.width / columns, Math.floor(index / columns) * mosaic.height / rows, mosaic.width / columns, mosaic.height / rows];
    const context = canvas.getContext('2d');
    try {
      if (!video || video.readyState < 2 || !video.getAttribute('src')) throw Error('no frame');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      grid?.drawImage(video, ...tile);
    } catch {
      // Nothing to show yet; a camera still seeking draws on its next frame.
      context.clearRect(0, 0, canvas.width, canvas.height);
      grid?.clearRect(...tile);
    }
  },

  cacheTelemetry(url, result) {
    this.telemetryCache ||= new Map();
    this.telemetryCache.set(url, result);
    while (this.telemetryCache.size > 6) this.telemetryCache.delete(this.telemetryCache.keys().next().value);
  },

  // Reads the next minute's front-camera telemetry ahead, so the HUD carries
  // on at the switch. The cache holds the pending promise; a failure leaves
  // the minute to load as usual.
  prefetchTelemetry(clip) {
    const file = clip.cameras.front;
    if (!file) return;
    const url = telemetryURL(file);
    if (this.telemetryCache?.has(url)) return;
    this.cacheTelemetry(url, fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((result) => { if (result) this.cacheTelemetry(url, result); else this.telemetryCache.delete(url); return result; })
      .catch(() => { this.telemetryCache.delete(url); return null; }));
  },

  async loadTelemetry(clip) {
    this.telemetryController?.abort();
    const controller = new AbortController();
    this.telemetryController = controller;
    this.telemetrySamples = [];
    this.telemetryState = 'Reading recorded telemetry…';
    this.renderTelemetry(0);
    this.telemetryCache ||= new Map();
    for (const camera of ['front', ...this.cams.filter(c => c !== 'front')]) {
      const file = clip.cameras[camera];
      if (!file) continue;
      const url = telemetryURL(file);
      try {
        let result = await this.telemetryCache.get(url);
        if (!result) {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) continue;
          result = await response.json();
          this.cacheTelemetry(url, result);
        }
        if (controller.signal.aborted || this.clips[this.i] !== clip) return;
        if (result.samples?.length) {
          this.telemetrySamples = result.samples;
          this.telemetryState = '';
          this.renderTelemetry(this.master?.currentTime || 0);
          return;
        }
      } catch (error) { if (controller.signal.aborted) return; }
    }
    if (!controller.signal.aborted && this.clips[this.i] === clip) {
      this.telemetryState = 'No telemetry recorded in this clip';
      this.renderTelemetry(this.master?.currentTime || 0);
    }
  },

  renderTelemetry(offset) {
    if (!$('#viewer-telemetry')) return;
    const sample = window.GloveboxTelemetry.at(this.telemetrySamples || [], offset);
    // Called for every video frame; the HUD only changes with the sample.
    const shown = [sample, this.speedUnit, this.telemetryState];
    if ($('#viewer-details').hidden && this.lastSample !== undefined && shown.every((v, k) => v === this.lastSample[k])) return;
    this.lastSample = shown;
    $('#hud-status').textContent = sample ? '' : this.telemetryState || 'No telemetry for this moment';
    $('#viewer-telemetry').classList.toggle('unavailable', !sample);
    $('#hud-speed').textContent = sample ? window.GloveboxTelemetry.speed(sample.speed_mps, this.speedUnit) : '—';
    $('#hud-gear').textContent = sample ? ['P', 'D', 'R', 'N'][sample.gear] || '?' : '—';
    $('#hud-unit').textContent = this.speedUnit === 'kmh' ? 'km/h' : 'MPH';
    $('#hud-unit').setAttribute('aria-label', 'Speed in ' + (this.speedUnit === 'kmh' ? 'km/h' : 'MPH') + '; switch to ' + (this.speedUnit === 'kmh' ? 'MPH' : 'km/h'));
    // The strip under the card names the driving aid; manual driving has none.
    const assist = sample ? ['', 'Self Driving', 'Autosteer', 'Traffic-Aware Cruise'][sample.autopilot] ?? 'Unknown' : '';
    $('#hud-assist').textContent = assist;
    $('#hud-assist').hidden = !assist;
    $('#hud-wheel').style.transform = 'rotate(' + (sample?.steering_deg || 0) + 'deg)';
    $('#hud-left').classList.toggle('active', !!sample?.left);
    $('#hud-right').classList.toggle('active', !!sample?.right);
    $('#hud-brake').classList.toggle('active', !!sample?.brake);
    $('#hud-throttle').classList.toggle('active', (sample?.accelerator || 0) > 0.01);
    $('#hud-throttle').style.setProperty('--pedal', (Math.max(0, Math.min(1, sample?.accelerator || 0)) * 100) + '%');
    $('#hud-steering').classList.toggle('assisted', !!sample && sample.autopilot > 0);
    $('#hud-throttle').title = sample ? 'Recorded accelerator pedal: ' + (sample.accelerator * 100).toFixed(1) + '% (not motor power)' : 'No recorded accelerator data';
    if (!$('#viewer-details').hidden) {
      const rows = sample ? [
        ['Speed', window.GloveboxTelemetry.speed(sample.speed_mps, this.speedUnit) + (this.speedUnit === 'kmh' ? ' km/h' : ' mph')],
        ['Gear', ['Park', 'Drive', 'Reverse', 'Neutral'][sample.gear] || 'Unknown'],
        ['Steering wheel', sample.steering_deg.toFixed(1) + '°'],
        ['Accelerator', (sample.accelerator * 100).toFixed(1) + '%'],
        ['Brake', sample.brake ? 'Applied' : 'Released'],
        ['Turn signals', [sample.left ? 'Left' : '', sample.right ? 'Right' : ''].filter(Boolean).join(' + ') || 'Off'],
        ['Driving assistance', ['None', 'Self-driving', 'Autosteer', 'Traffic-aware cruise'][sample.autopilot] || 'Unknown'],
        ['Latitude / longitude', sample.latitude.toFixed(6) + ', ' + sample.longitude.toFixed(6)],
        ['Heading', sample.heading.toFixed(1) + '°'],
        ['Acceleration X / Y / Z', [sample.accel_x, sample.accel_y, sample.accel_z].map(n => n.toFixed(2)).join(' / ') + ' m/s²'],
        ['Frame / schema', sample.frame + ' / v' + sample.version],
      ] : [['Telemetry', this.telemetryState || 'No recorded sample at this moment']];
      $('#telemetry-details').replaceChildren(...rows.flatMap(([key, value]) => [el('dt', {}, key), el('dd', {}, value)]));
    }
  },

  updateCameraDownload() {
    const camera = this.selectedCamera === 'grid' ? (this.cams.includes('front') ? 'front' : this.cams[0]) : this.selectedCamera;
    const file = this.clips[this.i]?.cameras[camera];
    const link = $('#viewer-download');
    if (!link) return;
    if (file) { link.href = mediaURL(file, true); link.setAttribute('download', ''); }
    else { link.removeAttribute('href'); link.removeAttribute('download'); }
    link.setAttribute('aria-disabled', String(!file));
    link.setAttribute('aria-label', 'Download ' + (CAMERA_NAMES[camera] || camera) + ' camera');
    link.title = file ? 'Download ' + (CAMERA_NAMES[camera] || camera) + ' camera' : 'Camera was not recorded in this minute';
  },

  focus(camera) {
    if (camera !== 'grid' && !this.cams.includes(camera)) return;
    this.selectedCamera = camera;
    $('#cams').classList.toggle('viewer-grid', camera === 'grid');
    for (const box of $('#cams').children) box.classList.toggle('main', box.dataset.cam === camera);
    for (const button of $('#camera-rail').children) button.setAttribute('aria-pressed', String(button.dataset.camera === camera));
    this.updateCameraDownload();
    // Switch what streams, picking up where the old view was.
    if (!this.master) return; // nothing loaded yet
    const at = this.master.currentTime;
    this.stopFrameUpdates();
    this.discardPrepared();
    this.pickMaster();
    for (const v of this.active()) if (Math.abs(v.currentTime - at) > 0.25) v.currentTime = at;
    if (this.playing) this.play();
    else for (const v of Object.values(this.videos)) v.pause();
    this.startFrameUpdates();
  },

};

document.addEventListener('keydown', (e) => {
  if (!player.clips.length || e.target.closest('input, select, textarea, button, a, [contenteditable=true]')) return;
  if (e.key === 'Escape' && !document.fullscreenElement) {
    if (!$('#viewer-details').hidden) { $('#viewer-details').hidden = true; $('#viewer-info').setAttribute('aria-expanded', 'false'); }
    else location.hash = $('#back').getAttribute('href');
    return;
  }
  if (e.key === ' ') { e.preventDefault(); player.playing ? player.pause() : player.play(); }
  if (e.key === 'ArrowRight') player.seek(player.position() + 5);
  if (e.key === 'ArrowLeft') player.seek(player.position() - 5);
});

