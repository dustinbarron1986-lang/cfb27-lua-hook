const { scoreSituation } = require("./situation-scorer");
const { evaluateOffensiveCandidate } = require("./counter-model");
const { objectiveFit } = require("../gameplan/drive-objective");
const { hashGeometryScore } = require("../analysis/hash-geometry");

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

function usageSaturation(store, play, counter, situation) {
  const summary = store.summarizePlay(play.id);
  const attempts = Number(summary.attempts || 0);
  if (attempts < 5) return { score: 0, attempts, exploit: false, reasons: [] };

  let penalty = 0;
  if (attempts >= 5) penalty -= Math.min(1.0, (attempts - 4) * 0.16);
  if (attempts >= 10) penalty -= Math.min(1.5, (attempts - 9) * 0.24);
  if (attempts >= 15) penalty -= Math.min(2.0, (attempts - 14) * 0.30);
  if (attempts >= 20) penalty -= Math.min(2.0, (attempts - 19) * 0.36);

  const success = Number(summary.situationalSuccessRate);
  const fit = Number(counter?.fit);
  const exploit = success >= 0.58 && fit >= 0.72 && counter?.gate?.valid !== false &&
    !situation?.flags?.fourMinute && !situation?.flags?.trailingLate;
  if (exploit) penalty *= 0.48;

  return {
    score: penalty,
    attempts,
    exploit,
    reasons: [
      `usage saturation: exact play has ${attempts} game calls`,
      ...(exploit ? ['REUSE: defense still has not demonstrated an effective structural answer, so saturation cost is reduced rather than banning the call.'] : []),
    ],
  };
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
  constructor({ store, sequences, tendencies, knowledge = null, recommendationHistory = null, strategy = null, driveObjectives = null, selfScout = null, empiricalPrior = null, offensiveProfiles = null }) {
    this.store = store;
    this.sequences = sequences;
    this.tendencies = tendencies;
    this.knowledge = knowledge;
    this.recommendationHistory = recommendationHistory;
    this.strategy = strategy;
    this.driveObjectives = driveObjectives;
    this.selfScout = selfScout;
    this.empiricalPrior = empiricalPrior;
    this.offensiveProfiles = offensiveProfiles;
  }

  rank({ playbook, situation, defensePlay = null, limit = 5 }) {
    const plays = normalizePlaybook(playbook);
    const tendency = this.tendencies.summarize(situation);
    const driveObjective = this.driveObjectives?.get ? this.driveObjectives.get(situation) : null;
    const sequenceIntent = this.sequences?.intent ? this.sequences.intent(plays) : null;
    const events = this.store.getAll();
    const oracle = Boolean(defensePlay?.name || defensePlay?.coverageFamily || defensePlay?.assignmentFamilies?.length);
    // Both OC stages use the shared structural counter model. Before the exact
    // defense is known, recent opponent defensive structure supplies the best
    // available incomplete-information profile. Once a fresh exact call is
    // available, that exact call becomes the dominant current structure.
    const defenseProfile = this.tendencies.recentDefensiveStructures(defensePlay || null);
    const historicalStructureAvailable = !oracle && defenseProfile.sampleSize >= 2;

    const evaluated = plays.map(originalPlay => {
      const normalizedProfile = this.offensiveProfiles?.profile
        ? this.offensiveProfiles.profile(originalPlay)
        : (originalPlay.normalizedProfile || {});
      const play = { ...originalPlay, normalizedProfile };
      const situationPart = scoreSituation(play, situation);
      const empiricalSituation = this.empiricalPrior?.situationEvidence
        ? this.empiricalPrior.situationEvidence(situation, normalizedProfile)
        : { available:false, score:0 };
      const empiricalCoverage = oracle && this.empiricalPrior?.routeCoverageEvidence
        ? this.empiricalPrior.routeCoverageEvidence(normalizedProfile, defensePlay || {})
        : { available:false, score:0 };
      const objectivePart = objectiveFit(normalizedProfile, driveObjective?.objective);
      const hashPart = hashGeometryScore(play, situation, null);
      const intentPart = this.sequences?.candidateIntentFit
        ? this.sequences.candidateIntentFit(play, sequenceIntent, plays)
        : { aligned:false, tier:0 };
      const selfScoutPart = !oracle && this.selfScout?.candidateValue
        ? this.selfScout.candidateValue(play)
        : { score:0, reason:null, scout:null };
      const tendencyPart = this.tendencies.scoreCandidate(play, tendency);
      const performancePart = performanceScore(this.store, play, situation);
      const localSituationAttempts = Number(performancePart.situationSummary?.attempts || 0);
      const localWeight = localSituationAttempts / (localSituationAttempts + 8);
      const genericWeight = 1 - localWeight;
      const empiricalSituationScore = empiricalSituation.available ? empiricalSituation.score * genericWeight : 0;
      const learningBlend = {
        localAttempts: localSituationAttempts,
        localWeight: Number(localWeight.toFixed(3)),
        genericPriorWeight: Number(genericWeight.toFixed(3)),
        genericPriorRaw: empiricalSituation.score || 0,
        genericPriorApplied: Number(empiricalSituationScore.toFixed(3)),
        localEvidence: performancePart.situationSummary,
        note: 'Local CFB27 outcomes gain influence smoothly; no local EPA is fabricated.',
      };
      const setupPart = setupScore(this.sequences, this.store, play);
      // No generic variety penalty: repetition is valid until self-scout/structure supplies a football reason to change.
      const executionRepetition = 0;
      const riskPenalty = situationPart.risk > 0 ? -0.25 * situationPart.risk : 0;
      const counter = evaluateOffensiveCandidate({
        defenseProfile,
        play,
        knowledge: this.knowledge,
        situation
      });
      const family = counterFamily(counter, play);
      const saturation = usageSaturation(this.store, play, counter, situation);
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
        legacySequenceSetup: setupPart.score * 0.50,
        usageSaturation: saturation.score * 0.35,
        historicalTendency: tendencyPart.score * 0.20,
        executionRepetition: executionRepetition * 0.35,
        recommendationRepetition: recommendationPenalty.score,
        risk: riskPenalty,
        empiricalCoveragePrior: empiricalCoverage.available ? empiricalCoverage.score * 0.75 : 0,
      } : {
        // Stage 1 remains counter-first, but the counter evidence comes from
        // prior defensive structure rather than a not-yet-known exact call.
        historicalStructureFit: historicalStructureAvailable ? counter.score * 0.55 : 0,
        situation: situationPart.score,
        historicalTendency: tendencyPart.score * 0.75,
        gameDayPerformance: performancePart.score,
        legacySequenceSetup: setupPart.score,
        usageSaturation: saturation.score,
        executionRepetition,
        recommendationRepetition: recommendationPenalty.score,
        risk: riskPenalty,
        empiricalSituationPrior: empiricalSituationScore,
        driveObjectiveFit: objectivePart.score,
        hashGeometry: hashPart.score,
        selfScoutValue: selfScoutPart.score,
        gameplanFit: strategyPart.components?.gameplanFit || 0,
        callSheetMembership: strategyPart.components?.callSheetMembership || 0,
        gameplanMixAccountability: strategyPart.components?.gameplanMixAccountability || 0,
        strategicSituation: strategyPart.components?.strategicSituation || 0,
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
        ...saturation.reasons,
        ...recommendationPenalty.reasons,
        ...(empiricalCoverage.available ? [`empirical route/coverage prior: ${empiricalCoverage.route || 'route'} vs ${empiricalCoverage.coverage || empiricalCoverage.shell || 'shell'}`] : []),
      ] : [
        ...(historicalStructureAvailable
          ? counter.reasons.map(r => r.replace('punishes current defense with:', 'historical defensive profile favors:'))
          : []),
        ...situationPart.reasons,
        ...tendencyPart.reasons,
        ...performancePart.reasons,
        ...setupPart.reasons,
        ...saturation.reasons,
        ...recommendationPenalty.reasons,
        ...(empiricalSituation.available ? [`empirical situation prior ${empiricalSituation.rowId}: ${empiricalSituation.mode} edge ${empiricalSituation.score >= 0 ? '+' : ''}${empiricalSituation.score}`] : []),
        ...objectivePart.reasons.map(r => `drive objective: ${r}`),
        ...(hashPart.available && hashPart.reason ? [`hash geometry: ${hashPart.reason}`] : []),
        ...(intentPart.reason ? [`sequence: ${intentPart.reason}`] : []),
        ...(selfScoutPart.reason ? [`self-scout: ${selfScoutPart.reason}`] : []),
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
        intentTier: Number(intentPart.tier || 0),
        sequenceIntent,
        driveObjective,
        strategicWhy: [
          ...(sequenceIntent?.reason ? [sequenceIntent.reason] : []),
          ...(driveObjective?.reason ? [driveObjective.reason] : []),
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
          usageSaturation: saturation,
          recommendationExposure: recommendationPenalty,
          strategy: strategyPart,
          driveObjective,
          sequenceIntent,
          sequenceFit: intentPart,
          selfScout: selfScoutPart.scout,
          normalizedProfile,
          hashGeometry: hashPart,
          empiricalSituation,
          learningBlend,
          empiricalCoverage,
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

    const byScore = [...pool].sort((a,b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.play?.id || a.play?.name || '').localeCompare(String(b.play?.id || b.play?.name || ''));
    });
    let ranked = byScore;
    if (!oracle && sequenceIntent && byScore.length) {
      const aligned = byScore.filter(row => row.intentTier > 0);
      const bestOverall = Number(byScore[0]?.score || 0);
      const viableAligned = aligned.filter(row => Number(row.score) >= bestOverall - 2.0);
      if (viableAligned.length) {
        const preferred = viableAligned.sort((a,b) => {
          if (b.intentTier !== a.intentTier) return b.intentTier - a.intentTier;
          return b.score - a.score;
        });
        const preferredIds = new Set(preferred.map(row => String(row.play?.id)));
        ranked = [...preferred, ...byScore.filter(row => !preferredIds.has(String(row.play?.id)))];
      }
    }

    return {
      situation,
      tendency,
      driveObjective,
      sequenceIntent,
      selfScout: this.selfScout?.summarize ? this.selfScout.summarize() : null,
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

module.exports = { PlaySelectionEngine, performanceScore, recentRepetitionPenalty, usageSaturation };
