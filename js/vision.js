// Camera front end: table calibration plus a lightweight ball tracker.
//
// The tracker works on a downscaled greyscale copy of the frame. A ping-pong
// ball is small, bright and the fastest thing in the picture, so scoring each
// pixel by (frame difference x brightness) and taking the best small cluster
// finds it without any model or library. Motion prediction from the previous
// two frames keeps it locked on through a fast rally and rejects the much
// larger blobs made by arms and shirts.


// A regulation table is 2.74 m long and 1.525 m wide, and the ball is 40 mm.
// Once the box is on the table, those numbers turn a position in the picture
// into the size the ball must appear there — which is a far better test than
// any fixed pixel threshold.
const TABLE_WIDTH_M = 1.525;
const BALL_M = 0.04;

// Alpha-beta (constant-velocity) tracking filter. Alpha corrects position
// toward each measurement; beta corrects the velocity estimate. Tuned to be
// responsive enough for a smash yet steady enough that one noisy frame doesn't
// throw the track. All positions are normalised 0..1, velocities per second.
const ALPHA = 0.6;
const BETA = 0.32;
const CONFIRM = 3;        // detections before a track is trusted
const V_MAX = 9;          // clamp on estimated speed (frame-widths / second)
const LOST_CONFIRMED = 420;   // ms of no detection before a real track dies
const LOST_TENTATIVE = 140;   // an unconfirmed track dies fast
const REACQUIRE_MS = 120;     // after this long coasting, a far blob re-acquires
const BOUNCE_VY = 0.35;       // filtered vertical speed either side of a bounce

export class VisionReferee {
  constructor(video, overlay) {
    this.video = video;
    this.overlay = overlay;
    this.octx = overlay.getContext('2d');

    this.proc = document.createElement('canvas');
    this.pctx = this.proc.getContext('2d', { willReadFrequently: true });

    this.prev = null;
    this.track = null;              // { x, y, vx, vy, t, conf } in normalised 0..1
    this.trail = [];
    this.table = null;              // { corners:[{x,y}x4], net:[p,q], sideOfA:number }
    this.motionThreshold = 22;
    this.showDebug = true;
    this.fps = 0;
    this.facing = 'environment';
    this.tracking = false;      // only hunt for the ball during an active match
    this.onCameraLost = () => {};
    this.onCameraBack = () => {};
    this._recovering = false;
    this.bg = null;             // running background; the phone is stationary
    this.outMargin = 0.35;      // out-of-bounds line, as a fraction of table size
    this.onBallOut = () => {};
    this._wasInside = true;
    this.procWidth = 192;       // adapts down on a phone that can't keep up
    this.onBallBounce = () => {};   // visual bounce (vertical direction reversal)
    this.onLost = () => {};
    this._lastSeen = 0;
    this._running = false;
    this._frames = 0;
    this._fpsAt = performance.now();
  }

  async start(constraints = {}) {
    // Every constraint here is "ideal": a hard minimum frame rate makes
    // getUserMedia fail outright on cameras that won't promise it, and a slow
    // camera is still far better than no camera. Ask high, take what we get.
    // A phone does this work on battery: start smaller on a small screen and
    // let the frame loop adapt from there.
    if (Math.min(screen.width, screen.height) < 500) this.procWidth = 160;

    const wanted = {
      video: {
        facingMode: this.facing,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
      },
      ...constraints,
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(wanted);
    } catch (err) {
      if (err.name !== 'OverconstrainedError') throw err;
      this.stream = await navigator.mediaDevices.getUserMedia({ video: true });
    }
    this.settings = this.stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    if (this.settings.facingMode) this.facing = this.settings.facingMode;
    this._attachStream(this.stream);
    await this.video.play();
    this._running = true;
    requestAnimationFrame(this._loop);
    return this.stream;
  }

