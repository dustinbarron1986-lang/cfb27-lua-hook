const { isDefensivelyEligible, categorizeDefensivePlay } = require("./defensive-eligibility");

function normalizePlaybook(playbook) {
  if (Array.isArray(playbook)) return playbook;
  return playbook?.plays || [];
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function detectedPressure(play) {
  const haystack = [play?.name, play?.type, ...(play?.concepts || [])].join(" ");
  return /\b(blitz|pressure|fire|smoke|sting|zero)\b/i.test(haystack);
}

function offenseFamily(knowledge, play) {
  if (play?.conceptFamily) return play.conceptFamily;
  for (const value of [...(play?.concepts || []), play?.name]) {
    const resolved = knowledge.resolveConcept(value);
    if (resolved) return resolved;
  }
  return play?.presentationFamily || null;
}

function defenseFamily(knowledge, play) {
  if (play?.coverageFamily) return play.coverageFamily;
  const resolved = knowledge.resolveCoverage(play?.name || (play?.concepts || []).join(" "));
  return resolved || play?.presentationFamily || null;
}

function recentDefenseRepetitionPenalty(events, play, window = 6) {
  const recent = events.slice(-window);
  const hits = recent.filter(e => String(e.opponentPlay?.id) === String(play.id)).length;
  return -hits * 0.65;
}

function recentDefenseFamilyRepetitionPenalty(events, knowledge, family, window = 6) {
  if (!family) return 0;
  const recent = events.slice(-window);
  const hits = recent.filter(event => defenseFamily(knowledge, event.opponentPlay) === family).length;
  // Modest predictability signal only. It deliberately caps below one point so
  // legitimate football/situation evidence can still justify staying in the
  // same coverage/structure family.
  return hits ? -Math.min(hits, 3) * 0.18 : 0;
}

function coldStartStructuralPrior(knowledge, play, theory) {
  if (theory?.evaluations?.length) return { score: 0, reasons: [] };
  const family = defenseFamily(knowledge, play);
  if (!family) return { score: 0, reasons: [] };
  return {
    score: 0.08,
    reasons: [`cold-start structural prior: recognized defensive family ${family}`],
  };
}

function empiricalReliability(attempts) {
  // The observed matchup becomes the majority signal around five samples and
  // approaches source-of-truth status with a dozen-plus samples.
  const n = Math.max(0, Number(attempts) || 0);
  return clamp(n / 8, 0, 1);
}

function summarizeEmpiricalDefense(summary) {
  if (!summary || summary.attempts === 0) {
    return { rawScore: 0, reasons: [] };
  }

  let rawScore = 0;
  const reasons = [];

  if (summary.defensiveSuccessRate != null) {
    rawScore += (summary.defensiveSuccessRate - 0.5) * 5.0;
    reasons.push(`observed defensive win rate ${Math.round(summary.defensiveSuccessRate * 100)}% (${summary.attempts} snaps)`);
  }
  if (summary.avgYards != null) {
    rawScore += clamp((4.0 - summary.avgYards) * 0.25, -1.6, 1.6);
    reasons.push(`observed ${summary.avgYards.toFixed(1)} yards/play`);
  }
  if (summary.explosiveAllowedRate != null && summary.explosiveAllowedRate > 0) {
    rawScore -= summary.explosiveAllowedRate * 2.2;
    reasons.push(`${Math.round(summary.explosiveAllowedRate * 100)}% explosive-allowed rate`);
  }
  if (summary.takeawayRate != null && summary.takeawayRate > 0) {
    rawScore += summary.takeawayRate * 1.6;
    reasons.push(`${Math.round(summary.takeawayRate * 100)}% takeaway rate`);
  }

  return { rawScore: clamp(rawScore, -5, 5), reasons };
}

function defensiveSituationScore(play, situation = {}) {
  const down = Number(situation.down || 0);
  const distance = Number(situation.distance || 0);
  const name = String(play?.name || "");
  const concepts = new Set((play?.concepts || []).map(x => String(x).toLowerCase()));
  const pressure = detectedPressure(play);
  let score = 0;
  const reasons = [];

  const isQuarters = /cover\s*4|quarters|palms/i.test(name) || concepts.has("cover_4");
  const isSingleHigh = /cover\s*[13]\b|robber/i.test(name) || concepts.has("single_high");
  const isTwoHigh = /cover\s*[2469]\b|tampa/i.test(name) || concepts.has("two_high");

  if ((down === 3 || down === 4) && distance >= 7) {
    if (isQuarters || isTwoHigh) {
      score += 0.8;
      reasons.push("coverage shell fits long-yardage sticks/explosive prevention");
    }
    if (pressure) {
      score += 0.35;
      reasons.push("pressure has value on obvious passing down");
    }
  }

  if (distance > 0 && distance <= 2) {
    if (isSingleHigh || pressure) {
      score += 0.55;
      reasons.push("aggressive structure fits short-yardage constraint");
    }
    if (isQuarters) {
      score -= 0.3;
    }
  }

  return { score, reasons };
}

function theoryScore(knowledge, offensePlay, defensePlay) {
  const concepts = [offensePlay?.name, ...(offensePlay?.concepts || [])];
  const pressure = detectedPressure(defensePlay);
  const evaluations = [];

  for (const concept of concepts) {
    const result = knowledge.evaluateMatchup({
      concept,
      coverage: defensePlay?.name || (defensePlay?.concepts || []).join(" "),
      pressure
    });
    if (result.known) evaluations.push(result);
  }

  if (!evaluations.length) {
    return {
      score: 0,
      reasons: ["no bootstrap theory match for this exact offensive concept"],
      evaluations: []
    };
  }

  // Protect against the offense's strongest known structural answer. The
  // knowledge score is offense-positive, so invert it for the defense.
  const offenseBest = evaluations.reduce((best, x) => x.score > best.score ? x : best, evaluations[0]);
  const score = -offenseBest.score;
  const reasons = (offenseBest.reasons || []).map(r => `bootstrap theory: ${r}`);

  return { score, reasons, evaluations };
}

class DefensiveSelectionEngine {
  constructor({ store, knowledge }) {
    this.store = store;
    this.knowledge = knowledge;
  }

  rank({ playbook, offensePlay, situation, limit = 5 }) {
    const allPlays = normalizePlaybook(playbook);
    const events = this.store.getAll();

    const candidatePool = { total: allPlays.length, eligible: 0, excludedSpecialTeams: 0, excludedSituational: 0, excludedUnknown: 0 };
    const plays = allPlays.filter(play => {
      if (isDefensivelyEligible(play, situation)) {
        candidatePool.eligible += 1;
        return true;
      }
      const category = categorizeDefensivePlay(play);
      if (category === 'special_teams') candidatePool.excludedSpecialTeams += 1;
      else if (category === 'unknown') candidatePool.excludedUnknown += 1;
      else candidatePool.excludedSituational += 1; // prevent/goal_line, situationally ineligible right now
      return false;
    });

    // Canonical-id -> index-of-most-recent-actual-use, built from completed,
    // telemetry-graded events (never from a mere recommendation display).
    // Used only as a tie-break after scoring -- never adjusts `score` itself.
    const lastUsedIndex = new Map();
    const lastUsedFamilyIndex = new Map();
    events.forEach((event, index) => {
      const id = event.opponentPlay?.id;
      if (id != null) lastUsedIndex.set(String(id), index);
      const family = defenseFamily(this.knowledge, event.opponentPlay);
      if (family) lastUsedFamilyIndex.set(family, index);
    });

    const ranked = plays.map(play => {
      const theory = theoryScore(this.knowledge, offensePlay, play);
      const exactMatchup = this.store.summarizeMatchup(offensePlay?.id, play.id);
      const contextualMatchup = this.store.summarizeMatchup(offensePlay?.id, play.id, situation);
      const offenseFamilyKey = offenseFamily(this.knowledge, offensePlay);
      const defenseFamilyKey = defenseFamily(this.knowledge, play);
      const structuralPrior = coldStartStructuralPrior(this.knowledge, play, theory);
      const familyMatchup = this.store.summarizeFamilyMatchup(offenseFamilyKey, defenseFamilyKey);
      const contextualFamilyMatchup = this.store.summarizeFamilyMatchup(offenseFamilyKey, defenseFamilyKey, situation);
      const overallDefense = this.store.summarizeDefensePlay(play.id);
      const empirical = summarizeEmpiricalDefense(exactMatchup);
      const contextualEmpirical = summarizeEmpiricalDefense(contextualMatchup);
      const familyEmpirical = summarizeEmpiricalDefense(familyMatchup);
      const contextualFamilyEmpirical = summarizeEmpiricalDefense(contextualFamilyMatchup);
      const reliability = empiricalReliability(exactMatchup.attempts);
      const contextualReliability = empiricalReliability(contextualMatchup.attempts);
      const familyReliability = empiricalReliability(familyMatchup.attempts);
      const contextualFamilyReliability = empiricalReliability(contextualFamilyMatchup.attempts);

      // Exact matchup evidence is most specific. Family evidence fills the gap,
      // while football theory is only a bootstrap prior for sparse observations.
      const empiricalCoverage = clamp(Math.max(reliability, familyReliability * 0.8), 0, 1);
      const bootstrapTheory = theory.score * (1 - empiricalCoverage);
      const observedMatchup = empirical.rawScore * reliability;
      const observedContext = contextualEmpirical.rawScore * contextualReliability * 0.75;
      const familyBackfillWeight = (1 - reliability) * familyReliability * 0.85;
      const observedFamilyMatchup = familyEmpirical.rawScore * familyBackfillWeight;
      const observedFamilyContext = contextualFamilyEmpirical.rawScore * (1 - contextualReliability) * contextualFamilyReliability * 0.55;

      let execution = 0;
      const executionReasons = [];
      if (overallDefense.attempts >= 3 && overallDefense.defensiveSuccessRate != null) {
        execution += (overallDefense.defensiveSuccessRate - 0.5) * 1.5;
        if (overallDefense.avgYards != null) execution += clamp((4.5 - overallDefense.avgYards) * 0.08, -0.5, 0.5);
        executionReasons.push(`this defense has ${Math.round(overallDefense.defensiveSuccessRate * 100)}% observed success overall`);
      }

      const situationPart = defensiveSituationScore(play, situation);
      const repetition = recentDefenseRepetitionPenalty(events, play);
      const familyRepetition = recentDefenseFamilyRepetitionPenalty(events, this.knowledge, defenseFamilyKey);
      const lastUsedAt = lastUsedIndex.has(String(play.id)) ? lastUsedIndex.get(String(play.id)) : -1;
      const lastFamilyUsedAt = defenseFamilyKey && lastUsedFamilyIndex.has(defenseFamilyKey)
        ? lastUsedFamilyIndex.get(defenseFamilyKey)
        : -1;

      const components = {
        bootstrapTheory,
        structuralPrior: structuralPrior.score,
        observedExactMatchup: observedMatchup,
        observedSituationMatchup: observedContext,
        observedFamilyMatchup,
        observedFamilySituation: observedFamilyContext,
        observedExecution: execution,
        situation: situationPart.score,
        repetition,
        familyRepetition
      };

      const total = Object.values(components).reduce((a,b) => a + b, 0);
      const reasons = [
        ...theory.reasons,
        ...empirical.reasons.map(r => `exact empirical matchup: ${r}`),
        ...contextualEmpirical.reasons.map(r => `exact same-situation matchup: ${r}`),
        ...familyEmpirical.reasons.map(r => `family empirical matchup: ${r}`),
        ...contextualFamilyEmpirical.reasons.map(r => `family same-situation matchup: ${r}`),
        ...executionReasons,
        ...structuralPrior.reasons,
        ...situationPart.reasons
      ];

      return {
        play,
        score: Number(total.toFixed(3)),
        components,
        reasons,
        exactOffense: offensePlay,
        diagnostic: {
          side: "defense",
          playId: play.id,
          playName: play.name,
          exactOffense: offensePlay,
          offenseFamily: offenseFamilyKey,
          defenseFamily: defenseFamilyKey,
          empiricalReliability: Number(reliability.toFixed(3)),
          familyReliability: Number(familyReliability.toFixed(3)),
          theoryWeight: Number((1 - empiricalCoverage).toFixed(3)),
          exactMatchup,
          sameSituationMatchup: contextualMatchup,
          familyMatchup,
          familySituationMatchup: contextualFamilyMatchup,
          overallDefense,
          totalComponents: components,
          lastUsedAt,
          lastFamilyUsedAt
        },
        selectionPolicy: "exact_offense_oracle_with_empirical_override"
      };
    }).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Genuine score tie: prefer the least recently ACTUALLY used defensive
      // family, then the least recently used exact call. This is deterministic
      // predictability control, not a diversity mandate; the family penalty
      // above is intentionally small enough for stronger football evidence to win.
      if (a.diagnostic.lastFamilyUsedAt !== b.diagnostic.lastFamilyUsedAt) {
        return a.diagnostic.lastFamilyUsedAt - b.diagnostic.lastFamilyUsedAt;
      }
      return a.diagnostic.lastUsedAt - b.diagnostic.lastUsedAt;
    });

    return {
      situation,
      exactOffense: offensePlay,
      recommendations: ranked.slice(0, limit),
      evaluated: ranked.length,
      candidatePool,
      learningPolicy: "bootstrap football theory fades as observed exact-play and play-family matchup samples grow"
    };
  }
}

module.exports = {
  DefensiveSelectionEngine,
  empiricalReliability,
  summarizeEmpiricalDefense,
  theoryScore,
  recentDefenseFamilyRepetitionPenalty,
  coldStartStructuralPrior
};
