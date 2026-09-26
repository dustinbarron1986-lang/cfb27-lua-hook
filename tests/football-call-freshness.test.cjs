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
  updateSideFreshness,
  updateFreshness,
  logFreshnessTransitions,
} = require('../src/coordinator/live-coordinator.cjs');

function makeIo() {
  const logs = [];
  return { io: { log: (...args) => logs.push(args.join(' ')) }, logs };
}

// A real Pro Style sample-playbook play/formation pair, so the new
// playbook-membership gate passes for tests that aren't specifically probing
// that gate.
const REAL_OFFENSE = { offensiveSet: 'I Form Pro', offensivePlay: 'HB Duo', offensivePlayId: 101 };
const REAL_OFFENSE_B = { offensiveSet: 'I Form Pro', offensivePlay: 'PA Boot', offensivePlayId: 102 };
const REAL_DEFENSE = { defensiveSet: '3-4', defensivePlay: 'Cover 3 Sky', defensivePlayId: 1 };
const REAL_DEFENSE_B = { defensiveSet: '3-4', defensivePlay: 'Mid Blitz', defensivePlayId: 2 };

function baseState(overrides = {}) {
  return {
    possession: 0, quarter: 1, down: 1, distance: 10, yardLine: 23,
    fieldX: 23, lineToGain: 33, gameClockSeconds: 590, playClockSeconds: 20,
    offensiveCallAvailable: true, offensiveCallStatus: 'ok', offensiveSide: 0,
    defensiveCallAvailable: true, defensiveCallStatus: 'ok', defensiveSide: 1,
    ...REAL_OFFENSE,
    ...REAL_DEFENSE,
    ...overrides,
  };
}

function setup() {
  const engine = new FootballEngine();
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io, logs } = makeIo();
  return { engine, playbooks, coordinatorWindow, io, logs };
}

function primeStaleKickoffSelection(coordinatorWindow) {
  coordinatorWindow.showSelection(
    { type: 'selected', play: { name: '5-4-2 Kick Return', formation: null }, opponentPlay: { name: 'Kickoff Right', formation: null } },
    { available: false, reason: 'play not mapped to concept knowledge', guide: { mode: 'run', lane: 'inside', headline: 'x', watch: 'y', steps: ['z'] } },
    {},
  );
}

// ---- Unit-level tests on the pure freshness functions ----

test('updateSideFreshness: identical signature at a still-available boundary stays quarantined', () => {
  const quarantine = { available: true, set: '?', name: '5-4-2 Kick Return', id: '9' };
  const current = { available: true, set: '?', name: '5-4-2 Kick Return', id: '9' };
  const result = updateSideFreshness(current, quarantine, { fresh: false, cleared: false });
  assert.equal(result.fresh, false);
});

test('updateSideFreshness: differing signature becomes fresh immediately', () => {
  const quarantine = { available: true, set: '?', name: '5-4-2 Kick Return', id: '9' };
  const current = { available: true, set: 'Singleback Ace', name: 'PA JET SWEEP', id: '55' };
  const result = updateSideFreshness(current, quarantine, { fresh: false, cleared: false });
  assert.equal(result.fresh, true);
});

test('updateSideFreshness: boundary unavailable, first appearance is fresh', () => {
  const quarantine = { available: false };
  const current = { available: true, set: 'I Form Pro', name: 'HB Duo', id: '101' };
  const result = updateSideFreshness(current, quarantine, { fresh: false, cleared: false });
  assert.equal(result.fresh, true);
});

test('updateSideFreshness: available -> unavailable -> identical reappearance becomes fresh', () => {
  const quarantine = { available: true, set: '?', name: 'PA JET SWEEP', id: '9' };
  let state = { fresh: false, cleared: false };

  state = updateSideFreshness({ available: false }, quarantine, state);
  assert.equal(state.fresh, false);
  assert.equal(state.cleared, true);

  state = updateSideFreshness({ available: true, set: '?', name: 'PA JET SWEEP', id: '9' }, quarantine, state);
  assert.equal(state.fresh, true, 'a clear-then-reappear proves a new generation even with an identical signature');
});

test('updateSideFreshness: once fresh, stays fresh even if the call later goes unavailable', () => {
  const quarantine = { available: true, set: 'a', name: 'a', id: '1' };
  let state = { fresh: true, cleared: false };
  state = updateSideFreshness({ available: false }, quarantine, state);
  assert.equal(state.fresh, true, 'freshness must be latched for the situation');
});

