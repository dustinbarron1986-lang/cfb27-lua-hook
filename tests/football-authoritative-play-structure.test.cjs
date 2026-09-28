'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAuthoritativePlayStructure,
  deriveRunExecution,
  deriveScreenExecution,
  deriveRpoExecution,
  authoritativeReceiverRows,
} = require('../src/football/analysis/authoritative-play-structure');
const { analyzeRunAssignments } = require('../src/football/analysis/run-gap-engine');
const { deriveStructuralProgression } = require('../src/football/analysis/passing-progression-engine');
const { FootballEngine } = require('../src/football/engine');

function routeAssignment(id, name, family, points, extra = {}) {
  return {
    positionAssignId: id,
    assignmentName: name,
    routeType: `AssignRouteType_${family}`,
    assignmentAssetPath: `assignments/${name}`,
    assignmentActions: extra.actions || [],
    assignmentSemantics: {
      route: {
        routeFamily: family,
        points,
        segments: [],
        events: [],
        motion: extra.motion || [],
        optionRoutes: [],
        totalDistance: 10,
        movementCost: extra.movementCost ?? 8,
        delayUnits: 0,
        maxDepth: extra.maxDepth ?? 8,
      },
      blocking: extra.blocking || null,
    },
    source: 'EA_AUTHORED',
  };
}

function blockingAssignment(id, name, blocking, actions = []) {
  return {
    positionAssignId: id,
    assignmentName: name,
    routeType: null,
    assignmentAssetPath: `assignments/${name}`,
    assignmentActions: actions,
    assignmentSemantics: { route: null, blocking },
    source: 'EA_AUTHORED',
  };
}

function syntheticExpanded({ offensePlayType, runHole = null, assignments = {}, playName = 'Synthetic Play' }) {
  const positions = Array.from({ length: 11 }, (_, index) => ({
    index,
    positionType: index === 0 ? 'QB' : (index === 1 ? 'HB' : `P${index}`),
    x: index < 6 ? index * 2 : -index * 2,
    y: index === 0 ? -5 : 0,
  }));
  const players = Array.from({ length: 11 }, (_, index) => ({
    index,
    resolutionStatus: 'resolved_exact_identity',
    assignment: assignments[index] || blockingAssignment(1000 + index, `Base ${index}`, {
      passBlocks: [],
      runBlocks: [],
      leadBlocks: [],
    }),
  }));
  return {
    status: 'resolved',
    playKey: `play:${playName}`,
    formation: { name: 'Test Formation' },
    set: { name: 'Test Set', positions },
    play: {
      name: playName,
      offensePlayType,
      runHole,
      concepts: [],
      passData: [],
    },
    players,
  };
}

function unknownKnowledge() {
  return {
    advise: ({ concept }) => ({
      known: false,
      concept,
      headline: null,
      reasons: [],
      coaching: { preSnap: [], postSnap: [] },
      coverage: null,
      pressureDetected: false,
    }),
  };
}

test('authoritative PASS reconstructs exact route geometry and a structural flood read without buttons', () => {
  const expanded = syntheticExpanded({
    offensePlayType: 'OffensePlayType_Pass',
    playName: 'Sail Test',
    assignments: {
      2: routeAssignment(2, 'Flat', 'flat', [{ x: 0, y: 0 }, { x: 5, y: 3 }], { maxDepth: 3, movementCost: 4 }),
      3: routeAssignment(3, 'Sail', 'corner', [{ x: 0, y: 0 }, { x: 8, y: 12 }], { maxDepth: 12, movementCost: 10 }),
      4: routeAssignment(4, 'Post', 'post', [{ x: 0, y: 0 }, { x: -4, y: 18 }], { maxDepth: 18, movementCost: 14 }),
    },
  });
  const structure = buildAuthoritativePlayStructure(expanded);
  const progression = deriveStructuralProgression({ playArt: structure.playArt });

  assert.equal(structure.players.length, 11);
  assert.equal(structure.classification.kind, 'pass');
  assert.equal(structure.playArt.exactAssignmentCount, 3);
  assert.equal(progression.status, 'derived_structural');
  assert.equal(progression.relationship, 'flood');
  assert.match(progression.keyDefenderRole, /curl-flat|overhang/i);
  assert.equal(progression.reads[0].button, null);
  assert.match(progression.warning, /not EA-authored|EA does not author/i);
});

test('authoritative RUN uses EA blocking evidence and does not decode numeric runHole', () => {
  const expanded = syntheticExpanded({
    offensePlayType: 'OffensePlayType_RunPower',
    runHole: 2,
    playName: 'Power Test',
    assignments: {
      5: blockingAssignment(55, 'Pull Lead Left', {
        passBlocks: [],
        runBlocks: [],
        leadBlocks: [{ gap: 'BLOCKINGGAP_B_GAP_LEFT', technique: 'BLOCKINGTECHNIQUE_LEAD' }],
      }),
    },
  });
  const structure = buildAuthoritativePlayStructure(expanded);
  const runGap = analyzeRunAssignments(
    structure.players.map(player => ({ player: player.label, eaAssignment: player.eaAssignment })),
    { runHole: structure.play.runHole }
  );
  const execution = deriveRunExecution(structure, runGap);

  assert.equal(structure.classification.kind, 'run');
  assert.equal(runGap.catalogRunHole, '2');
  assert.equal(runGap.primaryGap, 'BLOCKINGGAP_B_GAP_LEFT');
  assert.equal(execution.status, 'derived_structural');
  assert.match(execution.headline, /B GAP LEFT/i);
  assert.doesNotMatch(execution.headline, /runHole 2 is/i);
  assert.match(execution.steps[0], /pull|lead/i);
});

