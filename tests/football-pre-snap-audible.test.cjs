'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyDefensiveBox,
  normalizeOffenseIntent,
  advisePreSnapAudible,
} = require('../src/football/recommendation/pre-snap-audible-advisor');
const { ExecutionAdvisor } = require('../src/football/recommendation/execution-advisor');

test('authoritative EA classification takes priority over legacy play type', () => {
  const intent = normalizeOffenseIntent({
    selectedPlay: { type: 'PASS' },
    authoritativeClassification: { kind: 'run' },
  });
  assert.equal(intent.family, 'RUN');
  assert.equal(intent.confidence, 'HIGH');
  assert.equal(intent.provenance, 'EA_AUTHORED');
});

test('Dime/Dollar/Prevent are LIGHT only at medium heuristic confidence', () => {
  for (const set of ['Dime 3-2', 'Dollar 3-2', 'Prevent 3 Deep']) {
    const box = classifyDefensiveBox({ set, name: 'Cover 4 Drop' });
    assert.equal(box.classification, 'LIGHT');
    assert.equal(box.confidence, 'MEDIUM');
    assert.equal(box.provenance, 'HEURISTIC');
  }
});

test('explicit goal-line or 6-2 presentation is HEAVY with high confidence', () => {
  const box = classifyDefensiveBox({ set: 'Goal Line GL 6-2', name: '60 Pinch' });
  assert.equal(box.classification, 'HEAVY');
  assert.equal(box.confidence, 'HIGH');
});

test('double-mug presentation is HEAVY but remains heuristic/medium confidence', () => {
  const box = classifyDefensiveBox({ set: 'Nickel 2-4 Dbl Mug', name: 'Mid Blitz' });
  assert.equal(box.classification, 'HEAVY');
  assert.equal(box.confidence, 'MEDIUM');
  assert.equal(box.provenance, 'HEURISTIC');
});

test('ordinary base fronts remain NEUTRAL instead of being forced light/heavy', () => {
  for (const set of ['3-3-5 Mint', 'Nickel 3-3 Over Jack', '4-2-5 Even', '3-4 Under']) {
    const box = classifyDefensiveBox({ set, name: 'Cover 3 Match' });
    assert.equal(box.classification, 'NEUTRAL');
    assert.notEqual(box.confidence, 'LOW');
  }
});

test('PASS + trustworthy LIGHT box recommends RUN', () => {
  const audible = advisePreSnapAudible({
    selectedPlay: { type: 'PASS' },
    defensiveCall: { set: 'Dime 3-2', name: 'Cover 4 Drop' },
  });
  assert.equal(audible.decision, 'RUN');
  assert.equal(audible.actionable, true);
});

test('RUN + trustworthy HEAVY box recommends PASS', () => {
  const audible = advisePreSnapAudible({
    selectedPlay: { type: 'RUN' },
    defensiveCall: { set: 'Nickel 2-4 Dbl Mug', name: 'Mid Blitz' },
  });
  assert.equal(audible.decision, 'PASS');
  assert.equal(audible.actionable, true);
});

test('NEUTRAL or LOW-confidence box reads conservatively KEEP', () => {
  const neutral = advisePreSnapAudible({
    selectedPlay: { type: 'PASS' },
    defensiveCall: { set: '3-3-5 Mint', name: 'Cover 3 Match' },
  });
  assert.equal(neutral.decision, 'KEEP');
  assert.equal(neutral.actionable, false);

  const low = advisePreSnapAudible({
    selectedPlay: { type: 'PASS' },
    defensiveCall: { set: 'Unknown Structure', name: 'Unknown Call' },
  });
  assert.equal(low.box.confidence, 'LOW');
  assert.equal(low.decision, 'KEEP');
});

test('RPO remains AMBIGUOUS and KEEP even versus an otherwise actionable box', () => {
  const audible = advisePreSnapAudible({
    selectedPlay: { type: 'RUN' },
    authoritativeClassification: { kind: 'rpo' },
    defensiveCall: { set: 'Dime 3-2', name: 'Cover 4 Drop' },
  });
  assert.equal(audible.offense.family, 'AMBIGUOUS');
  assert.equal(audible.decision, 'KEEP');
});

test('ExecutionAdvisor exposes the pre-snap audible result without requiring detailed concept guidance', () => {
  const advisor = new ExecutionAdvisor({
    playKnowledgeStore: null,
    eaPlayKnowledgeStore: null,
  });
  const result = advisor.advise({
    selectedPlay: { id: 'mystery-pass', name: 'Mystery Dropback', formation: 'Gun', type: 'PASS', concepts: [] },
    defensiveCall: { id: 'd1', set: 'Dime 3-2', name: 'Cover 4 Drop' },
  });
  assert.ok(result.audible);
  assert.equal(result.audible.decision, 'RUN');
  assert.equal(result.audible.offense.provenance, 'PLAY_METADATA');
});