test('updateFreshness: each side updates independently in the same tick', () => {
  const quarantine = {
    offense: { available: true, set: '?', name: '5-4-2 Kick Return', id: '9' },
    defense: { available: true, set: '?', name: 'Kickoff Right', id: '8' },
  };
  const current = {
    offensiveCallAvailable: true, offensiveSet: 'Singleback Ace', offensivePlay: 'PA JET SWEEP', offensivePlayId: 55,
    defensiveCallAvailable: true, defensiveSet: '?', defensivePlay: 'Kickoff Right', defensivePlayId: 8,
  };
  const result = updateFreshness(current, quarantine, { offense: false, defense: false }, { offense: false, defense: false });
  assert.equal(result.fresh.offense, true, 'offense rotated first and should be recognized as fresh');
  assert.equal(result.fresh.defense, false, 'defense is still the exact quarantined signature');
});

// ---- Integration-level tests through printExecutionAdvice / printDefensiveRecommendation ----

test('the exact live Kick Return / Kickoff Right case remains quarantined and cannot overwrite the huddle', () => {
  const { engine, playbooks, coordinatorWindow, io } = setup();
  const state = baseState({
    offensiveSet: '?', offensivePlay: '5-4-2 Kick Return', offensivePlayId: 9,
    defensiveSet: '?', defensivePlay: 'Kickoff Right', defensivePlayId: 8,
  });

  const quarantine = handleNewSituation(engine, playbooks, state, null, 'boundary-key', io, coordinatorWindow);
  // handleNewSituation resets to a clean/pending state and then immediately
  // calls printRecommendation, which repopulates with the real sample-playbook
  // huddle pick -- either way, it must not be the stale kick-return name.
  assert.notEqual(coordinatorWindow.state.call, '5-4-2 Kick Return');

  const { fresh } = updateFreshness(state, quarantine, { offense: false, defense: false }, { offense: false, defense: false });
  printExecutionAdvice(engine, playbooks, state, null, fresh, io, coordinatorWindow);

  assert.notEqual(coordinatorWindow.state.call, '5-4-2 Kick Return');
});

test('fresh offense + stale defense does NOT render execution advice', () => {
  const { engine, playbooks, coordinatorWindow, io } = setup();
  const state = baseState();
  const quarantine = { offense: { available: false }, defense: { available: true, set: REAL_DEFENSE.defensiveSet, name: REAL_DEFENSE.defensivePlay, id: String(REAL_DEFENSE.defensivePlayId) } };

  const fresh = { offense: true, defense: false }; // offense proven fresh, defense identical to quarantine
  const result = printExecutionAdvice(engine, playbooks, state, null, fresh, io, coordinatorWindow);

  assert.equal(result, null);
  assert.equal(coordinatorWindow.state.call, null);
});

test('stale offense + fresh defense does NOT render execution advice', () => {
  const { engine, playbooks, coordinatorWindow, io } = setup();
  const state = baseState();
  const fresh = { offense: false, defense: true };
  const result = printExecutionAdvice(engine, playbooks, state, null, fresh, io, coordinatorWindow);

  assert.equal(result, null);
  assert.equal(coordinatorWindow.state.call, null);
});

test('both sides fresh DOES render execution advice', () => {
  const { engine, playbooks, coordinatorWindow, io } = setup();
  const state = baseState();
  const fresh = { offense: true, defense: true };
  const result = printExecutionAdvice(engine, playbooks, state, null, fresh, io, coordinatorWindow);

  assert.ok(result);
  assert.equal(coordinatorWindow.state.call, 'HB Duo');
  assert.equal(coordinatorWindow.state.phase, 'selected');
});

test('freshness is latched: audible, then audible back to a previously-seen signature, remains eligible', () => {
  const { engine, playbooks, coordinatorWindow, io } = setup();
  // Boundary is the stale kickoff pair -- both sides start not-fresh.
  const boundaryState = baseState({
    offensiveSet: '?', offensivePlay: '5-4-2 Kick Return', offensivePlayId: 9,
    defensiveSet: '?', defensivePlay: 'Kickoff Right', defensivePlayId: 8,
  });
  const quarantine = handleNewSituation(engine, playbooks, boundaryState, null, 'boundary-key', io, coordinatorWindow);

  let fresh = { offense: false, defense: false };
  let cleared = { offense: false, defense: false };

  // First real call: HB Duo / Cover 3 Sky -- both differ from the stale
  // kickoff quarantine, so both sides become fresh and latch here.
  const firstRealState = baseState(REAL_OFFENSE);
  ({ fresh, cleared } = updateFreshness(firstRealState, quarantine, fresh, cleared));
  let key = printExecutionAdvice(engine, playbooks, firstRealState, null, fresh, io, coordinatorWindow);
  assert.equal(coordinatorWindow.state.call, 'HB Duo');

  // Audible to PA Boot (defense side unchanged).
  const audibleState = baseState(REAL_OFFENSE_B);
  ({ fresh, cleared } = updateFreshness(audibleState, quarantine, fresh, cleared));
  key = printExecutionAdvice(engine, playbooks, audibleState, key, fresh, io, coordinatorWindow);
  assert.equal(coordinatorWindow.state.call, 'PA Boot');

  // Audible back to HB Duo -- a signature that was already seen once before
  // (not the boundary's own signature, but the point is identical to it: the
  // latch must not re-evaluate "does this match something already seen" at
  // all once fresh, it must simply keep rendering).
  ({ fresh, cleared } = updateFreshness(firstRealState, quarantine, fresh, cleared));
  key = printExecutionAdvice(engine, playbooks, firstRealState, key, fresh, io, coordinatorWindow);
  assert.equal(coordinatorWindow.state.call, 'HB Duo');
  assert.equal(coordinatorWindow.state.phase, 'audible');
});

