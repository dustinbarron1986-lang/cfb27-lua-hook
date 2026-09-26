function confidenceFromSample(n) {
  if (n >= 30) return "HIGH";
  if (n >= 12) return "MEDIUM";
  if (n >= 5) return "LOW";
  return "VERY_LOW";
}

function successRate(rows) {
  if (!rows.length) return null;
  return rows.reduce((s, x) => s + (x.grades?.offense?.situationalSuccess ? 1 : 0), 0) / rows.length;
}

class SequenceMemory {
  constructor(store) { this.store = store; }

  sequenceLift({ targetPlayId, setupConcept, window = 6, minOccurrences = 1, setupSuccessOnly = true }) {
    const events = this.store.getAll();
    const baseline = events.filter(e => e.play?.id === targetPlayId);
    const qualified = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.play?.id !== targetPlayId) continue;

      const prior = events.slice(Math.max(0, i - window), i);
      const hits = prior.filter(p => {
        if (!(p.play?.concepts || []).includes(setupConcept)) return false;
        return !setupSuccessOnly || Boolean(p.grades?.offense?.situationalSuccess);
      });

      if (hits.length >= minOccurrences) qualified.push(e);
    }

    const baselineRate = successRate(baseline);
    const conditionalRate = successRate(qualified);

    return {
      targetPlayId,
      setupConcept,
      window,
      minOccurrences,
      baseline: { attempts: baseline.length, successRate: baselineRate },
      conditional: { attempts: qualified.length, successRate: conditionalRate },
      sequenceLift: baselineRate == null || conditionalRate == null ? null : conditionalRate - baselineRate,
      confidence: confidenceFromSample(qualified.length)
    };
  }

  setupStrength({ setupConcept, window = 6 }) {
    const events = this.store.getAll().slice(-window);
    let score = 0;

    for (const e of events) {
      if (!(e.play?.concepts || []).includes(setupConcept)) continue;
      score += 1; // shown
      if (e.grades?.offense?.situationalSuccess) score += 2; // successful
      if (e.grades?.offense?.explosive) score += 1; // explosive
    }

    return { concept: setupConcept, window, rawScore: score };
  }
}

module.exports = { SequenceMemory };
