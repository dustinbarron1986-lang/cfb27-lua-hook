'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FootballEngine } = require('../src/football/engine');
const { PlayKnowledgeStore } = require('../src/football/knowledge/play-knowledge-store');
const { buildNoviceGuide } = require('../src/football/recommendation/novice-execution-guide');
const { CoordinatorWindow } = require('../src/football/ui/coordinator-window');
const { loadPlaybooks } = require('../src/coordinator/playbook-loader.cjs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// Matches the real DatabasePlaybookRepository.get(405) output for this exact
// formation/play (verified via a direct DB query) -- primaryConcept "slants"
// is consistent with button B's decoded slant_route_family assignment.
const PA_JET_SWEEP = {
  id: '405:verified:singleback-ace:pa-jet-sweep',
  name: 'PA JET SWEEP',
  formation: 'Singleback Ace',
  type: 'PASS',
  concepts: ['play_action', 'slants', 'slant', 'quick_game'],
  primaryConcept: 'slants',
  sourcePlaybookId: 405,
};

test('Pro Style PlayKnowledgeStore loads successfully with the expected audit counts', () => {
  const store = new PlayKnowledgeStore();
  const audit = store.audit(405);
  assert.equal(audit.counts.total, 486);
  assert.equal(audit.counts.buttonMapHigh, 123);
  assert.equal(audit.counts.partialRouteKnowledge, 120);
  assert.equal(audit.counts.progressionVerified, 0);
});

test('PA JET SWEEP / Singleback Ace resolves its known controller mappings', () => {
  const store = new PlayKnowledgeStore();
  const resolved = store.resolve(405, 'Singleback Ace', 'PA JET SWEEP');
  assert.ok(resolved);
  const byButton = Object.fromEntries(resolved.receiverButtons.map(r => [r.button, r]));
  assert.equal(byButton.B.assignment_meaning, 'slant_route_family');
  assert.equal(byButton.B.assignment_confidence, 'high');
  for (const btn of ['X', 'Y', 'A', 'RB']) {
    assert.equal(byButton[btn].assignment_meaning, null, `${btn} should remain undecoded, not invented`);
  }
});

test('known partial-route information is labeled PARTIAL, not VERIFIED', () => {
  const engine = new FootballEngine();
  const result = engine.adviseExecution({
    selectedPlay: PA_JET_SWEEP,
    defensiveCall: { id: 'd1', name: 'Cover 1 Robber Press', set: '3-3 Wide Jack' },
  });
  assert.ok(result.guide);
  assert.equal(result.guide.diagramMode, 'assignment_partial');
  assert.equal(result.guide.progressionStatus, 'unverified');
  assert.equal(result.guide.routeStatus, 'partial');
  assert.notEqual(result.guide.diagramMode, 'verified');
});

test('with current recovered data, verified progression count remains zero', () => {
  const store = new PlayKnowledgeStore();
  assert.equal(store.audit(405).counts.progressionVerified, 0);
});

test('unknown play degrades to ESTIMATED instead of throwing', () => {
  const engine = new FootballEngine();
  let result;
  assert.doesNotThrow(() => {
    result = engine.adviseExecution({
      selectedPlay: {
        id: 'unknown-1', name: 'Totally Fictional Play Nobody Has Run',
        formation: 'Some Formation', type: 'PASS', concepts: [], sourcePlaybookId: 405,
      },
      defensiveCall: { id: 'd1', name: 'Cover 3 Sky' },
    });
  });
  assert.ok(result.guide);
  assert.equal(result.guide.diagramMode, 'concept_estimated');
  assert.match(result.guide.warning, /not verified/i);
});

test('unknown/non-Pro-Style playbook degrades gracefully', () => {
  const engine = new FootballEngine();
  let result;
  assert.doesNotThrow(() => {
    result = engine.adviseExecution({
      // A real catalog-resolvable play, but attributed to Southern Miss (295),
      // which has no play-knowledge book at all.
      selectedPlay: {
        id: '295:seam-divide', name: 'Seam Divide', formation: 'Gun Bunch Spread Nasty',
        type: 'PASS', concepts: ['four_verticals'], primaryConcept: 'four_verticals', sourcePlaybookId: 295,
      },
      defensiveCall: { id: 'd1', name: 'Cover 3 Sky' },
    });
  });
  assert.ok(result.guide);
  assert.equal(result.guide.diagramMode, 'concept_estimated');
  assert.equal(result.guide.concept, 'four_verticals');
});

test('pass concept produces a pass guide', () => {
  const engine = new FootballEngine();
  const result = engine.adviseExecution({
    selectedPlay: PA_JET_SWEEP,
    defensiveCall: { id: 'd1', name: 'Cover 1 Robber Press' },
  });
  assert.notEqual(result.guide.mode, 'run');
  assert.ok(result.guide.diagramMode);
});

test('run concept produces a run guide', () => {
  const engine = new FootballEngine();
  const result = engine.adviseExecution({
    selectedPlay: {
      id: 'hb-stretch', name: 'HB Stretch', formation: 'Singleback Ace Overload',
      type: 'RUN', concepts: ['outside_zone'], primaryConcept: 'outside_zone', sourcePlaybookId: 405,
    },
    defensiveCall: { id: 'd1', name: 'Cover 3 Sky' },
  });
  assert.equal(result.guide.mode, 'run');
  assert.equal(result.guide.concept, 'outside_zone');
  assert.equal(result.guide.lane, 'outside');
  assert.ok(result.guide.watch);
  assert.ok(Array.isArray(result.guide.steps) && result.guide.steps.length > 0);
});

test('RPO concept produces conflict/key-defender guidance where supported', () => {
  const engine = new FootballEngine();
  const resolved = engine.knowledge.resolveConcept('RPO Glance Post');
  assert.equal(resolved, 'rpo_glance_post');

  const result = engine.adviseExecution({
    selectedPlay: {
      id: 'rpo-glance-post', name: 'RPO Glance Post', formation: 'Singleback Ace',
      type: 'PASS', concepts: ['rpo_glance_post'], primaryConcept: 'rpo_glance_post', sourcePlaybookId: 405,
    },
    defensiveCall: { id: 'd1', name: 'Cover 3 Sky' },
  });

  assert.equal(result.guide.mode, 'rpo');
  // No Pro Style knowledge entry exists for this exact play -> estimated, not invented.
  assert.equal(result.guide.diagramMode, 'concept_estimated');
  assert.ok(result.guide.family);

  // Where partial receiver knowledge DOES support it, the conflict/key-defender
  // read must surface (via the decoded assignment's plain-English label).
  const partialGuide = buildNoviceGuide({
    selectedPlay: { name: 'RPO Glance Post', type: 'PASS', concepts: ['rpo_glance_post'] },
    advice: { concept: 'rpo_glance_post' },
    defensiveCall: { name: 'Cover 3 Sky' },
    playKnowledge: {
      receiverButtons: [
        { button: 'Y', x: -10, y: -2, assignment: 88, assignment_meaning: 'glance_or_post_receiver_action', assignment_confidence: 'high' },
      ],
    },
  });
  assert.equal(partialGuide.diagramMode, 'assignment_partial');
  assert.ok(partialGuide.targets.some(t => /deep middle/i.test(t.label)));
});

test('Xbox receiver buttons reach the guide/UI state', () => {
  const engine = new FootballEngine();
  const result = engine.adviseExecution({
    selectedPlay: PA_JET_SWEEP,
    defensiveCall: { id: 'd1', name: 'Cover 1 Robber Press' },
  });
  const buttons = result.guide.receivers.map(r => r.button).sort();
  assert.deepEqual(buttons, ['A', 'B', 'RB', 'X', 'Y']);

  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  assert.doesNotThrow(() => {
    coordinatorWindow.showSelection({ type: 'selected', play: PA_JET_SWEEP, opponentPlay: { name: 'Cover 1 Robber Press' } }, result, {});
  });
  assert.deepEqual(coordinatorWindow.state.guide.receivers.map(r => r.button).sort(), ['A', 'B', 'RB', 'X', 'Y']);
});

test('actual defense may alter the POST-SELECTION execution guide', () => {
  const engine = new FootballEngine();
  const nonBlitz = engine.adviseExecution({
    selectedPlay: PA_JET_SWEEP,
    defensiveCall: { id: 'd1', name: 'Cover 3 Sky' },
  });
  const blitz = engine.adviseExecution({
    selectedPlay: PA_JET_SWEEP,
    defensiveCall: { id: 'd2', name: 'Cover 0 Zero Blitz' },
  });
  assert.notEqual(nonBlitz.guide.coverageNote, blitz.guide.coverageNote);
});

test('actual defense does NOT enter offensive huddle recommendation scoring', () => {
  const engine = new FootballEngine();
  const offense = loadPlaybooks(root, { useDatabase: false }).offense;
  const situation = { down: 2, distance: 5, yardLine: 45 };

  assert.ok(!('defensiveCall' in situation) && !('defense' in situation));

  const before = engine.recommendPlays({ playbook: offense, situation, limit: 3 });
  // Build execution advice/guide against two very different defensive calls in between.
  engine.adviseExecution({ selectedPlay: PA_JET_SWEEP, defensiveCall: { id: 'd1', name: 'Cover 3 Sky' } });
  engine.adviseExecution({ selectedPlay: PA_JET_SWEEP, defensiveCall: { id: 'd2', name: 'Cover 0 Zero Blitz' } });
  const after = engine.recommendPlays({ playbook: offense, situation, limit: 3 });

  assert.deepEqual(before.recommendations.map(r => r.score), after.recommendations.map(r => r.score));
  assert.equal(after.recommendations[0].selectionPolicy, 'pre_call_no_current_exact_defense');

  // Even a situation object that a bug might leak a defensive field into must not change scoring.
  const situationWithDefenseLeak = { ...situation, defensiveCall: { name: 'Cover 0 Zero Blitz' } };
  const withLeak = engine.recommendPlays({ playbook: offense, situation: situationWithDefenseLeak, limit: 3 });
  assert.deepEqual(withLeak.recommendations.map(r => r.score), before.recommendations.map(r => r.score));
});

test('audible rebuilds the guide, changes the selected play, and creates no completed snap', () => {
  const engine = new FootballEngine();
  const defensiveCall = { id: 'd1', name: 'Cover 1 Robber Press', set: '3-3 Wide Jack' };

  const playA = PA_JET_SWEEP;
  const playB = {
    id: 'hb-stretch', name: 'HB Stretch', formation: 'Singleback Ace Overload',
    type: 'RUN', concepts: ['outside_zone'], primaryConcept: 'outside_zone', sourcePlaybookId: 405,
  };

  const attemptsBefore = engine.performance.getAll().length;

  const resultA = engine.adviseExecution({ selectedPlay: playA, defensiveCall });
  const resultB = engine.adviseExecution({ selectedPlay: playB, defensiveCall });

  assert.notEqual(resultA.selectedPlay.name, resultB.selectedPlay.name);
  assert.notEqual(resultA.guide.mode, resultB.guide.mode);
  // No stale controller assignments from Play A should remain on Play B's guide.
  assert.equal(resultB.guide.receivers, undefined);

  const attemptsAfter = engine.performance.getAll().length;
  assert.equal(attemptsBefore, attemptsAfter, 'an audible (re-advise) must not record a performance/snap event');
});

test('partial guide never invents an exact progression', () => {
  const engine = new FootballEngine();
  const result = engine.adviseExecution({
    selectedPlay: PA_JET_SWEEP,
    defensiveCall: { id: 'd1', name: 'Cover 1 Robber Press' },
  });
  assert.deepEqual(result.guide.reads, []);
  assert.notEqual(result.guide.progressionStatus, 'verified');
});

test('estimated guide is clearly labeled estimated', () => {
  const engine = new FootballEngine();
  const result = engine.adviseExecution({
    selectedPlay: {
      id: 'unknown-2', name: 'Some Unmapped Concept Play', formation: 'X', type: 'PASS', concepts: [], sourcePlaybookId: 405,
    },
    defensiveCall: { id: 'd1', name: 'Cover 3 Sky' },
  });
  assert.equal(result.guide.diagramMode, 'concept_estimated');
  assert.match(result.guide.diagramLabel, /ESTIMATED/);
  assert.ok(result.guide.warning);
});

test('CoordinatorWindow renders verified/partial/estimated guide states without throwing', () => {
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });

  const verifiedGuide = buildNoviceGuide({
    selectedPlay: { name: 'Mesh Spot', type: 'PASS', concepts: ['mesh'] },
    advice: { concept: 'mesh', coverage: 'cover_1' },
    defensiveCall: { name: 'Cover 1' },
    playKnowledge: {
      progressionVerified: true,
      progression: [{ button: '1', label: 'Crosser', detail: 'Take the first open crosser.' }],
      routes: ['crossLeftToRight'],
      routeArtVerified: true,
    },
  });
  assert.equal(verifiedGuide.diagramMode, 'verified');

  const partialGuide = buildNoviceGuide({
    selectedPlay: PA_JET_SWEEP,
    advice: {},
    defensiveCall: { name: 'Cover 1 Robber Press' },
    playKnowledge: new PlayKnowledgeStore().resolve(405, 'Singleback Ace', 'PA JET SWEEP'),
  });
  assert.equal(partialGuide.diagramMode, 'assignment_partial');

  const estimatedGuide = buildNoviceGuide({
    selectedPlay: { name: 'Unmapped Play', type: 'PASS', concepts: [] },
    advice: {},
    defensiveCall: { name: 'Cover 3 Sky' },
    playKnowledge: null,
  });
  assert.equal(estimatedGuide.diagramMode, 'concept_estimated');

  for (const guide of [verifiedGuide, partialGuide, estimatedGuide]) {
    assert.doesNotThrow(() => {
      coordinatorWindow.showSelection({ type: 'selected', play: { name: 'x' }, opponentPlay: { name: 'y' } }, { available: true, guide, advice: { known: true } }, {});
    });
  }
});

