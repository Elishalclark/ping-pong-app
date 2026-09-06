// Geometry tests for the tracker: table halves, the out-of-bounds line, and
// the crossing rule. These are the decisions that turn a pixel position into
// a ruling, so they are worth pinning down away from a real camera.
import test from 'node:test';
import assert from 'node:assert/strict';

// The module reaches for a canvas at construction; a stub is enough since
// none of the geometry touches it.
const stubCanvas = () => ({ width: 0, height: 0, getContext: () => ({}) });
globalThis.document = { createElement: stubCanvas };
globalThis.screen = { width: 1280, height: 720 };

const { VisionReferee } = await import('../js/vision.js');

// A table drawn in perspective: A's end nearest the camera on the left.
const CORNERS = [
  { x: 0.20, y: 0.75 },  // A end, near
  { x: 0.30, y: 0.40 },  // A end, far
  { x: 0.72, y: 0.40 },  // B end, far
  { x: 0.82, y: 0.75 },  // B end, near
];

const make = (margin = 0.35) => {
  const v = new VisionReferee({}, stubCanvas());
  v.outMargin = margin;
  v.setTable(CORNERS);
  return v;
};

test('the two halves are split by the net line', () => {
  const v = make();
  assert.equal(v.sideOf({ x: 0.30, y: 0.6 }), 'A');
  assert.equal(v.sideOf({ x: 0.70, y: 0.6 }), 'B');
});

test('a point on the table is on the table, and one beside it is not', () => {
  const v = make();
  assert.equal(v.isOnTable({ x: 0.5, y: 0.55 }), true);
  assert.equal(v.isOnTable({ x: 0.5, y: 0.95 }), false);
});

test('the out-of-bounds line sits outside the table, not on it', () => {
  const v = make(0.35);
  // Just off the end of the table is still in play: that is where players
  // stand to strike the ball.
  const justOff = { x: 0.88, y: 0.78 };
  assert.equal(v.isOnTable(justOff), false);
  assert.equal(v.isInsideBoundary(justOff), true);
  // Far out is not.
  assert.equal(v.isInsideBoundary({ x: 1.4, y: 0.95 }), false);
});

test('a wider margin puts more of the room in play', () => {
  const far = { x: 1.05, y: 0.85 };
  assert.equal(make(0.15).isInsideBoundary(far), false);
  assert.equal(make(1.0).isInsideBoundary(far), true);
});

test('setOutMargin moves the line without recalibrating the table', () => {
  const v = make(0.15);
  const far = { x: 1.05, y: 0.85 };
  assert.equal(v.isInsideBoundary(far), false);
  v.setOutMargin(1.0);
  assert.equal(v.isInsideBoundary(far), true);
  assert.deepEqual(v.table.corners, CORNERS);
});

// --- the crossing rule --------------------------------------------------

/** Feed a straight line of positions through the tracker on a monotonic clock. */
function fly(v, from, to, steps = 8) {
  const calls = [];
  v.onBallOut = info => calls.push(info);
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    v.__clock = (v.__clock ?? 1000) + 16;
    v._updateTrack({
      x: from.x + (to.x - from.x) * f,
      y: from.y + (to.y - from.y) * f,
      t: v.__clock, conf: 1,
    }, v.__clock);
  }
  return calls;
}

test('a ball flying off the court is called out, once', () => {
  const v = make();
  const calls = fly(v, { x: 0.6, y: 0.55 }, { x: 1.6, y: 1.0 });
  assert.equal(calls.length, 1, 'one call, not one per frame');
});

test('a ball played from behind the end line is not out', () => {
  const v = make();
  // Starts outside the boundary and travels towards the table — this is a
  // player striking the ball, which happens on nearly every rally.
  const calls = fly(v, { x: 1.5, y: 0.95 }, { x: 0.5, y: 0.55 });
  assert.equal(calls.length, 0);
});

test('a ball that stays over the table is never out', () => {
  const v = make();
  const calls = fly(v, { x: 0.3, y: 0.55 }, { x: 0.7, y: 0.55 });
  assert.equal(calls.length, 0);
});

test('leaving, returning and leaving again is called twice', () => {
  const v = make();
  const out1 = fly(v, { x: 0.6, y: 0.55 }, { x: 1.6, y: 1.0 });
  const back = fly(v, { x: 1.6, y: 1.0 }, { x: 0.6, y: 0.55 });   // comes back in
  const out2 = fly(v, { x: 0.6, y: 0.55 }, { x: 1.6, y: 1.0 });   // and leaves again
  assert.deepEqual(
    [out1.length, back.length, out2.length], [1, 0, 1],
    'the boundary re-arms once the ball is back in play');
});

