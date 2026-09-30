'use strict';

// Live huddle lifecycle: exactly one Stage-1 call per huddle, the completed
// snap is recorded before the next huddle ranks, and telemetry noise inside a
// huddle (clocks, defensive call arriving, hash verification flicker) never
// manufactures a second call.

const test = require('node:test');
const assert = require('node:assert/strict');

const { situationIdentityKey, handleNewSituation, finalizeCompletedSnap } = require('../src/coordinator/live-coordinator.cjs');
const { SnapReducer } = require('../src/coordinator/snap-reducer.cjs');
const { HashLatch } = require('../src/coordinator/field-direction-tracker.cjs');
const { CoordinatorWindow } = require('../src/football/ui/coordinator-window');

function stubEngine(log) {
  const play = { id: 'iz', name: 'Inside Zone', formation: 'Singleback Ace', type: 'RUN' };
  return {
    knowledge: { resolveCoverage: () => null, catalogResolver: null },
    recordedBeforeRank: [],
    recorded: 0,
    recordPlay(event) { this.recorded += 1; log.push('record'); return event; },
    recommendPlays() {
      log.push('rank');
      this.recordedBeforeRank.push(this.recorded);
      return { recommendations: [{ play, score: 1, reasons: [] }], gameplan: null };
    },
    recordRecommendation() {},
  };
}

function tick(overrides = {}) {
  return {
    quarter: 1, gameClockSeconds: 598, playClockSeconds: 40, homeScore: 0, awayScore: 0,
    possession: 0, down: 1, distance: 10, fieldX: -25, lineToGain: -15, lineToGainSource: 'PLACEHOLDER',
    hash: 'left', hashSource: 'POSITION_BLOCK_VERIFIED',
    offensiveCallAvailable: false, defensiveCallAvailable: false,
    ...overrides,
  };
}

test('one Stage-1 call per huddle; completed snap recorded before the next huddle ranks', () => {
  const log = [];
  const engine = stubEngine(log);
  const playbooks = { offense: { plays: [] }, defense: { plays: [] } };
  const window = new CoordinatorWindow({ autoOpen: false });
  const io = { log: () => {} };
  const reducer = new SnapReducer();
  const latch = new HashLatch();
  let lastKey = null;
  let stage1Calls = 0;

  const run = raw => {
    const state = latch.apply({ ...raw });
    const reduced = reducer.ingest(state);
    if (reduced.type === 'ignored') return;
    finalizeCompletedSnap(engine, reduced, playbooks, window, io);
    const current = reduced.type === 'completed_snap' ? reduced.nextState : reduced.state;
    const key = situationIdentityKey(current);
    if (key !== lastKey) {
      handleNewSituation(engine, playbooks, current, lastKey, key, io, window);
      stage1Calls += 1;
      lastKey = key;
    }
  };

  // Huddle 1: clocks tick, user and CPU calls appear, hash verification flickers.
  run(tick());
  run(tick({ playClockSeconds: 35 }));
  run(tick({ playClockSeconds: 30, offensiveCallAvailable: true, offensiveSet: 'Ace', offensivePlay: 'Inside Zone' }));
  run(tick({ playClockSeconds: 28, hash: 'unknown', hashSource: 'UNAVAILABLE', offensiveCallAvailable: true, offensiveSet: 'Ace', offensivePlay: 'Inside Zone' }));
  run(tick({ playClockSeconds: 25, defensiveCallAvailable: true, defensiveSet: '2-4', defensivePlay: 'Cover 3 Sky', offensiveCallAvailable: true, offensiveSet: 'Ace', offensivePlay: 'Inside Zone' }));
  assert.equal(stage1Calls, 1);
  assert.equal(log.filter(x => x === 'rank').length, 1);

  // Snap: 4-yard gain -> 2nd & 6 (huddle 2).
  run(tick({ gameClockSeconds: 590, playClockSeconds: 40, down: 2, distance: 6, fieldX: -21, lineToGain: -15 }));
  run(tick({ gameClockSeconds: 590, playClockSeconds: 36, down: 2, distance: 6, fieldX: -21, lineToGain: -15 }));
  assert.equal(stage1Calls, 2);
  assert.equal(log.filter(x => x === 'rank').length, 2);
  // The second huddle ranked only after the completed snap was recorded.
  assert.deepEqual(engine.recordedBeforeRank, [0, 1]);
  assert.deepEqual(log.slice(-2), ['record', 'rank']);
});

test('hash latch only holds a verified hash at the same ball spot', () => {
  const latch = new HashLatch();
  assert.equal(latch.apply(tick()).hash, 'left');
  const flicker = latch.apply(tick({ hash: 'unknown' }));
  assert.equal(flicker.hash, 'left');
  assert.equal(flicker.hashSource, 'LATCHED_SAME_SPOT');
  // A new ball spot never inherits the previous hash.
  assert.equal(latch.apply(tick({ hash: 'unknown', down: 2, distance: 6, fieldX: -21 })).hash, 'unknown');
});
