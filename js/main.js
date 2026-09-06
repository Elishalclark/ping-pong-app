import { VisionReferee } from './vision.js';
import { AudioReferee } from './audio.js';
import { Referee } from './referee.js';

const $ = id => document.getElementById(id);
const els = {
  video: $('video'), overlay: $('overlay'), loupe: $('loupe'), hint: $('calibHint'),
  rotate: $('rotateHint'), cam: $('camStatus'), mic: $('micStatus'), fps: $('fpsStatus'),
  ptsA: $('ptsA'), ptsB: $('ptsB'), gamesA: $('gamesA'), gamesB: $('gamesB'),
  teamA: $('teamA'), teamB: $('teamB'), call: $('callBanner'), log: $('log'),
  level: $('levelBar'), flux: $('fluxBar'),
};

const vision = new VisionReferee(els.video, els.overlay);
const audio = new AudioReferee();
let referee = null;
let started = false;

// =========================================================================
// Calibration — built for a fingertip, not a mouse pointer
// =========================================================================
// A finger covers the very corner it is trying to place, so dragging shows a
// magnified loupe of the area under it. Corners stay draggable after they are
// placed: nudging one is far easier than starting the whole process again.

const CALIB_STEPS = [
  'Tap the table corner at <b>A’s end, nearest you</b>.',
  'Now the <b>far corner at A’s end</b>.',
  'Now the <b>far corner at B’s end</b>.',
  'Now the <b>corner at B’s end nearest you</b>.',
];
const HANDLE_R = 0.045;   // grab radius, as a fraction of the video's width
let calibrating = false;
let corners = [];
let dragIdx = -1;

function beginCalibration() {
  if (!started) return say('Tap <b>Start</b> first.', 'fault');
  calibrating = true;
  corners = [];
  dragIdx = -1;
  vision.table = null;
  vision.pending = corners;
  els.hint.hidden = false;
  els.hint.innerHTML = CALIB_STEPS[0];
  $('btnRef').disabled = true;
}

function finishCalibration() {
  vision.setTable(corners);
  vision.pending = null;
  calibrating = false;
  els.hint.hidden = true;
  $('btnRef').disabled = false;
  say('Table set — drag a corner to adjust. Tap <b>Begin match</b> when ready.', 'info');
}

// Map a pointer to normalised video coordinates, undoing the letterboxing
// that object-fit: contain applies.
function toVideo(e) {
  const r = els.overlay.getBoundingClientRect();
  const scale = Math.min(r.width / els.overlay.width, r.height / els.overlay.height);
  const dw = els.overlay.width * scale, dh = els.overlay.height * scale;
  return {
    x: (e.clientX - r.left - (r.width - dw) / 2) / dw,
    y: (e.clientY - r.top - (r.height - dh) / 2) / dh,
  };
}

els.overlay.addEventListener('pointerdown', e => {
  const p = toVideo(e);
  if (p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05) return;
  els.overlay.setPointerCapture(e.pointerId);

  const pts = calibrating ? corners : vision.table?.corners;
  if (pts) {
    const near = pts.findIndex(c => Math.hypot(c.x - p.x, (c.y - p.y) * 0.75) < HANDLE_R);
    if (near >= 0) { dragIdx = near; drawLoupe(pts[near]); return; }
  }
  if (calibrating && corners.length < 4) {
    corners.push({ x: clamp01(p.x), y: clamp01(p.y) });
    dragIdx = corners.length - 1;
    els.hint.innerHTML = corners.length < 4 ? CALIB_STEPS[corners.length] : 'Drag any corner to adjust, then lift your finger.';
    drawLoupe(corners[dragIdx]);
  }
});

els.overlay.addEventListener('pointermove', e => {
  if (dragIdx < 0) return;
  e.preventDefault();
  const p = toVideo(e);
  const pts = calibrating ? corners : vision.table.corners;
  pts[dragIdx] = { x: clamp01(p.x), y: clamp01(p.y) };
  if (!calibrating) vision.setTable(vision.table.corners);
  drawLoupe(pts[dragIdx]);
});

const endDrag = () => {
  if (dragIdx < 0) return;
  dragIdx = -1;
  els.loupe.hidden = true;
  if (calibrating && corners.length === 4) finishCalibration();
  else if (!calibrating) log('table corner adjusted', 'info', 1);
};
els.overlay.addEventListener('pointerup', endDrag);
els.overlay.addEventListener('pointercancel', endDrag);

function drawLoupe(p) {
  const v = els.video;
  if (!v.videoWidth) return;
  const c = els.loupe, ctx = c.getContext('2d');
  const size = 112, zoom = 3.2;
  if (c.width !== size) { c.width = c.height = size; }
  const sw = size / zoom, sh = size / zoom;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(v, p.x * v.videoWidth - sw / 2, p.y * v.videoHeight - sh / 2, sw, sh, 0, 0, size, size);
  ctx.strokeStyle = '#ffdc50'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(size / 2, size / 2 - 12); ctx.lineTo(size / 2, size / 2 + 12);
  ctx.moveTo(size / 2 - 12, size / 2); ctx.lineTo(size / 2 + 12, size / 2);
  ctx.stroke();
  // Keep the loupe away from the finger: it swaps sides as you cross the middle.
  c.style.left = p.x < 0.5 ? 'auto' : '8px';
  c.style.right = p.x < 0.5 ? '8px' : 'auto';
  c.hidden = false;
}

