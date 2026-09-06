import test from 'node:test';
import assert from 'node:assert/strict';
import { RulesEngine } from '../js/rules.js';

const rally = (e, ...evs) => evs.flatMap(ev => e.feed({ confidence: 1, t: 0, ...ev }));
const engine = (o = {}) => new RulesEngine({ firstServer: 'A', ...o });
const serve = e => e.feed({ type: 'serve-start', t: 0 });

test('a legal service is not a point by itself', () => {
  const e = engine(); serve(e);
  const calls = rally(e,
    { type: 'hit', side: 'A' },
    { type: 'bounce', side: 'A' },
    { type: 'bounce', side: 'B' });
  assert.equal(calls.filter(c => c.type === 'point').length, 0);
  assert.deepEqual(e.score, { A: 0, B: 0 });
});

test('service that misses the server’s own half is a point to the receiver', () => {
  const e = engine(); serve(e);
  rally(e, { type: 'hit', side: 'A' }, { type: 'bounce', side: 'B' });
  assert.deepEqual(e.score, { A: 0, B: 1 });
});

test('service bouncing twice on the server’s half is a point to the receiver', () => {
  const e = engine(); serve(e);
  rally(e, { type: 'hit', side: 'A' }, { type: 'bounce', side: 'A' }, { type: 'bounce', side: 'A' });
  assert.deepEqual(e.score, { A: 0, B: 1 });
});

test('net-cord service that still lands good is a let, and nobody scores', () => {
  const e = engine(); serve(e);
  const calls = rally(e,
    { type: 'hit', side: 'A' },
    { type: 'bounce', side: 'A' },
    { type: 'net' },
    { type: 'bounce', side: 'B' });
  assert.equal(calls.at(-1).type, 'let');
  assert.deepEqual(e.score, { A: 0, B: 0 });
});

test('service into the net is a point to the receiver', () => {
  const e = engine(); serve(e);
  rally(e, { type: 'hit', side: 'A' }, { type: 'bounce', side: 'A' }, { type: 'net' }, { type: 'out' });
  assert.deepEqual(e.score, { A: 0, B: 1 });
});

test('failing to return the ball concedes the point', () => {
  const e = engine(); serve(e);
  rally(e,
    { type: 'hit', side: 'A' }, { type: 'bounce', side: 'A' }, { type: 'bounce', side: 'B' },
    { type: 'hit', side: 'B' }, { type: 'bounce', side: 'A' },
    { type: 'bounce', side: 'A' });                    // A never got a racket on it
  assert.deepEqual(e.score, { A: 0, B: 1 });
});

test('a return that does not cross the net concedes the point', () => {
  const e = engine(); serve(e);
  rally(e,
    { type: 'hit', side: 'A' }, { type: 'bounce', side: 'A' }, { type: 'bounce', side: 'B' },
    { type: 'hit', side: 'B' }, { type: 'bounce', side: 'B' });
  assert.deepEqual(e.score, { A: 1, B: 0 });
});

test('hitting the ball off the table concedes the point', () => {
  const e = engine(); serve(e);
  rally(e,
    { type: 'hit', side: 'A' }, { type: 'bounce', side: 'A' }, { type: 'bounce', side: 'B' },
    { type: 'hit', side: 'B' }, { type: 'out' });
  assert.deepEqual(e.score, { A: 1, B: 0 });
});

test('volleying the ball before it bounces concedes the point', () => {
  const e = engine(); serve(e);
  rally(e,
    { type: 'hit', side: 'A' }, { type: 'bounce', side: 'A' }, { type: 'bounce', side: 'B' },
    { type: 'hit', side: 'B' },
    { type: 'hit', side: 'A' });                      // struck it out of the air
  assert.deepEqual(e.score, { A: 0, B: 1 });
});

test('service changes hands every two points', () => {
  const e = engine();
  assert.equal(e.server, 'A');
  e.award('A'); assert.equal(e.server, 'A');
  e.award('B'); assert.equal(e.server, 'B');
  e.award('A'); assert.equal(e.server, 'B');
  e.award('A'); assert.equal(e.server, 'A');
});

