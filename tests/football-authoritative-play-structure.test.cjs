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
const { deriveStructuralProgression, routeTraits } = require('../src/football/analysis/passing-progression-engine');
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
        segments: extra.segments || [],
        events: extra.events || [],
        motion: extra.motion || [],
        optionRoutes: extra.optionRoutes || [],
        totalDistance: 10,
        movementCost: extra.movementCost ?? 8,
        delayUnits: extra.delayUnits ?? 0,
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
  assert.match(progression.warning, /not an EA-authored progression/i);
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

function progressionTarget({ id, startX, family, routeType, maxDepth, movementCost, events = [], segments = [], optionRoutes = [] }) {
  return {
    button: null, playerIndex: id, playerLabel: `P${id}`, startX,
    assignmentId: id, assignmentName: family,
    routeType: routeType || `AssignRouteType_RR_${family}`, routeFamily: family,
    geometry: { start: { x: startX, y: 0 }, routeFamily: family, points: [{ x: startX, y: 0 }],
      events, segments, optionRoutes, maxDepth, movementCost, delayUnits: 0 },
  };
}

test('Post/Corner human labels use primary-break field position and post-cut geometry while preserving raw EA route type', () => {
  const post = progressionTarget({
    id: 21, startX: 12, family: 'post_deep', routeType: 'AssignRouteType_RR_Post_Deep', maxDepth: 24, movementCost: 30,
    events: [{ order: 1, type: 'cut', x: 0, y: 12, movementCostAtCut: 12, distanceAtCut: 12, delayUnitsAtCut: 0 }],
    segments: [{ order: 0, from: { x: 12, y: 0 }, to: { x: 12, y: 12 }, distance: 12, speed: 100 },
      { order: 2, from: { x: 12, y: 12 }, to: { x: 5, y: 24 }, distance: 14, speed: 100 }],
  });
  const corner = progressionTarget({
    id: 22, startX: 12, family: 'post_deep', routeType: 'AssignRouteType_RR_Post_Deep', maxDepth: 24, movementCost: 30,
    events: [{ order: 1, type: 'cut', x: 0, y: 12, movementCostAtCut: 12, distanceAtCut: 12, delayUnitsAtCut: 0 }],
    segments: [{ order: 0, from: { x: 12, y: 0 }, to: { x: 12, y: 12 }, distance: 12, speed: 100 },
      { order: 2, from: { x: 12, y: 12 }, to: { x: 21, y: 24 }, distance: 15, speed: 100 }],
  });
  const postTraits = routeTraits(post);
  const cornerTraits = routeTraits(corner);
  assert.equal(postTraits.derivedFootballRoute, 'Post');
  assert.equal(cornerTraits.derivedFootballRoute, 'Corner');
  assert.equal(postTraits.rawEaRouteType, 'AssignRouteType_RR_Post_Deep');
  assert.equal(cornerTraits.rawEaRouteType, 'AssignRouteType_RR_Post_Deep');
});

test('multi-cut deterministic route matures at final meaningful authored cut, not the setup cut', () => {
  const whip = progressionTarget({
    id: 31, startX: 10, family: 'whip', maxDepth: 8, movementCost: 20,
    events: [
      { order: 1, type: 'cut', x: 0, y: 3, movementCostAtCut: 3, distanceAtCut: 3, delayUnitsAtCut: 0 },
      { order: 3, type: 'cut', x: -2, y: 6, movementCostAtCut: 8, distanceAtCut: 7, delayUnitsAtCut: 0 },
    ],
    segments: [{ order: 0, from: { x: 10, y: 0 }, to: { x: 10, y: 3 }, distance: 3, speed: 100 },
      { order: 2, from: { x: 10, y: 3 }, to: { x: 8, y: 6 }, distance: 4, speed: 100 },
      { order: 4, from: { x: 8, y: 6 }, to: { x: 13, y: 6 }, distance: 5, speed: 100 }],
  });
  const traits = routeTraits(whip);
  assert.equal(traits.maturity.primaryBreak.order, 3);
  assert.equal(traits.maturity.source, 'final_meaningful_authored_cut');
  assert.equal(traits.maturity.bucket, 'early');
});

test('flat maturity ignores long whole-route cost while vertical maturity uses depth when no meaningful cut exists', () => {
  const flat = progressionTarget({ id: 41, startX: 8, family: 'flat_rt', maxDepth: 2, movementCost: 22,
    segments: [{ order: 0, from: { x: 8, y: 0 }, to: { x: 25, y: 2 }, distance: 17.5, speed: 85 }] });
  const vertical = progressionTarget({ id: 42, startX: -8, family: 'vertical', maxDepth: 20, movementCost: 20,
    segments: [{ order: 0, from: { x: -8, y: 0 }, to: { x: -8, y: 20 }, distance: 20, speed: 100 }] });
  assert.ok(['immediate', 'quick'].includes(routeTraits(flat).maturity.bucket));
  assert.equal(routeTraits(flat).maturity.source, 'release_shallow_window');
  assert.equal(routeTraits(vertical).maturity.bucket, 'late');
  assert.equal(routeTraits(vertical).maturity.source, 'depth_window');
});

test('option-route maturity stays ambiguous instead of forcing a final-cut interpretation', () => {
  const option = progressionTarget({
    id: 51, startX: 8, family: 'choice', maxDepth: 10, movementCost: 10,
    optionRoutes: [{ order: 2, asset: 'branch/a' }, { order: 2, asset: 'branch/b' }],
    events: [{ order: 1, type: 'cut', x: 0, y: 5, movementCostAtCut: 5, distanceAtCut: 5, delayUnitsAtCut: 0 },
      { order: 2, type: 'option_route', x: 0, y: 5, branches: [] }],
    segments: [{ order: 0, from: { x: 8, y: 0 }, to: { x: 8, y: 5 }, distance: 5, speed: 100 }],
  });
  const traits = routeTraits(option);
  assert.equal(traits.maturity.ambiguous, true);
  assert.equal(traits.maturity.bucket, 'ambiguous');
});

test('derived progression exposes relative WINDOW/THROW coaching and exact route identity without controller buttons', () => {
  const flat = progressionTarget({ id: 61, startX: 10, family: 'flat', maxDepth: 3, movementCost: 18,
    segments: [{ order: 0, from: { x: 10, y: 0 }, to: { x: 18, y: 3 }, distance: 9, speed: 100 }] });
  const dig = progressionTarget({
    id: 62, startX: 14, family: 'dig', maxDepth: 12, movementCost: 25,
    events: [{ order: 1, type: 'cut', x: 0, y: 10, movementCostAtCut: 10, distanceAtCut: 10, delayUnitsAtCut: 0 }],
    segments: [{ order: 0, from: { x: 14, y: 0 }, to: { x: 14, y: 10 }, distance: 10, speed: 100 },
      { order: 2, from: { x: 14, y: 10 }, to: { x: 2, y: 10 }, distance: 12, speed: 100 }],
  });
  const result = deriveStructuralProgression({ playArt: { targets: [flat, dig] } });
  const digRead = result.reads.find(read => read.assignmentId === 62);
  assert.ok(digRead);
  assert.equal(digRead.playerIndex, 62);
  assert.equal(digRead.button, null);
  assert.equal(digRead.timing, 'intermediate');
  assert.match(digRead.detail, /WINDOW: intermediate/i);
  assert.match(digRead.detail, /THROW: anticipate the final inside break/i);
  assert.match(result.warning, /not an EA-authored progression/i);
});