const clamp01 = v => Math.min(1, Math.max(0, v));

// =========================================================================
// Start / stop
// =========================================================================

$('btnStart').addEventListener('click', async () => {
  if (started) return;
  $('btnStart').disabled = true;
  say('Asking for the camera and microphone…', 'info');

  try {
    await vision.start();
    els.cam.className = 'pill on';
  } catch (err) {
    els.cam.className = 'pill off';
    $('btnStart').disabled = false;
    return say(cameraHelp(err), 'fault');
  }
  try {
    await audio.start();
    els.mic.className = 'pill on';
    if (audio.mode === 'fallback') log('using the compatibility audio path (older browser)', 'info', 1);
  } catch (err) {
    els.mic.className = 'pill off';
    say(`No microphone: ${err.message}. Bounces can’t be heard — use the manual buttons.`, 'fault');
  }

  referee = new Referee(vision, audio, {
    firstServer: $('firstServer').value,
    gamePoints: +$('gamePoints').value,
    doubles: $('doubles').checked,
  });
  referee.onCall = onCall;
  referee.onEvent = onEvent;
  audio.onLevel = onLevel;

  started = true;
  $('btnFlip').hidden = !(await vision.hasMultipleCameras());
  setInterval(() => (els.fps.textContent = `${vision.fps} fps`), 500);
  beginCalibration();
});

function cameraHelp(err) {
  if (err.name === 'NotAllowedError')
    return 'Camera permission was refused. Allow it in the address bar (or in Settings → Safari → Camera) and tap Start again.';
  if (err.name === 'NotFoundError') return 'No camera found on this device.';
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname))
    return 'The camera only works over HTTPS. Open this page on an https:// address (or localhost).';
  return `Camera unavailable: ${err.name} — ${err.message}`;
}

$('btnCalibrate').addEventListener('click', beginCalibration);

$('btnRef').addEventListener('click', async () => {
  if (!referee) return;
  if (referee.active) {
    referee.stop();
    releaseWakeLock();
    $('btnRef').textContent = 'Resume';
    say('Paused.', 'info');
  } else {
    referee.start();
    requestWakeLock();
    $('btnRef').textContent = 'Pause';
    announce(`${referee.engine.server} to serve. Love all.`);
    say(`<b>${referee.engine.server} to serve.</b> Watching every play.`, 'info');
  }
});

$('btnFlip').addEventListener('click', async () => {
  if (!started) return;
  try {
    await vision.flipCamera();
    log(`switched to the ${vision.facing === 'user' ? 'front' : 'rear'} camera`, 'info', 1);
  } catch (err) { say(`Could not switch camera: ${err.message}`, 'fault'); }
});

// =========================================================================
// Phone housekeeping: fullscreen, wake lock, haptics
// =========================================================================

$('btnFull').addEventListener('click', async () => {
  const el = document.documentElement;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await el.requestFullscreen?.();
      // Android only; iOS rejects this and that is fine.
      await screen.orientation?.lock?.('landscape').catch(() => {});
    }
  } catch {
    say('Fullscreen isn’t available in this browser. Add Umpire to your home screen for the same effect.', 'info');
  }
});

let wakeLock = null;
async function requestWakeLock() {
  if (!$('wakeLock').checked || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => (wakeLock = null));
  } catch { /* denied or unsupported: the screen may dim, nothing else breaks */ }
}
function releaseWakeLock() { wakeLock?.release?.(); wakeLock = null; }

// A phone dropping into the background suspends audio and video. Pick the
// wake lock back up when it returns, and warn that play was not being watched.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (referee?.active) {
    await requestWakeLock();
    await audio.resume();
    say('Back — <b>play while the app was hidden was not judged.</b>', 'let');
  }
});

function buzz(pattern) {
  if ($('haptics').checked) navigator.vibrate?.(pattern);
}

function checkOrientation() {
  const portrait = innerHeight > innerWidth;
  els.rotate.hidden = !(portrait && started && innerWidth < 700);
}
addEventListener('resize', checkOrientation);
addEventListener('orientationchange', () => setTimeout(checkOrientation, 300));

// =========================================================================
// Calls
// =========================================================================

