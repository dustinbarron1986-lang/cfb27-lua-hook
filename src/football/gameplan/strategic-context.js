'use strict';

const { classifyOffensiveStructure, normalize } = require('../analysis/structural-threat-model');

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function describeRisk(play = {}) {
  const structure = play.structural || classifyOffensiveStructure(play, play.authoritativeStructure || null);
  const threats = new Set(structure?.threatKeys || []);
  const modifiers = new Set(structure?.modifierKeys || []);
  const type = String(play.type || play.playKind || '').toUpperCase();
  const text = normalize([play.name, ...(play.concepts || [])].join(' '));
  const runLike = type === 'RUN' || type === 'RPO' || type === 'OPTION' ||
    threats.has('interior_run') || threats.has('gap_run') || threats.has('perimeter_run') || threats.has('qb_run_option');
  const passLike = type === 'PASS' || type === 'SCREEN';
  const shot = threats.has('vertical') || /deep shot|shot|four verts|vertical/.test(text);
  const slow = shot || /slow developing|deep drop/.test(text);
  const possessionPass = passLike && !shot && (
    threats.has('quick_horizontal') || threats.has('crossing') || threats.has('screen') || threats.has('intermediate_middle')
  );
  return { runLike, passLike, shot, slow, possessionPass, structure };
}

function fourMinuteStrength(situation = {}) {
  const q = finite(situation.quarter);
  const clock = finite(situation.clockSeconds);
  const diff = finite(situation.scoreDifferential);
  const uncertainPhase = situation.quarterConfidence === 'LOW' ||
    (situation.quarterEvidenceConflict === true && situation.quarterConfidence !== 'HIGH');
  if (uncertainPhase) return 0;
  if (q == null || q < 4 || clock == null || diff == null || diff <= 0) return 0;
  // Begins gently outside four minutes and ramps hard with lead size/time.
  const time = clock <= 240 ? 1 : clock <= 360 ? 0.78 : clock <= 720 ? 0.18 : 0;
  const lead = diff >= 14 ? 1 : diff >= 8 ? 0.72 : diff >= 4 ? 0.45 : 0.25;
  return Math.max(0, Math.min(1, time * lead));
}

function strategicPlayScore(play, situation = {}) {
  const strength = fourMinuteStrength(situation);
  if (!(strength > 0)) return { score: 0, strength: 0, reasons: [], risk: describeRisk(play) };
  const risk = describeRisk(play);
  let score = 0;
  const reasons = [];
  if (risk.runLike) { score += 1.35 * strength; reasons.push('clock-positive run/run-capable structure fits protect-the-lead mode'); }
  if (risk.possessionPass) { score += 0.45 * strength; reasons.push('possession-oriented pass remains compatible with clock/first-down goals'); }
  if (risk.shot) { score -= 1.35 * strength; reasons.push('unnecessary vertical/high-variance exposure is reduced while protecting the lead'); }
  if (risk.slow) { score -= 0.55 * strength; reasons.push('slow development adds avoidable sack/clock risk while protecting the lead'); }

  const down = finite(situation.down);
  const distance = finite(situation.distance);
  if ((down === 3 || down === 4) && distance != null && distance >= 6 && risk.passLike) {
    score += 0.9 * strength;
    reasons.push('money-down conversion need preserves appropriate passing freedom');
  }
  return { score, strength, reasons, risk };
}

function oracleStrategicDecision({ currentPlay, replacementPlay, situation, tacticalDelta, currentStructurallyValid = true } = {}) {
  const current = strategicPlayScore(currentPlay, situation);
  const replacement = strategicPlayScore(replacementPlay, situation);
  const strength = Math.max(current.strength, replacement.strength);
  if (!(strength > 0)) return { allow: true, thresholdAdjustment: 0, reason: null, current, replacement };

  // Strategic envelope does not save a structurally invalid/disastrous call.
  if (!currentStructurallyValid) {
    return {
      allow: true,
      thresholdAdjustment: 0,
      reason: 'Current call is structurally invalid; conversion/tactical survival outweighs clock preference.',
      current,
      replacement,
    };
  }

  const strategicGap = current.score - replacement.score;
  const requiredDelta = Math.max(0, strategicGap * 1.15);
  const delta = Number(tacticalDelta);
  if (strategicGap > 0.35 && Number.isFinite(delta) && delta < requiredDelta) {
    return {
      allow: false,
      thresholdAdjustment: requiredDelta,
      reason: 'KEEP RUN/SAFE CALL: protect-the-lead value outweighs the modest tactical gain from the pass audible.',
      current,
      replacement,
    };
  }
  return {
    allow: true,
    thresholdAdjustment: requiredDelta,
    reason: strategicGap > 0.35
      ? 'Tactical advantage is large enough to justify leaving the clock-positive strategic envelope.'
      : null,
    current,
    replacement,
  };
}

module.exports = { describeRisk, fourMinuteStrength, strategicPlayScore, oracleStrategicDecision };
