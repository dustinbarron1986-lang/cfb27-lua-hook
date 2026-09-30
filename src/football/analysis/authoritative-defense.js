'use strict';

// Authoritative defensive structure for an exact live defensive call.
//
// Source of truth: EA defensive playbook XML (11 defenders per play) resolved
// through the verified AssignRouteType bridge (see ea-defensive-play-store.js).
// Output is a static assignment structure: who rushes, who drops to which zone,
// who plays man. It never claims live leverage or receiver openness.

function assignmentDefense(player = {}) {
  return player.assignment?.assignmentSemantics?.defense ||
    player.assignment?.semantics?.defense ||
    player.eaAssignment?.semantics?.defense || null;
}

function familiesOf(zones, man, rush) {
  return [...new Set([
    ...zones.map(row => row.family),
    ...(man.length ? ['man'] : []),
    ...(rush.length ? ['rush'] : []),
  ].filter(Boolean))];
}

// Legacy entry point: an expanded Frostbite defensive play whose players carry
// PositionAssignmentDefine semantics. Retained for a future defensive
// PlayLibrary export; the live path uses buildFromDefensiveResolution().
function buildAuthoritativeDefensiveStructure(expanded) {
  if (!expanded || expanded.status !== 'resolved') {
    return { available: false, status: expanded?.status || 'unavailable', reason: expanded?.reason || 'authoritative_defensive_play_not_expanded', assignments: [], provenance: null };
  }
  const assignments = (expanded.players || []).map(player => {
    const defense = assignmentDefense(player);
    return {
      playerIndex: player.index,
      position: player.startingAlignment?.positionType || player.startingAlignment?.depthPosition || null,
      assignmentName: player.assignment?.assignmentName || null,
      assignmentId: player.assignment?.positionAssignId ?? null,
      zones: defense?.zones || [],
      man: defense?.man || [],
      rush: defense?.rush || [],
      alignments: defense?.alignments || [],
      disguise: defense?.disguise || [],
      known: Boolean(defense),
      provenance: defense ? 'EA_AUTHORED' : null,
    };
  });
  const known = assignments.filter(row => row.known);
  const zones = known.flatMap(row => row.zones.map(zone => ({ ...zone, playerIndex: row.playerIndex })));
  const man = known.flatMap(row => row.man.map(value => ({ ...value, playerIndex: row.playerIndex })));
  const rush = known.flatMap(row => row.rush.map(value => ({ ...value, playerIndex: row.playerIndex })));
  return {
    available: known.length > 0,
    status: known.length ? 'resolved' : 'no_defensive_assignment_semantics',
    playKey: expanded.playKey || null,
    play: expanded.play || null,
    assignments, zones, man, rush,
    responsibilityFamilies: familiesOf(zones, man, rush),
    provenance: known.length ? 'EA_AUTHORED' : null,
    unknownAssignments: assignments.filter(row => !row.known).map(row => row.playerIndex),
    knownAssignments: known.length,
    totalAssignments: assignments.length,
  };
}


function shellOf(deep) {
  const has = r => deep.some(z => z.responsibility === r);
  const count = r => deep.filter(z => z.responsibility === r).length;
  if (!deep.length) return 'ZERO_DEEP';
  if (count('QUARTER_INSIDE') + count('QUARTER_OUTSIDE') >= 3) return 'QUARTERS';
  if (has('DEEP_MIDDLE_THIRD') && count('DEEP_THIRD') >= 2) return 'THREE_DEEP';
  if (count('DEEP_HALF') >= 2) return 'TWO_HIGH';
  if (has('DEEP_HALF') && (has('QUARTER_INSIDE') || has('QUARTER_OUTSIDE'))) return 'QUARTER_HALF';
  if (deep.length === 1) return 'ONE_HIGH';
  return 'MIXED_DEEP';
}

function sideCounts(rows) {
  const out = { LEFT: 0, MIDDLE: 0, RIGHT: 0 };
  for (const row of rows) if (out[row.offenseSide] != null) out[row.offenseSide] += 1;
  return out;
}