  /**
   * Attach a stream and watch for it ending. On iOS in particular, speaking a
   * call through the speech synthesiser can make the system reclaim an active
   * capture session and end the camera track — the screen goes black and does
   * not come back on its own. Re-acquiring the moment the track ends keeps the
   * camera alive through a spoken point.
   */
  _attachStream(stream) {
    this.video.srcObject = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => this._recover());
    }
    // A track that merely muted (a transient interruption) usually unmutes by
    // itself; if it does not, the stall watchdog below re-acquires.
  }

  async _recover() {
    if (!this._running || this._recovering) return;
    this._recovering = true;
    this.onCameraLost?.();
    for (let attempt = 0; attempt < 5 && this._running; attempt++) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: this.facing } },
        });
        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = stream;
        this.prev = null; this.bg = null;
        this._attachStream(stream);
        await this.video.play();
        this._recovering = false;
        this.onCameraBack?.();
        return;
      } catch {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    this._recovering = false;
  }

  /**
   * Watchdog: if the video stops delivering new frames for a while (a stall
   * the 'ended' event didn't cover), force a re-acquire. Called from the frame
   * loop, which already tracks the last time a real frame was drawn.
   */
  _watchdog(t) {
    if (this._recovering) return;
    // A backgrounded app pauses the video on purpose; that is not a stall.
    if (typeof document !== 'undefined' && document.hidden) { this._okAt = t; return; }
    if (this.video.readyState >= 2 && !this.video.paused) { this._okAt = t; return; }
    if (!this._okAt) this._okAt = t;
    if (t - this._okAt > 2500) { this._okAt = t; this._recover(); }
  }

  /** Is there more than one camera to switch between? */
  async hasMultipleCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'videoinput').length > 1;
    } catch { return false; }
  }

  /** Swap between the rear and front cameras, keeping the tracker's state. */
  async flipCamera() {
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    this.stream?.getTracks().forEach(t => t.stop());
    this.prev = null;
    this.trail.length = 0;
    this.track = null;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this._attachStream(this.stream);
    await this.video.play();
    return this.facing;
  }

  stop() {
    this._running = false;
    this.stream?.getTracks().forEach(t => t.stop());
  }

  _loop = () => {
    if (!this._running) return;
    this._watchdog(performance.now());
    if (this.video.readyState >= 2 && !this.video.paused) this._frame();
    requestAnimationFrame(this._loop);
  };

  _frame() {
    const t = performance.now();
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw) return;

    const W = this.procWidth;
    const ph = Math.round((W * vh) / vw);
    if (this.proc.width !== W || this.proc.height !== ph) {
      this.proc.width = W; this.proc.height = ph; this.prev = null;
    }
    if (this.overlay.width !== vw) { this.overlay.width = vw; this.overlay.height = vh; }

    // Only look for the ball while a match is being judged and the table is
    // known. Before that there is no size or region gate, so the tracker
    // would latch onto any movement in the room — which looked like the
    // marker "going everywhere". Off the clock, just show the camera.
    if (this.tracking && this.table) {
      this.pctx.drawImage(this.video, 0, 0, W, ph);
      const frame = this.pctx.getImageData(0, 0, W, ph);
      const found = this._findBall(frame, W, ph, t);
      this._updateTrack(found, t);
    } else if (this.track) {
      this.track = null;
      this.trail.length = 0;
    }
    this._draw();

    // Tracking a ball is worthless if it costs so much that frames are
    // dropped, so trade resolution for frame rate until the phone keeps up.
    const cost = performance.now() - t;
    this._cost = this._cost ? this._cost * 0.9 + cost * 0.1 : cost;
    const floor = this.minProcWidth ?? 128;
    if (this._cost > 11 && this.procWidth > floor) this.procWidth -= 16;
    else if (this._cost < 4 && this.procWidth < 288) this.procWidth += 8;

    this._frames++;
    if (t - this._fpsAt > 500) {
      this.fps = Math.round((this._frames * 1000) / (t - this._fpsAt));
      this._frames = 0; this._fpsAt = t;
    }
  }

  _findBall(frame, w, h, t) {
    const d = frame.data;
    const n = w * h;
    const grey = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      grey[i] = (d[p] * 77 + d[p + 1] * 151 + d[p + 2] * 28) >> 8;
    }
    if (!this.prev || this.prev.length !== n) { this.prev = grey; this.bg = null; return null; }
    if (!this.bg || this.bg.length !== n) { this.bg = Float32Array.from(grey); return null; }

    // Where do we expect the ball? Prediction tightens the search and stops a
    // waving arm from stealing the track. The window widens the longer the
    // ball has been missing, so a brief occlusion doesn't lose it for good.
    let px = -1, py = -1, searchR = 1e9;
    if (this.track) {
      const age = t - this.track.t;
      if (age < 400) {
        const dt = age / 1000;
        px = (this.track.x + this.track.vx * dt) * w;
        py = (this.track.y + this.track.vy * dt) * h;
        const speed = Math.hypot(this.track.vx * w, this.track.vy * h);
        searchR = Math.max(20, speed * 0.09 + 16) * (1 + age / 150);
      }
    }

    // The ball can only be inside the out-of-bounds line, so there is no
    // reason to look at the rest of the room. On a phone this is most of the
    // saving: fewer pixels touched every frame, and less to mistake for a ball.
    let x0 = 1, y0 = 1, x1 = w - 1, y1 = h - 1;
    if (this.table) {
      const b = this.table.boundary;
      const pad = 4;
      x0 = Math.max(1, Math.floor(Math.min(...b.map(p => p.x)) * w) - pad);
      x1 = Math.min(w - 1, Math.ceil(Math.max(...b.map(p => p.x)) * w) + pad);
      y0 = Math.max(1, Math.floor(Math.min(...b.map(p => p.y)) * h) - pad);
      y1 = Math.min(h - 1, Math.ceil(Math.max(...b.map(p => p.y)) * h) + pad);
    }

    const thr = this.motionThreshold;
    // Candidate pixels are marked in a mask rather than collected in a list,
    // so they can be grouped by actual connectivity below.
    const mask = new Uint8Array(n);
    const weight = new Float32Array(n);
    let candidates = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const g = grey[i];
        // Against a mostly static scene, the ball stands out from the learned
        // background far more reliably than from the previous frame alone:
        // frame differencing leaves a ghost where the ball WAS as well as
        // where it is, and loses the ball entirely whenever it slows down.
        const fromBg = g - this.bg[i];
        if (fromBg < thr) continue;
        const moving = Math.abs(g - this.prev[i]);
        if (moving < thr * 0.4) continue;   // a static bright object isn't the ball
        if (px >= 0 && Math.hypot(x - px, y - py) > searchR) continue;
        // Bright *for this scene*: a white ball on a dark blue table and an
        // orange ball in a dim hall are both brighter than the table behind
        // them, but neither is reliably above a fixed threshold.
        if (g < 55) continue;
        mask[i] = 1;
        weight[i] = fromBg * (g / 255);
        candidates++;
      }
    }
    this.prev = grey;

    // Learn the background slowly, and not at all where the ball might be:
    // baking the ball into the background is what makes a tracker go blind
    // when a rally settles into a rhythm.
    for (let i = 0; i < n; i++) this.bg[i] += (grey[i] - this.bg[i]) * 0.02;
    if (!candidates) return null;

    // Group by connectivity, not by proximity. Grouping greedily lets a large
    // object — an arm, a shirt — fragment into several ball-sized pieces and
    // slip straight through the size test below.
    const blobs = connectedBlobs(mask, weight, w, x0, y0, x1, y1);

    let best = null;
    for (const c of blobs) {
      if (c.n < 2) continue;
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
      // A ball is roughly round. A fast one smears into a short streak, but
      // an arm or a shirt edge is far longer in one direction than the other.
      const elongation = Math.max(bw, bh) / Math.min(bw, bh);
      if (elongation > 4) continue;
      const fill = c.n / (bw * bh);          // a blob, not a scattered edge
      if (fill < 0.3) continue;

      const cx = c.sx / c.sw, cy = c.sy / c.sw;
      // The size test: a ball at this spot on the table must measure about
      // this many pixels across. Anything appreciably bigger is a hand, a
      // sleeve or a shadow, whatever else it looks like.
      const expect = this.table ? this.expectedBallPx({ x: cx / w, y: cy / h }, w, h) : 0;
      let sizeFit = 1;
      if (expect > 0) {
        const dim = Math.max(bw, bh);
        if (dim > expect * 3.5 || dim < expect * 0.45) continue;
        sizeFit = 1 / (1 + Math.abs(dim - expect) / expect);
      } else if (c.n > 90) {
        continue;                            // uncalibrated: fall back to a cap
      }

      let score = (c.sw / c.n) * (1 / (1 + c.n / 30)) * fill * sizeFit;
      if (px >= 0) score *= 1 / (1 + Math.hypot(cx - px, cy - py) / 25);
      if (!best || score > best.score) best = { x: cx / w, y: cy / h, score, n: c.n };
    }
    if (!best) return null;
    return { ...best, t, conf: Math.min(1, best.score / 40) };
  }

  _updateTrack(found, t) {
    if (found && this._accept(found, t)) {
      // The detection is where the ball was predicted to be: filter it in.
      this._rejectStreak = 0;
      this._lastReject = null;
      this._integrate(found, t);
      return;
    }
    if (found) {
      // A detection the model didn't expect. One such frame is treated as a
      // distractor and ignored — this is what kills a single-frame blip. But
      // the ball reverses on every paddle hit and every bounce, and a real
      // reversal produces a *run* of unexpected detections, not one. So the
      // second consistent surprise is trusted over the model and the track is
      // re-seeded on it, with velocity taken from the two surprises. The
      // distinction that matters: coasting is for when the ball is *not seen*
      // (occlusion); a ball that IS seen, just not where predicted, means the
      // model is wrong, not that the ball vanished.
      const lr = this._lastReject;
      this._lastReject = { x: found.x, y: found.y, t };
      this._rejectStreak = (this._rejectStreak || 0) + 1;
      if (this._rejectStreak >= 2 && lr && t > lr.t) {
        this._reseed(found, lr, t);
        this._rejectStreak = 0;
        this._lastReject = null;
        return;
      }
    }
    this._coast(t);
  }

  /** Restart the track on a detection the model had stopped following. */
  _reseed(m, prevReject, t) {
    const dt = clamp((t - prevReject.t) / 1000, 1 / 125, 0.1);
    let vx = (m.x - prevReject.x) / dt;
    let vy = (m.y - prevReject.y) / dt;
    const speed = Math.hypot(vx, vy);
    if (speed > V_MAX) { const k = V_MAX / speed; vx *= k; vy *= k; }
    this.track = { x: m.x, y: m.y, vx, vy, t, conf: m.conf ?? 0.5,
                   hits: CONFIRM, misses: 0, confirmed: true };
    this._checkBoundary({ x: m.x, y: m.y }, t);
    this._lastSeen = t;
    this._pushTrail(m.x, m.y, t, false);
  }

  /**
   * Would this detection be accepted, or is it a distractor? A freshly
   * acquired track accepts everything while it learns its velocity; a
   * confirmed one rejects anything implausibly far from where the ball is
   * predicted to be — that is what stops a waving arm from stealing the
   * track — unless it has been coasting long enough that the ball has
   * genuinely gone somewhere new.
   */
  _accept(m, t) {
    const p = this.track;
    if (!p || p.hits < CONFIRM) return true;
    const dt = Math.max(1 / 125, (t - p.t) / 1000);
    const xp = p.x + p.vx * dt, yp = p.y + p.vy * dt;
    const r = Math.hypot(m.x - xp, m.y - yp);
    const speed = Math.hypot(p.vx, p.vy);
    const gate = 0.1 + speed * dt * 2.5 + 0.05 * p.misses;
    if (r <= gate) return true;
    return t - this._lastSeen > REACQUIRE_MS;
  }

  _integrate(m, t) {
    const prev = this.track;
    if (!prev || t - this._lastSeen > LOST_CONFIRMED) {
      // Fresh acquisition: no velocity yet, so start at rest and let the next
      // few frames establish it.
      this.track = { x: m.x, y: m.y, vx: 0, vy: 0, t, conf: m.conf ?? 0.5,
                     hits: 1, misses: 0, confirmed: false };
      this._lastSeen = t;
      this._pushTrail(m.x, m.y, t, false);
      return;
    }

    const dt = clamp((t - prev.t) / 1000, 1 / 125, 0.1);
    // Predict, then correct toward the measurement.
    const xp = prev.x + prev.vx * dt;
    const yp = prev.y + prev.vy * dt;
    const rx = m.x - xp, ry = m.y - yp;

    // While the track is still young the velocity estimate is unreliable, so
    // seed it directly from the frame-to-frame difference instead of nudging
    // a near-zero value; alpha-beta smoothing takes over once established.
    let vx, vy;
    if (prev.hits < 2) {
      vx = (m.x - prev.x) / dt;
      vy = (m.y - prev.y) / dt;
    } else {
      vx = prev.vx + (BETA / dt) * rx;
      vy = prev.vy + (BETA / dt) * ry;
    }
    const speed = Math.hypot(vx, vy);
    if (speed > V_MAX) { const k = V_MAX / speed; vx *= k; vy *= k; }

    const x = xp + ALPHA * rx;
    const y = yp + ALPHA * ry;
    const hits = prev.hits + 1;
    const confirmed = prev.confirmed || hits >= CONFIRM;

    // A bounce is the ball's downward motion reversing to upward. Reading it
    // from the smoothed velocity, with clear thresholds either side, is far
    // steadier than the old single-frame sign test, which both missed real
    // bounces and invented them from jitter.
    if (confirmed && prev.vy > BOUNCE_VY && vy < -BOUNCE_VY * 0.4) {
      this.onBallBounce({ x, y, t, side: this.sideOf({ x, y }), onTable: this.isOnTable({ x, y }) });
    }

    this.track = { x, y, vx, vy, t, conf: m.conf ?? prev.conf, hits, misses: 0, confirmed };
    this._checkBoundary({ x, y }, t);
    this._lastSeen = t;
    this._pushTrail(x, y, t, false);
  }

  _coast(t) {
    const prev = this.track;
    if (!prev) return;
    const gap = t - this._lastSeen;
    const limit = prev.confirmed ? LOST_CONFIRMED : LOST_TENTATIVE;
    if (gap > limit) {
      this.track = null;
      this.trail.length = 0;
      this._rejectStreak = 0;
      this._lastReject = null;
      this.onLost(prev);
      return;
    }
    // Carry the ball forward on its last known motion, bleeding off a little
    // speed so a lost track drifts to a stop rather than flying away.
    const dt = clamp((t - prev.t) / 1000, 1 / 125, 0.1);
    const x = prev.x + prev.vx * dt;
    const y = prev.y + prev.vy * dt;
    this.track = { ...prev, x, y, t, misses: prev.misses + 1,
                   vx: prev.vx * 0.985, vy: prev.vy * 0.985 };
    this._checkBoundary({ x, y }, t);
    this._pushTrail(x, y, t, true);
  }

  _pushTrail(x, y, t, predicted) {
    this.trail.push({ x, y, t, predicted });
    if (this.trail.length > 48) this.trail.shift();
  }

  /**
   * Fire once when the ball crosses the out-of-bounds line outward. The
   * outward test matters: a ball travelling towards the table from behind a
   * player is a stroke being played, not a ball leaving the court.
   */
  _checkBoundary(p, t) {
    if (!this.table) return;
    if (this.isInsideBoundary(p)) { this._wasInside = true; return; }
    if (!this._wasInside) return;                     // already counted
    const c = this.table.centre;
    const outward = (p.x - c.x) * this.track.vx + (p.y - c.y) * this.track.vy;
    if (outward <= 0) return;                         // heading back towards the table
    this._wasInside = false;
    this.onBallOut({ x: p.x, y: p.y, t, speed: Math.hypot(this.track.vx, this.track.vy) });
  }

  /** Ball position at (or nearest to) a moment in time — used to place a sound. */
  positionAt(wallTime, windowMs = 120) {
    const tr = this.trail;
    if (!tr.length) return null;

    // The sound is timestamped to the millisecond, but frames land ~16-33 ms
    // apart. Interpolating between the two trail samples that bracket the
    // moment places the ball where it actually was when the bounce happened,
    // not merely at the nearest frame — which is what decides whose half it is.
    let before = null, after = null;
    for (const p of tr) {
      if (p.t <= wallTime && (!before || p.t > before.t)) before = p;
      if (p.t >= wallTime && (!after || p.t < after.t)) after = p;
    }
    if (before && after && after.t > before.t) {
      const f = (wallTime - before.t) / (after.t - before.t);
      return { x: before.x + (after.x - before.x) * f,
               y: before.y + (after.y - before.y) * f,
               t: wallTime, dt: 0, interpolated: true };
    }
    const near = before || after;
    const dt = Math.abs(near.t - wallTime);
    return dt <= windowMs ? { ...near, dt } : null;
  }

  // --- table geometry  // --- table geometry ----------------------------------------------------

  /**
   * corners: 4 normalised points, walked around the table starting at the
   * corner of A's end nearest the camera. So c0-c1 is A's end line, c2-c3 is
   * B's end line, and the net crosses the midpoints of the two long edges.
   */
  setTable(corners) {
    const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const net = [mid(corners[1], corners[2]), mid(corners[0], corners[3])];
    const centre = corners.reduce((a, c) => ({ x: a.x + c.x / 4, y: a.y + c.y / 4 }), { x: 0, y: 0 });
    const halfA = [corners[0], corners[1], net[0], net[1]];
    const halfB = [net[1], net[0], corners[2], corners[3]];
    // The two end lines are both one table-width long, so the difference in
    // their apparent length is the perspective foreshortening of the view.
    const nearMid = mid(corners[0], corners[3]);
    const farMid = mid(corners[1], corners[2]);
    this.table = {
      corners: corners.map(c => ({ ...c })),
      net, centre, halfA, halfB,
      sideOfA: sign(cross(net[0], net[1], corners[0])),
      boundary: expand(corners, centre, 1 + this.outMargin),
      nearEnd: [corners[0], corners[3]],
      farEnd: [corners[1], corners[2]],
      nearMid, farMid,
    };
    this._sizeProcWidth();
    return this.table;
  }

  /**
   * Find the table in the current frame and place the box on it.
   *
   * A table tennis table is the one big, uniformly coloured, low-texture
   * surface in the picture — blue or green in almost every hall. So: take the
   * dominant colour of the middle of the frame, keep every pixel close to it,
   * take the largest connected region of those, and fit a quadrilateral to
   * its extremes. It is a starting position, not a survey: the corners stay
   * draggable afterwards.
   *
   * Returns { corners, coverage } or null when nothing table-like is found.
   */
  scanTable(seed = { x: 0.5, y: 0.55 }) {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw) return null;

    const W = 160, H = Math.round((W * vh) / vw);
    this.proc.width = W; this.proc.height = H;
    this.pctx.drawImage(this.video, 0, 0, W, H);
    const d = this.pctx.getImageData(0, 0, W, H).data;
    this.prev = null; this.bg = null;      // the frame size changed under us

