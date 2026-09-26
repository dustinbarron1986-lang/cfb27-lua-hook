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

function performanceScore(store, play) {
  const playSummary = store.summarizePlay(play.id);
  const conceptSummaries = (play.concepts || []).map(c => store.summarizeConcept(c));

  let score = 0;
  const reasons = [];

  if (playSummary.attempts >= 2) {
    if (playSummary.situationalSuccessRate != null) {
      score += (playSummary.situationalSuccessRate - 0.5) * 2.0;
      reasons.push(`game-day play success ${Math.round(playSummary.situationalSuccessRate * 100)}% (${playSummary.attempts} calls)`);
    }
    if (playSummary.turnoverRate > 0) {
      score -= playSummary.turnoverRate * 1.5;
      reasons.push("game-day turnover history reduces confidence");
    }
  } else {
    const usable = conceptSummaries.filter(x => x.attempts >= 2 && x.situationalSuccessRate != null);
    const conceptRate = mean(usable.map(x => x.situationalSuccessRate));
    if (conceptRate != null) {
      score += (conceptRate - 0.5) * 1.2;
      reasons.push(`related concepts running ${Math.round(conceptRate * 100)}% situational success`);
    }
  }

  return { score, reasons };
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
      const performancePart = performanceScore(this.store, play);
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

module.exports = { PlaySelectionEngine };
