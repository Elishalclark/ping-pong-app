// Sensor fusion: turn "a sound happened" plus "the ball was here" into the
// physical events the rules engine understands.
//
// Neither sensor is trusted alone. The microphone says WHEN contact happened
// and roughly what was struck; the camera says WHERE the ball was at that
// instant, which is what decides whose half it bounced on. A sound with no
// ball behind it is discarded rather than guessed at.

import { CONTACT } from './audio.js';
import { RulesEngine } from './rules.js';

const RALLY_TIMEOUT = 2600;  // ms of silence before a rally is written off
const OUT_TIMEOUT = 900;     // ms the ball may fly past the table before it's out

export class Referee {
  constructor(vision, audio, opts = {}) {
    this.vision = vision;
    this.audio = audio;
    this.engine = new RulesEngine(opts);
    this.syncWindow = 120;
    this.active = false;
    this.onCall = () => {};
    this.onEvent = () => {};

    this._lastEventAt = 0;
    this._lastContactSide = null;
    this._pendingOut = null;

    this.audio.onOnset = o => this.handleOnset(o);
    this.vision.onLost = last => this.handleLost(last);
    this.vision.onBallOut = info => this.handleBallOut(info);
    this._tick = setInterval(() => this._housekeeping(), 120);
  }

  destroy() { clearInterval(this._tick); }

  start() {
    this.active = true;
    this._lastEventAt = performance.now();
    this._emit({ type: 'serve-start', t: performance.now() });
  }
  stop() { this.active = false; }

  handleOnset(o) {
    if (!this.active) return;
    const pos = this.vision.positionAt(o.wallTime, this.syncWindow);

    if (!pos) {
      // Heard something, can't see the ball: not a call, just a note.
      this.onEvent({ kind: 'unattributed', reason: `sound (${o.contact}) with no ball in view`, confidence: 0 });
      return;
    }

    const onTable = this.vision.isOnTable(pos);
    const side = this.vision.sideOf(pos);
    const nearNet = this._nearNet(pos);
    // Freshness of the visual match: a 10 ms gap is a solid pairing, 120 ms is a guess.
    const sync = 1 - Math.min(1, pos.dt / this.syncWindow);
    const confidence = round2(o.confidence * (0.55 + 0.45 * sync));

    if (nearNet && (o.contact === CONTACT.NET || o.contact === CONTACT.OTHER)) {
      this._emit({ type: 'net', t: o.wallTime, confidence });
      return;
    }

    if (onTable && o.contact !== CONTACT.PADDLE) {
      this._pendingOut = null;
      this._emit({ type: 'bounce', side, t: o.wallTime, confidence });
      return;
    }

    if (!this.vision.isInsideBoundary(pos)) {
      // A noise from the ball out beyond the boundary is it hitting the floor
      // or a wall — never a stroke, since nobody plays from out there.
      this._pendingOut = null;
      this._emit({ type: 'out', t: o.wallTime, confidence });
      return;
    }

    if (!onTable || o.contact === CONTACT.PADDLE) {
      // Contact off the surface is a stroke; the half the ball is over tells
      // us who played it.
      this._pendingOut = null;
      this._lastContactSide = side;
      this._emit({ type: 'hit', side, t: o.wallTime, confidence: round2(confidence * 0.9) });
    }
  }

  /**
   * The tracker watched the ball cross the out-of-bounds line and keep going.
   * This is a far better signal than waiting for the ball to disappear: it is
   * immediate, and it says the ball actually left rather than that the
   * tracker gave up.
   */
  handleBallOut(info) {
    if (!this.active || !this.engine.rally) return;
    this._pendingOut = null;
    this._emit({ type: 'out', t: info.t, confidence: 0.8 });
  }

  handleLost(last) {
    if (!this.active || !this.engine.rally) return;
    // The ball vanished. If it was last seen clear of the table and travelling
    // away from it, that is a ball out of play — but wait a beat first, since
    // the tracker also drops the ball behind a player's arm.
    const out = this.vision.outByFraction(last);
    if (out > 0.06) this._pendingOut = { t: performance.now(), last };
  }

  _housekeeping() {
    if (!this.active) return;
    const now = performance.now();

    if (this._pendingOut && now - this._pendingOut.t > OUT_TIMEOUT) {
      const p = this._pendingOut;
      this._pendingOut = null;
      if (!this.vision.track) this._emit({ type: 'out', t: p.t, confidence: 0.6 });
    }

    if (this.engine.rally && now - this._lastEventAt > RALLY_TIMEOUT) {
      this._emit({ type: 'dead', t: now, confidence: 0 });
    }
  }

  _emit(ev) {
    this._lastEventAt = performance.now();

    // A stroke while nobody is serving means a new rally has begun.
    if (ev.type === 'hit' && this.engine.phase === 'awaiting-serve') {
      this.engine.feed({ type: 'serve-start', t: ev.t });
    }
    const calls = this.engine.feed(ev);
    this.onEvent({ kind: ev.type, side: ev.side, confidence: ev.confidence ?? 0 });
    for (const c of calls) this.onCall(c, this.engine.state);
    return calls;
  }

  _nearNet(p) {
    const table = this.vision.table;
    if (!table) return false;
    const [a, b] = table.net;
    const len = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
    return d < 0.035;
  }
}

const round2 = v => Math.round(v * 100) / 100;
