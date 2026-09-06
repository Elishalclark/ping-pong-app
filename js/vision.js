// Camera front end: table calibration plus a lightweight ball tracker.
//
// The tracker works on a downscaled greyscale copy of the frame. A ping-pong
// ball is small, bright and the fastest thing in the picture, so scoring each
// pixel by (frame difference x brightness) and taking the best small cluster
// finds it without any model or library. Motion prediction from the previous
// two frames keeps it locked on through a fast rally and rejects the much
// larger blobs made by arms and shirts.


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
    this.pending = null;        // corners being placed during calibration
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
    this.video.srcObject = this.stream;
    await this.video.play();
    this._running = true;
    requestAnimationFrame(this._loop);
    return this.stream;
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
    this.video.srcObject = this.stream;
    await this.video.play();
    return this.facing;
  }

  stop() {
    this._running = false;
    this.stream?.getTracks().forEach(t => t.stop());
  }

  _loop = () => {
    if (!this._running) return;
    if (this.video.readyState >= 2) this._frame();
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

    this.pctx.drawImage(this.video, 0, 0, W, ph);
    const frame = this.pctx.getImageData(0, 0, W, ph);
    const found = this._findBall(frame, W, ph, t);
    this._updateTrack(found, t);
    this._draw();

    // Tracking a ball is worthless if it costs so much that frames are
    // dropped, so trade resolution for frame rate until the phone keeps up.
    const cost = performance.now() - t;
    this._cost = this._cost ? this._cost * 0.9 + cost * 0.1 : cost;
    if (this._cost > 11 && this.procWidth > 128) this.procWidth -= 16;
    else if (this._cost < 4 && this.procWidth < 224) this.procWidth += 8;

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
    if (!this.prev || this.prev.length !== n) { this.prev = grey; return null; }

    // Where do we expect the ball? Prediction tightens the search and stops a
    // waving arm from stealing the track.
    let px = -1, py = -1;
    if (this.track && t - this.track.t < 120) {
      const dt = (t - this.track.t) / 1000;
      px = (this.track.x + this.track.vx * dt) * w;
      py = (this.track.y + this.track.vy * dt) * h;
    }
    const searchR = px >= 0 ? Math.max(18, Math.hypot(this.track.vx * w, this.track.vy * h) * 0.09 + 16) : 1e9;

    const thr = this.motionThreshold;
    let best = null;
    const pts = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const diff = Math.abs(grey[i] - this.prev[i]);
        if (diff < thr) continue;
        if (px >= 0 && Math.hypot(x - px, y - py) > searchR) continue;
        // Bright pixels only: the ball is white or orange, brighter than most
        // of what moves behind it.
        const bright = grey[i];
        if (bright < 90) continue;
        pts.push({ x, y, s: diff * (bright / 255) });
      }
    }
    this.prev = grey;
    if (!pts.length) return null;

    // Cluster greedily; a ball at this scale is only a few pixels across, so
    // clusters bigger than ~90 px are limbs or camera shake, not the ball.
    const clusters = [];
    for (const p of pts) {
      let c = clusters.find(c => Math.abs(c.cx - p.x) < 6 && Math.abs(c.cy - p.y) < 6);
      if (!c) { c = { sx: 0, sy: 0, sw: 0, n: 0, cx: p.x, cy: p.y }; clusters.push(c); }
      c.sx += p.x * p.s; c.sy += p.y * p.s; c.sw += p.s; c.n++;
      c.cx = c.sx / c.sw; c.cy = c.sy / c.sw;
      if (clusters.length > 220) break;
    }
    for (const c of clusters) {
      if (c.n > 90 || c.n < 2) continue;
      const compact = 1 / (1 + c.n / 30);
      let score = (c.sw / c.n) * compact;
      if (px >= 0) score *= 1 / (1 + Math.hypot(c.cx - px, c.cy - py) / 25);
      if (!best || score > best.score) best = { x: c.cx / w, y: c.cy / h, score, n: c.n };
    }
    if (!best) return null;
    return { ...best, t, conf: Math.min(1, best.score / 40) };
  }

  _updateTrack(found, t) {
    if (!found) {
      if (this.track && t - this._lastSeen > 400) {
        const last = this.track;
        this.track = null;
        this.trail.length = 0;
        this.onLost(last);
      }
      return;
    }
    const prev = this.track;
    let vx = 0, vy = 0;
    if (prev && t - prev.t > 0 && t - prev.t < 200) {
      const dt = (t - prev.t) / 1000;
      vx = (found.x - prev.x) / dt;
      vy = (found.y - prev.y) / dt;
      // A downward-then-upward flip is a bounce as far as the camera can tell.
      if (prev.vy > 0.12 && vy < -0.12) {
        this.onBallBounce({ x: found.x, y: found.y, t, side: this.sideOf(found), onTable: this.isOnTable(found) });
      }
    }
    this.track = { x: found.x, y: found.y, vx, vy, t, conf: found.conf };
    this._lastSeen = t;
    this.trail.push({ x: found.x, y: found.y, t });
    if (this.trail.length > 40) this.trail.shift();
  }

  /** Ball position at (or nearest to) a moment in time — used to place a sound. */
  positionAt(wallTime, windowMs = 120) {
    let best = null, bestDt = Infinity;
    for (const p of this.trail) {
      const dt = Math.abs(p.t - wallTime);
      if (dt < bestDt) { bestDt = dt; best = p; }
    }
    if (!best || bestDt > windowMs) return null;
    return { ...best, dt: bestDt };
  }

  // --- table geometry ----------------------------------------------------

  /**
   * corners: 4 normalised points, walked around the table starting at the
   * corner of A's end nearest the camera. So c0-c1 is A's end line, c2-c3 is
   * B's end line, and the net crosses the midpoints of the two long edges.
   */
  setTable(corners) {
    const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    const net = [mid(corners[1], corners[2]), mid(corners[0], corners[3])];
    this.table = { corners: corners.map(c => ({ ...c })), net, sideOfA: sign(cross(net[0], net[1], corners[0])) };
    return this.table;
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
    if (!this.showDebug) return;

    // Corners being placed, and the handles that let a finger move them.
    const handles = this.pending?.length ? this.pending : this.table?.corners;
    if (handles) {
      ctx.lineWidth = 2;
      for (const p of handles) {
        ctx.strokeStyle = 'rgba(255,255,255,.95)';
        ctx.fillStyle = 'rgba(74,163,255,.35)';
        ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 14, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }

    if (this.table) {
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

      ctx.fillStyle = 'rgba(74,163,255,.9)'; ctx.font = '600 16px system-ui';
      ctx.fillText('A', ((c[0].x + c[1].x) / 2) * W - 6, ((c[0].y + c[1].y) / 2) * H - 8);
      ctx.fillStyle = 'rgba(255,138,74,.9)';
      ctx.fillText('B', ((c[2].x + c[3].x) / 2) * W - 6, ((c[2].y + c[3].y) / 2) * H - 8);
    }

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
}

// --- small geometry helpers ---------------------------------------------
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
