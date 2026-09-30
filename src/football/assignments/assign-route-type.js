'use strict';

// EA AssignRouteType bridge.
//
// Playbook XML (<player assignment="N">) stores the ORDINAL of EA's
// AssignRouteType enum. Every PositionAssignmentDefine asset in
// Research/Assignments declares the same enum by NAME in its `routeType` field.
// The ordinal is not a positionAssignId (defensive ordinal 5 has no asset with
// positionAssignId 5; ordinal 21 would otherwise be Kicker/Kickoff).
//
// The ordinal -> name table is derived and verified by
// scripts/research/derive-assign-route-types.cjs and checked in as
// data/knowledge/ea-assign-route-types.json. See that script for the proof.
//
// Coordinate convention (proved from both playbook families): the offense and
// defense XML share one field frame in which +x is the OFFENSE's right. EA
// "Lt"/"Rt" is each unit's own perspective, so an offensive *_Lt route sits at
// -x and a defensive *_Lt zone sits at +x (over the offense's right).

const fs = require('fs');
const path = require('path');

const DEFAULT_TABLE_PATH = path.resolve(__dirname, '..', '..', '..', 'data', 'knowledge', 'ea-assign-route-types.json');

let cachedTable = null;
let cachedTablePath = null;

function loadRouteTypeTable(tablePath = DEFAULT_TABLE_PATH) {
  if (cachedTable && cachedTablePath === tablePath) return cachedTable;
  const doc = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
  cachedTable = doc;
  cachedTablePath = tablePath;
  return doc;
}

function routeTypeForOrdinal(ordinal, table = loadRouteTypeTable()) {
  if (ordinal == null) return null;
  const row = table.ordinals?.[String(ordinal)];
  return row ? { ordinal: Number(ordinal), ...row } : null;
}

function shortName(name) {
  return String(name || '').replace(/^AssignRouteType_/, '');
}

function eaSideOf(short) {
  if (/(^|_)Lt(_|$)/.test(short)) return 'LT';
  if (/(^|_)Rt(_|$)/.test(short)) return 'RT';
  if (/(^|_)Mid(_|$)/.test(short)) return 'MID';
  return null;
}

// Defensive EA-left is the offense's right (see module comment).
function offenseSideForDefensiveEaSide(eaSide) {
  if (eaSide === 'LT') return 'RIGHT';
  if (eaSide === 'RT') return 'LEFT';
  if (eaSide === 'MID') return 'MIDDLE';
  return null;
}

function offenseSideForX(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  if (n > 0.5) return 'RIGHT';
  if (n < -0.5) return 'LEFT';
  return 'MIDDLE';
}

const ZONE_RESPONSIBILITY = [
  // [pattern, responsibility, zoneFamily, layer]
  [/^DefZone_Deep_2_(Lt|Rt)_Half$/, 'DEEP_HALF', 'deep', 'DEEP'],
  [/^DefZone_Deep_4_In_(Lt|Rt)_Qtr$/, 'QUARTER_INSIDE', 'deep', 'DEEP'],
  [/^DefZone_Deep_4_Out_(Lt|Rt)_Qtr$/, 'QUARTER_OUTSIDE', 'deep', 'DEEP'],
  [/^DefZone_Deep_Mid_3rd$/, 'DEEP_MIDDLE_THIRD', 'deep', 'DEEP'],
  [/^DefZone_Deep_(Lt|Rt)_3rd$/, 'DEEP_THIRD', 'deep', 'DEEP'],
  [/^DefZone_Curl_Flat_(Lt|Rt)$/, 'CURL_FLAT', 'curl_flat', 'UNDER'],
  [/^DefZone_Flat_(Lt|Rt)$/, 'FLAT', 'flat', 'UNDER'],
  [/^DefZone_Hook_Mid$/, 'MIDDLE_HOOK', 'hook', 'UNDER'],
  [/^DefZone_Hook_(Lt|Rt)$/, 'HOOK', 'hook', 'UNDER'],
];

// Normalized defensive responsibility for an AssignRouteType name. The EA name
// is always preserved alongside; unknown names return UNKNOWN, never a guess.
function defensiveResponsibility(routeTypeName) {
  const short = shortName(routeTypeName);
  const eaSide = eaSideOf(short);
  const base = {
    routeType: routeTypeName || null,
    eaSide,
    offenseSide: offenseSideForDefensiveEaSide(eaSide),
  };
  for (const [pattern, responsibility, zoneFamily, layer] of ZONE_RESPONSIBILITY) {
    if (pattern.test(short)) return { ...base, category: 'ZONE', responsibility, zoneFamily, layer };
  }
  if (short === 'DefPass_Rush') return { ...base, category: 'RUSH', responsibility: 'PASS_RUSH', zoneFamily: null, layer: 'LINE' };
  if (short === 'DefBlitz') return { ...base, category: 'RUSH', responsibility: 'BLITZ', zoneFamily: null, layer: 'LINE' };
  if (short === 'DefQB_Spy') return { ...base, category: 'SPY', responsibility: 'QB_SPY', zoneFamily: null, layer: 'UNDER' };
  if (short === 'DefMan_Coverage') return { ...base, category: 'MAN', responsibility: 'BRACKET', zoneFamily: null, layer: null };
  const man = short.match(/^Def_Man_(\d)$/);
  if (man) {
    return {
      ...base,
      category: 'MAN',
      responsibility: 'MAN',
      // EA MAN_COVER1..MAN_COVER4, MAN_LAST: receiver numbering from EA-left.
      manTarget: Number(man[1]),
      zoneFamily: null,
      layer: null,
    };
  }
  return { ...base, category: 'UNKNOWN', responsibility: 'UNKNOWN', zoneFamily: null, layer: null };
}

module.exports = {
  DEFAULT_TABLE_PATH,
  loadRouteTypeTable,
  routeTypeForOrdinal,
  defensiveResponsibility,
  offenseSideForDefensiveEaSide,
  offenseSideForX,
  shortName,
};
