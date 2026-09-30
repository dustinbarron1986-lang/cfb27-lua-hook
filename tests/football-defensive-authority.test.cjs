'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { researchPath } = require('./helpers/research-paths.cjs');
const { parsePlaybookXml } = require('../src/football/knowledge/ea-playbook-xml');
const {
  loadRouteTypeTable,
  routeTypeForOrdinal,
  defensiveResponsibility,
} = require('../src/football/assignments/assign-route-type');
const { EaDefensivePlayStore } = require('../src/football/knowledge/ea-defensive-play-store');
const {
  resolveAuthoritativeDefense,
  OpponentDefenseBookTracker,
  defensiveAuthorityLogLine,
} = require('../src/football/analysis/authoritative-defense');

const PLAYBOOKS = researchPath('Playbooks');
const ASSIGNMENTS = researchPath('Assignments');
const table = loadRouteTypeTable();
const store = EaDefensivePlayStore.load();

const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<playbook>
  <formation_set_list>
    <formation form_name="Nickel" ord="3" form_id="17">
      <set set_id="1070" set_name="3-3 Odd" form_id="17" ord="1" />
    </formation>
  </formation_set_list>
  <play play_id="7" formation_id="17" play_name="Cover 4 Quarters" play_type="44" set_id="1070" form_set_id="1070" classification="19">
    <run_data hole_num="0" />
    <player_data>
      <player plyr_idx="0" assignment="5" x="-3" y="1.2" depth="1" position_type="12" art_x="0" art_y="0" art_icon="0" art_id="0" />
      <player plyr_idx="1" assignment="13" x="17" y="7" depth="1" position_type="16" art_x="0" art_y="0" art_icon="0" art_id="0" />
    </player_data>
  </play>
