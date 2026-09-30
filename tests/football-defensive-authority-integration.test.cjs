'use strict';

// End-to-end: EA-authored offense (Frostbite plays) vs EA-authored defense
// (playbook_def via the AssignRouteType bridge) through the matchup evaluator,
// the structural classifier, the pre-snap coordinator and the live coordinator.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { EaPlayKnowledgeStore } = require('../src/football/knowledge/ea-play-knowledge-store');
const { buildAuthoritativePlayStructure } = require('../src/football/analysis/authoritative-play-structure');
const { buildOffensiveProfile } = require('../src/football/analysis/offensive-profile');
const { EaDefensivePlayStore } = require('../src/football/knowledge/ea-defensive-play-store');
const {
  resolveAuthoritativeDefense,
  attachDefensiveAuthority,
  OpponentDefenseBookTracker,
} = require('../src/football/analysis/authoritative-defense');
const { evaluateAssignmentMatchup } = require('../src/football/analysis/assignment-matchup');
const { classifyDefensiveStructure } = require('../src/football/analysis/structural-threat-model');
const { advisePreSnapCoordinator } = require('../src/football/recommendation/pre-snap-coordinator');
const { exactDefenseFromState } = require('../src/coordinator/live-coordinator.cjs');

const OFFENSE_ARTIFACT = path.resolve(__dirname, '..', 'data', 'knowledge', 'pro-style-ea-play-knowledge.json');
const offenseStore = new EaPlayKnowledgeStore({ filePath: OFFENSE_ARTIFACT });
const defenseStore = EaDefensivePlayStore.load();
const store = defenseStore;
const SKIP_DEFENSE = store ? false : 'defensive authority artifact not built (node scripts/build-ea-defensive-play-knowledge.cjs <Research/Playbooks>)';
const SKIP_OFFENSE = fs.existsSync(OFFENSE_ARTIFACT) ? false : 'offensive EA play knowledge not built (node scripts/build-ea-play-knowledge.cjs <Formations.zip> <Assignments.zip>)';
const SKIP_BOTH = SKIP_DEFENSE || SKIP_OFFENSE;

function offense(setName, playName) {
  const resolved = offenseStore.resolvePlay({
    playName,
    setName,
    evidence: { authorityEligible: true, playName: { value: playName, source: 'test' }, setName: { value: setName, source: 'test' } },
  });
  assert.equal(resolved.status, 'resolved', `${setName} / ${playName}`);
  const authority = buildAuthoritativePlayStructure(offenseStore.expandPlay(resolved.playKey));
  return { authority, profile: buildOffensiveProfile({ name: playName }, authority) };
}

function defense(set, name, bookId = null, candidateBookIds = null) {
  return resolveAuthoritativeDefense({ defensiveStore: defenseStore, liveCall: { available: true, set, name }, bookId, candidateBookIds });
}

const NO_OPEN_CLAIM = /will be open|receiver is open|is open\b|guaranteed open|wide open/i;

test('flood vs Cover 3 stresses the flat/curl-flat layer with high-low and flood structure', { skip: SKIP_BOTH }, () => {
  const o = offense('Ace', 'PA Flood');
  const d = defense('2-4', 'Cover 3 Sky', 522);
  const m = evaluateAssignmentMatchup({ offensiveAuthority: o.authority, offensiveProfile: o.profile, defensiveAuthority: d });
  assert.equal(m.available, true);
  assert.equal(m.classification, 'GREEN');
  const keys = m.stresses.map(s => s.key);
  assert.ok(keys.includes('high_low'));
  assert.ok(keys.includes('flood'));
  assert.match(m.reasons.join(' '), /curl-flat|flat/);
  assert.doesNotMatch(JSON.stringify(m), NO_OPEN_CLAIM);
  assert.equal(m.evidence.completeDefense, true);
});

test('seam routes vs a three-deep shell stress the deep-middle-third defender', { skip: SKIP_BOTH }, () => {
  const o = offense('Ace', 'Skinny Posts');
  const m = evaluateAssignmentMatchup({ offensiveAuthority: o.authority, offensiveProfile: o.profile, defensiveAuthority: defense('2-4', 'Cover 3 Sky', 522) });
  assert.ok(m.stresses.some(s => s.key === 'seam_stress'));
});

test('verticals and crossers vs Cover 1 man structure', { skip: SKIP_BOTH }, () => {
  const o = offense('Ace', 'Skinny Posts');
  const m = evaluateAssignmentMatchup({ offensiveAuthority: o.authority, offensiveProfile: o.profile, defensiveAuthority: defense('Over', 'Cover 1 Hole', 503) });
  const keys = m.stresses.map(s => s.key);
  assert.ok(keys.includes('vertical_stretch'));
  assert.ok(keys.includes('man_crossers'));
  assert.match(m.limitation, /no live leverage/i);
});

test('pressure: authored rushers above authored pass blockers is a RED protection problem', { skip: SKIP_DEFENSE }, () => {
  const d = defense('6-2', '60 Half Out', 522); // authored Cover 0 with 7 rushers
  assert.equal(d.summary.shell, 'ZERO_DEEP');
  assert.ok(d.summary.rushers >= 7);
  const passBlock = { eaAssignment: { semantics: { blocking: { passBlocks: [{}] } } }, alignment: { x: 0 } };
  const m = evaluateAssignmentMatchup({
    offensiveAuthority: { routeTargets: [], blockingPlayers: [passBlock, passBlock, passBlock, passBlock, passBlock] },
    offensiveProfile: { decisionClass: 'pass', playMechanism: 'dropback', routes: [] },
    defensiveAuthority: d,
  });
  assert.equal(m.classification, 'RED');
  assert.match(m.reasons.join(' '), /7 authored rushers vs 5 authored pass blockers/);
  assert.match(m.reasons.join(' '), /not a live free-rusher claim/);
});