// Don't assume the table's colour. The user is pointing the phone at the
    // table, so whatever colour dominates the middle of the frame IS the
    // table — under whatever lighting they have. Sample that colour and grow
    // the region of pixels like it. This works for a worn green table in a
    // dim hall as well as a vivid blue one, where a fixed hue range failed.
    // Sample the colour of a small patch around the seed point — the middle of
    // the frame by default, or exactly where the user tapped the table.
    const sx = Math.round(clamp(seed.x, 0.05, 0.95) * W);
    const sy = Math.round(clamp(seed.y, 0.05, 0.95) * H);
    const rad = Math.max(3, (W * 0.06) | 0);
    let sr = 0, sg = 0, sb = 0, sn = 0;
    for (let y = Math.max(0, sy - rad); y < Math.min(H, sy + rad); y++) {
      for (let x = Math.max(0, sx - rad); x < Math.min(W, sx + rad); x++) {
        const i = (y * W + x) * 4;
        sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sn++;
      }
    }
    const seedColor = { r: sr / sn, g: sg / sn, b: sb / sn };

    // Compare by chromaticity plus a loose brightness band, so the shading
    // that falls across a real table (near edge bright, far edge dark) does
    // not split it into two different "colours".
    const chroma = (r, g, b) => { const t = r + g + b + 1; return [r / t, g / t]; };
    const [scr, scg] = chroma(seedColor.r, seedColor.g, seedColor.b);
    const seedLum = (seedColor.r + seedColor.g + seedColor.b) / 3;
    const CHROMA_TOL = 0.055;    // how different in colour a pixel may be
    const LUM_TOL = 95;          // and in brightness

    const mask = new Uint8Array(W * H);
    let count = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const [cr, cg] = chroma(r, g, b);
        if (Math.abs(cr - scr) + Math.abs(cg - scg) > CHROMA_TOL) continue;
        if (Math.abs((r + g + b) / 3 - seedLum) > LUM_TOL) continue;
        mask[y * W + x] = 1; count++;
      }
    }
    if (count < W * H * 0.03) return null;

    // Grow from the centre specifically, so if the floor happens to match too
    // it is the table (which the phone is aimed at) that anchors the region.
    const seedIdx = sy * W + sx;
    let region = mask[seedIdx] ? regionContaining(mask, W, H, seedIdx) : null;
    if (!region || region.size < W * H * 0.02) region = largestRegion(mask, W, H);
    if (!region || region.size < W * H * 0.02) return null;

    // Fit a quad by taking the extreme points along both diagonals — for a
    // rectangle seen in perspective these land on its four corners.
    const ext = {
      tl: { v: Infinity }, br: { v: -Infinity }, tr: { v: -Infinity }, bl: { v: Infinity },
    };
    let minX = W, maxX = 0, minY = H, maxY = 0;
    for (const idx of region.pixels) {
      const x = idx % W, y = (idx / W) | 0;
      const sum = x + y, diff = x - y;
      if (sum < ext.tl.v) ext.tl = { v: sum, x, y };
      if (sum > ext.br.v) ext.br = { v: sum, x, y };
      if (diff > ext.tr.v) ext.tr = { v: diff, x, y };
      if (diff < ext.bl.v) ext.bl = { v: diff, x, y };
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }

    // A region touching all four edges is the background (a wall, the floor
    // filling the view), not a table sitting in the frame.
    if (minX <= 1 && maxX >= W - 2 && minY <= 1 && maxY >= H - 2) return null;

    const norm = p => ({ x: p.x / W, y: p.y / H });
    // Walk the corners the way calibration expects: the near-left corner
    // first, then up the left edge, across, and back down.
    const corners = [norm(ext.bl), norm(ext.tl), norm(ext.tr), norm(ext.br)];

    const area = Math.abs(polygonArea(corners));
    if (area < 0.015) return null;           // too small to be the table

    // The region must actually fill the quad it was fitted to. An L-shaped or
    // scattered region can have four sensible extremes and be nothing like a
    // table.
    const fill = (region.size / (W * H)) / area;
    if (fill < 0.5) return null;

    this.setTable(corners);
    return { corners, coverage: region.size / (W * H), fill };    this.setTable(corners);
    return { corners, coverage: region.size / (W * H), fill };
  }

  /**
   * Expected ball diameter in processing pixels at a point, from the table's
   * real dimensions and how foreshortened the table is there.
   */
  expectedBallPx(p, W, H) {
    const t = this.table;
    if (!t) return 0;
    const len = (a, b) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
    const near = len(t.nearEnd[0], t.nearEnd[1]);
    const far = len(t.farEnd[0], t.farEnd[1]);

    // How far down the table the point lies, 0 at the near end, 1 at the far.
    const dx = t.farMid.x - t.nearMid.x, dy = t.farMid.y - t.nearMid.y;
    const len2 = dx * dx + dy * dy || 1e-9;
    const f = Math.min(1.4, Math.max(-0.4,
      ((p.x - t.nearMid.x) * dx + (p.y - t.nearMid.y) * dy) / len2));

    const widthHere = near + (far - near) * f;
    return Math.max(1.2, widthHere * (BALL_M / TABLE_WIDTH_M));
  }

  /**
   * Choose a processing resolution from the geometry rather than by guesswork:
   * enough that the ball is a few pixels across even at the far end, but no
   * more, because every extra pixel is battery.
   */
  _sizeProcWidth() {
    const t = this.table;
    if (!t) return;
    const probeW = 192, probeH = probeW * 0.75;
    const atFar = this.expectedBallPx(t.farMid, probeW, probeH);
    const wanted = probeW * (3.2 / Math.max(0.6, atFar));
    this.procWidth = Math.round(Math.min(288, Math.max(144, wanted)) / 8) * 8;
    this.minProcWidth = Math.max(128, Math.round(this.procWidth * 0.7));
    this.prev = null; this.bg = null;
  }

  /** Start or stop hunting for the ball. */
  setTracking(on) {
    this.tracking = on;
    if (on) this.captureBackground();   // start from the table as it is right now
    else { this.track = null; this.trail.length = 0; }
  }

  /** Remember the current frame as the empty-table background. */
  captureBackground() {
    const vw = this.video.videoWidth;
    if (!vw) return false;
    const W = this.procWidth, H = Math.round((W * this.video.videoHeight) / vw);
    this.proc.width = W; this.proc.height = H;
    this.pctx.drawImage(this.video, 0, 0, W, H);
    const d = this.pctx.getImageData(0, 0, W, H).data;
    const n = W * H;
    const grey = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      grey[i] = (d[p] * 77 + d[p + 1] * 151 + d[p + 2] * 28) >> 8;
    }
    this.bg = Float32Array.from(grey);
    this.prev = grey;
    return true;
  }

  /** Slide the whole box, keeping its shape. Used to drag it onto the table. */
  moveTable(dx, dy) {
    if (!this.table) return;
    this.setTable(this.table.corners.map(c => ({
      x: Math.min(1, Math.max(0, c.x + dx)),
      y: Math.min(1, Math.max(0, c.y + dy)),
    })));
  }

  /** Flip which end of the box is Player A's, without redrawing the box. */
  swapEnds() {
    if (!this.table) return;
    const c = this.table.corners;
    this.setTable([c[2], c[3], c[0], c[1]]);
  }

  /** Is a point inside the box? Used to tell a whole-box drag from a corner. */
  isInsideTable(p) { return this.isOnTable(p); }

  /** Move the out-of-bounds line in or out; 0 puts it on the table edge. */
  setOutMargin(m) {
    this.outMargin = m;
    if (this.table) this.table.boundary = expand(this.table.corners, this.table.centre, 1 + m);
  }

  /**
   * Is the ball still in play, positionally? Note this is NOT the table
   * outline: players legitimately strike the ball from well behind the end
   * line, so the ball being off the table means nothing on its own. The
   * boundary sits out beyond the table, at the point where the ball can no
   * longer be coming back.
   */
  isInsideBoundary(p) {
    if (!this.table) return true;
    const b = this.table.boundary;
    return inTriangle(p, b[0], b[1], b[2]) || inTriangle(p, b[0], b[2], b[3]);
  }

  isOnTable(p) {
    if (!this.table) return false;
    const c = this.table.corners;
    return inTriangle(p, c[0], c[1], c[2]) || inTriangle(p, c[0], c[2], c[3]);
  }

  /** Which half of the table a point falls on: 'A', 'B', or null if no table. */
  sideOf(p) {
    if (!this.table) return null;
    const s = sign(cross(this.table.net[0], this.table.net[1], p));
    return s === this.table.sideOfA ? 'A' : 'B';
  }

  /** How far outside the table the point is, as a fraction of table length. */
  outByFraction(p) {
    if (!this.table) return 0;
    if (this.isOnTable(p)) return 0;
    const c = this.table.corners;
    const len = Math.hypot(c[0].x - c[3].x, c[0].y - c[3].y) || 1;
    let dmin = Infinity;
    for (let i = 0; i < 4; i++) dmin = Math.min(dmin, distToSeg(p, c[i], c[(i + 1) % 4]));
    return dmin / len;
  }

  _draw() {
    const ctx = this.octx, W = this.overlay.width, H = this.overlay.height;
    ctx.clearRect(0, 0, W, H);

    if (this.table) {
      // The out-of-bounds line, drawn first so the table sits on top of it.
      const b = this.table.boundary;
      ctx.strokeStyle = 'rgba(248,81,73,.75)'; ctx.lineWidth = 2;
      ctx.setLineDash([10, 7]);
      ctx.beginPath();
      b.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
      ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(248,81,73,.85)';
      ctx.font = '600 13px system-ui';
      ctx.fillText('OUT', b[1].x * W + 4, b[1].y * H - 6);

      const c = this.table.corners;
      ctx.strokeStyle = 'rgba(74,163,255,.9)'; ctx.lineWidth = 2;
      ctx.beginPath();
      c.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
      ctx.closePath(); ctx.stroke();

      const [n0, n1] = this.table.net;
      ctx.strokeStyle = 'rgba(255,255,255,.75)';
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(n0.x * W, n0.y * H); ctx.lineTo(n1.x * W, n1.y * H); ctx.stroke();
      ctx.setLineDash([]);

      // Whose half is whose, said plainly in the middle of each half and in
      // the colours the scoreboard uses. Swap ends moves them.
      this._halfLabel(ctx, W, H, this.table.halfA, 'A', '#4aa3ff');
      this._halfLabel(ctx, W, H, this.table.halfB, 'B', '#ff8a4a');

      // Handles, so it is obvious the corners can be dragged.
      ctx.lineWidth = 2;
      for (const p of c) {
        ctx.strokeStyle = 'rgba(255,255,255,.95)';
        ctx.fillStyle = 'rgba(74,163,255,.35)';
        ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 14, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }

    if (!this.showDebug) return;

    if (this.trail.length > 1) {
      ctx.strokeStyle = 'rgba(255,220,80,.55)'; ctx.lineWidth = 2;
      ctx.beginPath();
      this.trail.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
      ctx.stroke();
    }
    if (this.track) {
      ctx.strokeStyle = '#ffdc50'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(this.track.x * W, this.track.y * H, 10, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /** A big letter on a chip, centred in one half of the table. */
  _halfLabel(ctx, W, H, half, text, colour) {
    const cx = half.reduce((a, p) => a + p.x, 0) / half.length * W;
    const cy = half.reduce((a, p) => a + p.y, 0) / half.length * H;
    const size = Math.max(20, Math.min(W, H) * 0.075);

    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + size * 0.9;
    const h = size * 1.5;

    ctx.fillStyle = 'rgba(0,0,0,.45)';   // legible over any table colour
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, size * 0.3);
    ctx.fill(); ctx.stroke();

    ctx.fillStyle = colour;
    ctx.fillText(text, cx, cy + size * 0.04);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
}

// --- small geometry helpers ---------------------------------------------
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

const hueDistance = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * Every 8-connected blob in a mask, with its weighted centroid and bounds.
 * Eight-way connectivity keeps a motion-blurred ball in one piece.
 */
function connectedBlobs(mask, weight, w, x0, y0, x1, y1) {
  const blobs = [];
  const stack = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const start = y * w + x;
      if (mask[start] !== 1) continue;
      stack.length = 0;
      stack.push(start);
      mask[start] = 2;
      const c = { n: 0, sx: 0, sy: 0, sw: 0, x0: x, x1: x, y0: y, y1: y };
      while (stack.length) {
        const i = stack.pop();
        const ix = i % w, iy = (i / w) | 0;
        const s = weight[i];
        c.n++; c.sx += ix * s; c.sy += iy * s; c.sw += s;
        if (ix < c.x0) c.x0 = ix; if (ix > c.x1) c.x1 = ix;
        if (iy < c.y0) c.y0 = iy; if (iy > c.y1) c.y1 = iy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = ix + dx, ny = iy + dy;
            if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
            const j = ny * w + nx;
            if (mask[j] === 1) { mask[j] = 2; stack.push(j); }
          }
        }
      }
      if (c.sw > 0) blobs.push(c);
      if (blobs.length > 400) return blobs;   // pathological frame; stop early
    }
  }
  return blobs;
}

