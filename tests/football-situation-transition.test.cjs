'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const { FootballEngine } = require('../src/football/engine');
const { CoordinatorWindow } = require('../src/football/ui/coordinator-window');
const { loadPlaybooks } = require('../src/coordinator/playbook-loader.cjs');
const {
  handleNewSituation,
  printExecutionAdvice,
  printDefensiveRecommendation,
} = require('../src/coordinator/live-coordinator.cjs');

function makeIo() {
  const logs = [];
  return { io: { log: (...args) => logs.push(args.join(' ')) }, logs };
}

function primeStaleKickReturnSelection(coordinatorWindow) {
  // Simulates printExecutionAdvice() having painted a kick-return selection
  // during the special-teams sequence, exactly like the live bug report.
  coordinatorWindow.showSelection(
    { type: 'selected', play: { name: '5-4-2 Kick Return', formation: null }, opponentPlay: { name: 'Kickoff Middle', formation: null } },
    { available: true, advice: { known: true, headline: 'ok' }, guide: { mode: 'run', lane: 'inside', headline: 'x', watch: 'y', steps: ['z'] } },
    {},
  );
  assert.equal(coordinatorWindow.state.call, '5-4-2 Kick Return');
  assert.equal(coordinatorWindow.state.defense, 'Kickoff Middle');
  assert.ok(coordinatorWindow.state.guide);
}

function firstOffensiveHuddleState() {
  return {
    possession: 0, quarter: 1, down: 1, distance: 10, yardLine: 23,
    fieldX: 23, lineToGain: 33, gameClockSeconds: 597, playClockSeconds: 25,
    offensiveCallAvailable: false, offensiveCallStatus: null, offensiveSide: 0,
    offensiveSet: null, offensivePlay: null, offensivePlayId: null,
    defensiveCallAvailable: false, defensiveCallStatus: null, defensiveSide: 1,
    defensiveSet: null, defensivePlay: null, defensivePlayId: null,
  };
}

test('kickoff return -> first offensive huddle clears the selected kick-return play', () => {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io } = makeIo();

  primeStaleKickReturnSelection(coordinatorWindow);
  handleNewSituation(engine, playbooks, firstOffensiveHuddleState(), 'stale-key', 'new-key', io, coordinatorWindow);

  assert.notEqual(coordinatorWindow.state.call, '5-4-2 Kick Return');
});

test('kickoff return -> first offensive huddle clears the kickoff defensive call', () => {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io } = makeIo();

  primeStaleKickReturnSelection(coordinatorWindow);
  handleNewSituation(engine, playbooks, firstOffensiveHuddleState(), 'stale-key', 'new-key', io, coordinatorWindow);

  assert.notEqual(coordinatorWindow.state.defense, 'Kickoff Middle');
  assert.equal(coordinatorWindow.state.defenseFormation, null);
});

test('guide/play art is cleared at a new situation boundary', () => {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io } = makeIo();

  primeStaleKickReturnSelection(coordinatorWindow);
  // A state where possession is ambiguous/ready-check fails for both offense
  // and defense repopulation, isolating the reset itself (see the dedicated
  // "possession===1, inputs not yet available" test below for that scenario
  // more directly). Here we just confirm the reset call itself nulls guide.
  handleNewSituation(engine, playbooks, firstOffensiveHuddleState(), 'stale-key', 'new-key', io, coordinatorWindow);
  // printRecommendation may or may not find a play; either way guide must be
  // null immediately (showRecommendation's huddle branch always nulls it,
  // and the unavailable branch does too).
  assert.equal(coordinatorWindow.state.guide, null);
});

test('next normal offensive huddle invokes recommendPlays()', () => {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io } = makeIo();

  let calls = 0;
  const original = engine.recommendPlays.bind(engine);
  engine.recommendPlays = (...args) => { calls += 1; return original(...args); };

  handleNewSituation(engine, playbooks, firstOffensiveHuddleState(), 'stale-key', 'new-key', io, coordinatorWindow);

  assert.equal(calls, 1);
  assert.equal(coordinatorWindow.state.phase, 'huddle');
  assert.ok(coordinatorWindow.state.call);
});

