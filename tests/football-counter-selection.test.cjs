const test = require('node:test');
const assert = require('node:assert/strict');

const { CatalogResolver } = require('../src/football/knowledge/catalog-resolver');
const { PerformanceStore } = require('../src/football/memory/performance-store');
const { RecommendationHistory } = require('../src/football/memory/recommendation-history');
const { OpponentTendencies } = require('../src/football/recommendation/opponent-tendencies');
const { DefensiveSelectionEngine } = require('../src/football/recommendation/defensive-selection-engine');
const { PlaySelectionEngine } = require('../src/football/recommendation/play-selection-engine');
const { classifyOffensiveStructure } = require('../src/football/analysis/structural-threat-model');

function knowledgeStub() {
  return {
    catalogResolver: { describeDefensivePlay: () => null },
    resolveConcept(value) {
      const n = String(value || '').toLowerCase();
      if (n.includes('inside zone')) return 'inside_zone';
      if (n.includes('flood') || n.includes('sail')) return 'flood';
      if (n.includes('vertical')) return 'four_verticals';
      return null;
    },
    resolveCoverage(value) {
      const n = String(value || '').toLowerCase();
      if (/cover\s*4|quarters|palms/.test(n)) return 'cover_4';
      if (/cover\s*3|3\s+(?:double\s+)?(?:buzz|sky|cloud)/.test(n)) return 'cover_3';
      if (/cover\s*2\s*man|2\s*man/.test(n)) return 'cover_2_man';
      if (/cover\s*2|tampa\s*2/.test(n)) return 'cover_2';
      if (/cover\s*1|robber/.test(n)) return 'cover_1';
      if (/cover\s*0|zero/.test(n)) return 'cover_0';
      return null;
    },
    evaluateMatchup() {
      return { known: false, score: 0, reasons: [] };
    },
  };
}

function event({ offense = 'Inside Zone', offenseId = offense, defense = 'Cover 3 Sky', defenseId = defense, yards = 4, defensiveSuccess = true, possession = 1 } = {}) {
  return {
    play: { id: offenseId, name: offense, concepts: [], conceptFamily: offense.toLowerCase().includes('zone') ? 'inside_zone' : null },
    opponentPlay: { id: defenseId, name: defense, concepts: [], coverageFamily: defense.toLowerCase().includes('3') ? 'cover_3' : null },
    situation: { possession, down: 1, distance: 10, yardLine: 35 },
    result: { yards, firstDown: yards >= 10, touchdown: false, turnover: false },
    grades: {
      offense: { objectiveSuccess: !defensiveSuccess, situationalSuccess: !defensiveSuccess, explosive: yards >= 15, negativePlay: yards < 0, resultGrade: yards },
      defense: { objectiveSuccess: defensiveSuccess, explosiveAllowed: yards >= 15, takeaway: false },
    },
  };
}

test('3 Double Buzz normalizes to the logical Cover-3 family', () => {
  const resolver = new CatalogResolver({ data: { plays: {
    buzz: {
      side: 'defense', name: '3 Double Buzz', playType: 190,
      assignmentFamilies: ['zone_coverage_responsibility_family'], concepts: [], modifiers: [],
    },
  } } });
  assert.equal(resolver.resolveCoverage('3 Double Buzz')?.key, 'cover_3');
  assert.equal(resolver.describeDefensivePlay('3 Double Buzz')?.coverageFamily, 'cover_3');
});

test('repeated Inside Zone raises interior-run threat more than one isolated call', () => {
  const one = new PerformanceStore([event()]);
  const three = new PerformanceStore([event(), event(), event()]);
  const current = { id: 'now', name: 'Inside Zone', concepts: ['inside_zone'] };
  const oneProfile = new OpponentTendencies(one, { knowledge: knowledgeStub() }).recentOffensiveThreats(current);
  const threeProfile = new OpponentTendencies(three, { knowledge: knowledgeStub() }).recentOffensiveThreats(current);
  assert.ok(threeProfile.scores.interior_run > oneProfile.scores.interior_run);
});

