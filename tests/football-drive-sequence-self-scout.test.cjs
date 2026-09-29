'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PerformanceStore } = require('../src/football/memory/performance-store');
const { SequenceMemory, relationshipBetween } = require('../src/football/sequencing/sequence-memory');
const { DriveObjectiveTracker, OBJECTIVE } = require('../src/football/gameplan/drive-objective');
const { SelfScout } = require('../src/football/memory/self-scout');

function event(play, success = true, possession = 0) {
  return {
    play,
    situation: { possession, down: 1, distance: 10 },
    grades: { offense: { situationalSuccess: success } },
    result: { yards: success ? 5 : 0 },
  };
}
function run(id, formation='Singleback Bunch') {
  return { id, name:id, formation, type:'RUN', normalizedProfile:{ decisionClass:'run', runFamily:'zone', runConcept:'inside_zone', playMechanism:'dropback' } };
}
function pa(id, formation='Singleback Bunch') {
  return { id, name:id, formation, type:'PASS', normalizedProfile:{ decisionClass:'pass', passConcept:'flood_sail', playMechanism:'play_action' } };
}

test('drive objective is sticky until a material state transition', () => {
  const tracker = new DriveObjectiveTracker();
  const first = tracker.get({ possession:0, quarter:1, clockSeconds:700, scoreDifferential:0, flags:{} });
  const second = tracker.get({ possession:0, quarter:1, clockSeconds:650, scoreDifferential:0, flags:{} });
  assert.equal(first.objective, OBJECTIVE.BALANCED);
  assert.equal(second.objective, OBJECTIVE.BALANCED);
  assert.equal(second.changed, false);
  const late = tracker.get({ possession:0, quarter:4, clockSeconds:180, scoreDifferential:7, flags:{ fourMinute:true } });
  assert.equal(late.objective, OBJECTIVE.FOUR_MINUTE);
  assert.equal(late.changed, true);
});

test('possession transition resets drive objective state', () => {
  const tracker = new DriveObjectiveTracker();
  tracker.get({ possession:0, quarter:1, scoreDifferential:0, flags:{} });
  tracker.observe({ possession:1 });
  tracker.observe({ possession:0 });
  const next = tracker.get({ possession:0, quarter:2, scoreDifferential:0, flags:{} });
  assert.equal(next.changed, true);
  assert.ok(next.driveSerial >= 2);
});

test('same-look run to play action relationship is discovered automatically', () => {
  const relation = relationshipBetween(run('smash'), pa('pa-corner'));
  assert.equal(relation.relationship, 'RUN_TO_PLAY_ACTION');
  assert.equal(relation.provenance, 'DERIVED');
});

test('sequence state recognizes payoff opportunity after repeated same look', () => {
  const store = new PerformanceStore([event(run('r1')), event(run('r1'))]);
  const sequence = new SequenceMemory(store);
  const intent = sequence.intent([run('r1'), pa('p1')]);
  assert.equal(intent.type, 'PAYOFF');
  const fit = sequence.candidateIntentFit(pa('p1'), intent, [run('r1'), pa('p1')]);
  assert.equal(fit.aligned, true);
  assert.equal(fit.tier, 2);
});

test('one failed play does not destroy an established sequence', () => {
  const store = new PerformanceStore([event(run('r1')), event(run('r1')), event(run('r1'), false)]);
  const sequence = new SequenceMemory(store);
  assert.equal(sequence.intent([run('r1'), pa('p1')]).type, 'PAYOFF');
});

test('possession boundary prevents prior drive from contaminating current sequence', () => {
  const store = new PerformanceStore([event(run('r1')), event(run('r1')), event(pa('opp'), true, 1), event(run('new'))]);
  const sequence = new SequenceMemory(store);
  const state = sequence.driveState();
  assert.equal(state.plays, 1);
});

test('self scout stays conservative at low sample and never claims CPU certainty', () => {
  const store = new PerformanceStore([event(run('r1')), event(run('r2'))]);
  const scout = new SelfScout(store).summarize();
  assert.equal(scout.confidence, 'VERY_LOW');
  assert.match(scout.interpretation, /does not claim/i);
});


test('sequence memory does not resurrect a prior offensive drive while opponent owns the latest snap', () => {
  const store = new PerformanceStore([
    event(run('old1')),
    event(run('old2')),
    event(pa('opp'), true, 1),
  ]);
  const sequence = new SequenceMemory(store);
  assert.equal(sequence.driveState().plays, 0);
  assert.equal(sequence.intent([run('r1'), pa('p1')]).type, 'ESTABLISH');
});

test('sequence presentation retains direction and resulting hash context', () => {
  const row = event({ ...run('r1'), runDirection: 'LEFT' });
  row.situation.hash = 'LEFT_HASH';
  row.situation.fieldSide = 'RIGHT';
  const state = new SequenceMemory(new PerformanceStore([row])).driveState();
  assert.equal(state.rows[0].direction, 'LEFT');
  assert.equal(state.rows[0].hash, 'LEFT_HASH');
  assert.equal(state.rows[0].fieldSide, 'RIGHT');
});