function onCall(call, state) {
  render(state);
  if (call.type === 'info') { log(call.reason, 'info', call.confidence); return; }

  const label = {
    point: `Point ${call.side} — ${call.reason}`,
    let: `Let — ${call.reason}`,
    game: call.reason,
    match: call.reason,
  }[call.type] || call.reason;
  const cls = call.type === 'let' ? 'let' : 'point';

  say(`<b>${label}</b>${call.confidence < 0.55 ? '<br><i>low confidence — check me</i>' : ''}`, cls);
  log(label, cls, call.confidence);
  buzz(call.type === 'match' ? [90, 60, 90, 60, 180] : call.type === 'game' ? [90, 60, 140] : 45);

  announce(call.type === 'point' ? `${label}. ${referee.engine.scoreCall()}` : label);
}

function onEvent(ev) {
  if (ev.kind === 'unattributed') log(ev.reason, 'info', 0);
  else if (ev.kind === 'bounce' || ev.kind === 'hit')
    log(`${ev.kind}${ev.side ? ` · ${ev.side} half` : ''}`, 'info', ev.confidence);
}

function onLevel(m) {
  els.level.style.width = Math.max(0, Math.min(100, (m.db + 70) * (100 / 70))) + '%';
  els.flux.style.width = Math.min(1, m.rms / (m.baseline * audio.settings.sensitivity + 1e-9)) * 100 + '%';
}

function render(state) {
  els.ptsA.textContent = state.score.A;
  els.ptsB.textContent = state.score.B;
  els.gamesA.textContent = state.games.A;
  els.gamesB.textContent = state.games.B;
  els.teamA.classList.toggle('serving', state.server === 'A');
  els.teamB.classList.toggle('serving', state.server === 'B');
}

function say(html, cls = 'info') {
  // Wrapped in one element: the banner is a flex container, and loose text
  // nodes beside a tag would each become a flex item, eating the space
  // between them ("A to serve.Watching every play.").
  els.call.innerHTML = `<span>${html}</span>`;
  els.call.className = `call ${cls}`;
}

function log(text, cls = 'info', confidence = 0) {
  const li = document.createElement('li');
  li.className = cls;
  const t = new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
  li.innerHTML = `<span class="t">${t}</span><span>${text}</span>` +
    (confidence ? `<span class="conf">${Math.round(confidence * 100)}%</span>` : '');
  els.log.prepend(li);
  while (els.log.children.length > 200) els.log.lastChild.remove();
}

function announce(text) {
  if (!$('speak').checked || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// =========================================================================
// Controls
// =========================================================================

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.tabpanel').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
}));

document.querySelectorAll('[data-award]').forEach(b => b.addEventListener('click', () => {
  if (!referee) return;
  referee.engine.award(b.dataset.award).forEach(c => onCall(c, referee.engine.state));
}));
$('btnLet').addEventListener('click', () => {
  if (!referee) return;
  referee.engine.callLet().forEach(c => onCall(c, referee.engine.state));
});
$('btnUndo').addEventListener('click', () => {
  if (!referee) return;
  if (referee.engine.undo()) { render(referee.engine.state); log('undo', 'info', 1); buzz(25); }
});
$('btnReset').addEventListener('click', () => {
  if (!referee) return;
  referee.engine.reset($('firstServer').value);
  render(referee.engine.state);
  say('Match reset.', 'info');
});
$('btnClearLog').addEventListener('click', () => (els.log.innerHTML = ''));
$('firstServer').addEventListener('change', e => {
  if (referee) { referee.engine.reset(e.target.value); render(referee.engine.state); }
});
$('gamePoints').addEventListener('change', e => {
  if (referee) { referee.engine.gamePoints = +e.target.value; render(referee.engine.state); }
});
$('doubles').addEventListener('change', e => { if (referee) referee.engine.doubles = e.target.checked; });
$('showDebug').addEventListener('change', e => (vision.showDebug = e.target.checked));
$('wakeLock').addEventListener('change', e => (e.target.checked ? requestWakeLock() : releaseWakeLock()));

bind('onsetSens', v => { audio.applySettings({ sensitivity: +v }); return v; });
bind('noiseGate', v => { audio.applySettings({ gateDb: +v }); return `${v} dB`; });
bind('motionThresh', v => { vision.motionThreshold = +v; return v; });
bind('outMargin', v => { vision.setOutMargin(+v / 100); return `${v}%`; });
bind('syncWin', v => { if (referee) referee.syncWindow = +v; return `${v} ms`; });

function bind(id, fn) {
  const el = $(id), out = $(id + 'Out');
  const apply = () => (out.textContent = fn(el.value));
  el.addEventListener('input', apply);
  apply();
}

// Hardware keyboard, for anyone running this on a laptop at the table.
addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'b') document.querySelector(`[data-award="${k.toUpperCase()}"]`).click();
  else if (k === 'l') $('btnLet').click();
  else if (k === 'u') $('btnUndo').click();
});

// =========================================================================
// Install to home screen + offline
// =========================================================================

let installPrompt = null;
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('installNote').hidden = false;
});
$('btnInstall').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('installNote').hidden = true;
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

render({ score: { A: 0, B: 0 }, games: { A: 0, B: 0 }, server: 'A' });
checkOrientation();