test('authoritative RPO requires actual handoff-option evidence and preserves attachment ambiguity', () => {
  const expanded = syntheticExpanded({
    offensePlayType: 'OffensePlayType_RPO1ReadLB',
    playName: 'RPO Peek Slant',
    assignments: {
      0: blockingAssignment(1, 'QB RPO', { passBlocks: [], runBlocks: [], leadBlocks: [] }, [{ opcode: 'ID_HANDOFF_OPTION' }]),
      2: routeAssignment(2, 'Peek Slant', 'slant', [{ x: 0, y: 0 }, { x: -5, y: 7 }], { maxDepth: 7 }),
      3: routeAssignment(3, 'Bubble', 'bubble_screen', [{ x: 0, y: 0 }, { x: 6, y: 1 }], { maxDepth: 1 }),
    },
  });
  const structure = buildAuthoritativePlayStructure(expanded);
  const execution = deriveRpoExecution(structure);

  assert.equal(structure.classification.kind, 'rpo');
  assert.ok(structure.classification.qbActions.includes('ID_HANDOFF_OPTION'));
  assert.equal(execution.available, true);
  assert.equal(execution.ambiguous, true);
  assert.match(execution.keyDefenderRole, /conflict defender/i);
  assert.equal(execution.reads.at(-1).label, 'give');
});

test('authoritative SCREEN uses the dedicated screen path rather than normal route ranking', () => {
  const expanded = syntheticExpanded({
    offensePlayType: 'OffensePlayType_PassScreen',
    playName: 'HB Slip Screen',
    assignments: {
      1: routeAssignment(11, 'HB Slip Screen', 'screen', [{ x: 0, y: 0 }, { x: 6, y: 2 }], { maxDepth: 2, movementCost: 3 }),
    },
  });
  const structure = buildAuthoritativePlayStructure(expanded);
  const execution = deriveScreenExecution(structure);

  assert.equal(structure.classification.kind, 'screen');
  assert.equal(execution.relationship, 'screen_release');
  assert.equal(execution.ambiguous, false);
  assert.equal(execution.reads.length, 1);
  assert.match(execution.reads[0].detail, /screen attachment/i);
});

test('authoritative PA requires EA handoff-fake evidence while progression remains derived', () => {
  const expanded = syntheticExpanded({
    offensePlayType: 'OffensePlayType_PassPlayAction',
    playName: 'PA Boot Test',
    assignments: {
      0: blockingAssignment(1, 'QB Play Action', { passBlocks: [], runBlocks: [], leadBlocks: [] }, [{ opcode: 'ID_HANDOFF_FAKE' }]),
      2: routeAssignment(2, 'Flat', 'flat', [{ x: 0, y: 0 }, { x: 6, y: 3 }], { maxDepth: 3 }),
      3: routeAssignment(3, 'Cross', 'cross', [{ x: 0, y: 0 }, { x: -9, y: 10 }], { maxDepth: 10 }),
    },
  });
  const store = { expandPlay: () => expanded };
  const engine = new FootballEngine({
    knowledge: unknownKnowledge(),
    executionAdvisor: { eaPlayKnowledgeStore: store },
  });
  const result = engine.adviseExecution({
    selectedPlay: {
      id: 'pa',
      name: 'Unknown To Legacy Engine',
      formation: 'Test',
      type: 'PASS',
      concepts: [],
      eaAuthority: { playKey: expanded.playKey },
    },
    defensiveCall: { name: 'Unknown Defense' },
  });

  assert.equal(result.available, true, 'authoritative guidance must not depend on legacy concept availability');
  assert.equal(result.advice.known, false);
  assert.equal(result.authority.classification.playAction, true);
  assert.ok(result.authority.classification.qbActions.includes('ID_HANDOFF_FAKE'));
  assert.equal(result.guide.progressionStatus, 'derived');
  assert.match(result.guide.warning, /handoff|play-action/i);
  assert.ok(result.guide.reads.length >= 2);
});

test('authoritative receiver adaptation never invents controller buttons', () => {
  const expanded = syntheticExpanded({
    offensePlayType: 'OffensePlayType_Pass',
    assignments: {
      2: routeAssignment(2, 'Curl', 'curl', [{ x: 0, y: 0 }, { x: 0, y: 8 }]),
    },
  });
  const rows = authoritativeReceiverRows(buildAuthoritativePlayStructure(expanded));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].button, null);
});
