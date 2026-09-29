const { strategicPlayScore } = require("../gameplan/strategic-context");
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
  const down = Number(situation.down || 0);
  const distance = Number(situation.distance || 0);
  const yardLine = Number.isFinite(Number(situation.yardLine)) ? Number(situation.yardLine) : null;
  const quarter = Number(situation.quarter || 0);
  const clock = Number.isFinite(Number(situation.clockSeconds)) ? Number(situation.clockSeconds) : null;
  const scoreDiff = situation.scoreDifferential == null
    ? null
    : (Number.isFinite(Number(situation.scoreDifferential)) ? Number(situation.scoreDifferential) : null);
  const flags = situation.flags || {};

  let score = 0;
  const reasons = [];

  // Down/distance: not a coverage matchup; simply whether the call fits the job.
  if ((down === 3 || down === 4) && distance > 0) {
    if (distance <= 2) {
      if (isRun(play) || hasConcept(play, "quick_game", "qb_sneak", "duo", "interior_run")) {
        score += 2.0; reasons.push("fits short-yardage conversion");
      }
      if (hasConcept(play, "vertical", "deep_shot")) {
        score -= 1.5; reasons.push("lower conversion fit on short-yardage money down");
      }
    } else if (distance >= 7) {
      if (isPass(play) && hasConcept(play, "mesh", "crossers", "levels", "flood", "stick", "quick_intermediate")) {
        score += 2.2; reasons.push("concept can reach long-yardage sticks");
      } else if (isRun(play) && !hasConcept(play, "draw", "screen")) {
        score -= 1.6; reasons.push("ordinary run has weak long-yardage conversion fit");
      }
    }
  }

  if (down === 1 && distance >= 9) {
    if (isRun(play)) { score += 0.5; reasons.push("keeps early-down run constraint credible"); }
    if (hasConcept(play, "play_action")) { score += 0.6; reasons.push("play-action has early-down sequencing value"); }
  }

  // 2nd-and-short is a classic opportunity to spend some risk on an explosive attempt.
  if (down === 2 && distance > 0 && distance <= 3) {
    if (hasConcept(play, "deep_shot", "vertical", "play_action", "shot")) {
      score += 2.4; reasons.push("2nd-and-short creates a favorable shot opportunity");
    } else if (isRun(play)) {
      score += 0.8; reasons.push("high-probability conversion keeps the offense on schedule");
    }
  }

  // Field position.
  if (yardLine != null) {
    if (yardLine <= 10) {
      if (hasConcept(play, "deep_drop", "slow_developing")) {
        score -= 1.5; reasons.push("backed-up field position increases sack/safety cost");
      }
      if (isRun(play) || hasConcept(play, "quick_game", "screen")) {
        score += 0.7; reasons.push("safer backed-up call");
      }
    }

    if (yardLine >= 80) {
      if (hasConcept(play, "vertical", "deep_shot")) {
        score -= 0.7; reasons.push("compressed red-zone space reduces pure vertical value");
      }
      if (hasConcept(play, "mesh", "rub", "pick", "slant", "fade", "power", "duo", "qb_run")) {
        score += 0.8; reasons.push("concept translates well to compressed red-zone space");
      }
    }
  }

  // Score/clock strategy.
  const late = quarter >= 4 && clock != null && clock <= 360;
  if (late && scoreDiff < 0) {
    if (isPass(play) || hasConcept(play, "sideline", "no_huddle", "quick_game")) {
      score += 1.1; reasons.push("trailing late favors clock-efficient yardage");
    }
    if (hasConcept(play, "slow_developing") && clock <= 120) {
      score -= 0.8; reasons.push("slow development carries extra late-game clock/sack cost");
    }
  }

  if (late && scoreDiff > 0) {
    if (isRun(play)) {
      score += 1.1; reasons.push("leading late favors clock pressure and lower-variance calls");
    }
    if (hasConcept(play, "deep_shot", "high_variance")) {
      score -= 1.3; reasons.push("unnecessary high variance while protecting a late lead");
    }
  }

  if (flags.fourMinute && isRun(play)) {
    score += 0.8; reasons.push("four-minute context rewards possession and clock pressure");
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