test('a current PA Flood changes the primary threat after two recent Inside Zone calls', () => {
  const store = new PerformanceStore([event(), event()]);
  const profile = new OpponentTendencies(store, { knowledge: knowledgeStub() })
    .recentOffensiveThreats({ id: 'now', name: 'PA Flood', type: 'PASS', concepts: ['flood'], modifiers: ['play_action'] });
  assert.equal(profile.primary, 'flood');
  assert.ok(profile.scores.interior_run > 0, 'recent run context should still remain present');
});

test('DC counter-first selection prefers an interior-fit structure against Inside Zone', () => {
  const store = new PerformanceStore();
  const knowledge = knowledgeStub();
  const tendencies = new OpponentTendencies(store, { knowledge });
  const engine = new DefensiveSelectionEngine({ store, knowledge, tendencies, recommendationHistory: new RecommendationHistory() });
  const ranked = engine.rank({
    playbook: { plays: [
      { id: 'light', name: 'Cover 3 Sky', formation: 'Dime 3-2', concepts: ['cover_3'] },
      { id: 'heavy', name: 'Cover 3 Sky', formation: '4-3 Over', concepts: ['cover_3'] },
    ] },
    offensePlay: { id: 'iz', name: 'Inside Zone', type: 'RUN', concepts: ['inside_zone'] },
    situation: { down: 1, distance: 10 },
    limit: 2,
  });
  assert.equal(ranked.recommendations[0].play.id, 'heavy');
  assert.ok(ranked.recommendations[0].components.counterFit > 0);
  assert.ok(ranked.strategicEligible >= 1);
});

test('3rd-and-long hard gate overrides established run tendency', () => {
  const store = new PerformanceStore([event(), event(), event()]);
  const knowledge = knowledgeStub();
  const tendencies = new OpponentTendencies(store, { knowledge });
  const engine = new DefensiveSelectionEngine({ store, knowledge, tendencies, recommendationHistory: new RecommendationHistory() });
  const ranked = engine.rank({
    playbook: { plays: [
      { id: 'run-stop', name: 'Cover 1 Robber', formation: '4-3 Over', concepts: ['cover_1'] },
      { id: 'quarters', name: 'Cover 4 Quarters', formation: 'Nickel 3-3', concepts: ['cover_4'] },
    ] },
    offensePlay: { id: 'iz', name: 'Inside Zone', type: 'RUN', concepts: ['inside_zone'] },
    situation: { down: 3, distance: 15, flags: { longYardage: true } },
    limit: 2,
  });
  assert.equal(ranked.recommendations[0].play.id, 'quarters');
  assert.equal(ranked.recommendations.some(r => r.play.id === 'run-stop'), false);
});

test('OC oracle mode selects a Cover-3 counter instead of a structurally unrelated run', () => {
  const store = new PerformanceStore();
  const knowledge = knowledgeStub();
  const tendencies = new OpponentTendencies(store, { knowledge });
  const sequences = { setupStrength: () => ({ rawScore: 0 }) };
  const engine = new PlaySelectionEngine({ store, sequences, tendencies, knowledge, recommendationHistory: new RecommendationHistory() });
  const ranked = engine.rank({
    playbook: { plays: [
      { id: 'run', name: 'Inside Zone', type: 'RUN', concepts: ['inside_zone'] },
      { id: 'flood', name: 'PA Flood', type: 'PASS', concepts: ['flood'], modifiers: ['play_action'] },
    ] },
    defensePlay: { id: 'cpu-def', name: 'Cover 3 Sky', coverageFamily: 'cover_3', assignmentFamilies: ['zone_coverage_responsibility_family'] },
    situation: { down: 2, distance: 7 },
    limit: 2,
  });
  assert.equal(ranked.selectionPolicy, 'exact_defense_oracle_counter_first');
  assert.equal(ranked.recommendations[0].play.id, 'flood');
});

