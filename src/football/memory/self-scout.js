'use strict';

const { trailingUserDrive, playFamily } = require('../sequencing/sequence-memory');

function confidence(n) {
  if (n >= 8) return 'MEDIUM';
  if (n >= 4) return 'LOW';
  return 'VERY_LOW';
}

class SelfScout {
  constructor(store) { this.store = store; }

  summarize() {
    const rows = trailingUserDrive(this.store.getAll());
    const formations = {};
    const families = {};
    const runPassByFormation = {};
    const directionByFormation = {};
    const mechanisms = {};
    const hashes = {};
    const fieldBoundary = { FIELD: 0, BOUNDARY: 0, MIDDLE: 0, UNKNOWN: 0 };

    for (const event of rows) {
      const play = event.play || {};
      const profile = play.normalizedProfile || {};
      const formation = play.formation || profile.formation || 'unknown';
      const family = playFamily(play) || 'unknown';
      const mode = profile.decisionClass || String(play.type || 'unknown').toLowerCase();
      const direction = String(play.runDirection || play.direction || play.side || 'unknown').toUpperCase();
      const mechanism = profile.playMechanism || 'unknown';
      const hash = event.situation?.hash || 'UNKNOWN';
      const fieldSide = event.situation?.fieldSide || event.situation?.hashGeometry?.fieldSide || null;
      const boundarySide = event.situation?.boundarySide || event.situation?.hashGeometry?.boundarySide || null;

      formations[formation] = (formations[formation] || 0) + 1;
      families[family] = (families[family] || 0) + 1;
      mechanisms[mechanism] = (mechanisms[mechanism] || 0) + 1;
      hashes[hash] = (hashes[hash] || 0) + 1;

      if (!runPassByFormation[formation]) runPassByFormation[formation] = { run: 0, pass: 0, hybrid: 0, unknown: 0 };
      runPassByFormation[formation][mode] = (runPassByFormation[formation][mode] || 0) + 1;

      if (!directionByFormation[formation]) directionByFormation[formation] = {};
      directionByFormation[formation][direction] = (directionByFormation[formation][direction] || 0) + 1;

      if (fieldSide === 'BOTH' || boundarySide === 'BOTH') fieldBoundary.MIDDLE += 1;
      else if (direction !== 'UNKNOWN' && direction === fieldSide) fieldBoundary.FIELD += 1;
      else if (direction !== 'UNKNOWN' && direction === boundarySide) fieldBoundary.BOUNDARY += 1;
      else fieldBoundary.UNKNOWN += 1;
    }
    return {
      sampleSize: rows.length,
      confidence: confidence(rows.length),
      formations,
      families,
      runPassByFormation,
      directionByFormation,
      mechanisms,
      hashes,
      fieldBoundary,
      interpretation: 'Observed self-scout only; does not claim the CPU has learned or reacted to these tendencies.',
      provenance: 'LOCAL_OBSERVED',
    };
  }

  candidateValue(play) {
    const scout = this.summarize();
    const n = Number(scout.formations[play.formation] || 0);
    if (n < 3) return { score: 0, reason: null, scout };
    const profile = play.normalizedProfile || {};
    const mix = scout.runPassByFormation[play.formation] || {};
    const total = Object.values(mix).reduce((a,b) => a + Number(b || 0), 0);
    if (!total) return { score: 0, reason: null, scout };
    const mode = profile.decisionClass || String(play.type || '').toLowerCase();
    const share = Number(mix[mode] || 0) / total;
    if (share >= 0.75 && total >= 4) {
      return {
        score: -0.20,
        reason: 'Self-scout shows a strong exposed formation/mode tendency; a credible counter may gain relevance.',
        scout,
      };
    }
    if (share <= 0.25 && total >= 4) {
      return {
        score: 0.20,
        reason: 'Candidate is a conservative tendency breaker from a repeatedly shown formation.',
        scout,
      };
    }
    return { score: 0, reason: null, scout };
  }
}

module.exports = { SelfScout };
