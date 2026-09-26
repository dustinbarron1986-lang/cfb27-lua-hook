const { scoreSituation } = require("./situation-scorer");

function mean(values) {
  const nums = values.filter(v => Number.isFinite(v));
  return nums.length ? nums.reduce((a,b) => a+b, 0) / nums.length : null;
}

function normalizePlaybook(playbook) {
  if (Array.isArray(playbook)) return playbook;
  return playbook?.plays || [];
}

function recentRepetitionPenalty(events, play, window = 6) {
  const recent = events.slice(-window);
  const playHits = recent.filter(e => e.play?.id === play.id).length;
  const family = play.presentationFamily || null;
  const familyHits = family ? recent.filter(e => e.play?.presentationFamily === family).length : 0;
  return -(playHits * 0.8 + familyHits * 0.25);
}

function bounded(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function performanceScore(store, play, situation) {
  const playSummary = store.summarizePlay(play.id);
  const situationSummary = store.summarizePlayInSituation(play.id, situation);
  const conceptSummaries = (play.concepts || []).map(c => store.summarizeConcept(c));

  let score = 0;
  const reasons = [];
  const components = {
    exactPlaySuccess: 0,
    contextualSuccess: 0,
    yardage: 0,
    negativePlays: 0,
    turnovers: 0,
    conceptFallback: 0,
    recentFailureEscalation: 0
  };

  if (playSummary.attempts >= 2) {
    if (playSummary.situationalSuccessRate != null) {
      components.exactPlaySuccess = (playSummary.situationalSuccessRate - 0.5) * 3.0;
      reasons.push(`game-day play success ${Math.round(playSummary.situationalSuccessRate * 100)}% (${playSummary.attempts} calls)`);
    }

    if (playSummary.avgYards != null) {
      // Roughly neutral around 4 yards/play; meaningful losses hurt quickly.
      components.yardage = bounded((playSummary.avgYards - 4.0) * 0.18, -1.5, 1.2);
      reasons.push(`game-day average ${playSummary.avgYards.toFixed(1)} yards`);
    }

    if (playSummary.negativePlayRate != null && playSummary.negativePlayRate > 0) {
      components.negativePlays = -playSummary.negativePlayRate * 2.4;
      if (playSummary.negativePlayRate >= 0.34) reasons.push(`${Math.round(playSummary.negativePlayRate * 100)}% negative-play rate`);
    }

    if (playSummary.turnoverRate > 0) {
      components.turnovers = -playSummary.turnoverRate * 2.5;
      reasons.push("game-day turnover history reduces confidence");
    }

    // Same down/distance/field bucket gets extra weight once repeated.
    if (situationSummary.attempts >= 2 && situationSummary.situationalSuccessRate != null) {
      components.contextualSuccess = (situationSummary.situationalSuccessRate - 0.5) * 3.2;
      reasons.push(`same-situation success ${Math.round(situationSummary.situationalSuccessRate * 100)}% (${situationSummary.attempts} calls)`);
    }

    // A play that repeatedly fails in the exact situation should be shelved fast.
    if (situationSummary.attempts >= 2 && situationSummary.situationalSuccessRate === 0) {
      components.recentFailureEscalation = -Math.min(3.0, 0.9 + (situationSummary.attempts - 2) * 0.8);
      reasons.push("repeated same-situation failures trigger a strong shelf penalty");
    }
  } else {
    const usable = conceptSummaries.filter(x => x.attempts >= 2 && x.situationalSuccessRate != null);
    const conceptRate = mean(usable.map(x => x.situationalSuccessRate));
    if (conceptRate != null) {
      components.conceptFallback = (conceptRate - 0.5) * 1.2;
      reasons.push(`related concepts running ${Math.round(conceptRate * 100)}% situational success`);
    }
  }

  score = Object.values(components).reduce((a,b) => a + b, 0);
  return { score, reasons, components, playSummary, situationSummary };
}

function setupScore(sequenceMemory, store, play) {
  const setupBy = play.setupBy || [];
  if (!setupBy.length) return { score: 0, reasons: [] };

  let best = 0;
  let bestConcept = null;
  for (const concept of setupBy) {
    const strength = sequenceMemory.setupStrength({ setupConcept: concept, window: 8 });
    const normalized = Math.min(2.0, strength.rawScore * 0.25);
    if (normalized > best) {
      best = normalized;
      bestConcept = concept;
    }
  }

  return best > 0
    ? { score: best, reasons: [`${bestConcept} has been shown enough to create setup value`] }
    : { score: 0, reasons: [] };
}

class PlaySelectionEngine {
  constructor({ store, sequences, tendencies }) {
    this.store = store;
    this.sequences = sequences;
    this.tendencies = tendencies;
  }

  rank({ playbook, situation, limit = 5 }) {
    const plays = normalizePlaybook(playbook);
    const tendency = this.tendencies.summarize(situation);
    const events = this.store.getAll();

    const ranked = plays.map(play => {
      const situationPart = scoreSituation(play, situation);
      const tendencyPart = this.tendencies.scoreCandidate(play, tendency);
      const performancePart = performanceScore(this.store, play, situation);
      const setupPart = setupScore(this.sequences, this.store, play);
      const repetitionPenalty = recentRepetitionPenalty(events, play);
      const riskPenalty = situationPart.risk > 0 ? -0.25 * situationPart.risk : 0;

      const components = {
        situation: situationPart.score,
        opponentTendency: tendencyPart.score,
        gameDayPerformance: performancePart.score,
        setupValue: setupPart.score,
        repetition: repetitionPenalty,
        risk: riskPenalty
      };

      const total = Object.values(components).reduce((a,b) => a + b, 0);
      const reasons = [
        ...situationPart.reasons,
        ...tendencyPart.reasons,
        ...performancePart.reasons,
        ...setupPart.reasons
      ];

      return {
        play,
        score: Number(total.toFixed(3)),
        components,
        reasons,
        tendencyContext: tendency,
        diagnostic: {
          side: "offense",
          playId: play.id,
          playName: play.name,
          thisGame: performancePart.playSummary,
          sameSituation: performancePart.situationSummary,
          performanceComponents: performancePart.components,
          totalComponents: components
        },
        selectionPolicy: "pre_call_no_current_exact_defense"
      };
    }).sort((a,b) => b.score - a.score);

    return {
      situation,
      tendency,
      recommendations: ranked.slice(0, limit),
      evaluated: ranked.length
    };
  }
}

module.exports = { PlaySelectionEngine, performanceScore };
