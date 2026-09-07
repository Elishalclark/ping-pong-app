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

test('a motion-blurred ball (a short streak) is still detected', () => {
  // A fast ball smears into a streak; roundness must not be a hard gate or the
  // ball is lost during exactly the fast play the app is for.
  const v = make();
  v.setBallColor('white');
  const w = 200, h = 150, cx = 0.5 * w, cy = 0.55 * h;
  const streak = (ww, hh) => {
    const data = new Uint8ClampedArray(ww * hh * 4);
    for (let i = 0; i < ww * hh; i++) { data[i*4]=60; data[i*4+1]=90; data[i*4+2]=70; data[i*4+3]=255; }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -3; dx <= 3; dx++) {
      const x = Math.round(cx + dx), y = Math.round(cy + dy);
      const i = (y*ww + x)*4; data[i]=248; data[i+1]=248; data[i+2]=248;
    }
    return { data };
  };
  const plain = (ww, hh) => {
    const data = new Uint8ClampedArray(ww * hh * 4);
    for (let i = 0; i < ww * hh; i++) { data[i*4]=60; data[i*4+1]=90; data[i*4+2]=70; data[i*4+3]=255; }
    return { data };
  };
  v.prev = null; v.bg = null; v.track = null;
  v._findBall(plain(w, h), w, h, 0);
  v._findBall(plain(w, h), w, h, 16);
  const found = v._findBall(streak(w, h), w, h, 32);
  assert.ok(found, 'a short streak (blurred ball) should still be found');
  assert.ok(Math.abs(found.x - 0.5) < 0.05 && Math.abs(found.y - 0.55) < 0.05, 'at the streak');
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

/** A grey frame with coloured discs, so colour gating can be exercised. */
function colorFrame(w, h, blobs, base = [70, 74, 78]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = base[0]; data[i * 4 + 1] = base[1]; data[i * 4 + 2] = base[2]; data[i * 4 + 3] = 255;
  }
  for (const { x, y, r, c } of blobs) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const px = Math.round(x + dx), py = Math.round(y + dy);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    }
  }
  return { data };
}

function detectColor(v, w, h, blobs) {
  v.prev = null; v.bg = null; v.track = null;
  v._findBall(colorFrame(w, h, []), w, h, 0);
  v._findBall(colorFrame(w, h, []), w, h, 16);
  return v._findBall(colorFrame(w, h, blobs), w, h, 32);
}

test('a white ball is followed and a skin-coloured blob the same size is not', () => {
  const v = make();
  v.setBallColor('white');
  const w = 192, h = 144, centre = { x: 0.5, y: 0.55 };
  const r = Math.max(2, v.expectedBallPx(centre, w, h) / 2);
  const white = detectColor(v, w, h, [{ x: centre.x * w, y: centre.y * h, r, c: [245, 245, 245] }]);
  assert.ok(white, 'the white ball should be found');
  const skin = detectColor(v, w, h, [{ x: centre.x * w, y: centre.y * h, r, c: [205, 150, 120] }]);
  assert.equal(skin, null, 'a skin-coloured blob must be rejected');
});

test('with white selected, an orange ball is ignored, and vice versa', () => {
  const w = 192, h = 144, centre = { x: 0.5, y: 0.55 };
  const vw = make(); vw.setBallColor('white');
  const r = Math.max(2, vw.expectedBallPx(centre, w, h) / 2);
  assert.equal(detectColor(vw, w, h, [{ x: centre.x*w, y: centre.y*h, r, c: [230,120,30] }]), null,
    'white mode ignores an orange blob');
  const vo = make(); vo.setBallColor('orange');
  assert.ok(detectColor(vo, w, h, [{ x: centre.x*w, y: centre.y*h, r, c: [230,120,30] }]),
    'orange mode finds the orange ball');
});