test('OC 3rd-and-long gate removes an ordinary run even if it is in the playbook', () => {
  const store = new PerformanceStore();
  const knowledge = knowledgeStub();
  const tendencies = new OpponentTendencies(store, { knowledge });
  const engine = new PlaySelectionEngine({ store, sequences: { setupStrength: () => ({ rawScore: 0 }) }, tendencies, knowledge, recommendationHistory: new RecommendationHistory() });
  const ranked = engine.rank({
    playbook: { plays: [
      { id: 'run', name: 'Inside Zone', type: 'RUN', concepts: ['inside_zone'] },
      { id: 'flood', name: 'Flood', type: 'PASS', concepts: ['flood'] },
    ] },
    defensePlay: { id: 'cpu-def', name: 'Cover 3 Sky', coverageFamily: 'cover_3' },
    situation: { down: 3, distance: 12 },
    limit: 5,
  });
  assert.equal(ranked.recommendations.some(r => r.play.id === 'run'), false);
  assert.equal(ranked.recommendations[0].play.id, 'flood');
});

test('recommendation history is separate from execution history', () => {
  const history = new RecommendationHistory();
  const store = new PerformanceStore();
  const rec = { play: { id: 'c3', name: 'Cover 3 Sky', coverageFamily: 'cover_3' } };
  history.record('defense', rec, { opponentPlay: { id: 'iz' }, situation: { down: 1, distance: 10 }, family: 'cover_3' });
  history.record('defense', rec, { opponentPlay: { id: 'iz2' }, situation: { down: 2, distance: 6 }, family: 'cover_3' });
  assert.equal(store.getAll().length, 0);
  assert.ok(history.penalty('defense', rec.play, 'cover_3').score < 0);
});

test('response success ranks a working answer above a failing answer inside the valid counter set', () => {
  const good = { id: 'good', name: 'Cover 3 Sky', formation: '4-3 Over', concepts: ['cover_3'], coverageFamily: 'cover_3' };
  const bad = { id: 'bad', name: 'Cover 3 Cloud', formation: '4-3 Under', concepts: ['cover_3'], coverageFamily: 'cover_3' };
  const rows = [];
  for (let i = 0; i < 4; i += 1) rows.push(event({ offenseId: 'iz', defense: good.name, defenseId: good.id, yards: 1, defensiveSuccess: true }));
  for (let i = 0; i < 4; i += 1) rows.push(event({ offenseId: 'iz', defense: bad.name, defenseId: bad.id, yards: 8, defensiveSuccess: false }));
  const store = new PerformanceStore(rows);
  const knowledge = knowledgeStub();
  const tendencies = new OpponentTendencies(store, { knowledge });
  const engine = new DefensiveSelectionEngine({ store, knowledge, tendencies, recommendationHistory: new RecommendationHistory() });
  const ranked = engine.rank({
    playbook: { plays: [bad, good] },
    offensePlay: { id: 'iz', name: 'Inside Zone', type: 'RUN', concepts: ['inside_zone'], conceptFamily: 'inside_zone' },
    situation: { down: 1, distance: 10 },
    limit: 2,
  });
  assert.equal(ranked.recommendations[0].play.id, 'good');
  assert.ok(ranked.recommendations[0].components.observedExactMatchup > ranked.recommendations[1].components.observedExactMatchup);
});

test('offensive structure remains multi-label for an RPO', () => {
  const structure = classifyOffensiveStructure({ name: 'RPO Zone Stick', type: 'PASS', concepts: [] });
  assert.ok(structure.threatKeys.includes('interior_run'));
  assert.ok(structure.threatKeys.includes('quick_horizontal'));
  assert.ok(structure.modifierKeys.includes('RPO_CONFLICT'));
});
