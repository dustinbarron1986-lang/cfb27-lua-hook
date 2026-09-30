'use strict';

const { normalizeSituation } = require('../analysis/situation-normalizer');

const OBJECTIVE = Object.freeze({
  BALANCED: 'BALANCED',
  CONTROL: 'CONTROL',
  AGGRESSIVE: 'AGGRESSIVE',
  QUICK_SCORE: 'QUICK_SCORE',
  TWO_MINUTE: 'TWO_MINUTE',
  FOUR_MINUTE: 'FOUR_MINUTE',
  PROTECT_POSSESSION: 'PROTECT_POSSESSION',
});

function resolveObjective(situation = {}) {
  const s = normalizeSituation(situation);
  const score = Number.isFinite(Number(s.scoreDifferential)) ? Number(s.scoreDifferential) : 0;
  const quarter = Number(s.quarter || 0);
  const clock = Number.isFinite(Number(s.clockSeconds)) ? Number(s.clockSeconds) : null;
  const flags = s.flags || {};
  const uncertainPhase = s.quarterConfidence === 'LOW' ||
    (s.quarterEvidenceConflict === true && s.quarterConfidence !== 'HIGH');
  if (uncertainPhase) {
    return {
      objective: OBJECTIVE.BALANCED,
      reason: 'Quarter provenance is uncertain, so the coordinator stays BALANCED instead of inferring a late-game objective.',
      phaseConfidence: s.quarterConfidence || 'LOW',
    };
  }

  if (flags.fourMinute) {
    return { objective: OBJECTIVE.FOUR_MINUTE, reason: 'Late lead creates a four-minute possession objective.' };
  }
  if (flags.twoMinute && score < 0) {
    return { objective: OBJECTIVE.TWO_MINUTE, reason: 'Two-minute trailing context prioritizes efficient clock-aware scoring.' };
  }
  if (quarter >= 4 && clock != null && clock <= 360 && score <= -8) {
    return { objective: OBJECTIVE.QUICK_SCORE, reason: 'Late multi-score deficit requires a faster scoring posture.' };
  }
  if (quarter >= 4 && score > 0) {
    return { objective: OBJECTIVE.PROTECT_POSSESSION, reason: 'Late lead prioritizes possession quality and turnover avoidance.' };
  }
  if (score <= -10 && quarter >= 3) {
    return { objective: OBJECTIVE.AGGRESSIVE, reason: 'Material second-half deficit increases the value of explosive scoring opportunities.' };
  }
  if (score >= 10 && quarter >= 3) {
    return { objective: OBJECTIVE.CONTROL, reason: 'Material second-half lead favors efficient possession control.' };
  }
  return { objective: OBJECTIVE.BALANCED, reason: 'Normal game state supports balanced sequence building.' };
}

function objectiveMateriallyChanged(previous = {}, next = {}) {
  if (!previous || !Object.keys(previous).length) return true;
  if (previous.possession != null && next.possession != null &&
      Number(previous.possession) !== Number(next.possession)) return true;
  return resolveObjective(previous).objective !== resolveObjective(next).objective;
}

class DriveObjectiveTracker {
  constructor() {
    this.current = null;
    this.lastObservedPossession = null;
    this.driveSerial = 0;
  }

  observe(situation = {}) {
    const possession = situation?.possession;
    if (possession != null && this.lastObservedPossession != null &&
        Number(possession) !== Number(this.lastObservedPossession)) {
      this.current = null;
      this.driveSerial += 1;
    }
    if (possession != null) this.lastObservedPossession = possession;
  }

  get(situation = {}) {
    this.observe(situation);
    const resolved = resolveObjective(situation);
    if (!this.current || objectiveMateriallyChanged(this.current.situation, situation)) {
      this.current = {
        ...resolved,
        driveSerial: this.driveSerial,
        situation: { ...situation },
        changed: true,
      };
    } else {
      this.current = {
        ...this.current,
        changed: false,
        situation: { ...situation },
      };
    }
    return {
      objective: this.current.objective,
      reason: this.current.reason,
      driveSerial: this.current.driveSerial,
      changed: this.current.changed,
      provenance: 'DERIVED',
    };
  }
}

function objectiveFit(profile = {}, objective = OBJECTIVE.BALANCED) {
  const mechanism = profile.playMechanism;
  const decision = profile.decisionClass;
  const stress = new Set(profile.fieldStress || []);
  let score = 0;
  const reasons = [];

  if (objective === OBJECTIVE.FOUR_MINUTE || objective === OBJECTIVE.PROTECT_POSSESSION || objective === OBJECTIVE.CONTROL) {
    if (decision === 'run' || decision === 'hybrid') score += 0.55;
    if (mechanism === 'screen' || stress.has('short_outside') || stress.has('short_middle')) score += 0.20;
    if (stress.has('deep_middle') || stress.has('deep_outside')) score -= 0.30;
    reasons.push('Drive objective favors efficient possession-preserving structure.');
  } else if ([OBJECTIVE.TWO_MINUTE, OBJECTIVE.QUICK_SCORE, OBJECTIVE.AGGRESSIVE].includes(objective)) {
    if (stress.has('intermediate_outside') || stress.has('intermediate_middle')) score += 0.35;
    if (stress.has('deep_middle') || stress.has('deep_outside') || stress.has('vertical')) score += 0.45;
    if (stress.has('sideline')) score += 0.25;
    if (decision === 'run' && mechanism !== 'designed_qb_run') score -= 0.20;
    reasons.push('Drive objective increases value of clock-aware intermediate/explosive stress.');
  }

  return { score, reasons, objective };
}

module.exports = { OBJECTIVE, resolveObjective, objectiveMateriallyChanged, DriveObjectiveTracker, objectiveFit };
