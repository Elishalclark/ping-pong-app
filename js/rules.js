// ITTF-style match state machine.
//
// The engine consumes low-level physical events (a paddle contact, a bounce on
// one half of the table, a net touch, the ball leaving play) and turns them
// into rulings. It knows nothing about cameras or microphones — everything it
// needs arrives through feed().

export const SIDE = { A: 'A', B: 'B' };
export const other = s => (s === 'A' ? 'B' : 'A');

export class RulesEngine {
  constructor(opts = {}) {
    this.gamePoints = opts.gamePoints ?? 11;
    this.bestOf = opts.bestOf ?? 5;
    this.doubles = opts.doubles ?? false;
    this.reset(opts.firstServer ?? SIDE.A);
  }

  reset(firstServer = this.firstServer ?? SIDE.A) {
    this.firstServer = firstServer;
    this.score = { A: 0, B: 0 };
    this.games = { A: 0, B: 0 };
    // Service faults, counted against the player who committed them. They are
    // not a separate scoring mechanism — a fault costs the point outright —
    // but an umpire distinguishes one from a rally lost in play, and so do we.
    this.faults = { A: 0, B: 0 };
    this.server = firstServer;
    this.phase = 'awaiting-serve';
    this.rally = null;
    this.history = [];
    this.matchOver = false;
    // Set only when a rally was written off by _onDead — the ball went quiet
    // or out of camera view and nothing conclusive was ever heard again, not
    // an actual point being decided. See _onHit for why this matters.
    this._ambiguousResume = false;
  }

  get state() {
    return {
      score: { ...this.score },
      games: { ...this.games },
      faults: { ...this.faults },
      server: this.server,
      phase: this.phase,
      matchOver: this.matchOver,
      gamePoints: this.gamePoints,
    };
  }

  // --- rally bookkeeping -------------------------------------------------

  beginRally(t = performance.now()) {
    this.phase = 'serve';
    this.rally = {
      start: t,
      lastHitter: null,
      // bounces since the most recent paddle contact
      bouncesSinceHit: [],
      serveBounces: [],
      netTouched: false,
      strokes: 0,
    };
  }

  /**
   * Feed one detected event. Returns an array of calls:
   *   { type:'point'|'let'|'info'|'game'|'match', side?, reason, confidence }
   */
  feed(ev) {
    if (this.matchOver) return [];
    if (!this.rally && ev.type !== 'serve-start') return [];

    switch (ev.type) {
      case 'serve-start': this.beginRally(ev.t); return [{ type: 'info', reason: `${this.server} to serve`, confidence: 1 }];
      case 'hit':         return this._onHit(ev);
      case 'bounce':      return this._onBounce(ev);
      case 'net':         return this._onNet(ev);
      case 'out':         return this._onOut(ev);
      case 'dead':        return this._onDead(ev);
      default:            return [];
    }
  }

  _onHit(ev) {
    const r = this.rally;
    const side = ev.side;

    if (this.phase === 'serve' && r.strokes === 0) {
      // The service stroke itself. Server must be the one striking it — UNLESS
      // this rally only exists because Referee synthesises a serve-start the
      // moment a stroke arrives with nobody serving (see referee.js._emit).
      // That synthetic restart fires just as readily when the ball simply
      // went quiet or out of camera view for a few seconds mid-rally as it
      // does at a genuine new point: there is no way to tell those apart from
      // here. Faulting whoever happened to be hitting the ball when tracking
      // resumed — often the very player who did nothing wrong — is worse
      // than not enforcing serve turn for that one ambiguous stroke.
      r.strokes = 1;
      r.lastHitter = side;
      r.bouncesSinceHit = [];
      const ambiguous = this._ambiguousResume;
      this._ambiguousResume = false;
      if (side !== this.server && !ambiguous) {
        return this._point(other(side), 'served out of turn', ev.confidence, 'fault');
      }
      return [{ type: 'info', reason: ambiguous ? 'play resumed after a gap' : 'service struck', confidence: ev.confidence }];
    }

    // A return: the ball must have bounced exactly once, on the striker's own
    // half, before they hit it.
    const bounces = r.bouncesSinceHit;
    if (side === r.lastHitter) {
      return this._point(other(side), 'struck the ball twice', ev.confidence);
    }
    // The receiver's first stroke against a serve needs its own check before
    // the generic ones below. During the serve, _onBounce deliberately
    // overwrites bouncesSinceHit to hold just the MOST RECENT bounce, so a
    // legal serve — one bounce on the server's own half, then one on the
    // receiver's — isn't miscounted as two bounces the receiver has to
    // answer for. But that compression has a blind spot: a bounce on the
    // server's own half alone also leaves bouncesSinceHit as one element,
    // identical to a legal bounce actually on the receiver's half. Read from
    // serveBounces (which is never overwritten) instead: fewer than two
    // means the serve hasn't reached the receiver's side yet at all, so
    // returning it now — even though "one bounce" is on record — is really
    // volleying the serve out of the air.
    if (this.phase === 'serve' && r.strokes === 1 && r.serveBounces.length < 2) {
      return this._point(other(side), 'returned the serve before it bounced on their side', ev.confidence);
    }
    if (bounces.length === 0) {
      // Volley — obstructing the ball before it bounced on your own half.
      return this._point(other(side), 'volleyed the ball', ev.confidence);
    }
    if (bounces.length > 1) {
      return this._point(other(side), 'ball bounced twice', ev.confidence);
    }

    r.strokes += 1;
    r.lastHitter = side;
    r.bouncesSinceHit = [];
    if (this.phase === 'serve' && r.strokes === 2) this.phase = 'rally';
    return [{ type: 'info', reason: 'return', confidence: ev.confidence }];
  }

