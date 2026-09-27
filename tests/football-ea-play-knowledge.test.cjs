'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFormationXml, parseSetXml, parsePlayXml } =
  require('../src/football/knowledge/ea-play-asset-parser');
const {
  PROVENANCE,
  createAssetIndex,
  resolveReference,
  compileEaPlayKnowledge,
} = require('../src/football/knowledge/ea-play-knowledge-compiler');

const FORMATION_PATH = 'football/Gameplay/playbooks/PlayLibrary/Formations/Offense/Shotgun/Empty_Base_Flex';
const SET_PATH = `${FORMATION_PATH}/Empty_Base_Flex`;
const PLAY_PATH = `${FORMATION_PATH}/Stick`;

const FORMATION_XML = `<?xml version="1.0" encoding="utf-8"?>
<partition guid="form-part" primaryInstance="form-primary">
  <instance guid="form-primary" type="Formation" exported="true">
    <field name="Name">${FORMATION_PATH}</field>
    <field name="formationName">Empty Base Flex</field>
    <field name="formationType">FORMATION_SHOTGUN</field>
    <field name="formId">123</field>
  </instance>
</partition>`;

const SET_XML = `<?xml version="1.0" encoding="utf-8"?>
<partition guid="set-part" primaryInstance="set-primary">
  <instance guid="set-primary" type="Set" exported="true">
    <field name="Name">${SET_PATH}</field>
    <field name="setName">Empty Base Flex</field>
    <field name="setId">456</field>
    <field name="form" ref="${FORMATION_PATH}\\form-primary" partitionGuid="form-part" />
    <array name="preSnapMovements" type="ref(PointerRef)">
      <item ref="movement-default" />
    </array>
  </instance>
  <instance guid="movement-default" type="PreSnapMovement" exported="true">
    <field name="name">Default</field>
    <field name="isDefault">true</field>
    <array name="PlayerPosition" type="ref(PointerRef)">
      <item ref="pos-0" />
      <item ref="pos-1" />
      <item ref="pos-2" />
      <item ref="pos-3" />
      <item ref="pos-4" />
      <item ref="pos-5" />
      <item ref="pos-6" />
      <item ref="pos-7" />
      <item ref="pos-8" />
      <item ref="pos-9" />
      <item ref="pos-10" />
    </array>
  </instance>
    <instance guid="pos-0" type="SetPosition" exported="true">
      <field name="posOrder">0</field>
      <field name="depthPosition">Depth_0</field>
      <field name="XPos">-5</field>
      <field name="YPos">0</field>
      <field name="flipAssign">10</field>
    </instance>
    <instance guid="pos-1" type="SetPosition" exported="true">
      <field name="posOrder">1</field>
      <field name="depthPosition">Depth_1</field>
      <field name="XPos">-4</field>
      <field name="YPos">1</field>
      <field name="flipAssign">9</field>
    </instance>
    <instance guid="pos-2" type="SetPosition" exported="true">
      <field name="posOrder">2</field>
      <field name="depthPosition">Depth_2</field>
      <field name="XPos">-3</field>
      <field name="YPos">2</field>
      <field name="flipAssign">8</field>
    </instance>
    <instance guid="pos-3" type="SetPosition" exported="true">
      <field name="posOrder">3</field>
      <field name="depthPosition">Depth_3</field>
      <field name="XPos">-2</field>
      <field name="YPos">3</field>
      <field name="flipAssign">7</field>
    </instance>
    <instance guid="pos-4" type="SetPosition" exported="true">
      <field name="posOrder">4</field>
      <field name="depthPosition">Depth_4</field>
      <field name="XPos">-1</field>
      <field name="YPos">4</field>
      <field name="flipAssign">6</field>
    </instance>
    <instance guid="pos-5" type="SetPosition" exported="true">
      <field name="posOrder">5</field>
      <field name="depthPosition">Depth_5</field>
      <field name="XPos">0</field>
      <field name="YPos">5</field>
      <field name="flipAssign">5</field>
    </instance>
    <instance guid="pos-6" type="SetPosition" exported="true">
      <field name="posOrder">6</field>
      <field name="depthPosition">Depth_6</field>
      <field name="XPos">1</field>
      <field name="YPos">6</field>
      <field name="flipAssign">4</field>
    </instance>
    <instance guid="pos-7" type="SetPosition" exported="true">
      <field name="posOrder">7</field>
      <field name="depthPosition">Depth_7</field>
      <field name="XPos">2</field>
      <field name="YPos">7</field>
      <field name="flipAssign">3</field>
    </instance>
    <instance guid="pos-8" type="SetPosition" exported="true">
      <field name="posOrder">8</field>
      <field name="depthPosition">Depth_8</field>
      <field name="XPos">3</field>
      <field name="YPos">8</field>
      <field name="flipAssign">2</field>
    </instance>
    <instance guid="pos-9" type="SetPosition" exported="true">
      <field name="posOrder">9</field>
      <field name="depthPosition">Depth_9</field>
      <field name="XPos">4</field>
      <field name="YPos">9</field>
      <field name="flipAssign">1</field>
    </instance>
    <instance guid="pos-10" type="SetPosition" exported="true">
      <field name="posOrder">10</field>
      <field name="depthPosition">Depth_10</field>
      <field name="XPos">5</field>
      <field name="YPos">10</field>
      <field name="flipAssign">0</field>
    </instance>
</partition>`;

