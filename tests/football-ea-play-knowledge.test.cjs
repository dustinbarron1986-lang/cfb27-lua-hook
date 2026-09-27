'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFormationXml, parseSetXml, parsePlayXml } =
  require('../src/football/knowledge/ea-play-asset-parser');
const { compileEaPlayKnowledge } =
  require('../src/football/knowledge/ea-play-knowledge-compiler');

const FORMATION_XML = `<?xml version="1.0" encoding="utf-8"?>
<partition guid="form-part" primaryInstance="form-primary">
  <instance guid="form-primary" type="Formation" exported="true">
    <field name="Name">football/Gameplay/playbooks/PlayLibrary/Formations/Offense/Shotgun/Empty_Base_Flex</field>
    <field name="formationType">FORMATION_SHOTGUN</field>
    <field name="formId">123</field>
  </instance>
</partition>`;

const SET_XML = `<?xml version="1.0" encoding="utf-8"?>
<partition guid="set-part" primaryInstance="set-primary">
  <instance guid="set-primary" type="Set" exported="true">
    <field name="Name">football/Gameplay/playbooks/PlayLibrary/Sets/Offense/Shotgun/Empty_Base_Flex</field>
    <field name="setName">Empty Base Flex</field>
    <field name="setId">456</field>
    <field name="Formation" ref="form-primary" partitionGuid="form-part" />
    <array name="SetPosition" type="SetPosition">
      ${Array.from({ length: 11 }, (_, i) =>
        `<item><complex><field name="positionIndex">${i}</field><field name="positionType">POS_${i}</field><field name="x">${i - 5}</field><field name="y">0</field></complex></item>`
      ).join('')}
    </array>
  </instance>
</partition>`;

const PLAY_XML = `<?xml version="1.0" encoding="utf-8"?>
<partition guid="play-part" primaryInstance="play-primary">
  <instance guid="play-primary" type="Play" exported="true">
    <field name="Name">football/Gameplay/playbooks/PlayLibrary/Formations/Offense/Shotgun/Empty_Base_Flex/Stick</field>
    <field name="playName">Stick</field>
    <field name="playId">789</field>
    <field name="Set" ref="set-primary" partitionGuid="set-part" />
    <field name="BlockingSchemeDefine" assetPath="football/Gameplay/playbooks/PlayLibrary/BlockingSchemes/CODE_DETERMINE" />
    <field name="offensePlayType">PASS</field>
    <array name="positionAssignmentDefines" type="ref(PointerRef)">
      ${Array.from({ length: 11 }, (_, i) =>
        `<item ref="assign-${i}" partitionGuid="assign-part-${i}" />`
      ).join('')}
    </array>
    <array name="passData" type="PlayPassData">
      <item><complex><field name="position">1</field><field name="combo">7</field><field name="percentage">60</field><field name="concept">Concept_Stick</field></complex></item>
      <item><complex><field name="position">2</field><field name="combo">8</field><field name="percentage">40</field><field name="concept">Concept_Ohio</field></complex></item>
    </array>
  </instance>
</partition>`;

function assignmentIndex() {
  const assignments = {};
  for (let i = 0; i < 11; i++) {
    assignments[String(5000 + i)] = {
      positionAssignId: 5000 + i,
      name: `football/Gameplay/playbooks/PlayLibrary/Assignments/Test/Assignment_${i}`,
      shortName: `Assignment_${i}`,
      category: i < 6 ? 'RunRoute' : 'Blocking',
      routeType: i < 6 ? 'AssignRouteType_RR_Test' : 'AssignRouteType_Block_Pass',
      partitionGuid: `assign-part-${i}`,
      primaryGuid: `assign-${i}`,
      semantics: { route: i < 6 ? { routeFamily: 'test' } : null, blocking: i >= 6 ? { passBlocks: [{}] } : null }
    };
  }
  return { metadata: { schemaVersion: 1 }, assignments };
}

test('parses Formation/Set/Play references and preserves ordered 11-player assignments', () => {
  const formation = parseFormationXml(FORMATION_XML);
  const set = parseSetXml(SET_XML);
  const play = parsePlayXml(PLAY_XML);

  assert.equal(formation.formId, 123);
  assert.equal(set.setId, 456);
  assert.equal(set.positions.length, 11);
  assert.equal(play.playId, 789);
  assert.equal(play.positionAssignmentDefines.length, 11);
  assert.equal(play.positionAssignmentDefines[10].partitionGuid, 'assign-part-10');
  assert.deepEqual(play.concepts, ['Concept_Stick', 'Concept_Ohio']);
  assert.equal(play.passData[0].percentage, 60);
});

test('compiler reconstructs a fully authoritative 11-player play', () => {
  const compiled = compileEaPlayKnowledge({
    formations: [parseFormationXml(FORMATION_XML)],
    sets: [parseSetXml(SET_XML)],
    plays: [parsePlayXml(PLAY_XML)],
    assignmentIndex: assignmentIndex(),
  });

  assert.equal(compiled.metadata.fullyResolvedPlayCount, 1);
  assert.equal(compiled.unresolved.length, 0);
  assert.equal(compiled.plays[0].players.length, 11);
  assert.equal(compiled.plays[0].players[0].positionAssignId, 5000);
  assert.equal(compiled.plays[0].players[7].startingAlignment.index, 7);
  assert.equal(compiled.plays[0].provenance.progression, 'not_authored_here');
  assert.match(compiled.metadata.notes.join(' '), /never used to resolve PositionAssignmentDefine\.positionAssignId/i);
});

test('compiler reports missing assignment refs instead of guessing a numeric join', () => {
  const play = parsePlayXml(PLAY_XML);
  play.positionAssignmentDefines[3] = {
    index: 3,
    ref: 'missing',
    partitionGuid: 'missing-part',
    raw: {},
  };
  const compiled = compileEaPlayKnowledge({
    formations: [parseFormationXml(FORMATION_XML)],
    sets: [parseSetXml(SET_XML)],
    plays: [play],
    assignmentIndex: assignmentIndex(),
  });

  assert.equal(compiled.metadata.fullyResolvedPlayCount, 0);
  assert.equal(compiled.unresolved.length, 1);
  assert.equal(compiled.plays[0].players[3].positionAssignId, null);
  assert.equal(compiled.plays[0].players[3].resolutionStatus, 'unresolved_reference');
});