test('guide state clears correctly between phases', () => {
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });

  coordinatorWindow.showSelection(
    { type: 'selected', play: PA_JET_SWEEP, opponentPlay: { name: 'Cover 1' } },
    { available: true, advice: { known: true }, guide: { mode: 'pass', diagramMode: 'assignment_partial', receivers: [{ button: 'B' }] } },
    {},
  );
  assert.ok(coordinatorWindow.state.guide);

  coordinatorWindow.showRecommendation({ available: true, play: { name: 'Some Call' } }, {});
  assert.equal(coordinatorWindow.state.guide, null);

  coordinatorWindow.showSelection(
    { type: 'selected', play: PA_JET_SWEEP, opponentPlay: { name: 'Cover 1' } },
    { available: true, advice: { known: true }, guide: { mode: 'pass', diagramMode: 'assignment_partial', receivers: [{ button: 'B' }] } },
    {},
  );
  coordinatorWindow.showResult({ event: { play: { name: 'PA JET SWEEP' }, result: { yards: 5 } } }, {});
  assert.equal(coordinatorWindow.state.guide, null);
});

test('Stage 3 defensive recommendation still renders correctly after Stage 4 UI changes', () => {
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  coordinatorWindow.showDefensiveRecommendation({
    available: true,
    cpuPlay: { name: 'Shock H Option', formation: 'Gun Trio Y-Flex' },
    play: { name: 'Mid Blitz', formation: 'Nickel 2-4 Dbl Mug' },
    reasons: ['test reason'],
  }, {});
  assert.equal(coordinatorWindow.state.phase, 'defensive_huddle');
  assert.equal(coordinatorWindow.state.guide, null);
});