const PLAY_XML = `<?xml version="1.0" encoding="utf-8"?>
<partition guid="play-part" primaryInstance="play-primary">
  <instance guid="play-primary" type="Play" exported="true">
    <field name="Name">${PLAY_PATH}</field>
    <field name="Set" ref="${SET_PATH}\\set-primary" partitionGuid="set-part" />
    <field name="playName">Stick</field>
    <array name="positionAssignmentDefines" type="ref(PointerRef)">
      <item ref="football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_0\\assign-0" partitionGuid="assign-part-0" />
      <item ref="football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_1\\assign-1" partitionGuid="assign-part-1" />
      <item ref="football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_2\\assign-2" partitionGuid="assign-part-2" />
      <item ref="football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_3\\assign-3" partitionGuid="assign-part-3" />
      <item ref="football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_4\\assign-4" partitionGuid="assign-part-4" />
      <item ref="football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_5\\assign-5" partitionGuid="assign-part-5" />
      <item ref="football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_6\\assign-6" partitionGuid="assign-part-6" />
      <item ref="football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_7\\assign-7" partitionGuid="assign-part-7" />
      <item ref="football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_8\\assign-8" partitionGuid="assign-part-8" />
      <item ref="football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_9\\assign-9" partitionGuid="assign-part-9" />
      <item ref="football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_10\\assign-10" partitionGuid="assign-part-10" />
    </array>
    <field name="BlockingSchemeDefine" ref="football/Gameplay/playbooks/PlayLibrary/Blocking/CODE_DETERMINE\\blocking-guid" partitionGuid="blocking-part" />
    <array name="passData" type="ref(PointerRef)">
      <item ref="pass-1" />
      <item ref="pass-2" />
    </array>
    <field name="playId">789</field>
    <field name="offensePlayType">OffensePlayType_PassShotgun</field>
    <field name="runHole">0</field>
    <field name="allowHotRoutes">true</field>
    <field name="enableMotion">true</field>
    <field name="passShort">true</field>
  </instance>
  <instance guid="pass-1" type="PlayPassData" exported="true">
    <field name="combo">1</field>
    <field name="position">5</field>
    <field name="percentage">0.88</field>
    <field name="concept">Concept_Stick</field>
  </instance>
  <instance guid="pass-2" type="PlayPassData" exported="true">
    <field name="combo">2</field>
    <field name="position">1</field>
    <field name="percentage">0.22</field>
    <field name="concept">Concept_Ohio</field>
  </instance>
</partition>`;

function assignmentIndex() {
  const assignments = {};
  for (let i = 0; i < 11; i++) {
    assignments[String(5000 + i)] = {
      positionAssignId: 5000 + i,
      name: `football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_${i}`,
      assetPath: `football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_${i}`,
      shortName: `Assignment_${i}`,
      category: i < 6 ? 'RunRoute' : 'Blocking',
      routeType: i < 6 ? 'AssignRouteType_RR_Test' : 'AssignRouteType_Block_Pass',
      partitionGuid: `assign-part-${i}`,
      primaryGuid: `assign-${i}`,
      actions: [
        { order: 0, guid: `action-${i}`, type: i < 6 ? 'RunRouteAssignment' : 'PassBlockAssignment', opcode: i < 6 ? 'ID_RUNROUTE' : 'ID_PASSBLOCK', fields: { distance: i + 1 }, arrays: {} },
        { order: 1, guid: `none-${i}`, type: 'NoneAssignment', opcode: 'ID_NONE', fields: {}, arrays: {} },
      ],
      semantics: {
        route: i < 6 ? { routeFamily: 'test', points: [{ x: 0, y: 0 }] } : null,
        blocking: i >= 6 ? { passBlocks: [{ order: 0 }] } : null,
      },
    };
  }
  return { metadata: { schemaVersion: 2 }, assignments };
}