test('position lookup matches a sound to where the ball was', () => {
  const v = make();
  fly(v, { x: 0.3, y: 0.55 }, { x: 0.7, y: 0.55 });
  const mid = v.__clock - 64;                    // a moment mid-flight
  const near = v.positionAt(mid, 120);
  assert.ok(near, 'a moment inside the window resolves');
  const far = v.positionAt(v.__clock + 4000, 120);
  assert.equal(far, null, 'a moment with no ball near it does not');
});

// --- ball size from the table's real dimensions -------------------------

test('the ball is expected to look bigger near the camera than far from it', () => {
  const v = make();
  const W = 192, H = 144;
  const near = v.expectedBallPx(v.table.nearMid, W, H);
  const far = v.expectedBallPx(v.table.farMid, W, H);
  assert.ok(near > far, `near ${near} should exceed far ${far}`);
});

test('expected ball size follows the table’s real proportions', () => {
  const v = make();
  const W = 192, H = 144;
  // The near end line is one table width (1.525 m) long; a 40 mm ball there
  // must measure that fraction of it.
  const nearLen = Math.hypot(
    (CORNERS[0].x - CORNERS[3].x) * W, (CORNERS[0].y - CORNERS[3].y) * H);
  const expected = nearLen * (0.04 / 1.525);
  const got = v.expectedBallPx(v.table.nearMid, W, H);
  assert.ok(Math.abs(got - expected) < expected * 0.05,
    `expected about ${expected.toFixed(2)}px, got ${got.toFixed(2)}px`);
});

test('processing resolution is chosen so the ball is a few pixels across', () => {
  const wide = new VisionReferee({}, stubCanvas());
  wide.setTable(CORNERS);
  assert.ok(wide.procWidth >= 144 && wide.procWidth <= 288, `got ${wide.procWidth}`);
  // A table that fills less of the frame needs more resolution, not less.
  const small = new VisionReferee({}, stubCanvas());
  small.setTable([
    { x: 0.42, y: 0.56 }, { x: 0.46, y: 0.46 },
    { x: 0.58, y: 0.46 }, { x: 0.62, y: 0.56 },
  ]);
  assert.ok(small.procWidth >= wide.procWidth,
    `small table ${small.procWidth} should not be coarser than large ${wide.procWidth}`);
});

// --- what counts as a ball ----------------------------------------------

/** A flat grey frame with bright discs painted on it. */
function frameWith(w, h, blobs, base = 70) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = base;
    data[i * 4 + 3] = 255;
  }
  for (const { x, y, r, v = 240 } of blobs) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const px = Math.round(x + dx), py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const i = (py * w + px) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
      }
    }
  }
  return { data };
}

/** Prime the background model, then detect on a frame containing blobs. */
function detect(v, w, h, blobs) {
  v.prev = null; v.bg = null; v.track = null;
  v._findBall(frameWith(w, h, []), w, h, 0);   // learns prev
  v._findBall(frameWith(w, h, []), w, h, 16);  // learns background
  return v._findBall(frameWith(w, h, blobs), w, h, 32);
}

test('a ball-sized bright blob on the table is taken for the ball', () => {
  const v = make();
  const w = 192, h = 144;
  const centre = { x: 0.5, y: 0.55 };
  const r = Math.max(1, v.expectedBallPx(centre, w, h) / 2);
  const found = detect(v, w, h, [{ x: centre.x * w, y: centre.y * h, r }]);
  assert.ok(found, 'the ball was not found');
  assert.ok(Math.abs(found.x - centre.x) < 0.05 && Math.abs(found.y - centre.y) < 0.05,
    `found at ${found.x.toFixed(2)},${found.y.toFixed(2)}`);
});

test('an arm-sized blob is not taken for the ball', () => {
  const v = make();
  const w = 192, h = 144;
  const centre = { x: 0.5, y: 0.55 };
  const tooBig = v.expectedBallPx(centre, w, h) * 4;
  const found = detect(v, w, h, [{ x: centre.x * w, y: centre.y * h, r: tooBig }]);
  assert.equal(found, null, 'a blob four times the ball’s size was accepted');
});

test('with both in view, the ball-sized one wins', () => {
  const v = make();
  const w = 192, h = 144;
  const ball = { x: 0.62, y: 0.5 };
  const r = Math.max(1, v.expectedBallPx(ball, w, h) / 2);
  const found = detect(v, w, h, [
    { x: ball.x * w, y: ball.y * h, r },
    { x: 0.35 * w, y: 0.6 * h, r: r * 5 },      // a sleeve
  ]);
  assert.ok(found, 'nothing was found');
  assert.ok(Math.abs(found.x - ball.x) < 0.06, `picked ${found.x.toFixed(2)} not the ball`);
});

