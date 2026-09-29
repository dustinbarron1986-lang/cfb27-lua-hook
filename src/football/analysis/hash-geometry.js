'use strict';

const { fieldBoundaryGeometry } = require('./situation-normalizer');
const { buildOffensiveProfile } = require('./offensive-profile');

function normalizeSide(value) {
  const text = String(value || '').trim().toUpperCase();
  if (/(^|_)LEFT($|_)/.test(text) || text === 'L') return 'LEFT';
  if (/(^|_)RIGHT($|_)/.test(text) || text === 'R') return 'RIGHT';
  return null;
}

function resolvePlayOrientation(play = {}, authoritative = null) {
  const explicit = normalizeSide(play.orientationSide || play.runDirection || play.direction || play.side);
  if (explicit) return { side: explicit, confidence: 'HIGH', provenance: play.orientationProvenance || 'LOCAL_OBSERVED' };

  const authored = authoritative?.play || {};
  const authoredSide = normalizeSide(authored.orientationSide || authored.runDirection || authored.direction || authored.side);
  if (authoredSide) return { side: authoredSide, confidence: 'HIGH', provenance: 'EA_AUTHORED' };

  return { side: null, confidence: 'UNKNOWN', provenance: null };
}

function mirrorability(play = {}, authoritative = null) {
  const authored = authoritative?.play || {};
  if (authored.allowFlip === true || authored.mirrorable === true || authored.canFlip === true) {
    return { mirrorable: true, confidence: 'HIGH', provenance: 'EA_AUTHORED' };
  }
  if (play.mirrorable === true || play.canFlip === true || play.allowFlip === true) {
    return { mirrorable: true, confidence: 'MEDIUM', provenance: play.mirrorProvenance || 'DERIVED' };
  }

  // Flipped formation coordinates prove only that the SET can be mirrored.
  // They do not prove that this specific play's assignments transform safely.
  const positions = authoritative?.set?.positions || [];
  const hasMirroredSetGeometry = positions.length > 0 &&
    positions.some(row => row.flippedX != null || row.flippedY != null || row.flipIndex != null);
  return {
    mirrorable: false,
    confidence: hasMirroredSetGeometry ? 'LOW' : 'UNKNOWN',
    provenance: hasMirroredSetGeometry ? 'DERIVED' : null,
    reason: hasMirroredSetGeometry
      ? 'EA set geometry has mirrored coordinates, but play-level assignment mirroring is not proven.'
      : 'No authoritative play-level mirror evidence is available.',
  };
}

function needsWideSpace(profile = {}) {
  const stress = new Set(profile.fieldStress || []);
  return profile.runFamily === 'perimeter' ||
    profile.playMechanism === 'screen' ||
    stress.has('horizontal') ||
    stress.has('intermediate_outside') ||
    stress.has('deep_outside');
}

function hashGeometryScore(play = {}, situation = {}, authoritative = null) {
  const geometry = fieldBoundaryGeometry(situation);
  const profile = play.normalizedProfile || buildOffensiveProfile(play, authoritative);
  const orientation = resolvePlayOrientation(play, authoritative);
  if (!geometry.fieldSide || geometry.fieldSide === 'BOTH' || !orientation.side) {
    return {
      score: 0,
      geometry,
      profile,
      orientation,
      available: false,
      reason: geometry.hash === 'UNKNOWN'
        ? 'Verified live hash is unavailable.'
        : 'Play orientation is not established strongly enough to apply field/boundary geometry.',
      provenance: null,
    };
  }

  if (!needsWideSpace(profile)) {
    return {
      score: 0,
      geometry,
      profile,
      orientation,
      available: true,
      reason: 'Current concept does not require a generic wide-side preference.',
      provenance: 'DERIVED',
    };
  }

  const towardField = orientation.side === geometry.fieldSide;
  return {
    score: towardField ? 0.45 : 0,
    geometry,
    profile,
    orientation,
    available: true,
    reason: towardField
      ? 'Known play orientation expresses a width-sensitive concept toward the field side.'
      : 'Width-sensitive concept is not currently oriented toward the field; boundary is not automatically penalized.',
    provenance: 'DERIVED',
  };
}

function flipRecommendation(play = {}, situation = {}, authoritative = null) {
  const current = hashGeometryScore(play, situation, authoritative);
  const mirror = mirrorability(play, authoritative);
  if (!mirror.mirrorable || !current.available || !current.orientation.side ||
      !current.geometry.fieldSide || current.geometry.fieldSide === 'BOTH') {
    return { recommend: false, current, mirror, reason: mirror.reason || current.reason };
  }

  const currentTowardField = current.orientation.side === current.geometry.fieldSide;
  if (currentTowardField || !needsWideSpace(current.profile)) {
    return { recommend: false, current, mirror, reason: currentTowardField ? 'Current orientation already points toward the field side.' : 'No meaningful field-side geometry gain is established.' };
  }

  return {
    recommend: true,
    targetSide: current.geometry.fieldSide,
    current,
    mirror,
    gain: 0.45,
    confidence: mirror.confidence === 'HIGH' ? 'HIGH' : 'MEDIUM',
    provenance: mirror.provenance === 'EA_AUTHORED' ? 'EA_AUTHORED' : 'DERIVED',
    reason: 'The called concept remains sound, but a supported mirror would put its width-sensitive action toward the field side.',
  };
}

module.exports = {
  normalizeSide,
  resolvePlayOrientation,
  mirrorability,
  needsWideSpace,
  hashGeometryScore,
  flipRecommendation,
};