test('parses real-shaped Formation/Set/Play structures and ordered slots', () => {
  const formation = parseFormationXml(FORMATION_XML);
  const set = parseSetXml(SET_XML);
  const play = parsePlayXml(PLAY_XML);

  assert.equal(formation.formId, 123);
  assert.equal(set.setId, 456);
  assert.equal(set.positions.length, 11);
  assert.deepEqual(set.positions.map(row => row.index), [0,1,2,3,4,5,6,7,8,9,10]);
  assert.equal(set.positions[3].x, -2);
  assert.equal(set.positions[3].y, 3);
  assert.equal(set.positions[3].flipIndex, 7);

  assert.equal(play.playId, 789);
  assert.equal(play.positionAssignmentDefines.length, 11);
  assert.equal(play.positionAssignmentDefines[0].assetPath, 'football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_0');
  assert.equal(play.positionAssignmentDefines[10].partitionGuid, 'assign-part-10');
  assert.deepEqual(play.concepts, ['Concept_Stick', 'Concept_Ohio']);
  assert.equal(play.passData[0].percentage, 0.88);
  assert.equal(play.passData[0].combo, 1);
  assert.equal(play.blockingSchemeRef.assetPath, 'football/Gameplay/playbooks/PlayLibrary/Blocking/CODE_DETERMINE');
});

test('strict reference resolution rejects path/GUID disagreement', () => {
  const index = createAssetIndex(Object.values(assignmentIndex().assignments));
  const good = resolveReference({
    assetPath: 'football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_2',
    partitionGuid: 'assign-part-2',
    ref: 'assign-2',
  }, index);
  assert.equal(good.status, 'resolved_exact_identity');

  const bad = resolveReference({
    assetPath: 'football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_2',
    partitionGuid: 'assign-part-2',
    ref: 'assign-9',
  }, index);
  assert.equal(bad.record, null);
  assert.equal(bad.status, 'identity_mismatch');
});

test('compiler reconstructs authoritative slots and preserves ordered assignment actions', () => {
  const compiled = compileEaPlayKnowledge({
    formations: [parseFormationXml(FORMATION_XML)],
    sets: [parseSetXml(SET_XML)],
    plays: [parsePlayXml(PLAY_XML)],
    assignmentIndex: assignmentIndex(),
  });

  assert.equal(compiled.metadata.fullyResolvedPlayCount, 1);
  assert.equal(compiled.metadata.assignmentRefCount, 11);
  assert.equal(compiled.metadata.resolvedAssignmentRefCount, 11);
  assert.equal(compiled.metadata.unresolvedNormalOffenseRefCount, 0);
  assert.equal(compiled.plays[0].resolution.status, 'fully_resolved');
  assert.equal(compiled.plays[0].players[0].positionAssignId, 5000);
  assert.equal(compiled.plays[0].players[7].startingAlignment.index, 7);
  assert.equal(compiled.plays[0].players[7].assignmentActions[0].opcode, 'ID_PASSBLOCK');
  assert.equal(compiled.plays[0].players[7].assignmentActions[1].opcode, 'ID_NONE');
  assert.equal(compiled.plays[0].players[0].source, PROVENANCE.EA_AUTHORED);
  assert.equal(compiled.plays[0].provenance.progression, PROVENANCE.DERIVED_STRUCTURAL);
  assert.match(compiled.metadata.notes.join(' '), /never used to resolve PositionAssignmentDefine\.positionAssignId/i);
});

test('SpecialTeams-only gaps are partial and do not become normal-offense failures', () => {
  const play = parsePlayXml(PLAY_XML);
  play.positionAssignmentDefines[3] = {
    index: 3,
    assetPath: 'football/Gameplay/playbooks/PlayLibrary/Assignments/SpecialTeams/Kickoff_Test',
    partitionGuid: 'special-part',
    ref: 'special-guid',
    raw: {},
  };

  const compiled = compileEaPlayKnowledge({
    formations: [parseFormationXml(FORMATION_XML)],
    sets: [parseSetXml(SET_XML)],
    plays: [play],
    assignmentIndex: assignmentIndex(),
  });

  assert.equal(compiled.plays[0].resolution.status, 'partial_special_teams');
  assert.equal(compiled.metadata.partiallyResolvedPlayCount, 1);
  assert.equal(compiled.metadata.unresolvedSpecialTeamsRefCount, 1);
  assert.equal(compiled.metadata.unresolvedNormalOffenseRefCount, 0);
  assert.equal(compiled.plays[0].players[3].resolutionStatus, 'unresolved_special_teams');
});

test('normal-offense missing assignment fails closed and never guesses a numeric join', () => {
  const play = parsePlayXml(PLAY_XML);
  play.positionAssignmentDefines[3] = {
    index: 3,
    assetPath: 'football/Gameplay/playbooks/PlayLibrary/Assignments/RunRoute/Missing_Normal_Offense',
    partitionGuid: 'missing-part',
    ref: 'missing-guid',
    raw: {},
  };

  const compiled = compileEaPlayKnowledge({
    formations: [parseFormationXml(FORMATION_XML)],
    sets: [parseSetXml(SET_XML)],
    plays: [play],
    assignmentIndex: assignmentIndex(),
  });

  assert.equal(compiled.plays[0].resolution.status, 'unresolved_normal_offense');
  assert.equal(compiled.metadata.unresolvedNormalOffenseRefCount, 1);
  assert.equal(compiled.plays[0].players[3].positionAssignId, null);
  assert.equal(compiled.plays[0].players[3].resolutionStatus, 'unresolved_reference');
});