function buildFromDefensiveResolution(resolution) {
  if (!resolution?.resolved) {
    return {
      available: false,
      status: resolution?.status || 'unavailable',
      reason: resolution?.reason || 'authoritative_defensive_play_unresolved',
      assignments: [], zones: [], man: [], rush: [],
      responsibilityFamilies: [],
      provenance: null,
      resolution: resolution || null,
    };
  }
  const assignments = resolution.players.map(player => {
    const r = player.responsibility;
    // Rush/drop side follows the defender's authored alignment; zone side
    // follows the zone's own EA side when it has one.
    const alignedSide = player.alignment?.offenseSide || null;
    const zones = r?.category === 'ZONE'
      ? [{ family: r.zoneFamily, responsibility: r.responsibility, layer: r.layer, offenseSide: r.offenseSide || alignedSide, routeType: r.routeType }]
      : [];
    const man = r?.category === 'MAN'
      ? [{ responsibility: r.responsibility, manTarget: r.manTarget ?? null, offenseSide: alignedSide, routeType: r.routeType }]
      : [];
    const rush = r?.category === 'RUSH'
      ? [{
        responsibility: r.responsibility,
        // EA authors DefBlitz separately from DefPass_Rush; that distinction
        // is the only blitz evidence used.
        blitz: r.responsibility === 'BLITZ',
        offenseSide: alignedSide,
        interior: player.alignment ? Math.abs(Number(player.alignment.x)) <= 3.5 : null,
        routeType: r.routeType,
      }]
      : [];
    const spy = r?.category === 'SPY' ? [{ responsibility: 'QB_SPY', routeType: r.routeType }] : [];
    return {
      playerIndex: player.index,
      position: player.position,
      positionType: player.positionType,
      alignment: player.alignment,
      assignmentRef: player.assignmentRef,
      assignmentName: player.routeType,
      responsibility: r?.responsibility || 'UNKNOWN',
      zones, man, rush, spy,
      known: player.known,
      provenance: player.provenance,
      conflictingRouteTypes: player.conflictingRouteTypes || undefined,
    };
  });
  const known = assignments.filter(row => row.known);
  const tag = (row, value) => ({ ...value, playerIndex: row.playerIndex, position: row.position });
  const zones = known.flatMap(row => row.zones.map(v => tag(row, v)));
  const man = known.flatMap(row => row.man.map(v => tag(row, v)));
  const rush = known.flatMap(row => row.rush.map(v => tag(row, v)));
  const spies = known.flatMap(row => row.spy.map(v => tag(row, v)));
  const deep = zones.filter(z => z.layer === 'DEEP');
  const under = zones.filter(z => z.layer === 'UNDER');
  const rushBySide = sideCounts(rush);
  const overloadSide = rushBySide.LEFT - rushBySide.RIGHT >= 2 ? 'LEFT'
    : (rushBySide.RIGHT - rushBySide.LEFT >= 2 ? 'RIGHT' : null);
  const summary = {
    shell: shellOf(deep),
    deepCount: deep.length,
    underCount: under.length,
    rushers: rush.length,
    blitzers: rush.filter(r => r.blitz).length,
    interiorRushers: rush.filter(r => r.interior === true).length,
    edgeRushers: rush.filter(r => r.interior === false).length,
    manDefenders: man.length,
    spies: spies.length,
    coverageMode: man.length && zones.length ? 'MIXED' : (man.length ? 'MAN' : (zones.length ? 'ZONE' : 'UNKNOWN')),
    rushBySide,
    overloadSide,
    responsibilities: known.reduce((acc, row) => { acc[row.responsibility] = (acc[row.responsibility] || 0) + 1; return acc; }, {}),
  };
  return {
    available: known.length > 0,
    status: resolution.status,
    playKey: resolution.playKey,
    play: { name: resolution.play, set: resolution.set, formation: resolution.formation, playId: resolution.playId },
    assignments, zones, man, rush, spies,
    responsibilityFamilies: familiesOf(zones, man, rush),
    summary,
    provenance: known.length ? 'EA_AUTHORED' : null,
    unknownAssignments: assignments.filter(row => !row.known).map(row => row.playerIndex),
    knownAssignments: known.length,
    totalAssignments: assignments.length,
    resolution,
  };
}

