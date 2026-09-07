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
const TABLE_LENGTH_M = 2.74;
const BALL_M = 0.04;

// Alpha-beta (constant-velocity) tracking filter. Alpha corrects position
// toward each measurement; beta corrects the velocity estimate. Tuned to be
// responsive enough for a smash yet steady enough that one noisy frame doesn't
// throw the track. All positions are normalised 0..1, velocities per second.
const ALPHA = 0.6;
const BETA = 0.32;
const CONFIRM = 4;        // consecutive COHERENT detections before a track is trusted
const COHERE_GATE = 0.09; // how far a tentative detection may sit from its prediction
const RESEED_RADIUS = 0.22; // a reversal is local; a distractor jumps — only re-seed near
const V_MAX = 9;          // clamp on estimated speed (frame-widths / second)
const LOST_CONFIRMED = 420;   // ms of no detection before a real track dies
const LOST_TENTATIVE = 140;   // an unconfirmed track dies fast
const REACQUIRE_MS = 120;     // after this long coasting, a far blob re-acquires
const BOUNCE_VY = 0.35;       // filtered vertical speed either side of a bounce
const MIN_BALL_SPEED = 0.5;   // frame-widths/second — the ball moves; a drifting arm barely does
const BALLISTIC_MIN = 0.3;    // how smooth the recent path must be to count as physical motion
// A blob smaller than this has no measurable shape and cannot be told from
// sensor noise, whatever else it scores. This is the ABSOLUTE floor, for the
// uncalibrated case where there is no per-position size to compare against;
// once a table is calibrated, MIN_FILL_FACTOR below is the real gate and it
// is almost always stricter than this.
const MIN_BALL_PIXELS = 4;
// Once calibrated, a candidate must fill at least this fraction of the disc
// area a real ball would have AT THAT SPOT — not a flat pixel count. A ball
// near the camera might be 8 px across (~50 px of area) and one at the far
// end 3 px across (~7 px of area); a flat floor is either too loose up close
// or too tight far away. Tying it to the expected area closes both at once:
// a 2x2 square (4 px, perfectly filled) is nowhere near a real disc's area
// wherever the ball would be genuinely large, but is not unduly punished at
// the far end where a real ball's disc is small too. 0.55 rather than 1.0
// because brightness thresholding and anti-aliasing always undercount a real
// disc's edge pixels.
const MIN_FILL_FACTOR = 0.55;
// How much more elongated a blob may be when its long axis points exactly the
// way the ball is travelling — i.e. how much motion blur is forgiven.
const BLUR_ELONG_FACTOR = 2.0;
// ... and how round it must be across that direction, where blur cannot
// explain any stretching at all.
const ROUND_ELONG = 1.8;
// Below this speed (processing pixels/second) the velocity estimate's
// DIRECTION is too noisy to judge blur by, and a ball that slow isn't blurred
// anyway, so the plain roundness bound is used instead.
const BLUR_MIN_SPEED_PX = 60;

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
    this.topDownCtx = null;         // set via setTopDownCanvas()
    this.facing = 'environment';
    this.tracking = false;      // only hunt for the ball during an active match
    // The ball's colour is the one property almost unique to it: a regulation
    // ball is white or orange, and nothing else on the table is. Selecting by
    // colour is what lets the tracker follow the ball and not arms or shirts.
    this.ballColor = 'white';   // 'white' | 'orange' | a sampled {r,g,b}
    // One dial for how picky the tracker is, 0 (tracks readily, may wander) to
    // 1 (only a textbook ball locks on). The right value depends on the room,
    // the ball and the lighting, which only the user can see — so it is a
    // slider, defaulted to lean toward tracking.
    this.strictness = 0.2;
    this._applyStrictness();
    this.ballTemplate = null;   // the ACTUAL ball's colour, learned once locked on
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

    // The processing resolution is chosen once from the table geometry
    // (_sizeProcWidth) so the ball is a few pixels across. It is NOT adapted
    // per frame: changing it mid-match resized the buffers and wiped the
    // learned background every time, which on a phone hovering near the cost
    // threshold happened constantly and made the tracker lose the ball. If a
    // device is truly too slow, one sustained step down is enough — handled
    // below with heavy hysteresis, never oscillating.
    const cost = performance.now() - t;
    this._cost = this._cost ? this._cost * 0.92 + cost * 0.08 : cost;
    this._overAt = this._cost > 16 ? (this._overAt ?? t) : null;
    if (this._overAt && t - this._overAt > 4000 && this.procWidth > (this.minProcWidth ?? 128)) {
      this.procWidth -= 16;          // one deliberate step after 4s of overload
      this._overAt = null;
    }

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

    // Learn the background slowly, and NOT where a candidate (possible ball)
    // was found — baking the ball into the background is what makes a tracker
    // go blind when a rally settles into a rhythm. (The previous version
    // updated every pixel, contradicting this intent.)
    for (let i = 0; i < n; i++) if (!mask[i]) this.bg[i] += (grey[i] - this.bg[i]) * 0.02;
    if (!candidates) return null;

    // Group by connectivity, not by proximity. Grouping greedily lets a large
    // object — an arm, a shirt — fragment into several ball-sized pieces and
    // slip straight through the size test below.
    const blobs = connectedBlobs(mask, weight, d, w, x0, y0, x1, y1);

    // Where is the ball predicted to be heading? A blob may only be stretched
    // along that direction (see the elongation gate below).
    let vAngle = null;
    if (this.track) {
      const vpx = this.track.vx * w, vpy = this.track.vy * h;
      if (Math.hypot(vpx, vpy) > BLUR_MIN_SPEED_PX) vAngle = Math.atan2(vpy, vpx);
    }

    let best = null;
    for (const c of blobs) {
      // A blob of two or three pixels has no shape to speak of, and a ball
      // that small could not be measured or told apart from sensor noise
      // anyway. Below this the tracker was scoring specks against the real
      // ball on equal terms — see the scoring note further down.
      if (c.n < MIN_BALL_PIXELS) continue;
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
      const fill = c.n / (bw * bh);          // a blob, not a scattered edge
      if (fill < 0.25) continue;

      const cx = c.sx / c.sw, cy = c.sy / c.sw;

      // "Only a round, ball-like thing is tracked." A ball IS round. The one
      // honest exception is motion blur, which smears a fast ball into a short
      // streak — but always ALONG the direction it is travelling. So elongation
      // is allowed exactly to the extent that the blob's long axis lines up
      // with where the ball is known to be going, and not otherwise. A table
      // line, a shirt seam, a cable or an arm edge lies whichever way it lies,
      // is not aligned with the ball's flight, and is turned away. While
      // acquiring there is no flight to compare against, so a genuinely round
      // blob is required — which is exactly the moment false locks happen.
      const shape = blobShape(c);
      let maxElong = this._elongMax ?? 2.8;
      if (vAngle !== null) {
        // cos of the angle between the two axes; squared so only a good
        // alignment buys much slack. Axes are undirected, hence the abs.
        // Misalignment TIGHTENS the bound rather than merely failing to loosen
        // it: blur stretches the ball along its flight and nowhere else, so a
        // blob stretched across the flight is not a blurred ball no matter how
        // fast the ball is going — it is the arm that just hit it, or an edge
        // behind it.
        const align = Math.abs(Math.cos(shape.angle - vAngle));
        maxElong = ROUND_ELONG + align * align * (maxElong * BLUR_ELONG_FACTOR - ROUND_ELONG);
      }
      if (!shape.measurable || shape.elong > maxElong) continue;

      // The size test: a ball at this spot on the table must measure about
      // this many pixels across. Anything appreciably bigger is a hand, a
      // sleeve or a shadow, whatever else it looks like.
      const expect = this.table ? this.expectedBallPx({ x: cx / w, y: cy / h }, w, h) : 0;
      let sizeFit = 1;
      if (expect > 0) {
        const dim = Math.max(bw, bh);
        const sTol = this._sizeTol ?? 1;
        // The upper bound is what strictness is really for — how much bigger
        // than a ball a thing may be before it's an arm. The lower bound is
        // barely loosened at all: something far SMALLER than a ball can be is
        // noise at any strictness, and letting the dial widen that floor was
        // what let single-pixel specks through at low strictness.
        if (dim > expect * 3.5 * sTol) continue;
        // The floor barely moves with the dial (a fourth root, not a full
        // division): the ball's apparent size at this spot is geometry, not
        // taste. The absolute floor of 2 px is what protects a genuinely
        // distant ball, which really is only a couple of pixels across at the
        // far end — the processing resolution is chosen to keep it so.
        if (dim < Math.max(2, expect * 0.68 / Math.pow(sTol, 0.25))) continue;
        // A real disc's AREA at this spot, not just its bounding-box width, is
        // what a degenerate blob (a filled square, a thick dot) cannot fake
        // without actually being close to that size everywhere the ball would
        // be big — see MIN_FILL_FACTOR above.
        const minArea = Math.PI * (expect / 2) ** 2 * MIN_FILL_FACTOR;
        if (c.n < minArea) continue;
        sizeFit = 1 / (1 + Math.abs(dim - expect) / expect);
      } else if (c.n > 90) {
        continue;                            // uncalibrated: fall back to a cap
      }

      const meanR = c.cr / c.n, meanG = c.cg / c.n, meanB = c.cb / c.n;
      // Colour is the decisive test: the blob must actually be the ball's
      // colour, not merely something that moved and is bright. This is what
      // rejects a swinging arm (skin) or a shirt in favour of the ball.
      const col = this.ballColorScore(meanR, meanG, meanB);
      if (!col.pass) continue;

      // Scoring. There used to be a 1/(1 + n/30) "prefer the smaller blob"
      // term here, left over from before the table geometry could say how big
      // the ball must actually be. Once calibrated it double-counted size and
      // pulled the wrong way: a 2-pixel speck scored 0.94 on it against 0.60
      // for a real ball, and since a degenerate blob also fills its own
      // bounding box perfectly (fill = 1.0), specks outscored the actual ball
      // — measured at 22.4 vs 14.7 at equal brightness. That is why the marker
      // chased every little thing. With a calibrated table, sizeFit IS the
      // size prior and the crude term is gone; it survives only as the
      // uncalibrated fallback, where there is nothing better to go on.
      let score = (c.sw / c.n) * fill * sizeFit * col.score * (0.35 + 0.65 * shape.round);
      if (expect <= 0) score *= 1 / (1 + c.n / 30);
      if (px >= 0) {
        // Persistence: a confirmed track should stay on its own ball rather
        // than being stolen by whatever else is momentarily bright. Once the
        // track is trusted its prediction is worth a lot, so the preference
        // for the candidate where the ball is expected is sharp; a tentative
        // track's prediction is not yet worth much, so it stays gentle.
        const grip = this.track?.confirmed ? 9 : 25;
        score *= 1 / (1 + Math.hypot(cx - px, cy - py) / grip);
      }
      if (!best || score > best.score) {
        best = { x: cx / w, y: cy / h, score, n: c.n, colScore: col.score,
                 round: shape.round, color: { r: meanR, g: meanG, b: meanB } };
      }
    }
    if (!best) return null;

    // Acquiring a fresh lock wants a decently on-colour blob (better to wait a
    // frame than to start on a white shirt), but the bar is deliberately not
    // so high that a blurred ball never qualifies. Tunable via strictness.
    const acquiring = !this.track || !this.track.confirmed;
    if (acquiring && best.colScore < this._acqColorFloor) return null;

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
      // Re-seed only on a self-coherent run of surprises: two in a row that
      // sit close to each OTHER form a smooth little trajectory, which is what
      // a real ball reversing (after a bounce or a hit) looks like — even when
      // it has travelled far from the stale track. A distractor that merely
      // flickers around produces surprises scattered apart, and is ignored.
      const lr = this._lastReject;
      this._lastReject = { x: found.x, y: found.y, t };
      this._rejectStreak = (this._rejectStreak || 0) + 1;
      if (this._rejectStreak >= 2 && lr && t > lr.t &&
          Math.hypot(found.x - lr.x, found.y - lr.y) < RESEED_RADIUS &&
          this._reseed(found, lr, t)) {
        this._rejectStreak = 0;
        this._lastReject = null;
        return;
      }
    }
    this._coast(t);
  }

  /**
   * How ballistic the recent motion is, 0..1. A flying ball traces a smooth
   * arc — constant horizontal speed, gravity pulling it down — which fits a
   * quadratic in time almost perfectly (a straight glide is the zero-gravity
   * case and fits too). An arm's jitter does not. Returns 1 when there aren't
   * enough points yet, so a fresh track isn't penalised.
   */
  _ballisticScore() {
    const pts = this.trail.filter(p => !p.predicted).slice(-6);
    if (pts.length < 4) return 1;
    const t0 = pts[0].t;
    const ts = pts.map(p => (p.t - t0) / 1000);
    const rx = quadFitResidual(ts, pts.map(p => p.x));
    const ry = quadFitResidual(ts, pts.map(p => p.y));
    return clamp(1 - Math.hypot(rx, ry) / 0.02, 0, 1);
  }

  /**
   * Restart the track on a run of detections the model stopped following.
   * Only a confirmed track re-seeds (a reversal of a real ball), and the new
   * motion must itself be fast enough to be a ball — otherwise this is just a
   * slow distractor and the track is dropped instead. The re-seeded track is
   * NOT auto-confirmed: it must re-earn confirmation through the normal
   * speed/ballistic/coherence gates, so a distractor cannot hijack the marker
   * by producing two nearby blobs.
   */
  _reseed(m, prevReject, t) {
    if (!this.track || !this.track.confirmed) return false;
    const dt = clamp((t - prevReject.t) / 1000, 1 / 125, 0.1);
    let vx = (m.x - prevReject.x) / dt;
    let vy = (m.y - prevReject.y) / dt;
    const speed = Math.hypot(vx, vy);
    if (speed < this._minSpeed) return false;      // too slow to be the ball
    if (speed > V_MAX) { const k = V_MAX / speed; vx *= k; vy *= k; }
    this.track = { x: m.x, y: m.y, vx, vy, t, conf: (m.conf ?? 0.5) * 0.6,
                   hits: 2, misses: 0, confirmed: false };
    this._lastSeen = t;
    this._pushTrail(m.x, m.y, t, false);
    return true;
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
    if (!p || p.hits < this._confirm) return true;
    const dt = Math.max(1 / 125, (t - p.t) / 1000);
    const xp = p.x + p.vx * dt, yp = p.y + p.vy * dt;
    const r = Math.hypot(m.x - xp, m.y - yp);
    const speed = Math.hypot(p.vx, p.vy);
    const gate = 0.1 + speed * dt * 2.5 + 0.05 * p.misses;
    // A confirmed track never jumps to a far detection. If the ball is truly
    // lost the track is dropped and re-acquired cleanly (four coherent frames
    // again), which is safe; letting a far blob in is how the marker "goes
    // everywhere".
    return r <= gate;
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

    // Before a track is confirmed, every detection must continue the motion
    // smoothly. A run that jumps around is noise — an arm here, a reflection
    // there — so restart the tentative track on the new point rather than
    // letting incoherent blobs accumulate into a false "confirmation". This is
    // what stops the marker locking onto anything that moves.
    if (!prev.confirmed && prev.hits >= 2 && Math.hypot(rx, ry) > COHERE_GATE) {
      this.track = { x: m.x, y: m.y, vx: 0, vy: 0, t, conf: m.conf ?? 0.5,
                     hits: 1, misses: 0, confirmed: false };
      this._lastSeen = t;
      this._pushTrail(m.x, m.y, t, false);
      return;
    }

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
    // Physical-motion gates: the ball is fast and flies smoothly. A slow,
    // coherent drift (a waving arm) is fast enough to move but not to fly, and
    // jittery motion isn't smooth — neither should confirm as the ball.
    this._pushTrail(x, y, t, false);          // push first so the fit sees this point
    const ballistic = this._ballisticScore();
    const fastEnough = speed >= this._minSpeed;
    const confirmed = prev.confirmed ||
      (hits >= this._confirm && fastEnough && ballistic >= this._ballisticMin);
    // The frame a track first confirms, adopt the ball's own colour as the
    // template so later frames track this specific ball, not a generic preset.
    if (confirmed && !prev.confirmed && m.color) this.ballTemplate = { ...m.color };

    // A bounce is the ball's downward motion reversing to upward. Reading it
    // from the smoothed velocity, with clear thresholds either side, is far
    // steadier than the old single-frame sign test, which both missed real
    // bounces and invented them from jitter.
    if (confirmed && prev.vy > BOUNCE_VY && vy < -BOUNCE_VY * 0.4) {
      this.onBallBounce({ x, y, t, side: this.sideOf({ x, y }), onTable: this.isOnTable({ x, y }) });
    }

    const conf = (m.conf ?? prev.conf) * (0.5 + 0.5 * ballistic);
    this.track = { x, y, vx, vy, t, conf, hits, misses: 0, confirmed, ballistic };
    this._checkBoundary({ x, y }, t);
    this._lastSeen = t;
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
      this.ballTemplate = null;   // back to the preset until we lock on again
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
    const net = [mid(corners[1], corners[2]), mid(corners[0], corners[3])];
    const centre = corners.reduce((a, c) => ({ x: a.x + c.x / 4, y: a.y + c.y / 4 }), { x: 0, y: 0 });
    const halfA = [corners[0], corners[1], net[0], net[1]];
    const halfB = [net[1], net[0], corners[2], corners[3]];
    // The two end lines are both one table-width long, so the difference in
    // their apparent length is the perspective foreshortening of the view.
    const nearMid = mid(corners[0], corners[3]);
    const farMid = mid(corners[1], corners[2]);
    // A homography turns the calibrated quad — foreshortened by whatever
    // angle the phone happens to sit at — into a true top-down rectangle:
    // c0 (A, near) and c3 (B, near) sit on the near edge, c1/c2 on the far
    // edge, matching the table's real proportions (length along x, width
    // along y) rather than the camera's. This is what the digital table view
    // and any "where is the ball really, on the table" question use.
    const homography = computeHomography(corners, [
      { x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 },
    ]);

    this.table = {
      corners: corners.map(c => ({ ...c })),
      net, centre, halfA, halfB,
      sideOfA: sign(cross(net[0], net[1], corners[0])),
      boundary: expand(corners, centre, 1 + this.outMargin),
      nearEnd: [corners[0], corners[3]],
      farEnd: [corners[1], corners[2]],
      nearMid, farMid,
      homography,
    };
    this._sizeProcWidth();
    return this.table;
  }

  /**
   * Where a point in the camera picture really is on the table, as a flat
   * top-down position — x 0..1 along the table's length (A to B), y 0..1
   * across its width. Undoes the camera's perspective entirely: unlike the
   * picture, equal distances on the table are equal distances here,
   * regardless of how close to or far from the camera they are.
   */
  topDownPoint(p) {
    if (!this.table?.homography) return null;
    return applyHomography(this.table.homography, p.x, p.y);
  }

  /** The table's real length-to-width ratio, for drawing the top-down view
   *  at the correct proportions rather than as a distorted square. */
  static get TOP_DOWN_ASPECT() { return TABLE_WIDTH_M / TABLE_LENGTH_M; }

  /**
   * Where the ball's actual flight is headed: a predicted landing point and,
   * if the path reaches it first, a predicted net crossing. Not a straight
   * line run forward — a straight line never lands anywhere — but the vertex
   * of a quadratic fitted to the ball's recent path, the same curve-fitting
   * `_ballisticScore` already uses to tell a real flight from an arm's
   * jitter. Returns null when there's no confident enough recent flight to
   * fit a curve to, or when neither a landing nor a net crossing falls
   * within the lookahead window.
   */
  predictedContact(horizonMs = 900) {
    if (!this.isLocked) return null;
    const pts = this.trail.filter(p => !p.predicted).slice(-8);
    if (pts.length < 4) return null;
    const t0 = pts[0].t;
    const ts = pts.map(p => (p.t - t0) / 1000);
    const fx = quadFit(ts, pts.map(p => p.x));
    const fy = quadFit(ts, pts.map(p => p.y));
    if (!fx || !fy) return null;

    const lastT = ts[ts.length - 1];
    const horizon = lastT + horizonMs / 1000;

    // The landing point is the vertex of the fitted curve in image-y — the
    // same proxy for height the bounce detector itself reads its reversal
    // from — not a run of the current velocity forward, which never curves
    // back down. A near-flat fit (|c| tiny) has no meaningful vertex within
    // reach, and is left null rather than reporting a wild, distant guess.
    let bounce = null;
    if (Math.abs(fy.c) > 1e-4) {
      const tVertex = -fy.b / (2 * fy.c);
      if (tVertex > lastT && tVertex <= horizon) {
        const x = fx.at(tVertex), y = fy.at(tVertex);
        if (x > -0.15 && x < 1.15 && y > -0.15 && y < 1.15) {
          bounce = { x, y, t: t0 + tVertex * 1000, onTable: this.isOnTable({ x, y }) };
        }
      }
    }

    // Net crossing: step the fitted curve forward and watch its TOP-DOWN
    // x-coordinate — 0.5 is the net, regardless of how the table is framed
    // — cross the midline, up to the predicted landing or the horizon,
    // whichever comes first. This is a position claim only: a single camera
    // has no way to know the ball's height above the table, so it is "the
    // path crosses the net's line," not "clears" or "clips" it — that call
    // is audio's to make (see Referee._nearNet), this is just showing where.
    let netCross = null;
    const limitT = bounce ? (bounce.t - t0) / 1000 : horizon;
    const STEP = 0.02;
    let prevSide = null;
    for (let t = lastT; t <= limitT; t += STEP) {
      const td = this.topDownPoint({ x: fx.at(t), y: fy.at(t) });
      if (!td) break;
      const side = Math.sign(td.x - 0.5) || 1;
      if (prevSide !== null && side !== prevSide) {
        netCross = { x: fx.at(t), y: fy.at(t), t: t0 + t * 1000 };
        break;
      }
      prevSide = side;
    }

    if (!bounce && !netCross) return null;
    return { bounce, netCross };
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
    const dx = t.farMid.x - t.nearMid.x, dy = t.farMid.y - t.nearMid.y;
    const len2 = dx * dx + dy * dy || 1e-9;
    const f = Math.min(1.4, Math.max(-0.4,
      ((p.x - t.nearMid.x) * dx + (p.y - t.nearMid.y) * dy) / len2));
    const widthHere = near + (far - near) * f;
    return Math.max(1.2, widthHere * (BALL_M / TABLE_WIDTH_M));
  }

  /** Choose a processing resolution from the geometry: the ball a few pixels
   *  across at the far end, no more, because every extra pixel is battery. */
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

  /** Choose what the ball looks like: 'white', 'orange', or a sampled colour. */
  setBallColor(c) { this.ballColor = c; this.ballTemplate = null; }

  /** 0 = track readily (may wander), 1 = only a clear ball locks on. */
  setStrictness(v) { this.strictness = clamp(v, 0, 1); this._applyStrictness(); }
  _applyStrictness() {
    const k = this.strictness;
    this._confirm = Math.round(2 + 3 * k);        // 2..5 coherent frames to trust
    // The alpha-beta filter's smoothed velocity briefly overshoots above a
    // drift's true steady-state speed during the first couple of confirming
    // frames, so the floor needs headroom over the nominal "arm speed", not
    // just to clear it at steady state.
    this._minSpeed = 0.20 + 0.62 * k;             // 0.20..0.82 frame-widths/s
    this._ballisticMin = 0.05 + 0.45 * k;         // 0.05..0.5 path smoothness
    this._acqColorFloor = 0.3 + 0.35 * k;         // 0.3..0.65 colour match to acquire
    // Everything above only ever controlled HOW a track is confirmed and
    // held. The colour and size windows in ballColorScore/_findBall were
    // fixed constants regardless of this dial, which meant turning
    // strictness all the way down still could not fix a ball that kept
    // failing on colour under real, uneven lighting — the slider looked
    // like it did nothing. They now widen at low strictness too, but only up
    // to a point: skin is noticeably less saturated than any regulation ball
    // colour, and that margin is kept intact even at strictness 0, on
    // purpose. Rejecting a hand is a correctness floor, not a preference —
    // the slider is for how patient the tracker is about a real ball, never
    // for whether it's willing to track an arm.
    this._colorTol = 1.2 - 0.2 * k;                // 1.2 (loose) .. 1.0 (tight)
    this._sizeTol = 1 + 0.8 * (1 - k);             // 1.8 (loose) .. 1 (tight)
    // How far from round a blob may be before it isn't ball-shaped. This is
    // the aspect ratio of a *stationary* candidate; a blob moving along its
    // own long axis is allowed BLUR_ELONG_FACTOR times this, because that is
    // what motion blur actually looks like.
    this._elongMax = 3.0 - 0.9 * k;                // 3.0 (loose) .. 2.1 (tight)
  }

  /** Sample the ball's colour from a patch of the current frame (tap the ball). */
  sampleBallColorAt(nx, ny) {
    const vw = this.video.videoWidth;
    if (!vw) return null;
    const W = 160, H = Math.round((W * this.video.videoHeight) / vw);
    this.proc.width = W; this.proc.height = H;
    this.pctx.drawImage(this.video, 0, 0, W, H);
    const d = this.pctx.getImageData(0, 0, W, H).data;
    const sx = Math.round(clamp(nx, 0.02, 0.98) * W), sy = Math.round(clamp(ny, 0.02, 0.98) * H);
    const rad = 3;
    let r = 0, g = 0, b = 0, k = 0;
    for (let y = Math.max(0, sy - rad); y < Math.min(H, sy + rad); y++)
      for (let x = Math.max(0, sx - rad); x < Math.min(W, sx + rad); x++) {
        const i = (y * W + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; k++;
      }
    this.prev = null; this.bg = null;
    this.ballColor = { r: r / k, g: g / k, b: b / k };
    this.ballTemplate = null;
    return this.ballColor;
  }

  /**
   * How well a colour matches the ball, 0..1, and whether it passes at all.
   * White: bright and unsaturated. Orange: the ball's hue, saturated. A
   * sampled colour: close in chromaticity. This is the gate that rejects skin,
   * shirts, the table and shadows whatever their motion.
   */
  ballColorScore(r, g, bl) {
    // Once the tracker has locked on, it matches the ball's own measured
    // colour — tighter and more specific than the white/orange preset, and it
    // adapts to the exact ball and lighting. It falls back to the preset the
    // moment the ball is lost.
    const tol = this._colorTol ?? 1.5;   // widened by strictness — see _applyStrictness
    if (this.ballTemplate) {
      const c = this.ballTemplate;
      const t1 = r + g + bl + 1, t2 = c.r + c.g + c.b + 1;
      const dc = Math.abs(r / t1 - c.r / t2) + Math.abs(g / t1 - c.g / t2);
      const dl = Math.abs((r + g + bl) / 3 - (c.r + c.g + c.b) / 3);
      const dcMax = 0.07 * tol, dlMax = 90 * tol;
      if (dc > dcMax || dl > dlMax) return { pass: false, score: 0 };
      return { pass: true, score: 0.4 + 0.6 * clamp(1 - dc / dcMax, 0, 1) };
    }
    const max = Math.max(r, g, bl), min = Math.min(r, g, bl);
    const v = max, sat = max === 0 ? 0 : (max - min) / max;
    if (this.ballColor === 'white') {
      // A white ball is bright and nearly colourless. Skin, wood and warm
      // lighting are all more saturated than this, which is what separates
      // them out.
      const satMax = 0.25 * tol, vMin = 105 / tol;
      if (v < vMin || sat > satMax) return { pass: false, score: 0 };
      const bright = clamp((v - vMin) / 150, 0, 1);
      const white = clamp(1 - sat / satMax, 0, 1);
      return { pass: true, score: 0.35 + 0.65 * bright * white };
    }
    if (this.ballColor === 'orange') {
      // Hue of orange is where red is high, green mid, blue low.
      let h = 0;
      const d2 = max - min || 1;
      if (max === r) h = 60 * (((g - bl) / d2) % 6);
      else if (max === g) h = 60 * ((bl - r) / d2 + 2);
      else h = 60 * ((r - g) / d2 + 4);
      if (h < 0) h += 360;
      // Orange balls are vividly saturated; skin shares the hue but is far
      // less saturated, so a high saturation floor is what tells them apart.
      const hueSpread = 20 * tol, satMin = 0.5 / tol, vMin = 80 / tol;
      const hueOk = h >= 28 - hueSpread && h <= 28 + hueSpread;
      if (!hueOk || sat < satMin || v < vMin) return { pass: false, score: 0 };
      const hueFit = 1 - Math.abs(h - 28) / hueSpread;
      return { pass: true, score: 0.35 + 0.65 * clamp(hueFit, 0, 1) * clamp(sat, 0, 1) };
    }
    // Sampled colour: compare chromaticity and brightness.
    const c = this.ballColor;
    const t1 = r + g + bl + 1, t2 = c.r + c.g + c.b + 1;
    const dc = Math.abs(r / t1 - c.r / t2) + Math.abs(g / t1 - c.g / t2);
    const dl = Math.abs((r + g + bl) / 3 - (c.r + c.g + c.b) / 3);
    const dcMax = 0.08 * tol, dlMax = 110 * tol;
    if (dc > dcMax || dl > dlMax) return { pass: false, score: 0 };
    return { pass: true, score: 0.4 + 0.6 * clamp(1 - dc / dcMax, 0, 1) };
  }

  /** True only when the tracker is genuinely locked on the ball (confirmed
   *  and still being seen) — the same condition that draws the marker. */
  get isLocked() {
    return !!(this.track && this.track.confirmed && this.track.misses < 4);
  }

  /** Start or stop hunting for the ball. */
  setTracking(on) {
    this.tracking = on;
    if (on) this.captureBackground();
    else { this.track = null; this.trail.length = 0; }
  }

  /**
   * Find the table and place the box on it. With no seed it searches a grid of
   * seed points and keeps the most table-shaped result, so it does not depend
   * on the table being centred; with a seed (the user tapped the table) it
   * grows from exactly there. Returns { corners, coverage, fill } or null.
   */
  scanTable(seed = null) {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw) return null;

    const W = 160, H = Math.round((W * vh) / vw);
    this.proc.width = W; this.proc.height = H;
    this.pctx.drawImage(this.video, 0, 0, W, H);
    const d = this.pctx.getImageData(0, 0, W, H).data;
    this.prev = null; this.bg = null;      // the frame size changed under us

    let best = null;
    if (seed) {
      best = this._tableFromSeed(d, W, H, seed.x, seed.y);
    } else {
      // Try a spread of seed points and keep the best-scoring table. The floor
      // and clutter produce low-scoring regions; the table, wherever it is,
      // produces a large one that fills its own quad.
      for (let gy = 0.35; gy <= 0.75; gy += 0.2) {
        for (let gx = 0.25; gx <= 0.75; gx += 0.25) {
          const cand = this._tableFromSeed(d, W, H, gx, gy);
          if (cand && (!best || cand.score > best.score)) best = cand;
        }
      }
    }
    if (!best) return null;

    this.setTable(best.corners);
    return { corners: best.corners, coverage: best.coverage, fill: best.fill };
  }

  /** Grow a table region from one seed point and fit a box to it. */
  _tableFromSeed(d, W, H, seedNx, seedNy) {
    const sx = Math.round(clamp(seedNx, 0.05, 0.95) * W);
    const sy = Math.round(clamp(seedNy, 0.05, 0.95) * H);

    // Seed colour: the average of a small patch, so one stray pixel (a line, a
    // reflection) doesn't set the reference.
    const rad = Math.max(3, (W * 0.05) | 0);
    let sr = 0, sg = 0, sb = 0, sn = 0;
    for (let y = Math.max(0, sy - rad); y < Math.min(H, sy + rad); y++) {
      for (let x = Math.max(0, sx - rad); x < Math.min(W, sx + rad); x++) {
        const i = (y * W + x) * 4;
        sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sn++;
      }
    }
    const seedColor = { r: sr / sn, g: sg / sn, b: sb / sn };

    // Compare by chromaticity plus a loose brightness band, so shading across
    // a real table does not split it into two different "colours".
    const chroma = (r, g, b) => { const t = r + g + b + 1; return [r / t, g / t]; };
    const [scr, scg] = chroma(seedColor.r, seedColor.g, seedColor.b);
    const seedLum = (seedColor.r + seedColor.g + seedColor.b) / 3;
    const CHROMA_TOL = 0.06, LUM_TOL = 100;

    let mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const [cr, cg] = chroma(r, g, b);
        if (Math.abs(cr - scr) + Math.abs(cg - scg) > CHROMA_TOL) continue;
        if (Math.abs((r + g + b) / 3 - seedLum) > LUM_TOL) continue;
        mask[y * W + x] = 1;
      }
    }

    // Close small gaps: the white net line and glare split the table into
    // pieces, and a dilate-then-erode bridges them back into one surface.
    mask = morphClose(mask, W, H, 1);

    const seedIdx = sy * W + sx;
    let region = mask[seedIdx] ? regionContaining(mask, W, H, seedIdx) : largestRegion(mask, W, H);
    if (!region || region.size < W * H * 0.02) return null;

    // Rebuild a mask of just this region, fill any holes inside it (glare
    // spots, the ball), then shave one pixel off the edge so a thin bleed into
    // a similar-coloured floor doesn't push the corners out.
    let rmask = new Uint8Array(W * H);
    for (const idx of region.pixels) rmask[idx] = 1;
    rmask = fillHoles(rmask, W, H);
    const eroded = morphErode(rmask, W, H, 1);
    const useMask = countMask(eroded) > W * H * 0.015 ? eroded : rmask;

    // Fit a quad from the extreme points along both diagonals — for a
    // rectangle in perspective these land near its four corners.
    let tlv = Infinity, brv = -Infinity, trv = -Infinity, blv = Infinity;
    let tl, br, tr, bl, minX = W, maxX = 0, minY = H, maxY = 0, size = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!useMask[y * W + x]) continue;
        size++;
        const sum = x + y, diff = x - y;
        if (sum < tlv) { tlv = sum; tl = { x, y }; }
        if (sum > brv) { brv = sum; br = { x, y }; }
        if (diff > trv) { trv = diff; tr = { x, y }; }
        if (diff < blv) { blv = diff; bl = { x, y }; }
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (!tl || size < W * H * 0.015) return null;
    // A region spanning essentially the whole frame on EITHER axis is the
    // background (the floor or a wall filling the view), not a table sitting
    // inside the frame — a real table, framed as the app asks, does not run
    // edge-to-edge in a real shot.
    const spansXfull = minX < 0.03 * W && maxX > 0.97 * W;
    const spansYfull = minY < 0.03 * H && maxY > 0.97 * H;
    if (spansXfull || spansYfull) return null;

    const norm = p => ({ x: p.x / W, y: p.y / H });
    const corners = [norm(bl), norm(tl), norm(tr), norm(br)];
    const area = Math.abs(polygonArea(corners));
    if (area < 0.015) return null;

    const fill = (size / (W * H)) / area;   // how well the region fills its quad
    if (fill < 0.5) return null;
    const coverage = region.size / (W * H);
    // Prefer a big region that fills its quad well and doesn't run to the edge.
    // Touching two opposite edges is background-like; penalise it so a real
    // table that merely reaches the bottom edge is still preferred.
    const spansX = minX < 0.03 * W && maxX > 0.97 * W;
    const spansY = minY < 0.03 * H && maxY > 0.97 * H;
    const edgePenalty = (spansX || spansY) ? 0.5 : 1;
    const score = coverage * fill * edgePenalty;
    return { corners, coverage, fill, score };
  }

  /** Remember the current frame as the empty-table background. */  /** Remember the current frame as the empty-table background. */
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

  /** Give the tracker a canvas to render the top-down table view into. */
  setTopDownCanvas(canvas) {
    this.topDownCanvas = canvas;
    this.topDownCtx = canvas.getContext('2d');
  }

  _draw() {
    const ctx = this.octx, W = this.overlay.width, H = this.overlay.height;
    ctx.clearRect(0, 0, W, H);
    this._drawTopDown();

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

    // Only draw the marker when the tracker is genuinely locked on: a
    // confirmed track that is still being seen (not coasting for long). When
    // it isn't sure, it shows nothing — an honest blank beats a marker
    // flailing around the room chasing arms and shadows.
    const locked = this.track && this.track.confirmed && this.track.misses < 4;
    if (!locked) return;

    const recent = this.trail.filter(p => this.track.t - p.t < 260);
    if (recent.length > 1) {
      ctx.strokeStyle = 'rgba(255,220,80,.55)'; ctx.lineWidth = 2;
      ctx.beginPath();
      recent.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
      ctx.stroke();
    }

    // Where it's headed, not just where it's been — but as the two contact
    // points that actually matter (will it land on the table, does its path
    // cross the net), not a line drawn forward from where it is now.
    this._drawContactMarkers(ctx, W, H, p => ({ x: p.x * W, y: p.y * H }));

    ctx.strokeStyle = '#ffdc50'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(this.track.x * W, this.track.y * H, 10, 0, Math.PI * 2); ctx.stroke();
  }

  /** Draw the predicted landing/net-crossing markers `toCanvas` maps into.
   *  `toCanvas` may return null (a top-down mapping can fail without a
   *  homography), in which case that marker is simply skipped. */
  _drawContactMarkers(ctx, W, H, toCanvas) {
    const contact = this.predictedContact();
    if (!contact) return;
    if (contact.netCross) {
      const c = toCanvas(contact.netCross);
      if (c) {
        ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(c.x - 7, c.y); ctx.lineTo(c.x + 7, c.y);
        ctx.moveTo(c.x, c.y - 7); ctx.lineTo(c.x, c.y + 7); ctx.stroke();
      }
    }
    if (contact.bounce) {
      const c = toCanvas(contact.bounce);
      if (c) {
        ctx.strokeStyle = contact.bounce.onTable ? 'rgba(120,220,255,.85)' : 'rgba(248,81,73,.85)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(c.x, c.y, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(c.x, c.y, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = ctx.strokeStyle; ctx.fill();
      }
    }
  }

  /**
   * The digital table: a true top-down diagram, drawn from the homography
   * rather than from the picture. The camera's own view is a trapezoid —
   * the far end always looks smaller and a ball near it looks closer to the
   * net than it really is. This corrects that entirely: on this view, equal
   * distances on the real table are equal distances on screen, which is
   * what makes it worth having alongside the camera feed rather than
   * instead of it.
   */
  _drawTopDown() {
    const ctx = this.topDownCtx;
    if (!ctx) return;
    const canvas = this.topDownCanvas;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    }
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!this.table) return;

    // Fit the table rectangle (real proportions, from TOP_DOWN_ASPECT) inside
    // the canvas with a margin, independent of the canvas's own aspect ratio.
    const aspect = VisionReferee.TOP_DOWN_ASPECT;   // height / width, table is wider than tall
    const pad = Math.min(W, H) * 0.08;
    let tw = W - pad * 2, th = tw * aspect;
    if (th > H - pad * 2) { th = H - pad * 2; tw = th / aspect; }
    const ox = (W - tw) / 2, oy = (H - th) / 2;
    const toCanvas = p => ({ x: ox + p.x * tw, y: oy + p.y * th });

    // The out-of-bounds margin, drawn the same way as on the camera view.
    const m = this.outMargin;
    ctx.strokeStyle = 'rgba(248,81,73,.6)'; ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(ox - tw * m, oy - th * m, tw * (1 + 2 * m), th * (1 + 2 * m));
    ctx.setLineDash([]);

    // The table itself.
    ctx.fillStyle = '#123a5e';
    ctx.fillRect(ox, oy, tw, th);
    ctx.strokeStyle = 'rgba(74,163,255,.9)'; ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, tw, th);

    // The net, running across the middle — table-space x = 0.5 by construction.
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(ox + tw / 2, oy); ctx.lineTo(ox + tw / 2, oy + th); ctx.stroke();
    ctx.setLineDash([]);

    const labelSize = Math.max(14, tw * 0.07);
    ctx.font = `700 ${labelSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#4aa3ff'; ctx.fillText('A', ox + tw * 0.22, oy + th / 2);
    ctx.fillStyle = '#ff8a4a'; ctx.fillText('B', ox + tw * 0.78, oy + th / 2);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';

    if (!this.isLocked) return;

    // The ball's true position on the table, and where it's headed — the
    // whole reason this view exists. Off the table entirely (outByFraction)
    // is drawn past the rectangle's edge rather than clamped onto it, so an
    // out ball visibly leaves the table here too.
    const tdBall = this.topDownPoint(this.track);
    if (!tdBall) return;

    const trail = this.trail.filter(p => this.track.t - p.t < 400).map(p => this.topDownPoint(p)).filter(Boolean);
    if (trail.length > 1) {
      ctx.strokeStyle = 'rgba(255,220,80,.5)'; ctx.lineWidth = 2;
      ctx.beginPath();
      trail.forEach((p, i) => { const c = toCanvas(p); i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y); });
      ctx.stroke();
    }

    // The same predicted landing/net-crossing markers as the camera view,
    // mapped through the homography onto true table coordinates instead of
    // the camera's foreshortened ones.
    this._drawContactMarkers(ctx, W, H, p => {
      const tp = this.topDownPoint(p);
      return tp ? toCanvas(tp) : null;
    });

    const bc = toCanvas(tdBall);
    ctx.fillStyle = '#ffdc50'; ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(bc.x, bc.y, Math.max(4, tw * 0.018), 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
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
function connectedBlobs(mask, weight, rgba, w, x0, y0, x1, y1) {
  const blobs = [];
  const stack = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const start = y * w + x;
      if (mask[start] !== 1) continue;
      stack.length = 0;
      stack.push(start);
      mask[start] = 2;
      const c = { n: 0, sx: 0, sy: 0, sw: 0, x0: x, x1: x, y0: y, y1: y, cr: 0, cg: 0, cb: 0,
                  mx: 0, my: 0, mxx: 0, myy: 0, mxy: 0 };
      while (stack.length) {
        const i = stack.pop();
        const ix = i % w, iy = (i / w) | 0;
        const s = weight[i];
        c.n++; c.sx += ix * s; c.sy += iy * s; c.sw += s;
        const p4 = i * 4; c.cr += rgba[p4]; c.cg += rgba[p4 + 1]; c.cb += rgba[p4 + 2];
        c.mx += ix; c.my += iy; c.mxx += ix * ix; c.myy += iy * iy; c.mxy += ix * iy;
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

/**
 * The shape of a blob, from its pixel covariance rather than its bounding
 * box — a box is fooled by a diagonal streak, which fills a perfectly square
 * box while being nothing like round.
 *
 * Returns roundness (1 for a disc, →0 as it stretches into a line), the
 * aspect ratio of the blob, and which way its long axis points. The axis
 * direction is what makes it possible to allow motion blur without allowing
 * every elongated thing in the room: a blurred ball is stretched ALONG its
 * travel, an arm edge or a table line is stretched whichever way it happens
 * to lie.
 *
 * `measurable` is false for a blob too small to have a shape at all. That is
 * deliberately distinct from "measured as not round": a two-pixel speck has
 * no orientation to check, and must be judged on size instead of being
 * quietly handed the benefit of the doubt.
 */
function blobShape(c) {
  const none = { round: 0, elong: Infinity, angle: 0, measurable: false };
  if (c.n < 4) return none;
  const mx = c.mx / c.n, my = c.my / c.n;
  const vxx = c.mxx / c.n - mx * mx;
  const vyy = c.myy / c.n - my * my;
  const vxy = c.mxy / c.n - mx * my;
  const tr = vxx + vyy;
  const det = vxx * vyy - vxy * vxy;
  const root = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + root;          // variance along the major axis
  const l2 = tr / 2 - root;          // ... and the minor
  if (l1 <= 1e-6) return none;
  const round = Math.max(0, l2 / l1);
  // Axis *lengths* go as the square root of the variances, so the blob's
  // aspect ratio is the square root of the eigenvalue ratio, not the ratio.
  const elong = Math.sqrt(1 / Math.max(round, 1e-6));
  // Eigenvector for l1: (vxy, l1 - vxx) satisfies M·e = l1·e. When vxy is ~0
  // the matrix is already diagonal and the axis is simply x or y.
  const angle = Math.abs(vxy) < 1e-9
    ? (vxx >= vyy ? 0 : Math.PI / 2)
    : Math.atan2(l1 - vxx, vxy);
  return { round, elong, angle, measurable: true };
}

/** Count set pixels in a mask. */
function countMask(m) { let n = 0; for (let i = 0; i < m.length; i++) if (m[i]) n++; return n; }

/** Dilate a binary mask by `r` (4-neighbour growth, repeated). */
function morphDilate(mask, W, H, r = 1) {
  let cur = mask;
  for (let pass = 0; pass < r; pass++) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (cur[i] || (x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1]) ||
            (y > 0 && cur[i - W]) || (y < H - 1 && cur[i + W])) out[i] = 1;
      }
    }
    cur = out;
  }
  return cur;
}

/** Erode a binary mask by `r` (drop any pixel with a missing 4-neighbour). */
function morphErode(mask, W, H, r = 1) {
  let cur = mask;
  for (let pass = 0; pass < r; pass++) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!cur[i]) continue;
        if (x === 0 || x === W - 1 || y === 0 || y === H - 1) continue;
        if (cur[i - 1] && cur[i + 1] && cur[i - W] && cur[i + W]) out[i] = 1;
      }
    }
    cur = out;
  }
  return cur;
}

/** Closing = dilate then erode: bridges thin gaps (the net line, glare). */
function morphClose(mask, W, H, r = 1) {
  return morphErode(morphDilate(mask, W, H, r), W, H, r);
}

/** Fill holes: background not connected to the frame edge becomes foreground. */
function fillHoles(mask, W, H) {
  const outside = new Uint8Array(W * H);
  const stack = [];
  const pushIf = i => { if (!mask[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { pushIf(x); pushIf((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { pushIf(y * W); pushIf(y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i / W) | 0;
    if (x > 0) pushIf(i - 1);
    if (x < W - 1) pushIf(i + 1);
    if (y > 0) pushIf(i - W);
    if (y < H - 1) pushIf(i + W);
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] || !outside[i] ? 1 : 0;
  return out;
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

/**
 * Perspective transform (homography) mapping four source points to four
 * destination points, via the standard direct linear transform: eight point
 * coordinates give eight linear equations in the eight unknowns of a 3x3
 * matrix with h33 fixed at 1, solved by Gaussian elimination. This is what
 * turns the calibrated table — a quadrilateral, foreshortened by the
 * camera's angle — into a true top-down rectangle: every point on the table
 * has one consistent flat position, not one that depends on the camera's
 * viewpoint.
 */
function computeHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x: sx, y: sy } = src[i], { x: dx, y: dy } = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]); b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]); b.push(dy);
  }
  const h = solveLinear(A, b);
  return h && [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Solve an 8x8 linear system by Gaussian elimination with partial pivoting. */
function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-10) return null;   // degenerate — corners too nearly collinear
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Apply a homography to one point. */
function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * RMS residual of a least-squares quadratic fit y = a + b·t + c·t². Small when
 * the samples lie on a smooth constant-acceleration curve (a flying ball),
 * large when they jitter. Solves the 3×3 normal equations by Cramer's rule.
 */
/**
 * Least-squares quadratic y = a + b*t + c*t^2 through the given points.
 * Returns null for a degenerate (too-clustered) set of t values.
 */
function quadFit(ts, ys) {
  const n = ts.length;
  let S0 = n, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
  for (let i = 0; i < n; i++) {
    const t = ts[i], y = ys[i], t2 = t * t;
    S1 += t; S2 += t2; S3 += t2 * t; S4 += t2 * t2;
    T0 += y; T1 += t * y; T2 += t2 * y;
  }
  const det = (a, b, c, d, e, f, g, h, i) =>
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const D = det(S0, S1, S2, S1, S2, S3, S2, S3, S4);
  if (Math.abs(D) < 1e-12) return null;
  const a = det(T0, S1, S2, T1, S2, S3, T2, S3, S4) / D;
  const b = det(S0, T0, S2, S1, T1, S3, S2, T2, S4) / D;
  const c = det(S0, S1, T0, S1, S2, T1, S2, S3, T2) / D;
  return { a, b, c, at: t => a + b * t + c * t * t };
}

function quadFitResidual(ts, ys) {
  const fit = quadFit(ts, ys);
  if (!fit) return 0;
  let sse = 0;
  for (let i = 0; i < ts.length; i++) sse += (ys[i] - fit.at(ts[i])) ** 2;
  return Math.sqrt(sse / ts.length);
}
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