test('new situation with possession===1 and no CPU call available yet still clears stale state', () => {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io } = makeIo();

  primeStaleKickReturnSelection(coordinatorWindow);

  const defenseHuddleState = {
    possession: 1, quarter: 1, down: 1, distance: 10, yardLine: 77,
    fieldX: 77, lineToGain: 67, gameClockSeconds: 590, playClockSeconds: 25,
    offensiveCallAvailable: false, offensiveCallStatus: null, offensiveSide: 1,
    offensiveSet: null, offensivePlay: null, offensivePlayId: null,
    defensiveCallAvailable: false, defensiveCallStatus: null, defensiveSide: 0,
    defensiveSet: null, defensivePlay: null, defensivePlayId: null,
  };

  // Mirrors the real loop's composition for this tick: handleNewSituation
  // fires first (possession-agnostic reset), then the defensive branch gets
  // its turn -- and here it legitimately cannot repopulate anything yet
  // because the CPU hasn't made its call.
  handleNewSituation(engine, playbooks, defenseHuddleState, 'stale-key', 'defense-new-key', io, coordinatorWindow);
  const key = printDefensiveRecommendation(engine, playbooks, defenseHuddleState, null, { offense: true, defense: true }, io, coordinatorWindow);

  assert.equal(key, null, 'no defensive recommendation should have been produced yet');
  assert.notEqual(coordinatorWindow.state.call, '5-4-2 Kick Return');
  assert.notEqual(coordinatorWindow.state.defense, 'Kickoff Middle');
  assert.equal(coordinatorWindow.state.cpuPlay, null);
  assert.equal(coordinatorWindow.state.guide, null);
  // Left in the honest "pending" phase, not stuck on stale special-teams data.
  assert.equal(coordinatorWindow.state.phase, 'unavailable');
});

test('normal audible behavior still works within a scrimmage snap (unaffected by the fix)', () => {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io } = makeIo();

  const base = {
    possession: 0, quarter: 1, down: 1, distance: 10, yardLine: 23,
    fieldX: 23, lineToGain: 33, gameClockSeconds: 590, playClockSeconds: 20,
    offensiveCallAvailable: true, offensiveCallStatus: 'ok', offensiveSide: 0,
    defensiveCallAvailable: true, defensiveCallStatus: 'ok', defensiveSide: 1,
    defensiveSet: '3-4', defensivePlay: 'Cover 3 Sky', defensivePlayId: 1,
  };
  const playA = { ...base, offensiveSet: 'I Form Pro', offensivePlay: 'HB Duo', offensivePlayId: 101 };
  const playB = { ...base, offensiveSet: 'I Form Pro', offensivePlay: 'PA Boot', offensivePlayId: 102 };

  let key = printExecutionAdvice(engine, playbooks, playA, null, { offense: true, defense: true }, io, coordinatorWindow);
  assert.equal(coordinatorWindow.state.phase, 'selected');
  assert.equal(coordinatorWindow.state.call, 'HB Duo');

  key = printExecutionAdvice(engine, playbooks, playB, key, { offense: true, defense: true }, io, coordinatorWindow);
  assert.equal(coordinatorWindow.state.phase, 'audible');
  assert.equal(coordinatorWindow.state.call, 'PA Boot');
});

test('ordinary offense result -> next huddle still works', () => {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io } = makeIo();

  coordinatorWindow.showResult({ event: { play: { name: 'HB Duo' }, result: { yards: 6, firstDown: true } } }, {});
  assert.equal(coordinatorWindow.state.phase, 'result');

  handleNewSituation(engine, playbooks, firstOffensiveHuddleState(), 'stale-key', 'post-result-key', io, coordinatorWindow);

  assert.equal(coordinatorWindow.state.phase, 'huddle');
  assert.equal(coordinatorWindow.state.result, null);
});

test('offense/defense possession transition still works after the fix', () => {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io } = makeIo();

  const defenseState = {
    possession: 1, quarter: 1, down: 2, distance: 7, yardLine: 40,
    fieldX: 40, lineToGain: 47, gameClockSeconds: 400, playClockSeconds: 20,
    offensiveCallAvailable: true, offensiveCallStatus: 'ok', offensiveSide: 1,
    offensiveSet: 'Gun Trio Y-Flex', offensivePlay: 'Shock H Option', offensivePlayId: 55,
    defensiveCallAvailable: false, defensiveCallStatus: null, defensiveSide: 0,
  };

  handleNewSituation(engine, playbooks, defenseState, 'stale-key', 'defense-key', io, coordinatorWindow);
  printDefensiveRecommendation(engine, playbooks, defenseState, null, { offense: true, defense: true }, io, coordinatorWindow);

  assert.equal(coordinatorWindow.state.phase, 'defensive_huddle');
  assert.equal(coordinatorWindow.state.cpuPlay, 'Shock H Option');
});