// Narrows the CPU opponent's defensive book across one game: each exact
// observation keeps only the books that contain it. The narrowed set is used
// only when it is non-empty; an observation outside every remaining book (a
// team book not in the export) is ignored rather than emptying the set.
class OpponentDefenseBookTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.candidates = null;
    this.observations = 0;
  }

  observe(store, { setName, playName } = {}) {
    if (!store || !playName) return this.candidates;
    const books = store.booksContaining({ setName, playName });
    if (!books.length) return this.candidates;
    const next = this.candidates ? this.candidates.filter(id => books.includes(id)) : books;
    if (next.length) {
      this.candidates = next;
      this.observations += 1;
    }
    return this.candidates;
  }
}

function resolveAuthoritativeDefense({ defensiveStore = null, store = null, liveCall, bookId = null, candidateBookIds = null } = {}) {
  const defense = defensiveStore || null;
  if (!liveCall?.available || !liveCall?.name) {
    return { available: false, status: 'unavailable', reason: 'live_defensive_identity_unavailable' };
  }
  if (defense && typeof defense.resolveLiveCall === 'function') {
    const resolution = defense.resolveLiveCall({ setName: liveCall.set, playName: liveCall.name, bookId, candidateBookIds });
    return buildFromDefensiveResolution(resolution);
  }
  // Legacy: a Frostbite store that can expand defensive plays.
  if (store && typeof store.resolvePlay === 'function' && liveCall.set) {
    const resolved = store.resolvePlay({ playName: liveCall.name, setName: liveCall.set, evidence: { authorityEligible: true, playName: { value: liveCall.name, source: 'live_telemetry.defensivePlay' }, setName: { value: liveCall.set, source: 'live_telemetry.defensiveSet' } } });
    if (resolved?.status !== 'resolved') return { available: false, status: resolved?.status || 'unresolved', reason: resolved?.reason || 'authoritative_defensive_structural_miss', resolution: resolved };
    return { ...buildAuthoritativeDefensiveStructure(store.expandPlay(resolved.playKey)), resolution: resolved };
  }
  return { available: false, status: 'unavailable', reason: 'defensive_authority_store_unavailable' };
}

function defensiveAuthorityLogLine(authority, { bookId = null } = {}) {
  const r = authority?.resolution || {};
  const s = authority?.summary || {};
  const zones = Object.entries(s.responsibilities || {})
    .filter(([k]) => !['PASS_RUSH', 'BLITZ', 'MAN', 'BRACKET', 'QB_SPY', 'UNKNOWN'].includes(k))
    .map(([k, v]) => `${k}x${v}`).join(',');
  return [
    '[DEF-AUTH]',
    `book=${r.book ?? (bookId ?? '?')}${r.book == null && r.candidateBooks?.length ? `(candidates=${r.candidateBooks.length})` : ''}`,
    `formation=${r.formation ?? (r.candidateFormations?.length ? r.candidateFormations.join('|') : '?')}`,
    `set=${r.set ?? r.liveSetName ?? '?'}`,
    `play=${r.play ?? r.livePlayName ?? '?'}`,
    `resolved=${authority?.available ? 'true' : 'false'}`,
    `evidence=${r.evidence || r.reason || authority?.reason || '?'}`,
    `knownAssignments=${authority?.knownAssignments ?? 0}/${authority?.totalAssignments ?? 11}`,
    `shell=${s.shell || '?'}`,
    `zones=${zones || 'none'}`,
    `rushers=${s.rushers ?? 0}${s.blitzers ? `(blitz=${s.blitzers})` : ''}`,
    `man=${s.manDefenders ?? 0}`,
    `provenance=${authority?.provenance || 'NONE'}`,
  ].join(' ');
}

module.exports = {
  assignmentDefense,
  buildAuthoritativeDefensiveStructure,
  buildFromDefensiveResolution,
  resolveAuthoritativeDefense,
  OpponentDefenseBookTracker,
  defensiveAuthorityLogLine,
};
