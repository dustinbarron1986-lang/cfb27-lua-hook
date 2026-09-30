const { scoreSituation } = require("./situation-scorer");
const { evaluateOffensiveCandidate } = require("./counter-model");
const { objectiveFit } = require("../gameplan/drive-objective");
const { hashGeometryScore } = require("../analysis/hash-geometry");
const { fourMinuteStrength } = require("../gameplan/strategic-context");
const { classifyOffensiveStructure } = require("../analysis/structural-threat-model");

// The authority-free structural threat classification of a playbook play is
// stable, so it is computed once per play object (regex-heavy, ~500 plays).
const structuralCache = new WeakMap();
function cachedStructure(play) {
  if (!play || typeof play !== 'object') return undefined;
  if (play.structural) return play.structural;
  // Authority-aware callers classify with the authored structure; leave them
  // on their original path.
  if (play.authoritativeStructure) return undefined;
  let structure = structuralCache.get(play);
  if (!structure) {
    structure = classifyOffensiveStructure(play);
    structuralCache.set(play, structure);
  }
  return structure;
}

// Local CFB27 evidence gains influence smoothly with sample size; the same
// constant retires the generic empirical prior as local attempts accumulate.
const LOCAL_SAMPLE_K = 8;
function sampleConfidence(n) {
  const attempts = Math.max(0, Number(n) || 0);
  return attempts / (attempts + LOCAL_SAMPLE_K);
}

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

function historicalDefenseInfluence(sampleSize) {
  const n = Math.max(0, Number(sampleSize) || 0);
  return Number((0.55 * (n / (n + 12))).toFixed(4));
}

function recentContextualResult(events, play, situation = {}, sequenceAligned = false) {
  const id = play?.id == null ? null : String(play.id);
  if (!id) return { score:0, rawScore:0, failures:0, successes:0, reasons:[] };
  const band = d => {
    const n = Number(d);
    if (!Number.isFinite(n)) return 'unknown';
    if (n <= 3) return 'short';
    if (n <= 7) return 'medium';
    return 'long';
  };
  const matches = [];
  let sameDrive = true;
  for (let i = (events || []).length - 1; i >= 0 && matches.length < 4; i -= 1) {
    const event = events[i] || {};
    if (situation.possession != null && event.situation?.possession != null &&
        Number(event.situation.possession) !== Number(situation.possession)) {
      sameDrive = false;
      continue;
    }
    if (String(event.play?.id ?? '') !== id) continue;
    const sameDown = Number(event.situation?.down) === Number(situation.down);
    const eventDistance = Number(event.situation?.distance);
    const targetDistance = Number(situation.distance);
    const similarDistance = band(eventDistance) === band(targetDistance) ||
      (Number.isFinite(eventDistance) && Number.isFinite(targetDistance) && Math.abs(eventDistance-targetDistance) <= 2);
    if (!sameDown || !similarDistance) continue;
    const success = event.grades?.offense?.situationalSuccess === true ||
      event.result?.firstDown === true || event.result?.touchdown === true || event.result?.conversion === true;
    const failure = event.grades?.offense?.situationalSuccess === false ||
      (!success && Number(event.result?.yards) <= 0);
    matches.push({success,failure,sameDrive});
  }
  if (matches[0]?.success) {
    return {score:0,rawScore:0,failures:matches.filter(x=>x.failure).length,successes:matches.filter(x=>x.success).length,
      reasons:['recent contextual result: latest comparable exact-play call succeeded; repetition remains viable']};
  }
  const failures = matches.filter(x=>x.failure).reduce((sum,row)=>sum+(row.sameDrive?1:0.6),0);
  if (!(failures>0)) return {score:0,rawScore:0,failures:0,successes:matches.filter(x=>x.success).length,reasons:[]};
  const rawScore=-Math.min(1.2,0.28+Math.max(0,failures-1)*0.24);
  const score=sequenceAligned?rawScore*0.45:rawScore;
  return {score:Number(score.toFixed(3)),rawScore:Number(rawScore.toFixed(3)),failures:Number(failures.toFixed(2)),
    successes:matches.filter(x=>x.success).length,sequenceDiscount:sequenceAligned?0.45:1,
    reasons:['recent contextual result: exact play recently failed in a similar context'+(sequenceAligned?'; sequence intent reduces the caution':'')]};
}

const SATURATION_CAP = 1.6;

