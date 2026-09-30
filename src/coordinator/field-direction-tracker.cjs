'use strict';

// Offense direction of travel along fieldX, from verified telemetry only.
//
// Live `lineToGain` is a placeholder (fieldX + distance), so its sign carries
// no information. Two sources are trusted instead:
//   1. a lineToGain value verified by the Lua position-block self-check
//      (lineToGainSource === 'POSITION_BLOCK_VERIFIED');
//   2. down/distance progression: on a same-possession snap that does not
//      reset the down, yards gained = start.distance - next.distance, so
//      sign(deltaFieldX / deltaDistance) is the direction. A first down
//      gained by a real advance (deltaFieldX >= start.distance) also proves it.
//
// Direction is kept per (quarter, possession). The tracker also learns the
// coordinate FRAME once evidence allows it:
//   OFFENSE_RELATIVE  every offense moves toward +x (both possessions agree)
//   PHYSICAL          possessions move in opposite directions and the ends
//                     swap between Q1/Q2 and Q3/Q4
// and then predicts unobserved (quarter, possession) keys from the frame.
// Anything else stays unknown.

const SOURCE = Object.freeze({
  VERIFIED_LINE_TO_GAIN: 'VERIFIED_LINE_TO_GAIN',
  DOWN_DISTANCE: 'DOWN_DISTANCE',
  FRAME_OFFENSE_RELATIVE: 'FRAME_OFFENSE_RELATIVE',
  FRAME_PHYSICAL: 'FRAME_PHYSICAL',
  UNKNOWN: 'UNKNOWN',
});

const FRAME = Object.freeze({ UNKNOWN: 'UNKNOWN', OFFENSE_RELATIVE: 'OFFENSE_RELATIVE', PHYSICAL: 'PHYSICAL' });

function finite(value) {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? n : null;
}

function key(quarter, possession) {
  return `${quarter}|${possession}`;
}

// Quarters that share a half (teams swap ends between them).
function pairedQuarter(quarter) {
  if (quarter === 1) return 2;
  if (quarter === 2) return 1;
  if (quarter === 3) return 4;
  if (quarter === 4) return 3;
  return null;
}

function verifiedLineToGainDirection(state = {}) {
  if (state.lineToGainSource !== 'POSITION_BLOCK_VERIFIED') return null;
  const delta = finite(state.lineToGain) - finite(state.fieldX);
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.25) return null;
  return Math.sign(delta);
}

// Direction evidence from one completed transition, or null.
function directionFromTransition(start = {}, next = {}) {
  if (start.possession == null || start.possession !== next.possession) return null;
  if (start.quarter !== next.quarter) return null;
  const dx = finite(next.fieldX) - finite(start.fieldX);
  if (!Number.isFinite(dx) || Math.abs(dx) < 1) return null;
  const startDown = finite(start.down);
  const nextDown = finite(next.down);
  const startDistance = finite(start.distance);
  const nextDistance = finite(next.distance);
  if (startDown == null || nextDown == null || startDistance == null || nextDistance == null) return null;

  if (nextDown === startDown + 1) {
    const gained = startDistance - nextDistance;
    if (Math.abs(gained) < 1) return null;
    // |dx| must match the distance change; otherwise this is not one clean snap.
    if (Math.abs(Math.abs(dx) - Math.abs(gained)) > 1.5) return null;
    return Math.sign(dx / gained);
  }
  if (nextDown === 1 && startDown >= 1 && Math.abs(dx) >= startDistance - 0.5 && startDistance > 0) {
    // A first down reached by advancing at least the line to gain.
    return Math.sign(dx);
  }
  return null;
}

class FieldDirectionTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.observed = new Map(); // key -> { direction, votes, conflicts }
    this.frame = FRAME.UNKNOWN;
  }

  observeTransition(start, next) {
    const direction = directionFromTransition(start, next);
    if (direction == null) return null;
    const k = key(start.quarter, start.possession);
    const row = this.observed.get(k) || { direction, votes: 0, conflicts: 0 };
    if (row.direction === direction) row.votes += 1;
    else {
      row.conflicts += 1;
      if (row.conflicts > row.votes) { row.direction = direction; row.votes = row.conflicts; row.conflicts = 0; }
    }
    this.observed.set(k, row);
    this._inferFrame();
    return direction;
  }

  _inferFrame() {
    let relative = 0;
    let physical = 0;
    const rows = [...this.observed.entries()].map(([k, row]) => {
      const [quarter, possession] = k.split('|').map(Number);
      return { quarter, possession, direction: row.direction };
    });
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i];
        const b = rows[j];
        const sameQuarterOtherSide = a.quarter === b.quarter && a.possession !== b.possession;
        const pairedSameSide = a.possession === b.possession && pairedQuarter(a.quarter) === b.quarter;
        if (!sameQuarterOtherSide && !pairedSameSide) continue;
        if (a.direction === b.direction) relative += 1;
        else physical += 1;
      }
    }
    if (relative && !physical) this.frame = FRAME.OFFENSE_RELATIVE;
    else if (physical && !relative) this.frame = FRAME.PHYSICAL;
    else this.frame = FRAME.UNKNOWN;
  }

  direction(state = {}) {
    const verified = verifiedLineToGainDirection(state);
    if (verified != null) return { direction: verified, source: SOURCE.VERIFIED_LINE_TO_GAIN, frame: this.frame };
    const quarter = finite(state.quarter);
    const possession = finite(state.possession);
    if (quarter == null || possession == null) return { direction: null, source: SOURCE.UNKNOWN, frame: this.frame };
    const own = this.observed.get(key(quarter, possession));
    if (own) return { direction: own.direction, source: SOURCE.DOWN_DISTANCE, frame: this.frame };
    if (this.frame === FRAME.OFFENSE_RELATIVE) return { direction: 1, source: SOURCE.FRAME_OFFENSE_RELATIVE, frame: this.frame };
    if (this.frame === FRAME.PHYSICAL) {
      const other = this.observed.get(key(quarter, possession === 0 ? 1 : 0));
      if (other) return { direction: -other.direction, source: SOURCE.FRAME_PHYSICAL, frame: this.frame };
      const paired = pairedQuarter(quarter);
      const sameSidePaired = paired != null ? this.observed.get(key(paired, possession)) : null;
      if (sameSidePaired) return { direction: -sameSidePaired.direction, source: SOURCE.FRAME_PHYSICAL, frame: this.frame };
    }
    return { direction: null, source: SOURCE.UNKNOWN, frame: this.frame };
  }
}

// Yards to the opponent goal from fieldX (yards from midfield) and a known
// direction of travel; null when direction is unknown (never mirrored).
function yardsToGoalFromDirection(fieldX, direction) {
  const x = finite(fieldX);
  if (x == null || (direction !== 1 && direction !== -1)) return null;
  return Math.max(0, Math.min(100, 50 - x * direction));
}

module.exports = {
  SOURCE,
  FRAME,
  FieldDirectionTracker,
  directionFromTransition,
  verifiedLineToGainDirection,
  yardsToGoalFromDirection,
  pairedQuarter,
};
