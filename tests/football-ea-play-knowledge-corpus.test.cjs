'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEaPlayKnowledge } = require('../scripts/build-ea-play-knowledge.cjs');

const formationSource = process.env.CFB27_FORMATIONS_SOURCE || null;
const assignmentSource = process.env.CFB27_ASSIGNMENTS_SOURCE || null;
const hasCorpus = Boolean(formationSource && assignmentSource);

function findPlay(result, suffix) {
  const match = result.plays.find(entry =>
    String(entry.play.assetPath || '').replace(/\\/g, '/').endsWith(suffix)
  );
  assert.ok(match, `Expected authoritative play ending with ${suffix}`);
  return match;
}

function ids(entry) {
  return entry.players.map(player => player.positionAssignId);
}

test('real Pro Style corpus matches the verified authoritative baseline', { skip: !hasCorpus }, () => {
  const result = buildEaPlayKnowledge(formationSource, assignmentSource, { compact: false });
  const meta = result.metadata;

  assert.equal(meta.sourceXmlCount, 572);
  assert.equal(meta.parseFailureCount, 0);
  assert.equal(meta.assignmentSourceFileCount, 5540);
  assert.equal(meta.assignmentParseFailureCount, 0);

  assert.equal(meta.formationCount, 14);
  assert.equal(meta.setCount, 44);
  assert.equal(meta.playCount, 514);
  assert.equal(meta.assignmentRefCount, 5654);
  assert.equal(meta.resolvedAssignmentRefCount, 5531);
  assert.equal(meta.unresolvedAssignmentRefCount, 123);
  assert.equal(meta.fullyResolvedPlayCount, 498);
  assert.equal(meta.partiallyResolvedPlayCount, 16);
  assert.equal(meta.unresolvedNormalOffensePlayCount, 0);
  assert.equal(meta.unresolvedNormalOffenseRefCount, 0);
  assert.equal(meta.unresolvedSpecialTeamsRefCount, 123);

  assert.ok(result.unresolved.every(row => row.resolutionStatus === 'partial_special_teams'));
  assert.ok(result.unresolved.every(row =>
    row.unresolvedRefs.every(ref => /\/Assignments\/SpecialTeams\//i.test(ref.assetPath || ''))
  ));
});

test('real representative plays reconstruct exact EA assignments and authored metadata', { skip: !hasCorpus }, () => {
  const result = buildEaPlayKnowledge(formationSource, assignmentSource, { compact: false });

  const stick = findPlay(result, '/Shotgun/Empty_Base_Flex/Stick');
  assert.equal(stick.resolution.status, 'fully_resolved');
  assert.deepEqual(ids(stick), [5553, 5248, 1228, 7303, 2911, 4423, 1419, 2391, 2391, 2391, 1419]);
  assert.deepEqual(stick.play.concepts.sort(), ['Concept_Ohio', 'Concept_Stick']);
  assert.equal(stick.play.passData.length, 5);
  assert.equal(stick.play.blockingSchemeAssetPath.endsWith('/Blocking/CODE_DETERMINE'), true);
  assert.equal(stick.players[0].assignmentActions[0].opcode, 'ID_SCRAMBLE');
  assert.equal(stick.players[3].assignmentActions.some(action => action.opcode === 'ID_OPTIONROUTE'), true);

  const duo = findPlay(result, '/I_Form/Pro/26_Duo');
  assert.equal(duo.resolution.status, 'fully_resolved');
  assert.equal(duo.play.offensePlayType, 'OffensePlayType_RunISO');
  assert.equal(duo.play.runHole, 2);
  assert.equal(duo.players[2].positionAssignId, 5137);
  assert.equal(duo.players[2].assignmentActions.some(action => action.opcode === 'ID_LEADBLOCK'), true);

  const power = findPlay(result, '/I_Form/Pro/Power_O');
  assert.equal(power.resolution.status, 'fully_resolved');
  assert.equal(power.play.offensePlayType, 'OffensePlayType_RunPower');
  assert.equal(power.players[7].positionAssignId, 2530);
  assert.equal(power.players[7].assignmentName, 'LG_Pull_H6_PowerORt');

  const boot = findPlay(result, '/I_Form/Pro/PA_Boot');
  assert.equal(boot.resolution.status, 'fully_resolved');
  assert.equal(boot.play.offensePlayType, 'OffensePlayType_PassPlayAction');
  assert.equal(boot.players[0].positionAssignId, 1385);
  assert.equal(boot.players[0].assignmentActions.some(action => action.opcode === 'ID_HANDOFF_FAKE'), true);

  const rpo = findPlay(result, '/Shotgun/Doubles_Offset/RPO_Zone_Peek');
  assert.equal(rpo.resolution.status, 'fully_resolved');
  assert.equal(rpo.play.name, 'RPO Peek Slant');
  assert.equal(rpo.play.offensePlayType, 'OffensePlayType_RPO1ReadLB');
  assert.equal(rpo.players[0].positionAssignId, 7028);
  assert.equal(rpo.players[0].assignmentActions.some(action => action.opcode === 'ID_HANDOFF_OPTION'), true);

  const motion = findPlay(result, '/I_Form/Wing_Over/SFT(WingPair)PA_U_Cross');
  assert.equal(motion.resolution.status, 'fully_resolved');
  assert.equal(motion.play.name, 'Shift PA U Cross');
  assert.equal(motion.play.additionalPresnapMovements.length, 1);

  const screen = findPlay(result, '/Shotgun/Bunch/HB_Slip_Screen');
  assert.equal(screen.resolution.status, 'fully_resolved');
  assert.equal(screen.play.offensePlayType, 'OffensePlayType_PassScreen');
  assert.deepEqual(ids(screen).slice(7, 10), [857, 2421, 2422]);
  assert.equal(new Set(screen.players.slice(7, 10).map(player => player.assignmentName)).size, 3);
  assert.ok(screen.players.slice(7, 10).every(player =>
    player.assignmentActions.some(action => action.opcode === 'ID_PASSBLOCK')
  ));
});

test('all real Set default alignment slots map exactly 0 through 10', { skip: !hasCorpus }, () => {
  const result = buildEaPlayKnowledge(formationSource, assignmentSource, { compact: false });
  const seen = new Map();

  for (const entry of result.plays) {
    if (!entry.set) continue;
    seen.set(entry.set.assetPath, entry.set);
  }

  assert.equal(seen.size, 44);
  for (const set of seen.values()) {
    assert.equal(set.positions.length, 11, set.assetPath);
    assert.deepEqual(
      set.positions.map(position => position.index),
      [0,1,2,3,4,5,6,7,8,9,10],
      set.assetPath
    );
  }
});