function usageSaturation(store, play, counter, situation) {
  const summary = store.summarizePlay(play.id);
  const attempts = Number(summary.attempts || 0);
  if (attempts < 5) return { score: 0, attempts, exploit: false, reasons: [] };

  // Self-scout exposure cost, bounded at SATURATION_CAP so it stays a
  // tendency signal rather than the largest term in the total (it previously
  // reached -6.5 and forced variety). A proven answer (strong structural fit,
  // or sustained high success over a real sample) keeps most of its value.
  let penalty = -Math.min(SATURATION_CAP, (attempts - 4) * 0.08 + Math.max(0, attempts - 12) * 0.04);

  const success = Number(summary.situationalSuccessRate);
  const fit = Number(counter?.fit);
  const provenAnswer = fit >= 0.72 || (success >= 0.75 && attempts >= 8);
  const exploit = success >= 0.58 && provenAnswer && counter?.gate?.valid !== false &&
    !situation?.flags?.fourMinute && !situation?.flags?.trailingLate;
  if (exploit) penalty *= 0.4;

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

  // Raw rates are shrunk by sample confidence: n=2 moves a play by at most a
  // few tenths, n=24 by most of the raw value. Same-situation failures are
  // represented once (contextualSuccess); they are not escalated separately.
  const playWeight = sampleConfidence(playSummary.attempts);
  const situationWeight = sampleConfidence(situationSummary.attempts);
  if (playSummary.attempts >= 2) {
    if (playSummary.situationalSuccessRate != null) {
      components.exactPlaySuccess = (playSummary.situationalSuccessRate - 0.5) * 3.0 * playWeight;
      reasons.push(`game-day play success ${Math.round(playSummary.situationalSuccessRate * 100)}% (${playSummary.attempts} calls)`);
    }

    if (playSummary.avgYards != null) {
      components.yardage = bounded((playSummary.avgYards - 4.0) * 0.18, -1.5, 1.2) * playWeight;
      reasons.push(`game-day average ${playSummary.avgYards.toFixed(1)} yards`);
    }

    if (playSummary.negativePlayRate != null && playSummary.negativePlayRate > 0) {
      components.negativePlays = -playSummary.negativePlayRate * 2.4 * playWeight;
      if (playSummary.negativePlayRate >= 0.34) reasons.push(`${Math.round(playSummary.negativePlayRate * 100)}% negative-play rate`);
    }

    if (playSummary.turnoverRate > 0) {
      components.turnovers = -playSummary.turnoverRate * 2.5 * playWeight;
      reasons.push("game-day turnover history reduces confidence");
    }

    if (situationSummary.attempts >= 2 && situationSummary.situationalSuccessRate != null) {
      components.contextualSuccess = (situationSummary.situationalSuccessRate - 0.5) * 3.2 * situationWeight;
      reasons.push(`same-situation success ${Math.round(situationSummary.situationalSuccessRate * 100)}% (${situationSummary.attempts} calls)`);
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
  return { score, reasons, components, playSummary, situationSummary, sampleWeight: { play: playWeight, situation: situationWeight } };
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
    const historicalSampleSize = Number(defenseProfile.sampleSize || 0);
    const historicalConfidenceWeight = !oracle ? historicalDefenseInfluence(historicalSampleSize) : 0;
    const historicalStructureAvailable = !oracle && historicalSampleSize > 0;
    const clockStrength = fourMinuteStrength(situation);

    const evaluated = plays.map(originalPlay => {
      const normalizedProfile = this.offensiveProfiles?.profile
        ? this.offensiveProfiles.profile(originalPlay)
        : (originalPlay.normalizedProfile || {});
      const play = { ...originalPlay, normalizedProfile, structural: cachedStructure(originalPlay) };
      const situationPart = scoreSituation(play, situation);
      const empiricalSituation = this.empiricalPrior?.situationEvidence
        ? this.empiricalPrior.situationEvidence(situation, normalizedProfile)
        : { available:false, score:0 };
      const empiricalCoverage = oracle && this.empiricalPrior?.routeCoverageEvidence
        ? this.empiricalPrior.routeCoverageEvidence(normalizedProfile, defensePlay || {})
        : { available:false, score:0 };
      const objectivePart = objectiveFit(normalizedProfile, driveObjective?.objective, { clockOwnership: clockStrength });
      const hashPart = hashGeometryScore(play, situation, null);
      const intentPart = this.sequences?.candidateIntentFit
        ? this.sequences.candidateIntentFit(play, sequenceIntent, plays)
        : { aligned:false, tier:0 };
      const performancePart = performanceScore(this.store, play, situation);
      // recentContextualResult and performance.contextualSuccess read the same
      // exact-play/same-situation events; once two such attempts exist the
      // sample-weighted rate owns that evidence.
      const contextualOwnedByPerformance = Number(performancePart.situationSummary?.attempts || 0) >= 2;
      const contextualRaw = recentContextualResult(events, play, situation, Boolean(intentPart.aligned));
      const contextualResult = contextualOwnedByPerformance
        ? { ...contextualRaw, score: 0, suppressedBy: 'gameDayPerformance.contextualSuccess', reasons: [] }
        : contextualRaw;
      const selfScoutPart = !oracle && this.selfScout?.candidateValue
        ? this.selfScout.candidateValue(play)
        : { score:0, reason:null, scout:null };
      const tendencyPart = this.tendencies.scoreCandidate(play, tendency);
      const localSituationAttempts = Number(performancePart.situationSummary?.attempts || 0);
      const localWeight = sampleConfidence(localSituationAttempts);
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
        usageSaturation: saturation.score * 0.35,
        // Fresh exact defense supersedes this opponent's historical tendency.
        historicalTendency: 0,
        executionRepetition: executionRepetition * 0.35,
        recommendationRepetition: recommendationPenalty.score,
        recentContextualResult: contextualResult.score,
        risk: riskPenalty,
        empiricalCoveragePrior: empiricalCoverage.available ? empiricalCoverage.score * 0.75 : 0,
      } : {
        // Stage 1 remains counter-first, but the counter evidence comes from
        // prior defensive structure rather than a not-yet-known exact call.
        historicalStructureFit: historicalStructureAvailable ? counter.score * historicalConfidenceWeight : 0,
        situation: situationPart.score,
        // Historical opponent tendency and historicalStructureFit read the
        // same opponent calls; the confidence-weighted structural fit owns it.
        historicalTendency: 0,
        gameDayPerformance: performancePart.score,
        usageSaturation: saturation.score,
        executionRepetition,
        recommendationRepetition: recommendationPenalty.score,
        risk: riskPenalty,
        empiricalSituationPrior: empiricalSituationScore,
        driveObjectiveFit: objectivePart.score,
        hashGeometry: hashPart.score,
        selfScoutValue: selfScoutPart.score,
        gameplanFit: bounded(Number(strategyPart.components?.gameplanFit || 0), -0.30, 0.45),
        callSheetMembership: 0,
        gameplanMixAccountability: bounded(Number(strategyPart.components?.gameplanMixAccountability || 0), -0.35, 0.45),
        // strategicPlayScore is already applied once inside `situation`.
        strategicSituation: 0,
        // Sequencing is an upstream intent layer. Legacy strategy components
        // remain visible in diagnostics below, but are intentionally not added
        // into the flat candidate total.
        aggression: bounded(Number(strategyPart.components?.aggression || 0), -0.20, 0.20),
        audibleFlexibility: bounded(Number(strategyPart.components?.audibleFlexibility || 0), 0, 0.15),
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
        ...performancePart.reasons,
        ...saturation.reasons,
        ...recommendationPenalty.reasons,
        ...contextualResult.reasons,
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
          recentContextualResult: contextualResult,
          historicalDefense: {
            sampleSize: historicalSampleSize,
            confidence: defenseProfile.confidence || 'VERY_LOW',
            rawStructuralScore: Number(counter.score || 0),
            appliedConfidenceWeight: historicalConfidenceWeight,
            appliedContribution: Number((historicalStructureAvailable ? counter.score * historicalConfidenceWeight : 0).toFixed(3)),
          },
          strategy: strategyPart,
          suppressedEvidence: {
            historicalTendency: { raw: tendencyPart.score, reason: oracle ? 'exact defense known' : 'owned by historicalStructureFit' },
            gameplanStrategicSituation: { raw: strategyPart.components?.strategicSituation || 0, reason: 'strategicPlayScore applied once inside situation' },
            recentContextualResult: contextualOwnedByPerformance ? { raw: contextualRaw.score, reason: 'owned by gameDayPerformance.contextualSuccess' } : null,
          },
          legacySequenceScoring: {
            appliedToTotal: false,
            manualSetupCompatibility: setupPart,
            sequencingValue: strategyPart.components?.sequencingValue || 0,
            setupValue: strategyPart.components?.setupValue || 0,
            payoffValue: strategyPart.components?.payoffValue || 0,
            tendencyBreakingValue: strategyPart.components?.tendencyBreakingValue || 0,
            reason: 'Sequence intent is applied upstream through candidateIntentFit, not as additive score.',
          },
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
    if (oracle) {
      // Fresh exact defense may hard-gate structural counters. Historical
      // defense is confidence-weighted evidence only and never hard-gates
      // Stage 1 from a tiny sample.
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

module.exports = { PlaySelectionEngine, sampleConfidence, LOCAL_SAMPLE_K, performanceScore, recentRepetitionPenalty, usageSaturation, historicalDefenseInfluence, recentContextualResult };
