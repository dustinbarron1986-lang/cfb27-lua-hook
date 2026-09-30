'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GamePhaseTracker } = require('../src/coordinator/game-phase-tracker.cjs');
const { resolveObjective } = require('../src/football/gameplan/drive-objective');
const { fourMinuteStrength } = require('../src/football/gameplan/strategic-context');
const { buildOffensiveProfile } = require('../src/football/analysis/offensive-profile');
const { historicalDefenseInfluence, recentContextualResult } = require('../src/football/recommendation/play-selection-engine');
const { RecommendationHistory } = require('../src/football/memory/recommendation-history');
const { CoordinatorWindow } = require('../src/football/ui/coordinator-window');
const { situationIdentityKey } = require('../src/coordinator/live-coordinator.cjs');

function tick(tracker, rawQuarter, apiQuarter, gameClockSeconds, extra = {}) {
  return tracker.resolve({ rawQuarter, apiQuarter, gameClockSeconds, ...extra });
}

test('Q1 memory/API disagreement cannot silently become high-confidence Q2', () => {
  const tracker = new GamePhaseTracker();
  const r = tick(tracker, 1, 2, 540);
  assert.equal(r.quarter, 1);
  assert.equal(r.quarterConfidence, 'LOW');
  assert.equal(r.quarterEvidenceConflict, true);
});

test('clock-wrap evidence advances periods; halftime and overtime remain supported', () => {
  const tracker = new GamePhaseTracker();
  tick(tracker, 1, 1, 540);
  tick(tracker, 1, 1, 8);
  const q2 = tick(tracker, 2, 1, 540);
  assert.equal(q2.clockWrapDetected, true);
  assert.equal(q2.quarter, 2);

  tick(tracker, 2, 2, 8);
  const q3 = tick(tracker, 3, 3, 540);
  assert.equal(q3.lifecycle, 'HALFTIME');

  const ot = new GamePhaseTracker();
  tick(ot, 4, 4, 540);
  tick(ot, 4, 4, 8);
  const q5 = tick(ot, 5, 5, 540);
  assert.equal(q5.phase, 'OT1');
});

test('stale memory/API cannot regress an established quarter', () => {
  const a = new GamePhaseTracker();
  tick(a, 2, 2, 400);
  assert.equal(tick(a, 1, 2, 390).quarter, 2);
  const b = new GamePhaseTracker();
  tick(b, 2, 2, 400);
  assert.equal(tick(b, 2, 1, 390).quarter, 2);
});

test('uncertain quarter provenance keeps drive objective conservative', () => {
  const s = { quarter:4, clockSeconds:180, scoreDifferential:14, quarterConfidence:'LOW',
    quarterEvidenceConflict:true, flags:{fourMinute:true} };
  assert.equal(resolveObjective(s).objective, 'BALANCED');
  assert.equal(fourMinuteStrength(s), 0);
});

test('Sail Y Shake stays PASS despite incidental rpo_glance_post catalog concept', () => {
  const p = buildOffensiveProfile({
    name:'Sail Y Shake', type:'PASS', playKind:'PASS', primaryConcept:'flood',
    concepts:['flood','zone_beater','quick_intermediate','rpo_glance_post'],
  });
  assert.equal(p.decisionClass, 'pass');
  assert.equal(p.playMechanism, 'dropback');
});

test('representative taxonomy distinguishes pass, PA, screen, RPO, option and run', () => {
  assert.equal(buildOffensiveProfile({name:'Curl Flat',playKind:'PASS',type:'PASS'}).decisionClass,'pass');
  assert.equal(buildOffensiveProfile({name:'PA Boot',playKind:'PASS',type:'PASS'}).playMechanism,'play_action');
  assert.equal(buildOffensiveProfile({name:'HB Slip Screen',playKind:'SCREEN',type:'SCREEN'}).playMechanism,'screen');
  assert.equal(buildOffensiveProfile({name:'RPO Glance',playKind:'RPO',type:'PASS'}).decisionClass,'hybrid');
  assert.equal(buildOffensiveProfile({name:'Read Option',playKind:'OPTION'}).decisionClass,'hybrid');
  assert.equal(buildOffensiveProfile({name:'Inside Zone',playKind:'RUN',type:'RUN'}).decisionClass,'run');
});

test('historical defensive structure influence is tiny at n=2 and grows smoothly', () => {
  const n2=historicalDefenseInfluence(2), n5=historicalDefenseInfluence(5), n20=historicalDefenseInfluence(20);
  assert.ok(n2 < 0.10);
  assert.ok(n2 < n5 && n5 < n20);
  assert.ok(n20 < 0.55);
});

test('recent contextual result penalizes failure modestly without banning repeats', () => {
  const play={id:'jet',name:'Jet PA Slot Screen'};
  const situation={possession:0,down:1,distance:10};
  const fail={play,situation,result:{yards:0},grades:{offense:{situationalSuccess:false}}};
  const success={play,situation,result:{yards:6},grades:{offense:{situationalSuccess:true}}};
  const one=recentContextualResult([fail],play,situation,false);
  assert.ok(one.score < 0 && one.score > -0.5);
  assert.equal(recentContextualResult([fail,success],play,situation,false).score,0);
  const seq=recentContextualResult([fail],play,situation,true);
  assert.ok(Math.abs(seq.score) < Math.abs(one.score));
  const many=recentContextualResult([fail,fail,fail],play,situation,false);
  assert.ok(many.score < one.score && many.score >= -1.2);
});

test('recommendation exposure is only tie-breaker scale', () => {
  const history=new RecommendationHistory();
  const play={id:'p1',name:'Inside Zone',primaryConcept:'inside_zone'};
  history.record('offense',play,{situation:{quarter:1,down:1,distance:10,yardLine:25},family:'inside_zone'});
  assert.ok(history.penalty('offense',play,'inside_zone').score >= -0.10);
});

test('result presentation does not replace the active huddle', () => {
  const ui=new CoordinatorWindow({autoOpen:false});
  const state={quarter:1,gameClockSeconds:500,down:3,distance:2,yardLine:40};
  ui.showRecommendation({available:true,play:{id:'n',name:'HB Lead Dive',formation:'I Form'},reasons:['run']},state);
  ui.showResult({event:{play:{name:'PA Corner Post'},result:{yards:8}}},state);
  assert.equal(ui.state.phase,'huddle');
  assert.equal(ui.state.coordinatorCall,'HB Lead Dive');
  assert.match(ui.state.result,/PA Corner Post: \+8 yards/);
});

test('hash is part of stable huddle identity at normalized granularity', () => {
  const base={possession:0,quarter:1,down:1,distance:10,fieldX:20,lineToGain:30};
  assert.notEqual(situationIdentityKey({...base,hash:'left'}),situationIdentityKey({...base,hash:'right'}));
  assert.equal(situationIdentityKey({...base,fieldY:-8}),situationIdentityKey({...base,fieldY:-9}));
});
