import { VisionReferee } from './vision.js';
import { AudioReferee } from './audio.js';
import { Referee } from './referee.js';

const $ = id => document.getElementById(id);
const els = {
  video: $('video'), overlay: $('overlay'), loupe: $('loupe'), hint: $('calibHint'),
  rotate: $('rotateHint'), cam: $('camStatus'), mic: $('micStatus'), fps: $('fpsStatus'),
  ptsA: $('ptsA'), ptsB: $('ptsB'), gamesA: $('gamesA'), gamesB: $('gamesB'),
  faultsA: $('faultsA'), faultsB: $('faultsB'),
  teamA: $('teamA'), teamB: $('teamB'), call: $('callBanner'),
  callText: $('callText'), callScore: $('callScore'), log: $('log'),
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

// The box starts as a sensible shape in the middle of the view; you drag it
// onto the table rather than trying to hit four corners with a fingertip in a
// prescribed order. Whole-box drag for position, corner drag for shape.
const DEFAULT_BOX = [
  { x: 0.22, y: 0.72 },   // A end, near the camera
  { x: 0.32, y: 0.42 },   // A end, far
  { x: 0.68, y: 0.42 },   // B end, far
  { x: 0.78, y: 0.72 },   // B end, near
];
const HANDLE_R = 0.05;    // grab radius for a corner, as a fraction of width
let calibrating = false;
let dragIdx = -1;         // corner being dragged
let dragBox = null;       // whole-box drag origin

function beginCalibration() {
  if (!started) return say('Tap <b>Start</b> first.', 'fault');
  calibrating = true;
  dragIdx = -1;
  dragBox = null;
  if (!vision.table) vision.setTable(DEFAULT_BOX.map(c => ({ ...c })));
  els.hint.hidden = false;
  $('btnRef').disabled = true;
  els.overlay.classList.add('calibrating');
  say('Place the box over the playing surface — drag the middle to move it, a corner to reshape it.', 'info');
}

function finishCalibration() {
  // Whatever is in front of the camera now becomes the reference frame. If
  // the players are already standing there it self-corrects within a second
  // or two, and if the table is empty it starts perfectly.
  vision.captureBackground();
  calibrating = false;
  els.hint.hidden = true;
  els.overlay.classList.remove('calibrating');
  $('btnRef').disabled = false;
  say('Table set. Tap <b>Begin</b> when the players are ready.', 'info');
  log('table box placed', 'info', 1);
}

$('btnScan').addEventListener('click', () => runScan());

// Tap the table in the picture to scan from that exact point.
function scanAt(pt) { runScan(pt); }

function runScan(seed) {
  const hint = $('calibText');
  flash();
  buzz(30);
  let found = null;
  try {
    found = vision.scanTable(seed);
  } catch (err) {
    hint.innerHTML = `Couldn’t read the camera (${err.name || 'error'}). Drag the box onto the table by hand instead.`;
    log('scan error: ' + (err.message || err), 'info', 0);
    return;
  }
  if (!found) {
    hint.innerHTML = seed
      ? 'That spot didn’t look like the table. Tap right on the playing surface, or drag the box on by hand.'
      : 'Couldn’t find the table automatically. <b>Tap the table</b> in the picture, or drag the box on by hand.';
    log('table scan found nothing', 'info', 0);
    return;
  }
  // The photo is the table with nobody playing on it, which is exactly the
  // reference the tracker wants for spotting the ball later.
  vision.captureBackground();
  hint.innerHTML = 'Got it. Check the box sits on the table — drag a corner to fix it, <b>Swap ends</b> if A and B are reversed — then <b>Use this box</b>.';
  log(`table found — ${Math.round(found.coverage * 100)}% of the view`, 'info', 1);
}

function flash() {
  const f = $('flash');
  f.hidden = false;
  // Restart the animation each time by forcing a reflow.
  f.style.animation = 'none'; void f.offsetWidth; f.style.animation = '';
  setTimeout(() => { f.hidden = true; }, 460);
}

$('btnCalibDone').addEventListener('click', finishCalibration);
$('btnSwapEnds').addEventListener('click', () => {
  vision.swapEnds();
  render(referee ? referee.engine.state : { score: { A: 0, B: 0 }, games: { A: 0, B: 0 }, server: 'A' });
  log('ends swapped', 'info', 1);
});

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

let downAt = null, moved = false;
els.overlay.addEventListener('pointerdown', e => {
  if (!vision.table) return;
  const p = toVideo(e);
  if (p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05) return;
  els.overlay.setPointerCapture(e.pointerId);
  downAt = { ...p };
  moved = false;

  // A corner wins over the box: the handles sit on the box's own edge, and
  // reshaping is the finer of the two gestures.
  const near = vision.table.corners.findIndex(
    c => Math.hypot(c.x - p.x, (c.y - p.y) * 0.75) < HANDLE_R);
  if (near >= 0) { dragIdx = near; drawLoupe(vision.table.corners[near]); return; }
  if (calibrating && vision.isInsideTable(p)) dragBox = { ...p };
});

els.overlay.addEventListener('pointermove', e => {
  if (downAt) {
    const p0 = toVideo(e);
    if (Math.hypot(p0.x - downAt.x, p0.y - downAt.y) > 0.02) moved = true;
  }
  if (dragIdx < 0 && !dragBox) return;
  e.preventDefault();
  const p = toVideo(e);
  if (dragIdx >= 0) {
    const corners = vision.table.corners.map((c, i) =>
      i === dragIdx ? { x: clamp01(p.x), y: clamp01(p.y) } : c);
    vision.setTable(corners);
    drawLoupe(corners[dragIdx]);
  } else {
    vision.moveTable(p.x - dragBox.x, p.y - dragBox.y);
    dragBox = { ...p };
  }
});

const endDrag = e => {
  // A one-shot ball-colour sample: consumes this tap wherever it lands.
  if (sampling && downAt && !moved) {
    sampling = false;
    const c = vision.sampleBallColorAt(downAt.x, downAt.y);
    setBallColorUI(null);   // now a custom sampled colour
    downAt = null; els.loupe.hidden = true;
    if (c) { say(`Ball colour sampled. Now tracking that colour.`, 'info'); log('ball colour sampled', 'info', 1); buzz(20); }
    return;
  }
  const wasCorner = dragIdx >= 0;
  const wasDraggingBox = !!dragBox;
  const tapPoint = downAt;
  const wasTap = !moved;
  dragIdx = -1;
  dragBox = null;
  downAt = null;
  els.loupe.hidden = true;
  if (!calibrating && wasCorner) { log('table corner adjusted', 'info', 1); return; }
  // A tap on the table during calibration — not a corner, not a drag — seeds
  // the scan there. This is the reliable path: the person points at the table
  // instead of the app guessing where it is.
  if (calibrating && wasTap && !wasCorner && tapPoint) scanAt(tapPoint);
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
  primeSpeech();
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

  // If the camera drops (some phones reclaim it when the app speaks), the
  // tracker re-acquires it automatically; keep the player informed meanwhile.
  vision.onCameraLost = () => {
    els.cam.className = 'pill off';
    say('Camera interrupted — bringing it back…', 'fault');
  };
  vision.onCameraBack = () => {
    els.cam.className = 'pill on';
    say('Camera back.', 'info');
  };

  started = true;
  $('btnFlip').hidden = !(await vision.hasMultipleCameras());
  clearInterval(window.__statusTimer);
  window.__statusTimer = setInterval(() => {
    els.fps.textContent = `${vision.fps} fps`;
    const ball = $('ballStatus');
    if (vision.tracking) {
      ball.hidden = false;
      const locked = vision.isLocked;
      ball.className = 'pill ' + (locked ? 'locked' : 'searching');
      ball.textContent = locked ? 'ball ●' : 'ball …';
    } else {
      ball.hidden = true;
    }
  }, 250);
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
    vision.setTracking(false);
    releaseWakeLock();
    $('btnRef').textContent = 'Resume';
    say('Paused.', 'info');
  } else {
    primeSpeech();
    vision.setTracking(true);
    referee.start();
    requestWakeLock();
    $('btnRef').textContent = 'Pause';
    announce(`Play. ${referee.engine.spokenScore()}`);
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

  const isFault = call.kind === 'fault';
  const onService = call.reason.startsWith('service') || call.reason === 'served out of turn';
  const label = {
    point: isFault
      ? `Fault, ${call.offender} — ${call.reason}. Point ${call.side}`
      : `Point ${call.side} — ${call.reason}`,
    let: `Let — ${call.reason}`,
    game: call.reason,
    match: call.reason,
  }[call.type] || call.reason;
  const cls = call.type === 'let' ? 'let' : isFault ? 'fault' : 'point';

  say(`<b>${label}</b>${call.confidence < 0.55 ? '<br><i>low confidence — check me</i>' : ''}`, cls);
  log(label, cls, call.confidence);
  buzz(call.type === 'match' ? [90, 60, 90, 60, 180] : call.type === 'game' ? [90, 60, 140] : 45);

  // Every rally ends with the score, on screen and out loud — that is what an
  // umpire is for. A fault or a let on the service is named as such first, so
  // the players know why the rally stopped before they hear the number.
  showScore();
  const score = referee.engine.spokenScore();
  if (call.type === 'match') announce(`Game and match to ${call.side}.`);
  else if (call.type === 'game') announce(`Game to ${call.side}. ${score}`);
  else if (call.type === 'let') announce(`Let${onService ? ' on the service' : ''}. Serve again. ${score}`);
  else if (isFault) announce(`Fault${onService ? ' on the service' : ''}, ${call.offender}. Point ${call.side}. ${score}`);
  else announce(`Point ${call.side}. ${score}`);
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
  const faults = state.faults ?? { A: 0, B: 0 };
  els.faultsA.textContent = faults.A;
  els.faultsB.textContent = faults.B;
  els.faultsA.classList.toggle('some', faults.A > 0);
  els.faultsB.classList.toggle('some', faults.B > 0);
  els.teamA.classList.toggle('serving', state.server === 'A');
  els.teamB.classList.toggle('serving', state.server === 'B');
}

function say(html, cls = 'info') {
  els.callText.innerHTML = html;
  els.call.className = `call ${cls}`;
}

/** Put the score on the banner, as the umpire has just called it. */
function showScore() {
  if (!referee) return;
  const { A, B, server, matchOver } = referee.engine.scoreParts();
  els.callScore.innerHTML = matchOver
    ? '<span class="srv">match over</span>'
    : `${A}–${B}<span class="srv">${server} to serve</span>`;
  els.callScore.hidden = false;
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

let speechReady = false;

/**
 * iOS refuses to speak unless speech has been started from a user gesture at
 * least once, so the first tap primes it with an empty utterance.
 */
function primeSpeech() {
  if (speechReady || !window.speechSynthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
    speechReady = true;
  } catch { /* no speech on this browser; calls still show on screen */ }
}

function announce(text) {
  if (!$('speak').checked || !window.speechSynthesis) return;
  try {
    _announce(text);
  } catch { /* a speech failure must never interrupt the match */ }
}

function _announce(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  u.pitch = 1;
  // Go deaf while talking, and for a moment after: the microphone is live and
  // would otherwise hear the umpire as a bounce.
  u.onstart = () => { if (referee) referee.deafUntil = Infinity; };
  const listenAgain = () => {
    if (referee) referee.deafUntil = performance.now() + 250;
  };
  u.onend = listenAgain;
  u.onerror = listenAgain;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  // If speech never starts (a muted phone, a browser that drops it), don't
  // leave the referee deaf for the rest of the match.
  setTimeout(() => { if (referee && referee.deafUntil === Infinity) listenAgain(); }, 4000);
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
$('btnFault').addEventListener('click', () => {
  if (!referee) return;
  // A fault is always the server's, so there is nothing to choose.
  const server = referee.engine.server;
  referee.engine.award(other(server), 'service fault called by the umpire', 'fault')
    .forEach(c => onCall(c, referee.engine.state));
});
const other = s => (s === 'A' ? 'B' : 'A');

$('btnUndo').addEventListener('click', () => {
  if (!referee) return;
  if (referee.engine.undo()) { render(referee.engine.state); log('undo', 'info', 1); buzz(25); }
});
$('btnReset').addEventListener('click', () => {
  if (!referee) return;
  referee.engine.reset($('firstServer').value);
  render(referee.engine.state);
  say('Match reset.', 'info');
  showScore();
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

// --- ball colour: the tracker follows this colour and rejects everything else
function setBallColorUI(mode) {
  if (mode === 'white' || mode === 'orange') vision.setBallColor(mode);
  $('ballWhite').classList.toggle('seg-on', mode === 'white');
  $('ballOrange').classList.toggle('seg-on', mode === 'orange');
}
$('ballWhite').addEventListener('click', () => { setBallColorUI('white'); log('ball colour: white', 'info', 1); });
$('ballOrange').addEventListener('click', () => { setBallColorUI('orange'); log('ball colour: orange', 'info', 1); });

// Arm a one-shot: the next tap on the video samples the ball's colour there.
let sampling = false;
$('ballSample').addEventListener('click', () => {
  if (!started) return say('Tap <b>Start</b> first.', 'fault');
  sampling = true;
  say('Hold the ball still on the table and <b>tap it</b> in the picture.', 'info');
});
$('wakeLock').addEventListener('change', e => (e.target.checked ? requestWakeLock() : releaseWakeLock()));

bind('onsetSens', v => { audio.applySettings({ sensitivity: +v }); return v; });
bind('noiseGate', v => { audio.applySettings({ gateDb: +v }); return `${v} dB`; });
bind('strictness', v => { vision.setStrictness(+v / 100); return `${v}%`; });
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

// A handle on the working parts, for debugging on a device where there is no
// console to hand and for driving the app from tests.
window.umpire = { get vision() { return vision; }, get audio() { return audio; }, get referee() { return referee; } };

render({ score: { A: 0, B: 0 }, games: { A: 0, B: 0 }, server: 'A' });
checkOrientation();
