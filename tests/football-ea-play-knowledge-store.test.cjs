'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  EaPlayKnowledgeStore,
} = require('../src/football/knowledge/ea-play-knowledge-store');

function syntheticArtifact(entries = []) {
  const formations = {};
  const sets = {};
  const assignments = {};
  const plays = {};

  for (const entry of entries) {
    const formationKey = `formation:${entry.formation}`;
    const setKey = `set:${entry.formation}/${entry.set}`;
    const playKey = entry.playKey || `play:${entry.formation}/${entry.set}/${entry.name}`;
    formations[formationKey] ||= {
      name: entry.formation,
      assetPath: `Formation/${entry.formation}`,
      source: 'EA_AUTHORED',
    };
    sets[setKey] ||= {
      name: entry.set,
      assetPath: `Set/${entry.formation}/${entry.set}`,
      positions: Array.from({ length: 11 }, (_, index) => ({ index })),
      source: 'EA_AUTHORED',
    };

    const players = Array.from({ length: 11 }, (_, index) => {
      if (entry.specialTeams && index === 10) {
        return {
          index,
          assignmentKey: null,
          resolutionStatus: 'unresolved_special_teams',
          specialTeamsUnresolved: true,
          assignmentRef: { assetPath: 'Assignments/SpecialTeams/Test', ref: 'special-guid' },
          source: 'EA_AUTHORED',
        };
      }
      const assignmentKey = `assignment:${playKey}:${index % 2}`;
      assignments[assignmentKey] ||= {
        assignmentAssetPath: `Assignments/Test/${index % 2}`,
        assignmentGuid: `guid-${index % 2}`,
        assignmentPartitionGuid: `partition-${index % 2}`,
        positionAssignId: index % 2,
        source: 'EA_AUTHORED',
      };
      return {
        index,
        assignmentKey,
        resolutionStatus: 'resolved_exact_identity',
        source: 'EA_AUTHORED',
      };
    });

    plays[playKey] = {
      formationKey,
      setKey,
      play: {
        name: entry.name,
        playId: entry.playId,
        assetPath: entry.assetPath || playKey.slice(5),
        source: 'EA_AUTHORED',
      },
      players,
      provenance: { play: 'EA_AUTHORED' },
      resolution: { status: entry.specialTeams ? 'partial_special_teams' : 'fully_resolved' },
    };
  }

  return {
    metadata: { runtimeFormat: 'deduplicated-json-v1' },
    formations,
    sets,
    assignments,
    plays,
    unresolved: [],
  };
}

const eligibleEvidence = { authorityEligible: true, source: 'test_exact_structure' };

test('missing authoritative artifact is optional and reports unavailable', () => {
  const store = new EaPlayKnowledgeStore({ filePath: path.join(__dirname, 'definitely-missing-authoritative.json') });
  assert.equal(store.available(), false);
  assert.equal(store.resolvePlay({ playName: 'PA Boot', presentation: 'I Form Pro', evidence: eligibleEvidence }).status, 'unavailable');
  assert.equal(store.availability().reason, 'artifact_missing');
});

test('loaded store distinguishes insufficient evidence from a corpus miss', () => {
  const store = new EaPlayKnowledgeStore({ document: syntheticArtifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 10 },
  ]) });

  const insufficient = store.resolvePlay({
    playName: 'PA Boot',
    presentation: 'I Form Pro',
    evidence: { authorityEligible: false },
  });
  assert.equal(insufficient.status, 'unresolved');
  assert.equal(insufficient.reason, 'insufficient_evidence');

  const miss = store.resolvePlay({
    playName: 'PA Boot',
    presentation: 'Weak I Pro',
    evidence: eligibleEvidence,
  });
  assert.equal(miss.status, 'not_found');
  assert.equal(miss.reason, 'authoritative_structural_miss');
});

test('unique normalized presentation plus play resolves to exact canonical playKey', () => {
  const store = new EaPlayKnowledgeStore({ document: syntheticArtifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 10, assetPath: 'Play/I_Form/Pro/PA_Boot' },
  ]) });

  const result = store.resolvePlay({
    playName: 'PA Boot',
    presentation: 'I_Form   Pro',
    evidence: eligibleEvidence,
    livePlayId: 10,
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.playKey, 'play:I Form/Pro/PA Boot');
  assert.equal(result.assetPath, 'Play/I_Form/Pro/PA_Boot');
  assert.equal(result.authoredPlayId, 10);
});

test('multiple exact normalized structural candidates are ambiguous, never first-match', () => {
  const artifact = syntheticArtifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 10, playKey: 'play:a' },
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 11, playKey: 'play:b' },
  ]);
  const store = new EaPlayKnowledgeStore({ document: artifact });

  const result = store.resolvePlay({
    playName: 'PA Boot',
    presentation: 'I Form Pro',
    evidence: eligibleEvidence,
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(new Set(result.candidates.map(row => row.playKey)), new Set(['play:a', 'play:b']));
});

test('separate Formation+Set+Play and presentation evidence intersect rather than broaden', () => {
  const store = new EaPlayKnowledgeStore({ document: syntheticArtifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 10 },
    { formation: 'Weak I', set: 'Pro', name: 'PA Boot', playId: 11 },
  ]) });

  const result = store.resolvePlay({
    playName: 'PA Boot',
    formationName: 'I Form',
    setName: 'Pro',
    presentation: 'I Form Pro',
    evidence: eligibleEvidence,
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.matchStrategy, 'structural_intersection');
  assert.equal(result.playKey, 'play:I Form/Pro/PA Boot');
});

test('live numeric id and authored EA playId remain diagnostic-only', () => {
  const store = new EaPlayKnowledgeStore({ document: syntheticArtifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 777 },
  ]) });

  assert.deepEqual(store.diagnosticAuthoredPlayId(777), ['play:I Form/Pro/PA Boot']);
  const result = store.resolvePlay({
    playName: 'Wrong Name',
    presentation: 'Wrong Structure',
    livePlayId: 777,
    evidence: eligibleEvidence,
  });
  assert.equal(result.status, 'not_found');
});

test('expandPlay preserves 11 ordered slots, shared assignment references, and partial SpecialTeams status', () => {
  const store = new EaPlayKnowledgeStore({ document: syntheticArtifact([
    { formation: 'Special', set: 'Kick', name: 'Kick Return', playId: 99, specialTeams: true },
  ]) });
  const resolved = store.resolvePlay({
    playName: 'Kick Return',
    presentation: 'Special Kick',
    evidence: eligibleEvidence,
  });
  assert.equal(resolved.status, 'resolved');

  const expanded = store.expandPlay(resolved.playKey);
  assert.equal(expanded.status, 'resolved');
  assert.equal(expanded.players.length, 11);
  assert.equal(expanded.players[0].index, 0);
  assert.equal(expanded.players[10].index, 10);
  assert.equal(expanded.players[0].assignment.assignmentAssetPath, expanded.players[2].assignment.assignmentAssetPath);
  assert.equal(expanded.players[10].assignment, null);
  assert.equal(expanded.players[10].specialTeamsUnresolved, true);
  assert.equal(expanded.resolution.status, 'partial_special_teams');
});
