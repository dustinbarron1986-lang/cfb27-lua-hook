'use strict';

// Evidence hierarchy of Stage-1 play selection: empirical prior vs local
// performance vs sequence intent vs clock strategy, with each fact counted once.

const test = require('node:test');
const assert = require('node:assert/strict');

const { PerformanceStore } = require('../src/football/memory/performance-store');
const { RecommendationHistory } = require('../src/football/memory/recommendation-history');
const { OpponentTendencies } = require('../src/football/recommendation/opponent-tendencies');
const { PlaySelectionEngine, sampleConfidence, performanceScore } = require('../src/football/recommendation/play-selection-engine');
const { EmpiricalPrior } = require('../src/football/recommendation/empirical-prior');
const { SequenceMemory } = require('../src/football/sequencing/sequence-memory');
const { DriveObjectiveTracker } = require('../src/football/gameplan/drive-objective');
const { OffensiveProfileProvider } = require('../src/football/analysis/offensive-profile');
const { scoreSituation } = require('../src/football/recommendation/situation-scorer');
const { strategicPlayScore } = require('../src/football/gameplan/strategic-context');

const knowledge = {
  catalogResolver: { describeDefensivePlay: () => null },
  resolveConcept: () => null,
  resolveCoverage: value => (/cover\s*3/i.test(String(value)) ? 'cover_3' : null),
  evaluateMatchup: () => ({ known: false, score: 0, reasons: [] }),
};

function engineFor(events = [], extra = {}) {
  const store = new PerformanceStore(events);
  return new PlaySelectionEngine({
    store,
    sequences: new SequenceMemory(store),
    tendencies: new OpponentTendencies(store, { knowledge }),
    knowledge,
    recommendationHistory: new RecommendationHistory(),
    driveObjectives: new DriveObjectiveTracker(),
    empiricalPrior: new EmpiricalPrior(),
    offensiveProfiles: new OffensiveProfileProvider(),
    ...extra,
  });
}

function snap(play, situation, success, yards = success ? 6 : 0) {
  return {
    play,
    opponentPlay: { id: 'd', name: 'Cover 3 Sky' },
    situation: { possession: 0, ...situation },
    result: { yards, firstDown: success, touchdown: false, turnover: false },
    grades: {
      offense: { situationalSuccess: success, objectiveSuccess: success, explosive: false, negativePlay: yards < 0, resultGrade: success ? 1 : 0 },
      defense: { objectiveSuccess: !success, explosiveAllowed: false, takeaway: false },
    },
  };
}

const RUN = { id: 'run', name: 'Inside Zone', formation: 'Singleback Ace', type: 'RUN', concepts: ['inside_zone'] };
const PASS = { id: 'pass', name: 'Curl Flat', formation: 'Singleback Ace', type: 'PASS', concepts: ['curl_flat'] };
const THIRD_SHORT = { possession: 0, down: 3, distance: 2, quarter: 2, clockSeconds: 400, scoreDifferential: 0, quarterConfidence: 'HIGH', flags: {} };

test('full playbook stays eligible: every play is evaluated, none filtered by the legacy call sheet', () => {
  const plays = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `Play ${i}`, formation: 'Singleback Ace', type: i % 2 ? 'PASS' : 'RUN' }));
  const ranked = engineFor().rank({ playbook: { plays }, situation: { down: 1, distance: 10 }, limit: 40 });
  assert.equal(ranked.evaluated, 40);
  assert.equal(ranked.strategicEligible, 40);
});

test('3rd-and-short cold start respects the run prior', () => {
  const ranked = engineFor().rank({ playbook: { plays: [PASS, RUN] }, situation: THIRD_SHORT, limit: 2 });
  assert.equal(ranked.recommendations[0].play.id, 'run');
  const run = ranked.recommendations[0];
  assert.ok(run.components.empiricalSituationPrior > 0);
});

test('a pass can override the 3rd-and-short run prior with strong local evidence', () => {
  const events = [];
  for (let i = 0; i < 24; i += 1) events.push(snap(PASS, { down: 3, distance: 2 }, true, 8));
  for (let i = 0; i < 6; i += 1) events.push(snap(RUN, { down: 3, distance: 2 }, false, 0));
  const ranked = engineFor(events).rank({ playbook: { plays: [PASS, RUN] }, situation: THIRD_SHORT, limit: 2 });
  assert.equal(ranked.recommendations[0].play.id, 'pass');
  assert.ok(ranked.recommendations[0].diagnostic.learningBlend.localWeight > 0.7);
});

test('n=2 local history stays weak and cannot swamp the prior', () => {
  const events = [snap(RUN, { down: 3, distance: 2 }, false, 0), snap(RUN, { down: 3, distance: 2 }, false, 0)];
  const store = new PerformanceStore(events);
  const perf = performanceScore(store, RUN, { down: 3, distance: 2, possession: 0 });
  assert.ok(Math.abs(perf.score) < 1.0, `n=2 performance moved the play by ${perf.score}`);
  assert.equal(perf.components.recentFailureEscalation, 0);
  assert.ok(Math.abs(sampleConfidence(2) - 0.2) < 1e-9);
  const ranked = engineFor(events).rank({ playbook: { plays: [PASS, RUN] }, situation: THIRD_SHORT, limit: 2 });
  assert.equal(ranked.recommendations[0].play.id, 'run');
  // recentContextualResult is suppressed once the sample-weighted rate owns it.
  const run = ranked.strategicCandidates.find(row => row.play.id === 'run');
  assert.equal(run.diagnostic.suppressedEvidence.recentContextualResult.reason, 'owned by gameDayPerformance.contextualSuccess');
});

