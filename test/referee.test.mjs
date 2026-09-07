// The referee's job is to turn "a sound happened" and "the ball was here"
// into rulings. These tests target the one geometric decision inside it that
// isn't pure rules: whether a bounce counts as touching the net.
import test from 'node:test';
import assert from 'node:assert/strict';

const stubCanvas = () => ({ width: 0, height: 0, getContext: () => ({}) });
globalThis.document = { createElement: stubCanvas };
globalThis.screen = { width: 1280, height: 720 };

const { VisionReferee } = await import('../js/vision.js');
const { Referee } = await import('../js/referee.js');

/** A table drawn in perspective, at a given scale/offset within the frame —
 *  standing in for the phone being set back further, or angled differently.
 *  Physically it is always the same 2.74m x 1.525m table. */
function tableAt(scale, ox, oy) {
  const base = [
    { x: 0.20, y: 0.75 }, { x: 0.30, y: 0.40 },
    { x: 0.72, y: 0.40 }, { x: 0.82, y: 0.75 },
  ];
  return base.map(p => ({ x: ox + (p.x - 0.5) * scale, y: oy + (p.y - 0.5) * scale }));
}

/** _nearNet only touches `this.vision`, so a real VisionReferee stands in for
 *  a full Referee without needing a live microphone/camera. */
function nearNet(vision, p) {
  return Referee.prototype._nearNet.call({ vision }, p);
}

test('a point on the net line is near the net at any framing of the same table', () => {
  for (const [scale, ox, oy] of [[1, 0.5, 0.5], [0.6, 0.5, 0.6], [0.35, 0.4, 0.7]]) {
    const v = new VisionReferee({}, stubCanvas());
    v.setTable(tableAt(scale, ox, oy));
    // The midpoint between the near and far net-line endpoints IS the net.
    const [a, b] = v.table.net;
    const onNet = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    assert.ok(nearNet(v, onNet), `should be near-net at scale ${scale}`);
  }
});

test('a point well into one half is never near the net, at any framing', () => {
  for (const [scale, ox, oy] of [[1, 0.5, 0.5], [0.6, 0.5, 0.6], [0.35, 0.4, 0.7]]) {
    const v = new VisionReferee({}, stubCanvas());
    v.setTable(tableAt(scale, ox, oy));
    // A point 3/4 of the way from the net to A's own end line.
    const nearMid = v.table.nearMid, farMid = v.table.farMid;
    const netPt = { x: (nearMid.x + farMid.x) / 2, y: (nearMid.y + farMid.y) / 2 };
    const deep = { x: netPt.x + (v.table.corners[0].x - netPt.x) * 0.75,
                   y: netPt.y + (v.table.corners[0].y - netPt.y) * 0.75 };
    assert.equal(nearNet(v, deep), false, `should not be near-net at scale ${scale}`);
  }
});

test('a bounce well clear of the net is not called a let just because the phone is set back further', () => {
  // The old, frame-space version of this check effectively had no fixed
  // physical size: shrink the same table in the frame (phone further back,
  // more zoomed out) and its "near net" zone grows right along with it. On
  // this fixture, at a fifth of the linear scale, it called a point 30% of
  // the way from the net to the end line a net touch — a bounce most of the
  // way into a half, nowhere near the net.
  const v = new VisionReferee({}, stubCanvas());
  v.setTable(tableAt(0.35, 0.5, 0.5));
  const netPt = { x: (v.table.nearMid.x + v.table.farMid.x) / 2, y: (v.table.nearMid.y + v.table.farMid.y) / 2 };
  const wellClear = { x: netPt.x + (v.table.corners[0].x - netPt.x) * 0.3,
                       y: netPt.y + (v.table.corners[0].y - netPt.y) * 0.3 };
  assert.equal(nearNet(v, wellClear), false,
    'a bounce 30% of the way into a half should never be called near the net, regardless of framing');
});

test('the net zone is symmetric: equally far into A’s half or B’s half are treated the same', () => {
  const v = new VisionReferee({}, stubCanvas());
  v.setTable(tableAt(1, 0.5, 0.5));
  // Walk the same top-down distance into either half via the homography's
  // corners rather than an inverse map: sample points from vision.table
  // directly at proportional positions along the near/far edges instead.
  const netPt = { x: (v.table.nearMid.x + v.table.farMid.x) / 2,
                  y: (v.table.nearMid.y + v.table.farMid.y) / 2 };
  const towardA = { x: netPt.x + (v.table.corners[0].x - netPt.x) * 0.1,
                     y: netPt.y + (v.table.corners[0].y - netPt.y) * 0.1 };
  const towardB = { x: netPt.x + (v.table.corners[3].x - netPt.x) * 0.1,
                     y: netPt.y + (v.table.corners[3].y - netPt.y) * 0.1 };
  assert.equal(nearNet(v, towardA), nearNet(v, towardB),
    'a symmetric nudge into either half should get the same call');
});
