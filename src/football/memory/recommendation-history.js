'use strict';

function sideKey(side) {
  return String(side || '').toLowerCase() === 'defense' ? 'defense' : 'offense';
}

function situationKey(situation = {}) {
  const clock = Number(situation.clockSeconds);
  const clockBucket = Number.isFinite(clock) ? Math.floor(clock / 30) : 'x';
  return [
    situation.possession ?? 'x',
    situation.quarter ?? 'x',
    situation.down ?? 'x',
    situation.distance ?? 'x',
    situation.yardLine ?? 'x',
    clockBucket,
  ].join('|');
}

class RecommendationHistory {
  constructor(limit = 64) {
    this.limit = Math.max(8, Number(limit) || 64);
    this.rows = { offense: [], defense: [] };
  }

  record(side, recommendation, context = {}) {
    const key = sideKey(side);
    const play = recommendation?.play || recommendation;
    if (!play?.id && !play?.name) return null;
    const opponent = context.opponentPlay || {};
    const dedupeKey = [
      key,
      situationKey(context.situation),
      opponent.id ?? opponent.name ?? 'unknown',
      play.id ?? play.name,
    ].join('|');
    const rows = this.rows[key];
    if (rows[rows.length - 1]?.dedupeKey === dedupeKey) return rows[rows.length - 1];

    const row = {
      side: key,
      playId: play.id == null ? null : String(play.id),
      playName: play.name || null,
      family: context.family || play.coverageFamily || play.conceptFamily || play.primaryConcept || play.presentationFamily || null,
      opponentId: opponent.id == null ? null : String(opponent.id),
      opponentName: opponent.name || null,
      situation: context.situation || null,
      dedupeKey,
      timestamp: Date.now(),
    };
    rows.push(row);
    if (rows.length > this.limit) rows.splice(0, rows.length - this.limit);
    return row;
  }

  recent(side, limit = 8) {
    return this.rows[sideKey(side)].slice(-Math.max(0, Number(limit) || 0));
  }

  penalty(side, play, family = null, window = 8) {
    const recent = this.recent(side, window);
    const id = play?.id == null ? null : String(play.id);
    const exactHits = id == null ? 0 : recent.filter(row => row.playId === id).length;
    const familyKey = family || play?.coverageFamily || play?.conceptFamily || play?.primaryConcept || play?.presentationFamily || null;
    const familyHits = familyKey == null ? 0 : recent.filter(row => String(row.family || '') === String(familyKey)).length;
    // Recommendation exposure suppresses display spam only; it is not a
    // football reason to force artificial variety.
    const exact = -Math.min(exactHits, 3) * 0.06;
    const structural = -Math.min(Math.max(0, familyHits - exactHits), 3) * 0.02;
    return {
      score: exact + structural,
      exactHits,
      familyHits,
      reasons: exactHits || familyHits
        ? [`recent recommendation exposure: exact=${exactHits}, family=${familyHits}`]
        : [],
    };
  }
}

module.exports = { RecommendationHistory, situationKey };