test('the ball colour picks the ball out from among several moving blobs', () => {
  const v = make();
  v.setBallColor('orange');
  const w = 192, h = 144;
  const ball = { x: 0.62, y: 0.5 };
  const r = Math.max(2, v.expectedBallPx(ball, w, h) / 2);
  const found = detectColor(v, w, h, [
    { x: ball.x * w, y: ball.y * h, r, c: [235, 125, 35] },     // the orange ball
    { x: 0.4 * w, y: 0.6 * h, r, c: [210, 155, 125] },          // a hand, same size
    { x: 0.5 * w, y: 0.45 * h, r, c: [240, 240, 240] },         // a white logo on a shirt
  ]);
  assert.ok(found, 'the ball was found');
  assert.ok(Math.abs(found.x - ball.x) < 0.06, `picked ${found.x.toFixed(2)}, expected the orange ball`);
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

test('an off-centre table is found — by the grid search and, exactly, by a tap', () => {
  const quad = [[0.55, 0.7], [0.6, 0.4], [0.9, 0.4], [0.95, 0.7]];
  // The multi-seed search should find it wherever it sits in the frame.
  const v = withScene({ quad, table: [150, 40, 40], floor: [40, 60, 40] });
  assert.ok(v.scanTable(), 'the grid search should find an off-centre table');
  assert.ok(v.table.corners[3].x > 0.8, 'and place the box over it');
  // A tap on the table nails it regardless of where it is.
  const v2 = withScene({ quad, table: [150, 40, 40], floor: [40, 60, 40] });
  assert.ok(v2.scanTable({ x: 0.75, y: 0.55 }), 'a tap on the table finds it');
  assert.ok(v2.table.corners[3].x > 0.85 && v2.table.corners[0].x > 0.5,
    'and the box hugs the real table edges');
});

test('a tap on the floor, away from the table, does not invent a table there', () => {
  const quad = [[0.55, 0.7], [0.6, 0.4], [0.9, 0.4], [0.95, 0.7]];
  const v = withScene({ quad, table: [150, 40, 40], floor: [40, 60, 40] });
  // Tapping the floor grows the floor, which fills the frame and is rejected.
  assert.equal(v.scanTable({ x: 0.15, y: 0.5 }), null);
});

test('the net line and a glare spot do not fragment the table', () => {
  // A table with a bright white stripe across the middle (the net line) and a
  // washed-out patch (glare). Morphological closing and hole-fill should keep
  // it one region rather than three.
  const draw = (w, h) => {
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
        let c = inside(x / w, y / h) ? [31, 111, 178] : [107, 98, 87];
        // Net line: a thin bright band across the middle of the table.
        if (inside(x / w, y / h) && Math.abs(y / h - 0.58) < 0.006) c = [240, 240, 240];
        // Glare: a small blown-out patch on the table.
        if (Math.hypot(x / w - 0.5, y / h - 0.5) < 0.03) c = [250, 250, 250];
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
      }
    }
    return data;
  };
  const v = new VisionReferee({ videoWidth: 640, videoHeight: 480 }, stubCanvas());
  v.proc = { width: 0, height: 0 };
  v.pctx = { drawImage() {}, getImageData: (x, y, w, h) => ({ data: draw(w, h) }) };
  const found = v.scanTable();
  assert.ok(found, 'the table should scan as one region despite the net line and glare');
  // The box should span most of the table's height, not stop at the net line.
  const ys = v.table.corners.map(c => c.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.28,
    'the box spans the whole table, not just half');
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

// --- more ways to tell the ball apart --------------------------------------

test('a round blob is taken but a same-area diagonal streak is rejected', () => {
  const v = make();
  v.setBallColor('white');
  const w = 192, h = 144, centre = { x: 0.5, y: 0.55 };
  const r = Math.max(2, v.expectedBallPx(centre, w, h) / 2);
  const round = detectColor(v, w, h, [{ x: centre.x * w, y: centre.y * h, r, c: [245, 245, 245] }]);
  assert.ok(round, 'the round ball should be found');

  // A thin diagonal streak of the same colour and similar pixel count.
  const v2 = make(); v2.setBallColor('white');
  const streak = (ww, hh) => {
    const data = new Uint8ClampedArray(ww * hh * 4);
    for (let i = 0; i < ww * hh; i++) { data[i*4]=70; data[i*4+1]=74; data[i*4+2]=78; data[i*4+3]=255; }
    for (let k = -8; k <= 8; k++) {
      const x = Math.round(centre.x*ww + k), y = Math.round(centre.y*hh + k);
      for (const [ox,oy] of [[0,0],[1,0],[0,1]]) {
        const i = ((y+oy)*ww + (x+ox))*4; data[i]=245; data[i+1]=245; data[i+2]=245;
      }
    }
    return { data };
  };
  v2.prev=null; v2.bg=null; v2.track=null;
  v2._findBall(streak(w,h), w, h, 0);   // but frame 0 has the streak already...
  // fresh background frames without the streak, then the streak frame:
  const v3 = make(); v3.setBallColor('white');
  const plain = (ww,hh)=>{const d=new Uint8ClampedArray(ww*hh*4);for(let i=0;i<ww*hh;i++){d[i*4]=70;d[i*4+1]=74;d[i*4+2]=78;d[i*4+3]=255;}return{data:d};};
  v3.prev=null; v3.bg=null; v3.track=null;
  v3._findBall(plain(w,h), w, h, 0); v3._findBall(plain(w,h), w, h, 16);
  const found = v3._findBall(streak(w,h), w, h, 32);
  assert.equal(found, null, 'a diagonal streak is not round enough to be the ball');
});

test('once locked, the tracker learns the ball’s own colour and reverts when lost', () => {
  const v = make();
  v.setBallColor('white');
  assert.equal(v.ballTemplate, null, 'no template before locking on');
  // Confirm a track by feeding a coherent run, each carrying a colour.
  let x = 0.4;
  for (let i = 0; i < 5; i++) {
    v.__clock = (v.__clock ?? 1000) + 16;
    v._updateTrack({ x, y: 0.55, t: v.__clock, conf: 1, color: { r: 250, g: 248, b: 235 } }, v.__clock);
    x += 0.03;
  }
  assert.ok(v.track && v.track.confirmed, 'the track confirmed');
  assert.ok(v.ballTemplate, 'the ball’s colour was learned on confirmation');
  assert.ok(Math.abs(v.ballTemplate.r - 250) < 1, 'and it is the colour that was seen');
  // Lose the ball; the template must clear so a preset applies again.
  for (let i = 0; i < 40; i++) step(v, null);
  assert.equal(v.ballTemplate, null, 'the template clears when the ball is lost');
});

// --- re-seed must not let a distractor hijack a confirmed track ------------

test('a distant slow distractor run does not re-seed a confirmed track', () => {
  const v = make();
  // Lock on to a fast ball moving right.
  let x = 0.35;
  for (let i = 0; i < 6; i++) { step(v, { x, y: 0.5 }); x += 0.05; }
  assert.ok(v.track && v.track.confirmed, 'ball confirmed');

  // A distractor appears far from the predicted path (so each detection is a
  // rejected *surprise*), self-coherent but SLOW — a drifting arm, not a ball.
  // The old code re-seeded onto any two nearby surprises and confirmed
  // instantly; now a slow re-seed is refused.
  step(v, { x: 0.30, y: 0.72 });
  step(v, { x: 0.305, y: 0.723 });   // ~0.006 over a frame → far below ball speed
  // The tracker must not now be a confirmed lock sitting on the distractor.
  const onDistractor = v.track && v.track.confirmed &&
    Math.hypot(v.track.x - 0.305, v.track.y - 0.723) < 0.05;
  assert.equal(onDistractor, false, 'a slow surprise run must not become a confirmed lock');
});

// --- physical (ballistic) motion -------------------------------------------

test('a slow, coherent drift does not confirm — the ball moves fast', () => {
  const v = make();
  // Smoothly moving but barely: a waving arm, not a struck ball.
  let x = 0.45;
  for (let i = 0; i < 8; i++) { step(v, { x, y: 0.5 }); x += 0.004; }   // ~0.25/s
  assert.equal(v.isLocked, false, 'a slow drift is not ball-like enough to lock on');
});

test('a fast smooth arc confirms and scores as ballistic', () => {
  const v = make();
  // A gravity arc: horizontal glide, vertical accelerating downward.
  let x = 0.35;
  const y = t => 0.35 + 0.9 * t + 4 * t * t;   // metres-ish, arbitrary but smooth
  let i = 0;
  for (; i < 6; i++) {
    const t = i * 0.016;
    step(v, { x, y: Math.min(0.72, y(t)) });
    x += 0.035;
  }
  assert.equal(v.isLocked, true, 'a fast smooth arc should lock on');
  assert.ok(v.track.ballistic > 0.6, `arc should score high, got ${v.track.ballistic?.toFixed(2)}`);
});

test('a fast but jittery path is not treated as physical motion', () => {
  const v = make();
  // Fast enough, but the vertical position jumps around — not a real flight.
  const ys = [0.5, 0.62, 0.44, 0.66, 0.4, 0.7];
  let x = 0.35;
  for (const yy of ys) { step(v, { x, y: yy }); x += 0.04; }
  // Either it never confirmed, or its ballistic score is low.
  if (v.isLocked) assert.ok(v.track.ballistic < 0.5, 'jittery motion should score low');
  else assert.ok(true, 'jittery motion did not confirm, which is fine');
});

// --- conservative acquisition: don't lock onto anything that moves ---------

test('jumpy, incoherent detections never confirm a track', () => {
  const v = make();
  // A different random spot every frame — arms, shadows, reflections, never a
  // smooth trajectory. The tracker must not "confirm" and start drawing.
  const spots = [[0.3,0.4],[0.7,0.6],[0.35,0.65],[0.72,0.42],[0.4,0.5],[0.68,0.63],[0.33,0.44],[0.71,0.58]];
  for (const [x,y] of spots) step(v, { x, y });
  assert.equal(v.isLocked, false, 'incoherent motion should never lock on');
});

test('a smooth run of detections does lock on', () => {
  const v = make();
  let x = 0.4;
  for (let i = 0; i < 6; i++) { step(v, { x, y: 0.55 }); x += 0.03; }
  assert.equal(v.isLocked, true, 'a smooth trajectory should lock on');
});

test('the marker stays hidden for the first few frames, until confirmed', () => {
  const v = make();
  let x = 0.4;
  step(v, { x, y: 0.5 }); x += 0.03;
  assert.equal(v.isLocked, false, 'not locked on the very first detection');
  for (let i = 0; i < 4; i++) { step(v, { x, y: 0.5 }); x += 0.03; }
  assert.equal(v.isLocked, true, 'locked once the run is confirmed');
});

test('the marker hides again when the ball is lost', () => {
  const v = make();
  let x = 0.4;
  for (let i = 0; i < 6; i++) { step(v, { x, y: 0.5 }); x += 0.03; }
  assert.equal(v.isLocked, true);
  for (let i = 0; i < 6; i++) step(v, null);   // ball gone for several frames
  assert.equal(v.isLocked, false, 'the marker hides while coasting/lost');
});

// --- only a round, ball-like blob is tracked --------------------------------
// These pin down the fix for "the tracker focuses on every little thing": the
// scoring used to prefer the smallest, most degenerate blob in the frame, so
// a two-pixel speck beat the actual ball (measured 22.4 vs 14.7 at equal
// brightness) and the marker chased sensor noise around the table.

/** Paint an exact set of pixels bright on a table-coloured frame. */
function pixelFrame(w, h, pixels, base = [70, 74, 78]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = base[0]; data[i * 4 + 1] = base[1]; data[i * 4 + 2] = base[2]; data[i * 4 + 3] = 255;
  }
  for (const [x, y] of pixels) {
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const i = (py * w + px) * 4;
    data[i] = 248; data[i + 1] = 248; data[i + 2] = 248;
  }
  return { data };
}

/** Two blank frames to learn the background, then the frame under test. */
function detectPixels(v, w, h, pixels, track = null) {
  v.prev = null; v.bg = null; v.track = null;
  v._findBall(pixelFrame(w, h, []), w, h, 0);
  v._findBall(pixelFrame(w, h, []), w, h, 16);
  v.track = track;
  return v._findBall(pixelFrame(w, h, pixels), w, h, 32);
}

const blockAt = (x, y, wide, tall) => {
  const out = [];
  for (let dy = 0; dy < tall; dy++) for (let dx = 0; dx < wide; dx++) out.push([x + dx, y + dy]);
  return out;
};

test('a two-pixel speck is not taken for the ball', () => {
  const v = make();
  v.setBallColor('white');
  const w = 240, h = 180;
  const found = detectPixels(v, w, h, blockAt(0.45 * w, 0.55 * h, 2, 1));
  assert.equal(found, null, 'a 2px speck has no shape and is far too small to be the ball');
});

test('scattered bright specks do not out-score the actual ball', () => {
  const v = make();
  v.setBallColor('white');
  const w = 240, h = 180, centre = { x: 0.5, y: 0.6 };
  const ball = blockAt(centre.x * w - 1, centre.y * h - 1, 3, 3);
  const specks = [
    ...blockAt(0.40 * w, 0.50 * h, 2, 1),
    ...blockAt(0.60 * w, 0.52 * h, 2, 1),
    ...blockAt(0.55 * w, 0.66 * h, 1, 2),
  ];
  const found = detectPixels(v, w, h, [...ball, ...specks]);
  assert.ok(found, 'the ball should still be found among the clutter');
  assert.ok(Math.abs(found.x - centre.x) < 0.04 && Math.abs(found.y - centre.y) < 0.04,
    `should land on the ball, not a speck (got ${found.x.toFixed(3)},${found.y.toFixed(3)})`);
});

test('a streak is allowed along the ball’s travel but not across it', () => {
  // Motion blur smears a fast ball ALONG its flight and nowhere else, so the
  // same streak is a blurred ball when it lies the way the ball is going, and
  // an arm edge or a table line when it lies across it.
  const w = 240, h = 180, cx = 0.5 * w, cy = 0.6 * h;
  const streak = blockAt(cx - 3, cy - 1, 7, 3);      // 7 wide, 3 tall

  const along = make(); along.setBallColor('white');
  const movingAcross = { x: 0.44, y: 0.6, vx: 2.0, vy: 0, t: 16, hits: 5, misses: 0, confirmed: true, conf: 0.8 };
  assert.ok(detectPixels(along, w, h, streak, movingAcross),
    'a streak along the direction of travel is a blurred ball');

  const across = make(); across.setBallColor('white');
  const movingDown = { x: 0.5, y: 0.5, vx: 0, vy: 3.0, t: 16, hits: 5, misses: 0, confirmed: true, conf: 0.8 };
  assert.equal(detectPixels(across, w, h, streak, movingDown), null,
    'the same streak across the direction of travel cannot be motion blur');
});

test('a bright distractor does not steal a confirmed track from the ball', () => {
  const v = make();
  v.setBallColor('white');
  const w = 240, h = 180;
  v.prev = null; v.bg = null; v.track = null;
  v._findBall(pixelFrame(w, h, []), w, h, 0);
  v._findBall(pixelFrame(w, h, []), w, h, 16);

  let t = 32, onBall = 0, confirmedFrames = 0;
  for (let i = 0; i < 20; i++) {
    const nx = 0.36 + 0.013 * i, ny = 0.58 + 0.004 * i;
    const pixels = blockAt(nx * w - 1, ny * h - 1, 3, 3);
    // From frame 8, a rival blob of the same colour sits just off the path.
    if (i >= 8) pixels.push(...blockAt((nx + 0.05) * w, (ny - 0.04) * h, 3, 3));
    v._updateTrack(v._findBall(pixelFrame(w, h, pixels), w, h, t), t);
    if (v.track && v.track.confirmed) {
      confirmedFrames++;
      if (Math.hypot(v.track.x - nx, v.track.y - ny) < 0.03) onBall++;
    }
    t += 16;
  }
  assert.ok(confirmedFrames >= 12, `should hold a lock through the rally (held ${confirmedFrames}/20)`);
  assert.equal(onBall, confirmedFrames, 'every confirmed frame should sit on the real ball');
});

// --- predicted contact points: a fitted landing point, not a straight line -

test('a ball still rising gets a predicted landing point ahead of it, not behind it', () => {
  const v = make();
  // Feed the RISING half of a parabolic arc only — the vertex (the turn from
  // rising to falling) lies just past the last sample, not inside the
  // observed window, which is what makes this a genuine forward prediction
  // rather than reporting a turn that has already happened.
  const t0 = 1000;
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const t = t0 + i * 16;
    const x = 0.3 + 0.02 * i;
    const y = 0.55 - 0.012 * i + 0.0008 * i * i;   // vertex is a couple of steps ahead
    pts.push({ x, y, t });
  }
  for (const p of pts) v._updateTrack({ ...p, conf: 1 }, p.t);
  assert.equal(v.isLocked, true, 'should be locked on after a smooth ballistic run');
  const contact = v.predictedContact();
  assert.ok(contact, 'a curved recent path should yield a prediction');
  assert.ok(contact.bounce, 'a curving arc should predict a landing point');
  assert.ok(contact.bounce.t > pts[pts.length - 1].t, 'the landing point should be in the future');
});

