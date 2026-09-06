import { VisionReferee } from './vision.js';
import { AudioReferee } from './audio.js';
import { Referee } from './referee.js';

const $ = id => document.getElementById(id);
const els = {
  video: $('video'), overlay: $('overlay'), wrap: $('videoWrap'), hint: $('calibHint'),
  cam: $('camStatus'), mic: $('micStatus'), fps: $('fpsStatus'),
  ptsA: $('ptsA'), ptsB: $('ptsB'), gamesA: $('gamesA'), gamesB: $('gamesB'),
  teamA: $('teamA'), teamB: $('teamB'), call: $('callBanner'), log: $('log'),
  level: $('levelBar'), flux: $('fluxBar'),
};

const vision = new VisionReferee(els.video, els.overlay);
const audio = new AudioReferee();
let referee = null;
let started = false;

// --- calibration ---------------------------------------------------------

const CALIB_STEPS = [
  'Click the corner of the table at <b>Player A’s end, nearest the camera</b>.',
  'Now the <b>far corner at Player A’s end</b>.',
  'Now the <b>far corner at Player B’s end</b>.',
  'Finally the <b>corner at Player B’s end nearest the camera</b>.',
];
let calibrating = false;
let corners = [];

function beginCalibration() {
  if (!started) return say('Start the camera first.', 'fault');
  calibrating = true;
  corners = [];
  els.hint.hidden = false;
  els.hint.innerHTML = CALIB_STEPS[0];
  vision.table = null;
}

els.overlay.addEventListener('click', e => {
  if (!calibrating) return;
  const r = els.overlay.getBoundingClientRect();
  // The canvas is letterboxed inside its box by object-fit: contain — map the
  // click back through that fit or every corner lands slightly off.
  const scale = Math.min(r.width / els.overlay.width, r.height / els.overlay.height);
  const dw = els.overlay.width * scale, dh = els.overlay.height * scale;
  const x = (e.clientX - r.left - (r.width - dw) / 2) / dw;
  const y = (e.clientY - r.top - (r.height - dh) / 2) / dh;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  corners.push({ x, y });
  if (corners.length < 4) {
    els.hint.innerHTML = CALIB_STEPS[corners.length];
    vision.table = null;
    drawPending();
    return;
  }
  vision.setTable(corners);
  calibrating = false;
  els.hint.hidden = true;
  $('btnRef').disabled = false;
  say('Table set. Press <b>Begin match</b> when the players are ready.', 'info');
  log('table calibrated', 'info', 1);
});

function drawPending() {
  const ctx = els.overlay.getContext('2d');
  const W = els.overlay.width, H = els.overlay.height;
  ctx.fillStyle = '#4aa3ff';
  for (const c of corners) { ctx.beginPath(); ctx.arc(c.x * W, c.y * H, 5, 0, 6.29); ctx.fill(); }
}

// --- start / stop --------------------------------------------------------

$('btnStart').addEventListener('click', async () => {
  if (started) return;
  try {
    await vision.start();
    els.cam.className = 'pill on';
  } catch (err) {
    els.cam.className = 'pill off';
    return say(`Camera unavailable: ${err.message}`, 'fault');
  }
  try {
    await audio.start();
    els.mic.className = 'pill on';
  } catch (err) {
    els.mic.className = 'pill off';
    say(`Microphone unavailable: ${err.message}. Calls will be visual only.`, 'fault');
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
  $('btnStart').disabled = true;
  say('Now calibrate the table so the referee knows which half is which.', 'info');
  beginCalibration();
  setInterval(() => { els.fps.textContent = `${vision.fps} fps`; }, 500);
});

$('btnCalibrate').addEventListener('click', beginCalibration);

$('btnRef').addEventListener('click', () => {
  if (!referee) return;
  if (referee.active) {
    referee.stop();
    $('btnRef').textContent = 'Resume match';
    say('Paused.', 'info');
  } else {
    referee.start();
    $('btnRef').textContent = 'Pause match';
    announce(`${referee.engine.server} to serve. Love all.`);
    say(`<b>${referee.engine.server} to serve.</b> Watching every play.`, 'info');
  }
});

// --- calls ---------------------------------------------------------------

function onCall(call, state) {
  render(state);
  if (call.type === 'info') { log(call.reason, 'info', call.confidence); return; }

  const label = {
    point: `Point ${call.side} — ${call.reason}`,
    let: `Let — ${call.reason}`,
    game: call.reason,
    match: call.reason,
  }[call.type] || call.reason;

  const cls = call.type === 'point' ? 'point' : call.type === 'let' ? 'let' : 'point';
  say(`<b>${label}</b>${call.confidence < 0.55 ? ' <i>(low confidence — check me)</i>' : ''}`, cls);
  log(label, cls, call.confidence);

  if (call.type === 'point') announce(`${label}. ${referee.engine.scoreCall()}`);
  else announce(label);
}

function onEvent(ev) {
  if (ev.kind === 'unattributed') log(ev.reason, 'info', 0);
  else if (ev.kind === 'bounce' || ev.kind === 'hit')
    log(`${ev.kind}${ev.side ? ` · ${ev.side} half` : ''}`, 'info', ev.confidence);
}

function onLevel(m) {
  const pct = Math.max(0, Math.min(100, (m.db + 70) * (100 / 70)));
  els.level.style.width = pct + '%';
  const ratio = Math.min(1, m.rms / (m.baseline * audio.settings.sensitivity + 1e-9));
  els.flux.style.width = ratio * 100 + '%';
}

function render(state) {
  els.ptsA.textContent = state.score.A;
  els.ptsB.textContent = state.score.B;
  els.gamesA.textContent = `games ${state.games.A}`;
  els.gamesB.textContent = `games ${state.games.B}`;
  els.teamA.classList.toggle('serving', state.server === 'A');
  els.teamB.classList.toggle('serving', state.server === 'B');
}

function say(html, cls = 'info') {
  els.call.innerHTML = html;
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

// --- manual override -----------------------------------------------------

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
  if (referee.engine.undo()) { render(referee.engine.state); log('undo', 'info', 1); }
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

// --- settings ------------------------------------------------------------

bind('onsetSens', v => { audio.applySettings({ sensitivity: +v }); return v; });
bind('noiseGate', v => { audio.applySettings({ gateDb: +v }); return `${v} dB`; });
bind('motionThresh', v => { vision.motionThreshold = +v; return v; });
bind('syncWin', v => { if (referee) referee.syncWindow = +v; return `${v} ms`; });
$('showDebug').addEventListener('change', e => (vision.showDebug = e.target.checked));

function bind(id, fn) {
  const el = $(id), out = $(id + 'Out');
  const apply = () => (out.textContent = fn(el.value));
  el.addEventListener('input', apply);
  apply();
}

// Keyboard shortcuts for whoever is standing at the table.
addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'b') document.querySelector(`[data-award="${k.toUpperCase()}"]`).click();
  else if (k === 'l') $('btnLet').click();
  else if (k === 'u') $('btnUndo').click();
});

render({ score: { A: 0, B: 0 }, games: { A: 0, B: 0 }, server: 'A' });
