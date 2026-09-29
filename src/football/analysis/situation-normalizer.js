'use strict';

const HASH = Object.freeze({
  LEFT: 'LEFT_HASH',
  RIGHT: 'RIGHT_HASH',
  MIDDLE: 'MIDDLE',
  UNKNOWN: 'UNKNOWN',
});

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function distanceBand(value) {
  const d = finiteOrNull(value);
  if (d == null || d < 1) return 'unknown';
  if (d <= 3) return 'short';
  if (d <= 6) return 'medium';
  if (d <= 10) return 'long';
  return 'extra_long';
}

function yardsToGoal(situation = {}) {
  const direct = finiteOrNull(situation.yardsToGoal);
  if (direct != null) return Math.max(0, Math.min(100, direct));
  const yardLine = finiteOrNull(situation.yardLine);
  if (yardLine == null) return null;
  return Math.max(0, Math.min(100, 100 - yardLine));
}

function normalizeHash(value, fieldY = null) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'left' || raw === 'left_hash' || raw === 'lefthash') return HASH.LEFT;
  if (raw === 'right' || raw === 'right_hash' || raw === 'righthash') return HASH.RIGHT;
  if (raw === 'middle' || raw === 'center' || raw === 'centre') return HASH.MIDDLE;

  const y = finiteOrNull(fieldY);
  if (y == null) return HASH.UNKNOWN;
  if (y < -1) return HASH.LEFT;
  if (y > 1) return HASH.RIGHT;
  return HASH.MIDDLE;
}

function offenseDirection(situation = {}) {
  const direct = finiteOrNull(situation.offenseDirection);
  if (direct != null && Math.abs(direct) >= 0.01) return Math.sign(direct);
  const fieldX = finiteOrNull(situation.fieldX);
  const lineToGain = finiteOrNull(situation.lineToGain);
  if (fieldX == null || lineToGain == null || Math.abs(lineToGain - fieldX) < 0.01) return null;
  return Math.sign(lineToGain - fieldX);
}

function invertSide(side) {
  if (side === 'LEFT') return 'RIGHT';
  if (side === 'RIGHT') return 'LEFT';
  return side;
}

function relativeSide(physicalSide, direction) {
  if (!physicalSide || physicalSide === 'MIDDLE' || direction == null) return physicalSide || null;
  return direction < 0 ? invertSide(physicalSide) : physicalSide;
}

function fieldBoundaryGeometry(situation = {}) {
  const hash = normalizeHash(situation.hash, situation.fieldY);
  const direction = offenseDirection(situation);
  if (hash === HASH.MIDDLE) {
    return {
      hash,
      offenseDirection: direction,
      fieldSidePhysical: 'BOTH',
      boundarySidePhysical: 'BOTH',
      fieldSide: 'BOTH',
      boundarySide: 'BOTH',
      provenance: situation.hash && String(situation.hash).toLowerCase() !== 'unknown'
        ? 'LOCAL_OBSERVED'
        : (finiteOrNull(situation.fieldY) != null ? 'DERIVED' : 'HEURISTIC'),
    };
  }
  if (hash === HASH.UNKNOWN) {
    return {
      hash,
      offenseDirection: direction,
      fieldSidePhysical: null,
      boundarySidePhysical: null,
      fieldSide: null,
      boundarySide: null,
      provenance: null,
    };
  }

  const boundaryPhysical = hash === HASH.LEFT ? 'LEFT' : 'RIGHT';
  const fieldPhysical = invertSide(boundaryPhysical);
  return {
    hash,
    offenseDirection: direction,
    fieldSidePhysical: fieldPhysical,
    boundarySidePhysical: boundaryPhysical,
    fieldSide: relativeSide(fieldPhysical, direction),
    boundarySide: relativeSide(boundaryPhysical, direction),
    provenance: situation.hash && String(situation.hash).toLowerCase() !== 'unknown'
      ? 'LOCAL_OBSERVED'
      : 'DERIVED',
  };
}

function normalizeSituation(situation = {}) {
  const down = finiteOrNull(situation.down);
  const ytg = finiteOrNull(situation.yardsToGo ?? situation.distance);
  const toGoal = yardsToGoal(situation);
  const geometry = fieldBoundaryGeometry(situation);
  return {
    ...situation,
    down,
    yardsToGo: ytg,
    distance: ytg,
    distanceBand: distanceBand(ytg),
    yardsToGoal: toGoal,
    fieldZone: toGoal == null ? 'unknown'
      : toGoal <= 10 ? 'goal_to_go_area'
      : toGoal <= 20 ? 'red_zone'
      : toGoal >= 90 ? 'backed_up'
      : toGoal <= 50 ? 'plus_territory'
      : 'open_field',
    hash: geometry.hash,
    fieldSide: geometry.fieldSide,
    boundarySide: geometry.boundarySide,
    hashGeometry: geometry,
  };
}

module.exports = {
  HASH,
  finiteOrNull,
  distanceBand,
  yardsToGoal,
  normalizeHash,
  offenseDirection,
  fieldBoundaryGeometry,
  normalizeSituation,
};
