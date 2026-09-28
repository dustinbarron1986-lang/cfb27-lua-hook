const { scoreSituation } = require("./situation-scorer");
const { evaluateOffensiveCandidate } = require("./counter-model");

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
  const playHits = recent.filter(e => String(e.play?.id) === String(play.id)).length;
  const family = play.presentationFamily || play.primaryConcept || null;
  const familyHits = family ? recent.filter(e => (e.play?.presentationFamily || e.play?.primaryConcept) === family).length : 0;
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

    if (situationSummary.attempts >= 2 && situationSummary.situationalSuccessRate != null) {
      components.contextualSuccess = (situationSummary.situationalSuccessRate - 0.5) * 3.2;
      reasons.push(`same-situation success ${Math.round(situationSummary.situationalSuccessRate * 100)}% (${situationSummary.attempts} calls)`);
    }

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

function counterFamily(counter, play) {
  return counter?.structure?.primaryThreat || play.primaryConcept || play.presentationFamily || null;
}

class PlaySelectionEngine {
  constructor({ store, sequences, tendencies, knowledge = null, recommendationHistory = null, strategy = null }) {
    this.store = store;
    this.sequences = sequences;
    this.tendencies = tendencies;
    this.knowledge = knowledge;
    this.recommendationHistory = recommendationHistory;
    this.strategy = strategy;
  }

