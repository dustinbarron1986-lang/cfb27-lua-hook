const { strategicPlayScore } = require("../gameplan/strategic-context");
const { normalizeSituation } = require("../analysis/situation-normalizer");
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function hasConcept(play, ...names) {
  const concepts = new Set((play.concepts || []).map(x => String(x).toLowerCase()));
  return names.some(name => concepts.has(String(name).toLowerCase()));
}

function isPass(play) { return String(play.type || "").toUpperCase() === "PASS"; }
function isRun(play) { return String(play.type || "").toUpperCase() === "RUN"; }

function scoreSituation(play, situation = {}) {
  const normalized = normalizeSituation(situation);
  const down = Number(normalized.down || 0);
  const distance = Number(normalized.yardsToGo || 0);
  const yardLine = Number.isFinite(Number(normalized.yardLine)) ? Number(normalized.yardLine) : null;
  const yardsToGoal = normalized.yardsToGoal;
  const quarter = Number(normalized.quarter || 0);
  const clock = Number.isFinite(Number(normalized.clockSeconds)) ? Number(normalized.clockSeconds) : null;
  const scoreDiff = normalized.scoreDifferential == null
    ? null
    : (Number.isFinite(Number(normalized.scoreDifferential)) ? Number(normalized.scoreDifferential) : null);
  const flags = normalized.flags || {};

  let score = 0;
  const reasons = [];

  // Mandatory conversion logic stays here; generic run/pass effectiveness lives
  // in EmpiricalPrior instead of hand-authored situation beliefs.
  if ((down === 3 || down === 4) && distance > 0) {
    if (distance <= 3 && hasConcept(play, "vertical", "deep_shot", "slow_developing")) {
      score -= 0.9; reasons.push("slow/deep design carries extra conversion risk in short yardage");
    }
    if (distance >= 7) {
      const canReachSticks = hasConcept(play, "mesh", "crossers", "levels", "flood", "stick", "quick_intermediate", "draw", "screen");
      if (isRun(play) && !canReachSticks) {
        score -= 1.25; reasons.push("ordinary run lacks credible line-to-gain structure on a mandatory long conversion");
      }
    }
  }

  // Field position.
  if (yardLine != null || yardsToGoal != null) {
    // yardLine alone is ambiguous (the marker number is the same at both
    // ends), so "backed up" requires a direction-aware yards-to-goal.
    if (yardsToGoal != null && yardsToGoal >= 90) {
      if (hasConcept(play, "deep_drop", "slow_developing")) {
        score -= 1.5; reasons.push("backed-up field position increases sack/safety cost");
      }
      if (isRun(play) || hasConcept(play, "quick_game", "screen")) {
        score += 0.7; reasons.push("safer backed-up call");
      }
    }

    if (yardsToGoal != null && yardsToGoal <= 20) {
      if (hasConcept(play, "vertical", "deep_shot")) {
        score -= 0.7; reasons.push("compressed red-zone space reduces pure vertical value");
      }
      if (hasConcept(play, "mesh", "rub", "pick", "slant", "fade", "power", "duo", "qb_run")) {
        score += 0.8; reasons.push("concept translates well to compressed red-zone space");
      }
    }
  }

  // Score/clock strategy has one owner per fact (no stacked votes):
  //   leading late  -> strategicPlayScore (graded four-minute strength, below)
  //   trailing late -> drive objective fit (TWO_MINUTE / QUICK_SCORE)
  // Only the late-clock sack/clock cost of slow development stays here.
  const late = quarter >= 4 && clock != null && clock <= 360;
  if (late && scoreDiff < 0 && hasConcept(play, "slow_developing") && clock <= 120) {
    score -= 0.8; reasons.push("slow development carries extra late-game clock/sack cost");
  }

  const strategic = strategicPlayScore(play, situation);
  if (strategic.score) {
    score += strategic.score * 1.25;
    reasons.push(...strategic.reasons);
  }

  // Conservative turnover/risk proxy from tags.
  let risk = 0;
  if (hasConcept(play, "deep_shot", "vertical", "slow_developing", "high_variance")) risk += 1;
  if (hasConcept(play, "quick_game", "screen", "interior_run", "duo")) risk -= 0.5;

  return {
    score: clamp(score, -5, 5),
    risk,
    reasons
  };
}

module.exports = { scoreSituation };