test('existing execution-advisor behavior remains intact', () => {
  const engine = new FootballEngine();
  const result = engine.adviseExecution({
    selectedPlay: PA_JET_SWEEP,
    defensiveCall: { id: 'd1', name: 'Cover 1 Robber Press' },
  });
  assert.equal(result.phase, 'post_selection_execution');
  assert.ok(result.advice);
  assert.equal(typeof result.advice.known, 'boolean');
  assert.equal(result.selectedPlay.name, 'PA JET SWEEP');
  assert.equal(result.defense.name, 'Cover 1 Robber Press');
});


test('authoritative structural guide is available even when legacy concept knowledge is unknown', () => {
  const route = (id, name, family, depth) => ({
    positionAssignId: id,
    assignmentName: name,
    routeType: `AssignRouteType_${family}`,
    assignmentAssetPath: `assignments/${name}`,
    assignmentActions: [],
    assignmentSemantics: {
      route: {
        routeFamily: family,
        points: [{ x: 0, y: 0 }, { x: family === 'flat' ? 5 : -4, y: depth }],
        segments: [],
        events: [],
        motion: [],
        optionRoutes: [],
        movementCost: depth,
        maxDepth: depth,
      },
      blocking: null,
    },
    source: 'EA_AUTHORED',
  });
  const expanded = {
    status: 'resolved',
    playKey: 'play:authoritative-only',
    formation: { name: 'Singleback' },
    set: {
      name: 'Ace',
      positions: Array.from({ length: 11 }, (_, index) => ({
        index,
        positionType: index === 0 ? 'QB' : `P${index}`,
        x: index * 2,
        y: 0,
      })),
    },
    play: { name: 'Authoritative Only', offensePlayType: 'OffensePlayType_Pass', runHole: null },
    players: Array.from({ length: 11 }, (_, index) => ({
      index,
      resolutionStatus: 'resolved_exact_identity',
      assignment: index === 2
        ? route(2, 'Flat', 'flat', 3)
        : index === 3
          ? route(3, 'Corner', 'corner', 12)
          : index === 4
            ? route(4, 'Post', 'post', 18)
            : {
                positionAssignId: 100 + index,
                assignmentName: `Block ${index}`,
                assignmentActions: [],
                assignmentSemantics: { route: null, blocking: { passBlocks: [], runBlocks: [], leadBlocks: [] } },
                source: 'EA_AUTHORED',
              },
    })),
  };
  const knowledge = {
    advise: ({ concept }) => ({
      known: false,
      concept,
      headline: null,
      reasons: [],
      coaching: { preSnap: [], postSnap: [] },
      coverage: null,
      pressureDetected: false,
    }),
    resolveConcept: () => null,
    resolveCoverage: () => null,
  };
  const engine = new FootballEngine({
    knowledge,
    executionAdvisor: { eaPlayKnowledgeStore: { expandPlay: () => expanded } },
  });
  const result = engine.adviseExecution({
    selectedPlay: {
      id: 'authoritative-only',
      name: 'Not In Legacy Knowledge',
      formation: 'Singleback Ace',
      type: 'PASS',
      concepts: [],
      eaAuthority: { playKey: expanded.playKey },
    },
    defensiveCall: { id: 'd', name: 'Unmapped Defense' },
  });

  assert.equal(result.advice.known, false);
  assert.equal(result.available, true);
  assert.equal(result.guide.diagramMode, 'assignment_geometry');
  assert.equal(result.guide.progressionStatus, 'derived');
  assert.ok(result.guide.reads.length >= 3);
  assert.ok(result.guide.reads.every(read => read.button == null));
});