  _onBounce(ev) {
    const r = this.rally;
    const side = ev.side;

    // --- service: own half, then receiver's half ---
    if (this.phase === 'serve' && r.strokes === 1) {
      r.serveBounces.push(side);
      // Only the most recent bounce matters to the receiver's stroke: the
      // server's own half bouncing first is part of a legal service, not a
      // double bounce the receiver has to answer for.
      r.bouncesSinceHit = [side];

      if (r.serveBounces.length === 1) {
        if (side !== this.server) {
          return this._point(other(this.server), 'service missed the server’s half', ev.confidence, 'fault');
        }
        return [{ type: 'info', reason: 'service bounce, own half', confidence: ev.confidence }];
      }

      if (r.serveBounces.length === 2) {
        if (side === this.server) {
          return this._point(other(this.server), 'service bounced twice on the server’s half', ev.confidence, 'fault');
        }
        if (r.netTouched) {
          r.netTouched = false;
          return this._let('service touched the net and landed good', ev.confidence);
        }
        return [{ type: 'info', reason: 'service good', confidence: ev.confidence }];
      }
    }

    // --- rally ---
    r.bouncesSinceHit.push(side);

    if (r.lastHitter && side === r.lastHitter) {
      // The ball came back down on the hitter's own half: it never crossed.
      return this._point(other(r.lastHitter), 'ball did not cross to the far half', ev.confidence);
    }
    if (r.bouncesSinceHit.length >= 2) {
      // Two bounces on the receiver's half — they failed to return it.
      return this._point(r.lastHitter, 'failed to return the ball', ev.confidence);
    }
    if (!r.lastHitter) {
      // Bounces heard before any stroke was: the microphone caught the ball
      // on the table but missed the racket. Nothing can be attributed.
      return [{ type: 'info', reason: `bounce, ${side} half — no stroke heard yet`, confidence: 0 }];
    }
    return [{ type: 'info', reason: `bounce, ${side} half`, confidence: ev.confidence }];
  }

  _onNet(ev) {
    const r = this.rally;
    r.netTouched = true;
    if (this.phase === 'serve' && r.strokes === 1) {
      // Ruling deferred: a net-cord serve is a let only if it still lands good.
      return [{ type: 'info', reason: 'service clipped the net', confidence: ev.confidence }];
    }
    return [{ type: 'info', reason: 'net touch', confidence: ev.confidence }];
  }

  _onOut(ev) {
    const r = this.rally;
    if (!r.lastHitter) return [];
    if (this.phase === 'serve' && r.strokes === 1 && r.netTouched && r.serveBounces.length < 2) {
      return this._point(other(this.server), 'service into the net', ev.confidence, 'fault');
    }
    // Who a ball leaving play belongs to depends entirely on whether it had
    // already landed. If it bounced on the far half first, the striker did
    // everything asked of them and it is the receiver who let it go by;
    // only a ball that never landed is the striker's mistake.
    // On the service stroke, any of these is a service fault rather than a
    // rally lost: the ball never became live.
    const serving = this.phase === 'serve' && r.strokes === 1;
    const firstBounce = r.bouncesSinceHit[0];
    if (firstBounce && firstBounce !== r.lastHitter) {
      // It landed on the far half, so the stroke was good and the receiver
      // simply let it go by.
      return this._point(r.lastHitter, 'ball went past without a return', ev.confidence);
    }
    if (firstBounce === r.lastHitter) {
      // It touched the table on the striker's own half and then left play
      // without ever reaching the other side.
      return this._point(other(r.lastHitter),
        serving ? 'service went out without reaching the far half' : 'bounced on their own half and went out',
        ev.confidence, serving ? 'fault' : 'rally');
    }
    return this._point(other(r.lastHitter),
      serving ? 'service went out' : 'ball out without touching the table',
      ev.confidence, serving ? 'fault' : 'rally');
  }

  // Rally fizzled out with nothing conclusive (ball lost, play stopped).
  _onDead(ev) {
    this.phase = 'awaiting-serve';
    this.rally = null;
    // Unlike a scored point, this doesn't mean play actually stopped — the
    // ball may simply have gone quiet or out of view for a few seconds while
    // the point continued. See _onHit for what this protects against.
    this._ambiguousResume = true;
    return [{ type: 'info', reason: 'rally ended, no call', confidence: ev.confidence ?? 0 }];
  }