test('leading late: clock strategy is counted once (situation), not again via gameplan or duplicate situation rules', () => {
  const lateLead = { possession: 0, down: 1, distance: 10, quarter: 4, clockSeconds: 150, scoreDifferential: 10, quarterConfidence: 'HIGH', flags: { fourMinute: true, leadingLate: true } };
  const situationPart = scoreSituation(RUN, lateLead);
  const strategic = strategicPlayScore(RUN, lateLead);
  // The situation score for a plain run late is exactly the graded strategic
  // clock value; the old +1.1 / +0.8 duplicate rules no longer stack on top.
  assert.ok(Math.abs(situationPart.score - strategic.score * 1.25) < 1e-9);
  const ranked = engineFor().rank({ playbook: { plays: [RUN, PASS] }, situation: lateLead, limit: 2 });
  const run = ranked.strategicCandidates.find(row => row.play.id === 'run');
  assert.equal(run.components.strategicSituation, 0);
  assert.equal(run.components.historicalTendency, 0);
  // Drive-objective possession credit fades by the strength the strategic
  // clock already applied (0.55 * (1 - strength)), instead of stacking.
  const { fourMinuteStrength } = require('../src/football/gameplan/strategic-context');
  const expected = 0.55 * (1 - fourMinuteStrength(lateLead));
  assert.ok(Math.abs(run.components.driveObjectiveFit - expected) < 1e-9);
  assert.ok(run.components.driveObjectiveFit < 0.55);
});

test('sequence intent survives a neutral (unknown) defense and is not beaten by a slightly higher flat score', () => {
  const setup = { id: 'iz', name: 'Inside Zone', formation: 'Singleback Bunch', type: 'RUN', normalizedProfile: { decisionClass: 'run', runFamily: 'zone', runConcept: 'inside_zone' } };
  const pa = { id: 'pa', name: 'PA Boot', formation: 'Singleback Bunch', type: 'PASS', normalizedProfile: { decisionClass: 'pass', playMechanism: 'play_action', passConcept: 'flood_sail' } };
  const other = { id: 'other', name: 'Four Verts', formation: 'Gun Trips', type: 'PASS', normalizedProfile: { decisionClass: 'pass', passConcept: 'four_verticals' } };
  const events = [snap(setup, { down: 1, distance: 10 }, true), snap(setup, { down: 2, distance: 4 }, true)];
  const ranked = engineFor(events, { offensiveProfiles: null }).rank({ playbook: { plays: [other, pa, setup] }, situation: { possession: 0, down: 1, distance: 10 }, limit: 3 });
  assert.equal(ranked.sequenceIntent.type, 'PAYOFF');
  assert.equal(ranked.sequenceIntent.stage, 'REPEAT_OR_PAYOFF');
  const top = ranked.recommendations[0];
  assert.ok(top.intentTier >= 2, `top pick ${top.play.id} tier ${top.intentTier}`);
  assert.notEqual(top.play.id, 'other');
});

test('sequencing does not force a payoff: a working base look stays first-class, a stopped one yields', () => {
  const setup = { id: 'iz', name: 'Inside Zone', formation: 'Singleback Bunch', type: 'RUN', normalizedProfile: { decisionClass: 'run', runFamily: 'zone', runConcept: 'inside_zone' } };
  const pa = { id: 'pa', name: 'PA Boot', formation: 'Singleback Bunch', type: 'PASS', normalizedProfile: { decisionClass: 'pass', playMechanism: 'play_action' } };
  const working = new SequenceMemory(new PerformanceStore([snap(setup, { down: 1, distance: 10 }, true), snap(setup, { down: 2, distance: 4 }, true)]));
  const workingIntent = working.intent([setup, pa]);
  assert.equal(working.candidateIntentFit(setup, workingIntent, [setup, pa]).tier, working.candidateIntentFit(pa, workingIntent, [setup, pa]).tier);
  const stopped = new SequenceMemory(new PerformanceStore([snap(setup, { down: 1, distance: 10 }, true), snap(setup, { down: 2, distance: 4 }, false)]));
  const stoppedIntent = stopped.intent([setup, pa]);
  assert.equal(stoppedIntent.stage, 'PAYOFF_AFTER_STOP');
  assert.ok(stopped.candidateIntentFit(pa, stoppedIntent, [setup, pa]).tier > stopped.candidateIntentFit(setup, stoppedIntent, [setup, pa]).tier);
});

test('exact defense switches to counter-first ranking: sequence tiers no longer reorder the pool', () => {
  const setup = { id: 'iz', name: 'Inside Zone', formation: 'Singleback Bunch', type: 'RUN', normalizedProfile: { decisionClass: 'run', runFamily: 'zone', runConcept: 'inside_zone' } };
  const events = [snap(setup, { down: 1, distance: 10 }, true), snap(setup, { down: 2, distance: 4 }, true)];
  const ranked = engineFor(events, { offensiveProfiles: null }).rank({
    playbook: { plays: [setup, { id: 'flood', name: 'Flood', formation: 'Gun Trips', type: 'PASS', concepts: ['flood'] }] },
    defensePlay: { id: 'c3', name: 'Cover 3 Sky', coverageFamily: 'cover_3' },
    situation: { possession: 0, down: 1, distance: 10 },
    limit: 2,
  });
  assert.equal(ranked.selectionPolicy, 'exact_defense_oracle_counter_first');
  const sorted = [...ranked.recommendations].sort((a, b) => b.score - a.score);
  assert.deepEqual(ranked.recommendations.map(r => r.play.id), sorted.map(r => r.play.id));
});