</playbook>`;

test('playbook XML parser keeps formation/set/play, assignment ordinals and alignment', () => {
  const parsed = parsePlaybookXml(FIXTURE);
  assert.equal(parsed.plays.length, 1);
  const play = parsed.plays[0];
  assert.equal(play.formationName, 'Nickel');
  assert.equal(play.setName, '3-3 Odd');
  assert.equal(play.playName, 'Cover 4 Quarters');
  assert.equal(play.playId, 7);
  assert.equal(play.classification, 19);
  assert.deepEqual(play.players[1], { index: 1, assignmentRef: 13, x: 17, y: 7, depth: 1, positionType: 16 });
});

test('real playbook_def-522 parses into 240 eleven-man plays with assignment refs retained', t => {
  const file = PLAYBOOKS && path.join(PLAYBOOKS, 'playbook_def-522.XML');
  if (!file || !fs.existsSync(file)) return t.skip('Research/Playbooks not present');
  const parsed = parsePlaybookXml(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.plays.length, 240);
  assert.ok(parsed.plays.every(play => play.players.length === 11));
  assert.ok(parsed.plays.every(play => play.players.every(p => Number.isInteger(p.assignmentRef))));
  const first = parsed.plays[0];
  assert.equal(first.playName, 'SS 2 Trap');
  assert.equal(first.formationName, '3-4');
  assert.equal(first.setName, 'Tite');
  assert.deepEqual(first.players.map(p => p.assignmentRef), [22, 5, 5, 5, 19, 20, 3, 10, 9, 3, 18]);
  assert.deepEqual([first.players[7].x, first.players[7].y], [-16, 8]);
});

test('assignment refs are AssignRouteType ordinals, not positionAssignId values', () => {
  assert.equal(table.metadata.validation.passed, true);
  // The same alignment checks fail when the defensive block is shifted by one.
  assert.ok(Object.values(table.metadata.validation.shiftedBlockFailureCounts).every(n => n > 0));
  const expected = {
    3: 'DefBlitz', 4: 'DefMan_Coverage', 5: 'DefPass_Rush', 6: 'DefQB_Spy',
    7: 'DefZone_Curl_Flat_Lt', 8: 'DefZone_Curl_Flat_Rt', 9: 'DefZone_Deep_2_Lt_Half', 10: 'DefZone_Deep_2_Rt_Half',
    11: 'DefZone_Deep_4_In_Lt_Qtr', 12: 'DefZone_Deep_4_In_Rt_Qtr', 13: 'DefZone_Deep_4_Out_Lt_Qtr', 14: 'DefZone_Deep_4_Out_Rt_Qtr',
    15: 'DefZone_Deep_Lt_3rd', 16: 'DefZone_Deep_Mid_3rd', 17: 'DefZone_Deep_Rt_3rd', 18: 'DefZone_Flat_Lt',
    19: 'DefZone_Flat_Rt', 20: 'DefZone_Hook_Lt', 21: 'DefZone_Hook_Mid', 22: 'DefZone_Hook_Rt',
    133: 'Def_Man_1', 134: 'Def_Man_2', 135: 'Def_Man_3', 136: 'Def_Man_4', 137: 'Def_Man_5',
    1: 'Block_Pass', 2: 'Block_Run', 24: 'K_FG', 40: 'QB_Pass', 98: 'RR_Streak',
  };
  for (const [ordinal, name] of Object.entries(expected)) {
    assert.equal(routeTypeForOrdinal(Number(ordinal))?.name, `AssignRouteType_${name}`, `ordinal ${ordinal}`);
  }
  // Ordinal 21 is a hook defender, never the Kicker/Kickoff asset whose
  // positionAssignId happens to be 21.
  assert.equal(defensiveResponsibility(routeTypeForOrdinal(21).name).responsibility, 'MIDDLE_HOOK');
  assert.equal(routeTypeForOrdinal(21).evidence, 'DEFENSIVE_ENUM_BLOCK+ALIGNMENT');
  assert.equal(routeTypeForOrdinal(98).evidence, 'OFFENSIVE_FROSTBITE_JOIN');
  assert.ok(routeTypeForOrdinal(13).assetFamily.count > 0, 'resolved route type reaches EA assignment assets');
  assert.ok(routeTypeForOrdinal(13).assetFamily.samples.every(p => p.startsWith('DefenseZone/')));
});

test('unknown ordinals do not guess', () => {
  for (const ordinal of [105, 107, 108, 139, 23, 9999]) assert.equal(routeTypeForOrdinal(ordinal), null);
  assert.equal(defensiveResponsibility('AssignRouteType_Something_New').responsibility, 'UNKNOWN');
  assert.equal(defensiveResponsibility(null).category, 'UNKNOWN');
});

test('defensive responsibilities preserve EA semantics and convert EA side to offense side', () => {
  const quarter = defensiveResponsibility('AssignRouteType_DefZone_Deep_4_Out_Lt_Qtr');
  assert.equal(quarter.responsibility, 'QUARTER_OUTSIDE');
  assert.equal(quarter.zoneFamily, 'deep');
  assert.equal(quarter.eaSide, 'LT');
  assert.equal(quarter.offenseSide, 'RIGHT'); // defensive EA-left is over the offense's right (+x)
  assert.equal(quarter.routeType, 'AssignRouteType_DefZone_Deep_4_Out_Lt_Qtr');
  assert.equal(defensiveResponsibility('AssignRouteType_DefZone_Curl_Flat_Rt').offenseSide, 'LEFT');
  assert.equal(defensiveResponsibility('AssignRouteType_DefZone_Hook_Mid').offenseSide, 'MIDDLE');
  assert.equal(defensiveResponsibility('AssignRouteType_Def_Man_5').manTarget, 5);
  assert.equal(defensiveResponsibility('AssignRouteType_DefBlitz').responsibility, 'BLITZ');
  assert.equal(defensiveResponsibility('AssignRouteType_DefQB_Spy').responsibility, 'QB_SPY');
});

test('checked-in route-type table matches a fresh derivation from the Research corpus', t => {
  if (!PLAYBOOKS || !ASSIGNMENTS || !fs.existsSync(ASSIGNMENTS)) return t.skip('Research corpus not present');
  const { derive } = require('../scripts/research/derive-assign-route-types.cjs');
  const fresh = derive({
    playbooksDir: PLAYBOOKS,
    assignmentsDir: ASSIGNMENTS,
    knowledgePath: path.resolve(__dirname, '..', 'data', 'knowledge', 'pro-style-ea-play-knowledge.json'),
  });
  assert.equal(fresh.metadata.validation.passed, true);
  const names = doc => Object.fromEntries(Object.entries(doc.ordinals).map(([k, v]) => [k, v.name]));
  assert.deepEqual(names(fresh), names(table));
});

test('Cover 4 Quarters in book 522 resolves 11/11 with quarters zones and EA provenance', () => {
  const auth = resolveAuthoritativeDefense({
    defensiveStore: store,
    liveCall: { available: true, set: '3-3 Odd', name: 'Cover 4 Quarters' },
    bookId: 522,
  });
  assert.equal(auth.available, true);
  assert.equal(auth.status, 'resolved');
  assert.equal(auth.resolution.evidence, 'EXACT_BOOK');
  assert.equal(auth.resolution.formation, 'Nickel');
  assert.equal(auth.knownAssignments, 11);
  assert.equal(auth.provenance, 'EA_AUTHORED');
  assert.equal(auth.summary.shell, 'QUARTERS');
  assert.equal(auth.summary.responsibilities.QUARTER_INSIDE, 2);
  assert.equal(auth.summary.responsibilities.QUARTER_OUTSIDE, 2);
  assert.equal(auth.summary.rushers, 4);
  assert.ok(auth.zones.every(zone => zone.routeType.startsWith('AssignRouteType_DefZone')));
  assert.match(defensiveAuthorityLogLine(auth), /\[DEF-AUTH\] book=522 formation=Nickel set=3-3 Odd play=Cover 4 Quarters resolved=true .*knownAssignments=11\/11/);
});

test('case and whitespace differences in live names still resolve exactly', () => {
  const auth = resolveAuthoritativeDefense({ defensiveStore: store, liveCall: { available: true, set: ' 3-3 odd', name: 'COVER 4  QUARTERS ' }, bookId: 522 });
  assert.equal(auth.knownAssignments, 11);
  assert.equal(auth.resolution.matchTier, 'normalized');
});

test('blitz play resolves authored blitzers and rushers', () => {
  const auth = resolveAuthoritativeDefense({ defensiveStore: store, liveCall: { available: true, set: 'Tite', name: 'Saw Blitz 3' }, bookId: 522 });
  assert.equal(auth.knownAssignments, 11);
  assert.equal(auth.summary.rushers, 5);
  assert.ok(auth.summary.blitzers >= 1);
  assert.ok(auth.rush.filter(r => r.blitz).every(r => r.routeType === 'AssignRouteType_DefBlitz'));
});

test('man play resolves Def_Man receiver numbering', () => {
  const auth = resolveAuthoritativeDefense({ defensiveStore: store, liveCall: { available: true, set: 'Over', name: 'Cover 1 Hole' }, bookId: 503 });
  assert.equal(auth.status, 'resolved');
  assert.equal(auth.summary.coverageMode, 'MIXED');
  assert.equal(auth.summary.shell, 'ONE_HIGH');
  assert.ok(auth.man.length >= 4);
  assert.ok(auth.man.every(m => m.responsibility === 'MAN' && m.manTarget >= 1 && m.manTarget <= 5));
});

test('ambiguous corpus match stays partial and never claims 11/11', () => {
  const auth = resolveAuthoritativeDefense({ defensiveStore: store, liveCall: { available: true, set: 'Over', name: 'Cover 4 Quarters' } });
  assert.equal(auth.available, true);
  assert.equal(auth.status, 'partial');
  assert.equal(auth.resolution.evidence, 'CORPUS');
  assert.ok(auth.resolution.candidateFormations.length > 1);
  assert.ok(auth.knownAssignments < 11);
  assert.equal(auth.resolution.slotMapping, false);
  assert.equal(auth.summary.shell, 'QUARTERS');
  assert.ok(auth.unknownAssignments.length >= 1);
  assert.match(defensiveAuthorityLogLine(auth), /knownAssignments=\d+\/11/);
});

test('play outside the exported corpus is unresolved, not approximated', () => {
  const auth = resolveAuthoritativeDefense({ defensiveStore: store, liveCall: { available: true, set: '3-3 Stack', name: 'Cover 2 Man' } });
  assert.equal(auth.available, false);
  assert.equal(auth.status, 'unresolved');
  assert.equal(auth.provenance, null);
});

test('special-teams return plays stay partially resolved', () => {
  const book = store.doc.books['522'];
  const row = book.plays.find(p => book.formations[p[1]]?.name === 'Kick Return');
  const players = store.expandStructure(row[6]);
  assert.ok(players.some(p => !p.known));
});

test('opponent book tracker narrows candidates across a game and ignores out-of-corpus calls', () => {
  const tracker = new OpponentDefenseBookTracker();
  const a = tracker.observe(store, { setName: '3-3 Wide Jack', playName: 'CB Zone Blitz Press' });
  assert.ok(a.length >= 2);
  const b = tracker.observe(store, { setName: '2-4 Load Mug', playName: 'Cover 3 Cloud' });
  assert.ok(b.length <= a.length && b.length >= 1);
  const c = tracker.observe(store, { setName: '3-3 Stack', playName: 'Cover 2 Man' });
  assert.deepEqual(c, b);
  const auth = resolveAuthoritativeDefense({ defensiveStore: store, liveCall: { available: true, set: 'Over', name: 'Cover 4 Quarters' }, candidateBookIds: b });
  assert.equal(auth.resolution.evidence, 'NARROWED_BOOKS');
});

test('whole-corpus statistics: every scrimmage defensive play fully resolves', () => {
  const m = store.metadata;
  assert.equal(m.nonElevenPlayer, 0);
  assert.ok(m.fullyResolvedPct > 90);
  for (const [bookId, book] of Object.entries(store.doc.books)) {
    for (const row of book.plays) {
      const formation = book.formations[row[1]]?.name || '';
      if (/Special|Kick Return|^ST /.test(formation)) continue;
      const players = store.expandStructure(row[6]);
      assert.ok(players.every(p => p.known), `${bookId} ${formation} ${row[3]}`);
    }
  }
});