test('boundary offense unavailable -> later available becomes fresh (full pipeline)', () => {
  const { engine, playbooks, coordinatorWindow, io } = setup();
  const boundaryState = baseState({ offensiveCallAvailable: false, offensiveSet: null, offensivePlay: null, offensivePlayId: null });
  const quarantine = handleNewSituation(engine, playbooks, boundaryState, null, 'boundary-key', io, coordinatorWindow);

  const nextState = baseState();
  const { fresh } = updateFreshness(nextState, quarantine, { offense: false, defense: false }, { offense: false, defense: false });
  assert.equal(fresh.offense, true);
});

test('boundary defense unavailable -> later available becomes fresh (full pipeline)', () => {
  const { engine, playbooks, coordinatorWindow, io } = setup();
  const boundaryState = baseState({ defensiveCallAvailable: false, defensiveSet: null, defensivePlay: null, defensivePlayId: null });
  const quarantine = handleNewSituation(engine, playbooks, boundaryState, null, 'boundary-key', io, coordinatorWindow);

  const nextState = baseState();
  const { fresh } = updateFreshness(nextState, quarantine, { offense: false, defense: false }, { offense: false, defense: false });
  assert.equal(fresh.defense, true);
});

test('user-defense path (printDefensiveRecommendation) requires only fresh CPU offense', () => {
  const { engine, playbooks, coordinatorWindow, io } = setup();
  const state = {
    possession: 1, quarter: 2, down: 2, distance: 7, yardLine: 40,
    fieldX: 40, lineToGain: 47, gameClockSeconds: 400, playClockSeconds: 20,
    offensiveCallAvailable: true, offensiveCallStatus: 'ok', offensiveSide: 1,
    offensiveSet: 'Gun Trio Y-Flex', offensivePlay: 'Shock H Option', offensivePlayId: 55,
    defensiveCallAvailable: false, defensiveCallStatus: null, defensiveSide: 0,
  };

  const notYetFresh = printDefensiveRecommendation(engine, playbooks, state, null, { offense: false, defense: false }, io, coordinatorWindow);
  assert.equal(notYetFresh, null);
  assert.equal(coordinatorWindow.state.cpuPlay, null);

  const fresh = printDefensiveRecommendation(engine, playbooks, state, null, { offense: true, defense: false }, io, coordinatorWindow);
  assert.ok(fresh);
  assert.equal(coordinatorWindow.state.phase, 'defensive_huddle');
  assert.equal(coordinatorWindow.state.cpuPlay, 'Shock H Option');
});

test('CPU offense is NOT checked against the user\'s offensive playbook', () => {
  const { engine, playbooks, coordinatorWindow, io } = setup();
  // "Shock H Option" is a real catalog play but is not present in the tiny
  // 3-play sample OFFENSE playbook this test loads -- if the defensive path
  // wrongly required offense-playbook membership for the CPU's call, this
  // would be rejected. It must not be.
  const state = {
    possession: 1, quarter: 2, down: 2, distance: 7, yardLine: 40,
    fieldX: 40, lineToGain: 47, gameClockSeconds: 400, playClockSeconds: 20,
    offensiveCallAvailable: true, offensiveCallStatus: 'ok', offensiveSide: 1,
    offensiveSet: 'Gun Trio Y-Flex', offensivePlay: 'Shock H Option', offensivePlayId: 55,
    defensiveCallAvailable: false, defensiveCallStatus: null, defensiveSide: 0,
  };
  assert.equal(playbooks.offense.plays.some(p => p.name === 'Shock H Option'), false);

  const result = printDefensiveRecommendation(engine, playbooks, state, null, { offense: true, defense: false }, io, coordinatorWindow);
  assert.ok(result);
  assert.equal(coordinatorWindow.state.cpuPlay, 'Shock H Option');
});