test('nothing outside the out-of-bounds line is even looked at', () => {
  const v = make();
  const w = 192, h = 144;
  const centre = { x: 0.5, y: 0.55 };
  const r = Math.max(1, v.expectedBallPx(centre, w, h) / 2);
  // Top-left corner of the frame, well outside the boundary.
  const found = detect(v, w, h, [{ x: 4, y: 4, r }]);
  assert.equal(found, null);
});

// --- scanning the table from a photo ------------------------------------

/** Paint a scene: a coloured quad on a floor, as RGBA bytes. */
function paint(w, h, { quad, table = [31, 111, 178], floor = [107, 98, 87] } = {}) {
  const data = new Uint8ClampedArray(w * h * 4);
  const inside = (x, y) => {
    if (!quad) return false;
    let hit = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = quad[i], [xj, yj] = quad[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = inside(x / w, y / h) ? table : floor;
      const i = (y * w + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  return data;
}

/** A vision instance whose camera shows the given painted scene. */
function withScene(scene) {
  const v = new VisionReferee({ videoWidth: 640, videoHeight: 480 }, stubCanvas());
  v.proc = { width: 0, height: 0 };
  v.pctx = {
    drawImage() {},
    getImageData: (x, y, w, h) => ({ data: paint(w, h, scene) }),
  };
  return v;
}

const TRUE_QUAD = [[0.2, 0.8], [0.3, 0.4], [0.7, 0.4], [0.8, 0.8]];

test('scanning finds a blue table on a floor', () => {
  const v = withScene({ quad: TRUE_QUAD });
  const found = v.scanTable();
  assert.ok(found, 'no table found');
  const got = v.table.corners;
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(got[i].x - TRUE_QUAD[i][0]) < 0.04 &&
              Math.abs(got[i].y - TRUE_QUAD[i][1]) < 0.04,
      `corner ${i}: got ${got[i].x.toFixed(3)},${got[i].y.toFixed(3)} ` +
      `want ${TRUE_QUAD[i][0]},${TRUE_QUAD[i][1]}`);
  }
});

test('scanning finds a green table too', () => {
  const v = withScene({ quad: TRUE_QUAD, table: [26, 122, 76] });
  assert.ok(v.scanTable(), 'a green table should be found');
});

test('scanning does not settle on the floor when there is no table', () => {
  const v = withScene({ quad: null });
  assert.equal(v.scanTable(), null);
});

test('scanning rejects a table-coloured background filling the frame', () => {
  const v = withScene({ quad: [[0, 0], [0, 1], [1, 1], [1, 0]] });
  assert.equal(v.scanTable(), null, 'a full-frame region is the background, not a table');
});

test('scanning finds a table under a brightness gradient across it', () => {
  // Real tables are lit unevenly; the near edge is brighter than the far one.
  // The shading must not split the table into "two colours".
  const shade = (w, h) => {
    const data = new Uint8ClampedArray(w * h * 4);
    const inside = (x, y) => {
      let hit = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        const [xi, yi] = TRUE_QUAD[i], [xj, yj] = TRUE_QUAD[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (inside(x / w, y / h)) {
          const k = 0.55 + 0.45 * (y / h);
          data[i] = 31 * k; data[i + 1] = 111 * k; data[i + 2] = 178 * k;
        } else { data[i] = 107; data[i + 1] = 98; data[i + 2] = 87; }
        data[i + 3] = 255;
      }
    }
    return data;
  };
  const v = new VisionReferee({ videoWidth: 640, videoHeight: 480 }, stubCanvas());
  v.proc = { width: 0, height: 0 };
  v.pctx = { drawImage() {}, getImageData: (x, y, w, h) => ({ data: shade(w, h) }) };
  assert.ok(v.scanTable(), 'a shaded table should still scan');
});

test('scanning finds a table that is neither blue nor green', () => {
  // Some club tables are dark red or grey. The colour is sampled from the
  // frame, not assumed, so these must work too.
  for (const table of [[150, 40, 40], [90, 90, 96]]) {
    const v = withScene({ quad: TRUE_QUAD, table, floor: [40, 60, 40] });
    assert.ok(v.scanTable(), `table ${table} should scan`);
  }
});

test('scanning works in dim light', () => {
  const v = withScene({ quad: TRUE_QUAD, table: [10, 40, 66], floor: [22, 20, 18] });
  assert.ok(v.scanTable(), 'a dim table should still scan');
});

test('a scanned table is placed, halves and boundary included', () => {
  const v = withScene({ quad: TRUE_QUAD });
  v.scanTable();
  assert.ok(v.table.boundary, 'the out-of-bounds line is built');
  assert.equal(v.sideOf({ x: 0.35, y: 0.6 }), 'A');
  assert.equal(v.sideOf({ x: 0.65, y: 0.6 }), 'B');
});

// --- the motion filter --------------------------------------------------

/** Feed one detection (or a miss, when m is null) at the next clock tick. */
function step(v, m, dtMs = 16) {
  v.__clock = (v.__clock ?? 1000) + dtMs;
  v._updateTrack(m ? { ...m, t: v.__clock, conf: 1 } : null, v.__clock);
  return v.track;
}

test('a single-frame outlier does not hijack a confirmed track', () => {
  const v = make();
  // Establish a track drifting slowly to the right.
  let x = 0.4;
  for (let i = 0; i < 6; i++) { step(v, { x, y: 0.55 }); x += 0.02; }
  const before = { x: v.track.x, y: v.track.y };
  // One wild detection across the table, then the real ball continues.
  step(v, { x: 0.8, y: 0.3 });
  assert.ok(Math.abs(v.track.x - before.x) < 0.1,
    `an outlier moved the track from ${before.x.toFixed(2)} to ${v.track.x.toFixed(2)}`);
  x += 0.02;
  step(v, { x, y: 0.55 });
  assert.ok(Math.abs(v.track.y - 0.55) < 0.06, 'the track stayed on the real ball');
});

test('a real change of direction is followed within two frames', () => {
  const v = make();
  let x = 0.4;
  for (let i = 0; i < 6; i++) { step(v, { x, y: 0.55 }); x += 0.03; }
  // The ball reverses sharply (a paddle hit): two frames later the track
  // should be moving back the other way, not stuck coasting forward.
  step(v, { x: x - 0.03, y: 0.55 });
  step(v, { x: x - 0.08, y: 0.55 });
  assert.ok(v.track.vx < 0, `velocity should have reversed, is ${v.track.vx.toFixed(2)}`);
});

test('the track coasts through a brief occlusion instead of dying', () => {
  const v = make();
  let x = 0.4;
  for (let i = 0; i < 6; i++) { step(v, { x, y: 0.5 }); x += 0.04; }
  const vx = v.track.vx;
  assert.ok(vx > 0, 'moving right before the occlusion');
  // Two frames with no detection at all (an arm passes in front).
  step(v, null); step(v, null);
  assert.ok(v.track, 'the track survived the occlusion');
  assert.ok(v.track.x > x, 'and was carried forward by its velocity');
});

test('the track is dropped after a long disappearance', () => {
  const v = make();
  for (let i = 0; i < 5; i++) step(v, { x: 0.5, y: 0.5 });
  let lost = null;
  v.onLost = t => (lost = t);
  for (let i = 0; i < 40; i++) step(v, null);   // ~640 ms of nothing
  assert.equal(v.track, null, 'the track was dropped');
  assert.ok(lost, 'onLost fired');
});

test('velocity is smoothed, not the raw frame-to-frame jump', () => {
  const v = make();
  // A steady glide with one jittery sample in the middle.
  const xs = [0.40, 0.44, 0.48, 0.585, 0.56, 0.60];   // 4th sample overshoots
  for (const x of xs) step(v, { x, y: 0.5 });
  // The smoothed speed should sit near the true glide (~0.04/frame ≈ 2.5/s),
  // nowhere near the instantaneous spike the jittery sample implies.
  assert.ok(v.track.vx > 0 && v.track.vx < 6,
    `smoothed vx ${v.track.vx.toFixed(2)} should not chase the spike`);
});

test('a bounce is read from the smoothed vertical velocity', () => {
  const v = make();
  const bounces = [];
  v.onBallBounce = b => bounces.push(b);
  // A parabola over the table: down, then up, past the confirmation count.
  const ys = [0.30, 0.42, 0.52, 0.60, 0.66, 0.70, 0.66, 0.60, 0.52, 0.42];
  let x = 0.45;
  for (const y of ys) { step(v, { x, y }); x += 0.01; }
  assert.equal(bounces.length, 1, `expected one bounce, got ${bounces.length}`);
  assert.ok(bounces[0].y > 0.6, 'the bounce was recorded near the bottom of the arc');
});

test('position lookup interpolates between frames for audio sync', () => {
  const v = make();
  step(v, { x: 0.30, y: 0.5 });
  step(v, { x: 0.50, y: 0.5 });     // two frames 16 ms apart
  const t0 = v.trail[v.trail.length - 2].t;
  const a = v.trail[v.trail.length - 2].x, b = v.trail[v.trail.length - 1].x;
  const at = v.positionAt(t0 + 8, 60);   // exactly between the two samples
  assert.ok(at && at.interpolated, 'the lookup interpolated');
  assert.ok(Math.abs(at.x - (a + b) / 2) < 1e-6,
    `interpolated x ${at?.x.toFixed(3)} should be the midpoint of ${a.toFixed(3)} and ${b.toFixed(3)}`);
});
