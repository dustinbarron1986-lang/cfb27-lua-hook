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
    for (const event of rows) {
      const play = event.play || {};
      const profile = play.normalizedProfile || {};
      const formation = play.formation || profile.formation || 'unknown';
      const family = playFamily(play) || 'unknown';
      const mode = profile.decisionClass || String(play.type || 'unknown').toLowerCase();
      formations[formation] = (formations[formation] || 0) + 1;
      families[family] = (families[family] || 0) + 1;
      if (!runPassByFormation[formation]) runPassByFormation[formation] = { run: 0, pass: 0, hybrid: 0, unknown: 0 };
      runPassByFormation[formation][mode] = (runPassByFormation[formation][mode] || 0) + 1;
    }
    return {
      sampleSize: rows.length,
      confidence: confidence(rows.length),
      formations,
      families,
      runPassByFormation,
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
