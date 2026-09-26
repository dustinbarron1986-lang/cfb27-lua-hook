function pct(value) {
  return value == null ? "n/a" : `${Math.round(value * 100)}%`;
}

function num(value, digits = 1) {
  if (value == null || value === "") return "n/a";
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "n/a";
}

function signed(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

function formatComponents(components = {}) {
  return Object.entries(components)
    .map(([key, value]) => `${key}: ${signed(value)}`)
    .join(" | ");
}

function formatRecommendationDiagnostic(recommendation) {
  const d = recommendation?.diagnostic;
  if (!d) return "No diagnostic available.";

  if (d.side === "offense") {
    const game = d.thisGame || {};
    const context = d.sameSituation || {};
    const last = game.lastResult;
    return [
      `${d.playName || d.playId}`,
      `THIS GAME: ${game.attempts || 0} calls | success ${pct(game.situationalSuccessRate)} | avg ${num(game.avgYards)} yds | negative ${pct(game.negativePlayRate)}`,
      `SAME SITUATION: ${context.attempts || 0} calls | success ${pct(context.situationalSuccessRate)} | avg ${num(context.avgYards)} yds`,
      last ? `LAST: ${last.yards >= 0 ? "+" : ""}${last.yards} yds${last.turnover ? " | TURNOVER" : ""}${last.sack ? " | SACK" : ""}` : "LAST: n/a",
      `PERFORMANCE: ${formatComponents(d.performanceComponents)}`,
      `TOTAL: ${formatComponents(d.totalComponents)}`,
      `FINAL SCORE: ${signed(recommendation.score)}`
    ].join("\n");
  }

  const pair = d.exactMatchup || {};
  const context = d.sameSituationMatchup || {};
  const family = d.familyMatchup || {};
  const familyContext = d.familySituationMatchup || {};
  const offense = d.exactOffense || {};
  const familyLabel = `${d.offenseFamily || "unknown offense family"} vs ${d.defenseFamily || "unknown defense family"}`;
  return [
    `${d.playName || d.playId} vs ${offense.name || offense.id || "unknown offense"}`,
    `EXACT MATCHUP: ${pair.attempts || 0} snaps | defensive win ${pct(pair.defensiveSuccessRate)} | ${num(pair.avgYards)} yds/play | explosives ${pct(pair.explosiveAllowedRate)}`,
    `EXACT / SAME SITUATION: ${context.attempts || 0} snaps | defensive win ${pct(context.defensiveSuccessRate)} | ${num(context.avgYards)} yds/play`,
    `FAMILY (${familyLabel}): ${family.attempts || 0} snaps | defensive win ${pct(family.defensiveSuccessRate)} | ${num(family.avgYards)} yds/play | explosives ${pct(family.explosiveAllowedRate)}`,
    `FAMILY / SAME SITUATION: ${familyContext.attempts || 0} snaps | defensive win ${pct(familyContext.defensiveSuccessRate)} | ${num(familyContext.avgYards)} yds/play`,
    `EVIDENCE WEIGHT: exact ${pct(d.empiricalReliability)} | family ${pct(d.familyReliability)} | bootstrap theory ${pct(d.theoryWeight)}`,
    `TOTAL: ${formatComponents(d.totalComponents)}`,
    `FINAL SCORE: ${signed(recommendation.score)}`
  ].join("\n");
}

module.exports = { formatRecommendationDiagnostic };
