/**
 * Example only: adapt YOUR reducer's completed-snap payload into the football engine event.
 * Keep raw game IDs even before every ID has a friendly name.
 *
 * Convention used here:
 * - yardLine is offense-relative: 0 = own goal line, 100 = opponent goal line.
 * - score fields may be supplied as offenseScore/defenseScore OR homeScore/awayScore
 *   with possessionHome=true/false.
 */
function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resolveScores(raw) {
  const offenseScore = finiteOrNull(raw.offenseScore);
  const defenseScore = finiteOrNull(raw.defenseScore);
  if (offenseScore != null && defenseScore != null) {
    return { offenseScore, defenseScore };
  }

  const home = finiteOrNull(raw.homeScore);
  const away = finiteOrNull(raw.awayScore);
  if (home == null || away == null || raw.possessionHome == null) {
    return { offenseScore: null, defenseScore: null };
  }

  return raw.possessionHome
    ? { offenseScore: home, defenseScore: away }
    : { offenseScore: away, defenseScore: home };
}

function deriveSituation(s) {
  const down = finiteOrNull(s.down);
  const distance = finiteOrNull(s.distance);
  const yardLine = finiteOrNull(s.yardLine);
  const quarter = finiteOrNull(s.quarter);
  const clockSeconds = finiteOrNull(s.clockSeconds);
  const scoreDiff = finiteOrNull(s.scoreDifferential);

  const twoMinute =
    (quarter === 2 || quarter >= 4) &&
    clockSeconds != null &&
    clockSeconds <= 120;

  const fourMinute =
    quarter >= 4 &&
    clockSeconds != null &&
    scoreDiff != null &&
    scoreDiff > 0 &&
    (clockSeconds <= 240 || (scoreDiff >= 8 && clockSeconds <= 360));

  return {
    redZone: yardLine != null ? yardLine >= 80 : false,
    goalToGo: Boolean(s.goalToGo) || (yardLine != null && distance != null && (100 - yardLine) <= distance),
    backedUp: yardLine != null ? yardLine <= 10 : false,
    plusTerritory: yardLine != null ? yardLine >= 50 : false,
    shortYardage: distance != null ? distance <= 2 : false,
    mediumYardage: distance != null ? distance >= 3 && distance <= 6 : false,
    longYardage: distance != null ? distance >= 7 : false,
    obviousPassing: down != null && distance != null ? ((down >= 3 && distance >= 6) || (down === 2 && distance >= 10)) : false,
    twoMinute,
    fourMinute,
    trailingLate: quarter >= 4 && clockSeconds != null && clockSeconds <= 360 && scoreDiff != null && scoreDiff < 0,
    leadingLate: quarter >= 4 && clockSeconds != null && clockSeconds <= 360 && scoreDiff != null && scoreDiff > 0
  };
}

function toFootballEvent(raw, lookup = {}) {
  const off = lookup.offensePlay?.(raw.offensePlayId) || {};
  const def = lookup.defensePlay?.(raw.defensePlayId) || {};
  const scores = resolveScores(raw);
  const directScoreDifferential = finiteOrNull(raw.scoreDifferential);
  const scoreDifferential = directScoreDifferential != null
    ? directScoreDifferential
    : (scores.offenseScore == null || scores.defenseScore == null
      ? null
      : scores.offenseScore - scores.defenseScore);

  const situation = {
    down: finiteOrNull(raw.down),
    distance: finiteOrNull(raw.distance),
    yardLine: finiteOrNull(raw.yardLine),
    quarter: finiteOrNull(raw.quarter),
    clockSeconds: finiteOrNull(raw.clockSeconds),
    playClockSeconds: finiteOrNull(raw.playClockSeconds),
    possession: raw.possession ?? null,
    offenseScore: scores.offenseScore,
    defenseScore: scores.defenseScore,
    scoreDifferential,
    scoreDifferentialSource: raw.scoreDifferentialSource || (directScoreDifferential != null ? 'USER_RELATIVE_TELEMETRY' : null),
    goalToGo: Boolean(raw.goalToGo)
  };

  situation.flags = deriveSituation(situation);

  return {
    play: {
      id: String(raw.offensePlayId),
      name: off.name || raw.offensePlayName || null,
      type: off.type || raw.offensePlayType || null,
      formation: off.formation || raw.offenseFormation || raw.offensiveSet || null,
      formationId: raw.offenseFormationId ?? null,
      personnel: off.personnel || raw.offensePersonnel || null,
      concepts: off.concepts || raw.offenseConcepts || [],
      setupBy: off.setupBy || []
    },
    opponentPlay: {
      id: raw.defensePlayId == null ? null : String(raw.defensePlayId),
      name: def.name || raw.defensePlayName || null,
      formation: def.formation || raw.defenseFormation || raw.defensiveSet || null,
      formationId: raw.defenseFormationId ?? null,
      concepts: def.concepts || raw.defenseConcepts || []
    },
    situation,
    result: {
      yards: finiteOrNull(raw.yardsGained) ?? 0,
      firstDown: Boolean(raw.firstDown),
      touchdown: Boolean(raw.touchdown),
      conversion: Boolean(raw.firstDown || raw.touchdown || raw.conversion),
      turnover: Boolean(raw.turnover),
      sack: Boolean(raw.sack),
      safetyAllowed: Boolean(raw.safetyAllowed)
    }
  };
}

module.exports = { toFootballEvent, deriveSituation, resolveScores };