/** The 4-connected region of the mask that contains a given pixel. */
function regionContaining(mask, W, H, start) {
  if (!mask[start]) return null;
  const seen = new Uint8Array(W * H);
  const stack = [start];
  seen[start] = 1;
  const pixels = [];
  while (stack.length) {
    const i = stack.pop();
    pixels.push(i);
    const x = i % W, y = (i / W) | 0;
    if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
    if (x < W - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && mask[i - W] && !seen[i - W]) { seen[i - W] = 1; stack.push(i - W); }
    if (y < H - 1 && mask[i + W] && !seen[i + W]) { seen[i + W] = 1; stack.push(i + W); }
  }
  return { size: pixels.length, pixels };
}

/** Largest 4-connected region of a binary mask, found iteratively. */
function largestRegion(mask, W, H) {
  const seen = new Uint8Array(W * H);
  const stack = [];
  let best = null;
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const pixels = [];
    while (stack.length) {
      const i = stack.pop();
      pixels.push(i);
      const x = i % W, y = (i / W) | 0;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < W - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && mask[i - W] && !seen[i - W]) { seen[i - W] = 1; stack.push(i - W); }
      if (y < H - 1 && mask[i + W] && !seen[i + W]) { seen[i + W] = 1; stack.push(i + W); }
    }
    if (!best || pixels.length > best.size) best = { size: pixels.length, pixels };
  }
  return best;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return a / 2;
}

/** Rounded rectangle path, with a fallback for browsers without roundRect. */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Scale a polygon outward from a point. */
function expand(pts, centre, k) {
  return pts.map(p => ({ x: centre.x + (p.x - centre.x) * k, y: centre.y + (p.y - centre.y) * k }));
}

const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cross = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
const sign = v => (v >= 0 ? 1 : -1);

function inTriangle(p, a, b, c) {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