test('at deuce the service changes every point', () => {
  const e = engine();
  for (let i = 0; i < 10; i++) { e.award('A'); e.award('B'); }
  assert.deepEqual(e.score, { A: 10, B: 10 });
  const s1 = e.server; e.award('A');
  assert.notEqual(e.server, s1);
});

test('a game needs 11 points and a margin of two', () => {
  const e = engine();
  for (let i = 0; i < 10; i++) { e.award('A'); e.award('B'); }
  e.award('A');
  assert.deepEqual(e.games, { A: 0, B: 0 }, '11-10 is not a game');
  const calls = e.award('A');
  assert.equal(calls.some(c => c.type === 'game'), true);
  assert.deepEqual(e.games, { A: 1, B: 0 });
  assert.deepEqual(e.score, { A: 0, B: 0 });
});

test('best of five ends the match at three games', () => {
  const e = engine();
  let calls = [];
  for (let g = 0; g < 3; g++) for (let i = 0; i < 11; i++) calls = e.award('A');
  assert.equal(calls.some(c => c.type === 'match'), true);
  assert.equal(e.matchOver, true);
});

test('service alternates from game to game', () => {
  const e = engine({ firstServer: 'A' });
  for (let i = 0; i < 11; i++) e.award('A');
  assert.equal(e.server, 'B', 'last game’s receiver serves first in the next game');
});

test('undo restores the score and the server', () => {
  const e = engine();
  e.award('A'); e.award('B'); e.award('B');
  const before = { ...e.score }, srv = e.server;
  e.award('A');
  assert.notDeepEqual(e.score, before);
  e.undo();
  assert.deepEqual(e.score, before);
  assert.equal(e.server, srv);
});

test('rulings stop once the match is over', () => {
  const e = engine();
  for (let g = 0; g < 3; g++) for (let i = 0; i < 11; i++) e.award('A');
  serve(e);
  assert.deepEqual(e.feed({ type: 'hit', side: 'A', confidence: 1 }), []);
});

test('a ball that never landed is the striker’s mistake', () => {
  const e = engine(); serve(e);
  rally(e,
    { type: 'hit', side: 'A' }, { type: 'bounce', side: 'A' }, { type: 'bounce', side: 'B' },
    { type: 'hit', side: 'B' },
    { type: 'out' });                        // B's return never touched the table
  assert.deepEqual(e.score, { A: 1, B: 0 });
});

test('a ball that landed first and then went past is the receiver’s mistake', () => {
  const e = engine(); serve(e);
  rally(e,
    { type: 'hit', side: 'A' }, { type: 'bounce', side: 'A' }, { type: 'bounce', side: 'B' },
    { type: 'hit', side: 'B' }, { type: 'bounce', side: 'A' },
    { type: 'out' });                        // A never got a racket on it
  assert.deepEqual(e.score, { A: 0, B: 1 });
});

test('a service that lands good and is then let go scores for the server', () => {
  const e = engine(); serve(e);
  rally(e,
    { type: 'hit', side: 'A' }, { type: 'bounce', side: 'A' }, { type: 'bounce', side: 'B' },
    { type: 'out' });                        // receiver let a legal serve go by
  assert.deepEqual(e.score, { A: 1, B: 0 });
});

test('bounces heard before any stroke do not award a phantom point', () => {
  const e = engine(); serve(e);
  // The microphone caught the ball on the table but missed the serve stroke.
  const calls = rally(e, { type: 'bounce', side: 'A' }, { type: 'bounce', side: 'B' },
    { type: 'bounce', side: 'B' });
  assert.deepEqual(e.score, { A: 0, B: 0 }, 'nobody scores');
  assert.equal(calls.some(c => c.type === 'point'), false);
  assert.deepEqual(Object.keys(e.score).sort(), ['A', 'B'], 'no stray side is invented');
});

test('an unattributable ball out is no call rather than a wrong one', () => {
  const e = engine(); serve(e);
  const calls = rally(e, { type: 'out' });
  assert.deepEqual(e.score, { A: 0, B: 0 });
  assert.equal(calls.some(c => c.type === 'point'), false);
});

test('an award to an invalid side is refused', () => {
  const e = engine();
  const calls = e.award(undefined, 'bad call');
  assert.equal(calls[0].type, 'info');
  assert.deepEqual(e.score, { A: 0, B: 0 });
});
