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

/** Feed a straight line of positions through the tracker. */
function fly(v, from, to, steps = 8) {
  const calls = [];
  v.onBallOut = info => calls.push(info);
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    v._updateTrack({
      x: from.x + (to.x - from.x) * f,
      y: from.y + (to.y - from.y) * f,
      t: 1000 + i * 16, conf: 1,
    }, 1000 + i * 16);
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
  const near = v.positionAt(1064, 120);
  assert.ok(near, 'a moment inside the window resolves');
  const far = v.positionAt(5000, 120);
  assert.equal(far, null, 'a moment with no ball near it does not');
});