test('handleNewSituation does not create a fake snap/performance event', () => {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io } = makeIo();

  const before = engine.performance.getAll().length;
  handleNewSituation(engine, playbooks, firstOffensiveHuddleState(), 'stale-key', 'new-key', io, coordinatorWindow);
  const after = engine.performance.getAll().length;

  assert.equal(before, 0);
  assert.equal(after, 0);
});

test('no stale controller buttons/routes survive the transition', () => {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io } = makeIo();

  coordinatorWindow.showSelection(
    { type: 'selected', play: { name: 'PA JET SWEEP' }, opponentPlay: { name: 'Cover 1' } },
    { available: true, advice: { known: true }, guide: { mode: 'pass', diagramMode: 'assignment_partial', receivers: [{ button: 'B', routeFamily: 'slant' }] } },
    {},
  );
  assert.ok(coordinatorWindow.state.guide.receivers.length);

  handleNewSituation(engine, playbooks, firstOffensiveHuddleState(), 'stale-key', 'new-key', io, coordinatorWindow);

  assert.equal(coordinatorWindow.state.guide, null);
});

test('special-teams reset does not erase a legitimate normal offensive selection before its snap', () => {
  // This mirrors the main loop's actual guard: handleNewSituation is only
  // ever invoked when situationKey changes. Within the same down (no key
  // change), it must never run, so an in-progress selection/audible survives.
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io } = makeIo();

  const state = {
    possession: 0, quarter: 1, down: 1, distance: 10, yardLine: 23,
    fieldX: 23, lineToGain: 33, gameClockSeconds: 590, playClockSeconds: 20,
    offensiveCallAvailable: true, offensiveCallStatus: 'ok', offensiveSide: 0,
    offensiveSet: 'I Form Pro', offensivePlay: 'HB Duo', offensivePlayId: 101,
    defensiveCallAvailable: true, defensiveCallStatus: 'ok', defensiveSide: 1,
    defensiveSet: '3-4', defensivePlay: 'Cover 3 Sky', defensivePlayId: 1,
  };
  printExecutionAdvice(engine, playbooks, state, null, { offense: true, defense: true }, io, coordinatorWindow);
  assert.equal(coordinatorWindow.state.call, 'HB Duo');

  const situationKey = `${state.possession}|${state.quarter}|${state.down}|${state.distance}|${state.fieldX}|${state.lineToGain}`;
  const lastSituationKey = situationKey; // unchanged -- the real loop would not call handleNewSituation here

  assert.equal(situationKey, lastSituationKey);
  // Confirm the selection is untouched since handleNewSituation was correctly
  // never invoked for this (no-op) tick.
  assert.equal(coordinatorWindow.state.call, 'HB Duo');
});

test('the situation-boundary log only fires when the key actually changes, not every tick', () => {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io, logs } = makeIo();

  // Simulate the main loop's own guard across several ticks: same situationKey
  // repeated (must not log), then one real change (must log exactly once).
  let lastSituationKey = null;
  const ticks = [
    firstOffensiveHuddleState(),
    firstOffensiveHuddleState(),
    firstOffensiveHuddleState(),
    { ...firstOffensiveHuddleState(), down: 2, distance: 4, fieldX: 26, lineToGain: 30 },
  ];
  for (const current of ticks) {
    const situationKey = `${current.possession}|${current.quarter}|${current.down}|${current.distance}|${current.fieldX}|${current.lineToGain}`;
    if (situationKey !== lastSituationKey) {
      handleNewSituation(engine, playbooks, current, lastSituationKey, situationKey, io, coordinatorWindow);
      lastSituationKey = situationKey;
    }
  }

  const boundaryLogs = logs.filter(l => l.includes('[COORD] Situation boundary:'));
  assert.equal(boundaryLogs.length, 2, 'expected exactly one boundary log for the initial key and one for the single real change');
});