  // --- outcomes ----------------------------------------------------------

  _let(reason, confidence = 1) {
    this.phase = 'awaiting-serve';
    this.rally = null;
    // A let is a real, well-understood outcome — nothing ambiguous about who
    // serves next — unlike the silent timeout _onDead sets this flag for.
    this._ambiguousResume = false;
    this.history.push({ kind: 'let', reason });
    return [{ type: 'let', reason, confidence }];
  }

  _point(side, reason, confidence = 1, kind = 'rally') {
    // Never score for nobody. If a call cannot be attributed to a player, the
    // honest outcome is no call — silently incrementing an undefined side
    // corrupts the match and shows the umpire "Point null".
    if (side !== SIDE.A && side !== SIDE.B) {
      this.phase = 'awaiting-serve';
      this.rally = null;
      return [{ type: 'info', reason: `${reason}, but it could not be attributed — no call`, confidence: 0 }];
    }
    const offender = kind === 'fault' ? other(side) : null;
    this.history.push({
      kind: 'point', side, reason,
      score: { ...this.score }, games: { ...this.games },
      faults: { ...this.faults }, server: this.server,
    });
    this.score[side] += 1;
    if (offender) this.faults[offender] += 1;
    this.phase = 'awaiting-serve';
    this.rally = null;
    // A real, decided point — same reasoning as _let above.
    this._ambiguousResume = false;

    const calls = [{ type: 'point', side, reason, confidence, kind, offender }];
    const g = this._checkGame();
    if (g) calls.push(...g);
    else this._updateServer();
    return calls;
  }

  // Public entry for a human overriding the machine.
  award(side, reason = 'umpire call', kind = 'rally') {
    return this._point(side, reason, 1, kind);
  }
  callLet(reason = 'umpire call') {
    return this._let(reason, 1);
  }

  undo() {
    const last = this.history.pop();
    if (!last) return false;
    if (last.kind === 'point') {
      this.score = { ...last.score };
      this.games = { ...last.games };
      this.faults = { ...last.faults };
      this.server = last.server;
      this.matchOver = false;
    }
    this.phase = 'awaiting-serve';
    this.rally = null;
    return true;
  }

  _checkGame() {
    const { A, B } = this.score;
    const target = this.gamePoints;
    const leader = A > B ? 'A' : 'B';
    const [hi, lo] = A > B ? [A, B] : [B, A];
    if (hi < target || hi - lo < 2) return null;

    this.games[leader] += 1;
    this.score = { A: 0, B: 0 };
    const calls = [{ type: 'game', side: leader, reason: `game to ${leader}`, confidence: 1 }];

    const needed = Math.floor(this.bestOf / 2) + 1;
    if (this.games[leader] >= needed) {
      this.matchOver = true;
      calls.push({ type: 'match', side: leader, reason: `match to ${leader}`, confidence: 1 });
      return calls;
    }
    // New game: service alternates game to game, receiver of the last game serves.
    this.firstServer = other(this.firstServer);
    this.server = this.firstServer;
    return calls;
  }

  // Service changes every 2 points; every point once both reach gamePoints-1.
  _updateServer() {
    const { A, B } = this.score;
    const deuce = A >= this.gamePoints - 1 && B >= this.gamePoints - 1;
    const total = A + B;
    const turns = deuce ? total : Math.floor(total / 2);
    this.server = turns % 2 === 0 ? this.firstServer : other(this.firstServer);
  }

  /** The score as an umpire says it: server's score first, then the receiver's. */
  spokenScore() {
    const { A, B } = this.score;
    if (this.matchOver) return 'Match over.';
    const [srv, rec] = this.server === 'A' ? [A, B] : [B, A];
    if (A >= this.gamePoints - 1 && B >= this.gamePoints - 1) {
      if (A === B) return `Deuce. ${this.server} to serve.`;
      return `Advantage ${A > B ? 'A' : 'B'}. ${this.server} to serve.`;
    }
    if (A === 0 && B === 0) return `Love all. ${this.server} to serve.`;
    if (srv === rec) return `${srv} all. ${this.server} to serve.`;
    return `${srv}, ${rec}. ${this.server} to serve.`;
  }

  /** The score split for display: the two numbers, and who serves next. */
  scoreParts() {
    const { A, B } = this.score;
    return { A, B, server: this.server, matchOver: this.matchOver };
  }

  scoreCall() {
    const { A, B } = this.score;
    const srv = this.server === 'A' ? [A, B] : [B, A];
    if (this.matchOver) return 'Match over';
    if (A >= this.gamePoints - 1 && B >= this.gamePoints - 1) {
      if (A === B) return `Deuce, ${this.server} to serve`;
      return `Advantage ${A > B ? 'A' : 'B'}`;
    }
    return `${srv[0]}–${srv[1]}, ${this.server} serving`;
  }
}
