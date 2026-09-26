'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { KnowledgeEngine } = require('../src/football/knowledge/knowledge-engine.js');
const { ExecutionAdvisor, detectConcept } = require('../src/football/recommendation/execution-advisor.js');

// Historically verified play-name -> concept/coverage mappings (the "v0.4" regression
// this stage restores). These must resolve correctly via the static catalog, not just
// coincidentally via the small hand-authored regex/alias tables.
test('KnowledgeEngine resolves historically verified concept mappings via the catalog', () => {
  const knowledge = new KnowledgeEngine();

  assert.equal(knowledge.resolveConcept('Seam Divide'), 'four_verticals');
  assert.equal(knowledge.resolveConcept('Shock H Option'), 'choice_option');
  assert.equal(knowledge.resolveConcept('Y Corner'), 'corner');
  assert.equal(knowledge.resolveConcept('HB Stretch'), 'outside_zone');
});

test('KnowledgeEngine resolves historically verified coverage mappings via the catalog', () => {
  const knowledge = new KnowledgeEngine();

  assert.equal(knowledge.resolveCoverage('Saw Blitz 1'), 'cover_1');
});

test('KnowledgeEngine.advise is known=true for previously-unresolved plays', () => {
  const knowledge = new KnowledgeEngine();

  const seamDivide = knowledge.advise({ concept: 'Seam Divide', defensivePlayName: 'Cover 3 Sky' });
  assert.equal(seamDivide.known, true);
  assert.equal(seamDivide.concept, 'four_verticals');

  const shockHOption = knowledge.advise({ concept: 'Shock H Option', defensivePlayName: 'Zone Blitz' });
  assert.equal(shockHOption.known, true);
  assert.equal(shockHOption.concept, 'choice_option');

  const yCorner = knowledge.advise({ concept: 'Y Corner', defensivePlayName: 'Overload 3 Sky Press' });
  assert.equal(yCorner.known, true);
  assert.equal(yCorner.concept, 'corner');
});

test('KnowledgeEngine.resolveConcept falls back to regex heuristics when the catalog has no confident match', () => {
  const knowledge = new KnowledgeEngine();

  // A made-up name that isn't in the static catalog at all must still fall
  // back to the existing regex/alias behavior rather than throwing or
  // silently resolving to nothing.
  assert.equal(knowledge.resolveConcept('Totally Made Up Mesh Concept'), 'mesh');
});

test('detectConcept prefers the catalog\'s exact primaryConcept over the whitelist guess', () => {
  // Reproduces the bug: a play tagged with multiple concepts where a whitelist
  // scan would previously pick the wrong one (four_verticals) because
  // choice_option/corner were absent from the whitelist.
  const shockHOption = {
    name: 'Shock H Option',
    primaryConcept: 'choice_option',
    concepts: ['choice_option', 'option_route', 'man_beater', 'four_verticals', 'vertical', 'deep_shot']
  };
  assert.equal(detectConcept(shockHOption), 'choice_option');

  const yCorner = {
    name: 'Y Corner',
    primaryConcept: 'corner',
    concepts: ['corner', 'zone_beater', 'quick_intermediate']
  };
  assert.equal(detectConcept(yCorner), 'corner');

  // Without a primaryConcept field, the whitelist scan is still the fallback,
  // and now recognizes choice_option/corner directly if they appear in concepts[].
  const noPrimaryConcept = {
    name: 'Some Corner Route',
    concepts: ['corner', 'zone_beater']
  };
  assert.equal(detectConcept(noPrimaryConcept), 'corner');
});

test('ExecutionAdvisor produces known post-selection advice for a play the old whitelist mis-tagged', () => {
  const advisor = new ExecutionAdvisor();

  const advice = advisor.advise({
    selectedPlay: {
      id: 'shock-h-option',
      name: 'Shock H Option',
      formation: 'Gun Trio Y-Flex',
      primaryConcept: 'choice_option',
      concepts: ['choice_option', 'option_route', 'man_beater', 'four_verticals', 'vertical', 'deep_shot']
    },
    defensiveCall: { name: 'Zone Blitz' }
  });

  assert.equal(advice.available, true);
  assert.equal(advice.advice.concept, 'choice_option');
});