test('a dead-straight glide (no curvature) predicts no landing point', () => {
  const v = make();
  const t0 = 1000;
  for (let i = 0; i < 8; i++) {
    const t = t0 + i * 16;
    v._updateTrack({ x: 0.3 + 0.02 * i, y: 0.55, conf: 1, t }, t);
  }
  assert.equal(v.isLocked, true);
  const contact = v.predictedContact();
  // A perfectly flat path has no vertex to find — reporting one anyway would
  // be inventing a landing point instead of reading one off the flight.
  assert.ok(!contact || !contact.bounce, 'a straight glide should not fabricate a landing point');
});

test('a path crossing the table centre predicts a net crossing', () => {
  const v = make();
  const t0 = 1000;
  // A flat shot heading toward the net position (table x=0.5 is the net),
  // still short of it by the last observed sample — the crossing is ahead,
  // not something that already happened inside the observed window.
  for (let i = 0; i < 8; i++) {
    const t = t0 + i * 16;
    v._updateTrack({ x: 0.30 + 0.015 * i, y: 0.58, conf: 1, t }, t);
  }
  assert.equal(v.isLocked, true);
  const contact = v.predictedContact();
  assert.ok(contact && contact.netCross, 'a path heading toward the net position should predict a crossing ahead of it');
});

test('a path that stays in one half predicts no net crossing', () => {
  const v = make();
  const t0 = 1000;
  // Drifts within A's half only, never approaching the net.
  for (let i = 0; i < 8; i++) {
    const t = t0 + i * 16;
    v._updateTrack({ x: 0.28 + 0.002 * i, y: 0.58, conf: 1, t }, t);
  }
  // This is slow drift, likely not even confirmed — but if it is, it must not
  // claim a net crossing it never approaches.
  const contact = v.predictedContact();
  if (contact) assert.equal(contact.netCross, null, 'should not predict a net crossing far from the net');
});