test('offensive execution path DOES require selected-playbook membership', () => {
  const { engine, playbooks, coordinatorWindow, io } = setup();
  const state = baseState({ offensiveSet: null, offensivePlay: '5-4-2 Kick Return', offensivePlayId: 9 });
  const fresh = { offense: true, defense: true };

  const result = printExecutionAdvice(engine, playbooks, state, null, fresh, io, coordinatorWindow);

  assert.equal(result, null);
  assert.notEqual(coordinatorWindow.state.call, '5-4-2 Kick Return');
});

test('valid DB-backed Pro Style play DOES pass membership despite synthetic-vs-live id mismatch', () => {
  const { engine, coordinatorWindow, io } = setup();
  const dbPlaybooks = loadPlaybooks(root, { offensePlaybookId: 405 });
  assert.equal(dbPlaybooks.offense.plays[0].id.startsWith('405:verified:'), true);

  const state = {
    possession: 0, quarter: 1, down: 1, distance: 10, yardLine: 23,
    fieldX: 23, lineToGain: 33, gameClockSeconds: 590, playClockSeconds: 20,
    offensiveCallAvailable: true, offensiveCallStatus: 'ok', offensiveSide: 0,
    offensiveSet: 'Singleback Ace', offensivePlay: 'PA JET SWEEP', offensivePlayId: 987654, // a live numeric id, unrelated to the DB synthetic id
    defensiveCallAvailable: true, defensiveCallStatus: 'ok', defensiveSide: 1,
    defensiveSet: '3-4', defensivePlay: 'Cover 3 Sky', defensivePlayId: 1,
  };

  const result = printExecutionAdvice(engine, dbPlaybooks, state, null, { offense: true, defense: true }, io, coordinatorWindow);

  assert.ok(result);
  assert.equal(coordinatorWindow.state.call, 'PA JET SWEEP');
  assert.equal(coordinatorWindow.state.formation, 'Singleback Ace');
});

test('no fake snap/performance event is created by freshness transitions', () => {
  const { engine, playbooks, coordinatorWindow, io } = setup();
  const state = baseState();
  const before = engine.performance.getAll().length;

  handleNewSituation(engine, playbooks, state, null, 'k', io, coordinatorWindow);
  updateFreshness(state, { offense: { available: false }, defense: { available: false } }, { offense: false, defense: false }, { offense: false, defense: false });
  printExecutionAdvice(engine, playbooks, state, null, { offense: true, defense: true }, io, coordinatorWindow);
  printDefensiveRecommendation(engine, playbooks, { ...state, possession: 1 }, null, { offense: true }, io, coordinatorWindow);

  assert.equal(before, 0);
  assert.equal(engine.performance.getAll().length, 0);
});

test('freshness-change diagnostic logs fire only on the false->true transition, per side', () => {
  const { engine, playbooks, coordinatorWindow, io, logs } = setup();

  const boundaryState = baseState({
    offensiveCallAvailable: false, offensiveSet: null, offensivePlay: null, offensivePlayId: null,
    defensiveCallAvailable: false, defensiveSet: null, defensivePlay: null, defensivePlayId: null,
  });
  const quarantine = handleNewSituation(engine, playbooks, boundaryState, null, 'boundary-key', io, coordinatorWindow);

  let fresh = { offense: false, defense: false };
  let cleared = { offense: false, defense: false };

  // Tick 1: still unavailable everywhere -> no freshness change -> no log.
  let previousFresh = fresh;
  ({ fresh, cleared } = updateFreshness(boundaryState, quarantine, fresh, cleared));
  logFreshnessTransitions(previousFresh, fresh, boundaryState, io);
  assert.equal(logs.filter(l => l.includes('call fresh:')).length, 0);

  // Tick 2: both sides become available and differ -> both flip false->true -> exactly two logs.
  const nextState = baseState();
  previousFresh = fresh;
  ({ fresh, cleared } = updateFreshness(nextState, quarantine, fresh, cleared));
  logFreshnessTransitions(previousFresh, fresh, nextState, io);

  const freshnessLogs = logs.filter(l => l.includes('call fresh:'));
  assert.equal(freshnessLogs.length, 2);
  assert.ok(freshnessLogs.some(l => l.includes('Offensive call fresh: I Form Pro / HB Duo')));
  assert.ok(freshnessLogs.some(l => l.includes('Defensive call fresh: 3-4 / Cover 3 Sky')));

  // Tick 3: nothing changes -> no further logs (latched, not re-announced).
  previousFresh = fresh;
  ({ fresh, cleared } = updateFreshness(nextState, quarantine, fresh, cleared));
  logFreshnessTransitions(previousFresh, fresh, nextState, io);
  assert.equal(logs.filter(l => l.includes('call fresh:')).length, 2);
});