test('run fit: box count uses authored alignment and in-box blockers', { skip: SKIP_BOTH }, () => {
  const o = offense('Ace', 'HB Power O');
  const light = evaluateAssignmentMatchup({ offensiveAuthority: o.authority, offensiveProfile: o.profile, defensiveAuthority: defense('3-3 Odd', 'Cover 4 Quarters', 522) });
  assert.ok(light.stresses.some(s => s.key === 'light_box'));
  const heavy = evaluateAssignmentMatchup({ offensiveAuthority: o.authority, offensiveProfile: o.profile, defensiveAuthority: defense('6-2', 'Base', 522) });
  assert.ok(!heavy.stresses.some(s => s.key === 'light_box'));
});

test('partial defense never claims box counts that need every defender', { skip: SKIP_BOTH }, () => {
  const o = offense('Ace', 'HB Power O');
  const partial = defense('Over', 'Cover 4 Quarters');
  assert.equal(partial.status, 'partial');
  const m = evaluateAssignmentMatchup({ offensiveAuthority: o.authority, offensiveProfile: o.profile, defensiveAuthority: partial });
  assert.ok(!m.stresses.some(s => s.key === 'light_box' || s.key === 'loaded_box'));
  assert.equal(m.evidence.completeDefense, false);
});

test('authored structure replaces name heuristics in the defensive classifier', { skip: SKIP_DEFENSE }, () => {
  const d = defense('6-2', '60 Half Out', 522);
  const byName = classifyDefensiveStructure({ name: '60 Half Out', formation: '6-2' });
  const authored = classifyDefensiveStructure({ name: '60 Half Out', formation: '6-2', authoritativeDefense: d });
  assert.equal(byName.pressure, false);
  assert.equal(authored.pressure, true);
  assert.equal(authored.coverageFamily, 'cover_0');
  assert.equal(authored.provenance, 'EA_AUTHORED');
  const quarters = classifyDefensiveStructure({ name: 'Cover 4 Quarters', authoritativeDefense: defense('3-3 Odd', 'Cover 4 Quarters', 522) });
  assert.equal(quarters.coverageFamily, 'cover_4');
  assert.equal(quarters.pressure, false);
});

test('pre-snap coordinator receives the authoritative matchup and cites it', { skip: SKIP_BOTH }, () => {
  const o = offense('Ace', 'PA Flood');
  const d = defense('2-4', 'Cover 3 Sky', 522);
  const advice = advisePreSnapCoordinator({
    selectedPlay: { id: 'pa-flood', name: 'PA Flood', formation: 'Singleback Ace', type: 'PASS', concepts: ['flood'] },
    defensiveCall: { id: 'c3', name: 'Cover 3 Sky', formation: '2-4', coverageFamily: 'cover_3', authoritativeDefense: d },
    playbook: { plays: [] },
    situation: { down: 1, distance: 10 },
    authoritativeKnowledge: { authoritative: o.authority },
  });
  assert.equal(advice.available, true);
  assert.equal(advice.baseGrade.assignmentMatchup.available, true);
  assert.equal(advice.baseGrade.assignmentMatchup.classification, 'GREEN');
  assert.equal(advice.matchupClassification, 'GREEN');
  assert.doesNotMatch(JSON.stringify(advice.reasons), NO_OPEN_CLAIM);
});

test('the user defensive book is annotated with authored structure once at load', { skip: SKIP_DEFENSE }, () => {
  const book = {
    id: '522',
    plays: [
      { id: '522:a', name: 'Cover 4 Quarters', formationId: 17, setId: 1070, sourcePlaybookId: 522 },
      { id: '522:b', name: 'Not A Real Play', formationId: 17, setId: 1070, sourcePlaybookId: 522 },
    ],
  };
  const stats = attachDefensiveAuthority(book, defenseStore);
  assert.deepEqual(stats, { plays: 2, resolved: 1, partial: 0, unresolved: 1 });
  assert.equal(book.plays[0].authoritativeDefense.resolution.evidence, 'EXACT_CATALOG_IDENTITY');
  assert.equal(book.plays[0].authoritativeDefense.knownAssignments, 11);
  assert.equal(book.plays[1].authoritativeDefense, undefined);
});

test('live exact CPU defense resolves through the defensive context and narrows the opponent book', { skip: SKIP_DEFENSE }, () => {
  const engine = { knowledge: { catalogResolver: null, resolveCoverage: () => null } };
  const tracker = new OpponentDefenseBookTracker();
  const state = {
    possession: 0,
    defensiveCallAvailable: true,
    defensiveSet: '3-3 Wide Jack',
    defensivePlay: 'CB Zone Blitz Press',
    defensivePlayId: 4019468125,
  };
  const exact = exactDefenseFromState(engine, state, { defense: true }, { store: defenseStore, bookId: null, tracker });
  assert.equal(exact.authoritativeDefense.available, true);
  assert.equal(exact.authoritativeDefense.knownAssignments, 11);
  assert.equal(exact.coverageFamily, 'cover_3'); // from the authored three-deep shell, not the name
  // Without a store the defense is honestly unavailable, never borrowed from offense.
  const bare = exactDefenseFromState(engine, state, { defense: true });
  assert.equal(bare.authoritativeDefense.available, false);
  // Stale defense (not fresh) produces nothing.
  assert.equal(exactDefenseFromState(engine, state, { defense: false }, { store: defenseStore }), null);
});
