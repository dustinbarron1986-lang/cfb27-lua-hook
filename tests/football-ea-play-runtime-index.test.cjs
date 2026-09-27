'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compactRuntimeIndex } = require('../scripts/build-ea-play-knowledge.cjs');

function player(index, assetPath, partitionGuid, assignmentGuid, positionAssignId) {
  return {
    index,
    startingAlignment: { index, x: index, y: 0 },
    assignmentRef: { assetPath, partitionGuid, ref: assignmentGuid },
    assignmentAssetPath: assetPath,
    assignmentPartitionGuid: partitionGuid,
    assignmentGuid,
    positionAssignId,
    routeType: 'AssignRouteType_Test',
    assignmentActions: [{ order: 0, opcode: 'ID_NONE', type: 'NoneAssignment', fields: {}, arrays: {} }],
    assignmentSemantics: { route: null, blocking: null, defense: null },
    assignmentName: assetPath.split('/').pop(),
    assignmentCategory: 'Test',
    assignmentSourceFile: 'test.xml',
    resolutionStatus: 'resolved_exact_identity',
    specialTeamsUnresolved: false,
    source: 'EA_AUTHORED',
  };
}

test('runtime artifact keys duplicate positionAssignIds by authoritative asset identity', () => {
  const compiled = {
    metadata: {
      resolvedAssignmentRefCount: 2,
      formationCount: 1,
      setCount: 1,
      playCount: 1,
    },
    unresolved: [],
    plays: [{
      formation: {
        assetPath: 'formation/path',
        primaryGuid: 'formation-guid',
        formId: 1,
        source: 'EA_AUTHORED',
      },
      set: {
        assetPath: 'set/path',
        primaryGuid: 'set-guid',
        setId: 2,
        positions: [{ index: 0, x: 0, y: 0 }, { index: 1, x: 1, y: 0 }],
        presnapMovements: [],
        packages: [],
        source: 'EA_AUTHORED',
      },
      play: {
        assetPath: 'play/path',
        playId: 3,
        name: 'Test Play',
        source: 'EA_AUTHORED',
      },
      players: [
        player(0, 'assignments/a', 'partition-a', 'guid-a', 88),
        player(1, 'assignments/b', 'partition-b', 'guid-b', 88),
      ],
      provenance: { play: 'EA_AUTHORED' },
      resolution: { status: 'fully_resolved' },
    }],
  };

  const runtime = compactRuntimeIndex(compiled);
  assert.equal(Object.keys(runtime.assignments).length, 2);

  const [first, second] = runtime.plays['play:play/path'].players;
  assert.notEqual(first.assignmentKey, second.assignmentKey);
  assert.equal(first.startingAlignment, undefined);
  assert.equal(first.assignmentRef, undefined);
  assert.equal(second.startingAlignment, undefined);
  assert.equal(second.assignmentRef, undefined);
});

test('runtime artifact retains unresolved SpecialTeams authoritative refs', () => {
  const compiled = {
    metadata: { resolvedAssignmentRefCount: 0, formationCount: 0, setCount: 0, playCount: 1 },
    unresolved: [],
    plays: [{
      formation: null,
      set: null,
      play: { assetPath: 'play/special', playId: 4, name: 'Special', source: 'EA_AUTHORED' },
      players: [{
        index: 0,
        startingAlignment: null,
        assignmentRef: {
          assetPath: 'football/Gameplay/playbooks/PlayLibrary/Assignments/SpecialTeams/Test',
          partitionGuid: 'special-part',
          ref: 'special-guid',
        },
        assignmentAssetPath: 'football/Gameplay/playbooks/PlayLibrary/Assignments/SpecialTeams/Test',
        assignmentPartitionGuid: 'special-part',
        assignmentGuid: 'special-guid',
        positionAssignId: null,
        resolutionStatus: 'unresolved_special_teams',
        specialTeamsUnresolved: true,
        source: 'EA_AUTHORED',
      }],
      provenance: { play: 'EA_AUTHORED' },
      resolution: { status: 'partial_special_teams' },
    }],
  };

  const runtime = compactRuntimeIndex(compiled);
  const unresolved = runtime.plays['play:play/special'].players[0];
  assert.equal(unresolved.assignmentKey, null);
  assert.equal(unresolved.specialTeamsUnresolved, true);
  assert.equal(unresolved.assignmentRef.ref, 'special-guid');
});