  rank({ playbook, situation, defensePlay = null, limit = 5 }) {
    const plays = normalizePlaybook(playbook);
    const tendency = this.tendencies.summarize(situation);
    const events = this.store.getAll();
    const oracle = Boolean(defensePlay?.name || defensePlay?.coverageFamily || defensePlay?.assignmentFamilies?.length);
    // Both OC stages use the shared structural counter model. Before the exact
    // defense is known, recent opponent defensive structure supplies the best
    // available incomplete-information profile. Once a fresh exact call is
    // available, that exact call becomes the dominant current structure.
    const defenseProfile = this.tendencies.recentDefensiveStructures(defensePlay || null);
    const historicalStructureAvailable = !oracle && defenseProfile.sampleSize >= 2;

    const evaluated = plays.map(play => {
      const situationPart = scoreSituation(play, situation);
      const tendencyPart = this.tendencies.scoreCandidate(play, tendency);
      const performancePart = performanceScore(this.store, play, situation);
      const setupPart = setupScore(this.sequences, this.store, play);
      const executionRepetition = recentRepetitionPenalty(events, play);
      const riskPenalty = situationPart.risk > 0 ? -0.25 * situationPart.risk : 0;
      const counter = evaluateOffensiveCandidate({
        defenseProfile,
        play,
        knowledge: this.knowledge,
        situation
      });
      const family = counterFamily(counter, play);
      const recommendationPenalty = this.recommendationHistory
        ? this.recommendationHistory.penalty('offense', play, family)
        : { score: 0, reasons: [], exactHits: 0, familyHits: 0 };
      const strategyPart = !oracle && this.strategy?.scoreCandidate
        ? this.strategy.scoreCandidate(play, situation, { defenseProfile, counter })
        : { score: 0, components: {}, reasons: [], planReasons: [], entry: null };

      const components = oracle ? {
        counterFit: counter.score,
        situation: situationPart.score,
        gameDayPerformance: performancePart.score * 0.45,
        setupValue: setupPart.score * 0.50,
        historicalTendency: tendencyPart.score * 0.20,
        executionRepetition: executionRepetition * 0.35,
        recommendationRepetition: recommendationPenalty.score,
        risk: riskPenalty,
      } : {
        // Stage 1 remains counter-first, but the counter evidence comes from
        // prior defensive structure rather than a not-yet-known exact call.
        historicalStructureFit: historicalStructureAvailable ? counter.score * 0.55 : 0,
        situation: situationPart.score,
        historicalTendency: tendencyPart.score * 0.75,
        gameDayPerformance: performancePart.score,
        setupValue: setupPart.score,
        executionRepetition,
        recommendationRepetition: recommendationPenalty.score,
        risk: riskPenalty,
        gameplanFit: strategyPart.components?.gameplanFit || 0,
        callSheetMembership: strategyPart.components?.callSheetMembership || 0,
        sequencingValue: strategyPart.components?.sequencingValue || 0,
        setupValue: strategyPart.components?.setupValue || 0,
        payoffValue: strategyPart.components?.payoffValue || 0,
        tendencyBreakingValue: strategyPart.components?.tendencyBreakingValue || 0,
        aggression: strategyPart.components?.aggression || 0,
        audibleFlexibility: strategyPart.components?.audibleFlexibility || 0,
      };

      const total = Object.values(components).reduce((a,b) => a + b, 0);
      const reasons = oracle ? [
        ...counter.reasons,
        ...situationPart.reasons,
        ...performancePart.reasons.map(r => `secondary execution evidence: ${r}`),
        ...recommendationPenalty.reasons,
      ] : [
        ...(historicalStructureAvailable
          ? counter.reasons.map(r => r.replace('punishes current defense with:', 'historical defensive profile favors:'))
          : []),
        ...situationPart.reasons,
        ...tendencyPart.reasons,
        ...performancePart.reasons,
        ...setupPart.reasons,
        ...recommendationPenalty.reasons,
        ...(strategyPart.planReasons || []).map(r => `gameplan: ${r}`),
        ...(strategyPart.reasons || []).map(r => `strategy: ${r}`),
      ];

      return {
        play,
        score: Number(total.toFixed(3)),
        components,
        reasons,
        tendencyContext: tendency,
        exactDefense: defensePlay,
        strategicWhy: [
          ...(strategyPart.planReasons || []),
          ...(strategyPart.reasons || []),
        ].slice(0, 3),
        diagnostic: {
          side: "offense",
          playId: play.id,
          playName: play.name,
          exactDefense: defensePlay,
          defenseProfile,
          counter,
          thisGame: performancePart.playSummary,
          sameSituation: performancePart.situationSummary,
          performanceComponents: performancePart.components,
          recommendationExposure: recommendationPenalty,
          strategy: strategyPart,
          totalComponents: components
        },
        selectionPolicy: oracle ? "exact_defense_oracle_counter_first" : "pre_call_no_current_exact_defense"
      };
    });

    const situationValid = evaluated.filter(row => row.diagnostic.counter?.gate?.valid !== false);
    const counterValid = situationValid.filter(row => row.diagnostic.counter?.valid === true);
    let pool = situationValid;
    if (oracle || historicalStructureAvailable) {
      // Exact defense gets the full counter gate. Stage 1 uses the same gate
      // when history supplies useful structural evidence, but degrades to the
      // situation-valid set when the historical taxonomy cannot distinguish
      // a viable answer.
      pool = counterValid.length ? counterValid : situationValid;
    }

    const ranked = pool.sort((a,b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.play?.id || a.play?.name || '').localeCompare(String(b.play?.id || b.play?.name || ''));
    });

    return {
      situation,
      tendency,
      exactDefense: defensePlay,
      defenseProfile,
      recommendations: ranked.slice(0, limit),
      // Expose the complete situation/counter-valid pool so the live Oracle
      // stage can compare the stored initial call with the exact-defense best
      // answer without rerunning a different scoring lifecycle.
      strategicCandidates: ranked,
      evaluated: evaluated.length,
      strategicEligible: pool.length,
      informationMode: oracle ? "exact_defense" : (historicalStructureAvailable ? "historical_defense_structure" : "situation_only"),
      selectionPolicy: oracle ? "exact_defense_oracle_counter_first" : "pre_call_no_current_exact_defense"
    };
  }
}

module.exports = { PlaySelectionEngine, performanceScore, recentRepetitionPenalty };
