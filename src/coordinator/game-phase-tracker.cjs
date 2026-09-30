'use strict';

// Quarter authority is deterministic, not a confidence vote:
//
//   1. a valid direct memory quarter (situation root +0x174) IS the quarter;
//   2. a valid GETQUARTER value is used only when memory is absent/invalid;
//   3. clock-wrap derivation is a fallback used only when neither direct
//      source is usable.
//
// Clock-wrap evidence never overrides a direct source. When a direct value
// stays unchanged across a strong wrap, the tracker reports
// `directQuarterStaleSuspect` for diagnostics but still reports the direct
// value; live logs then show the disagreement instead of silently inventing a
// period.

const QUARTER_SOURCE = Object.freeze({
  DIRECT_MEMORY: 'DIRECT_MEMORY',
  AUTHORITATIVE_API: 'AUTHORITATIVE_API',
  DERIVED_CLOCK_WRAP: 'DERIVED_CLOCK_WRAP',
  CARRIED_FORWARD: 'CARRIED_FORWARD',
  UNAVAILABLE: 'UNAVAILABLE',
});

const SCORE_SOURCE = Object.freeze({
  AUTHORITATIVE_API: 'AUTHORITATIVE_API',
  USER_RELATIVE_TELEMETRY: 'USER_RELATIVE_TELEMETRY',
  UNAVAILABLE: 'UNAVAILABLE',
});

function finite(value) {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) ? n : null;
}

function validQuarter(value) {
  const q = finite(value);
  return q != null && q >= 1 && q <= 20 ? Math.trunc(q) : null;
}

function phaseFromQuarter(quarter) {
  const q = validQuarter(quarter);
  if (q == null) return 'UNKNOWN';
  if (q <= 4) return 'Q' + q;
  return 'OT' + (q - 4);
}

function lifecycleForState(state = {}) {
  if (state.gameComplete === true || state.isGameOver === true || state.final === true) return 'FINAL';
  return null;
}

function directMemoryQuarter(raw) {
  // `rawQuarter` is the Lua memory read. `quarter` is only treated as memory
  // when the payload does not carry the explicit memory field (older fixtures
  // and adapters).
  if (raw.rawQuarter !== undefined) return validQuarter(raw.rawQuarter);
  if (raw.memoryQuarter !== undefined) return validQuarter(raw.memoryQuarter);
  return validQuarter(raw.quarter);
}

class GamePhaseTracker {
  constructor(options = {}) {
    this.minWrapLowSeconds = Number(options.minWrapLowSeconds || 20);
    this.wrapHighFraction = Number(options.wrapHighFraction || 0.72);
    this.reset();
  }

  reset() {
    this.resolvedQuarter = null;
    this.quarterSource = QUARTER_SOURCE.UNAVAILABLE;
    this.quarterConfidence = 'LOW';
    this.previousClock = null;
    // Highest clock value observed in the current period BEFORE the current
    // sample. A wrap requires that the clock was actually seen running down
    // from this value; a startup/uninitialized 0:00 sample establishes nothing.
    this.periodHighWater = null;
    this.phase = 'UNKNOWN';
    this.finalEmitted = false;
  }

  _isStrongClockWrap(previousClock, nextClock) {
    if (previousClock == null || nextClock == null) return false;
    const highWater = Number(this.periodHighWater);
    if (!(highWater > 0)) return false;
    const lowThreshold = Math.max(this.minWrapLowSeconds, highWater * 0.08);
    // The period must have been observed well above the low threshold before
    // the low sample; otherwise the "low" sample is not an end-of-period event.
    if (highWater <= lowThreshold) return false;
    const highThreshold = highWater * this.wrapHighFraction;
    const largeJump = nextClock - previousClock >= Math.max(45, highWater * 0.45);
    return previousClock <= lowThreshold && nextClock >= highThreshold && largeJump;
  }

  _apply(quarter, source, confidence) {
    this.resolvedQuarter = validQuarter(quarter);
    this.quarterSource = source;
    this.quarterConfidence = confidence;
  }

  resolve(raw = {}) {
    const memoryQuarter = directMemoryQuarter(raw);
    const apiQuarter = validQuarter(raw.apiQuarter ?? raw.authoritativeQuarter);
    const clock = finite(raw.apiGameClockSeconds) ?? finite(raw.gameClockSeconds);
    const priorQuarter = this.resolvedQuarter;
    const wrap = this._isStrongClockWrap(this.previousClock, clock);

    if (memoryQuarter != null) {
      this._apply(memoryQuarter, QUARTER_SOURCE.DIRECT_MEMORY, 'HIGH');
    } else if (apiQuarter != null) {
      this._apply(apiQuarter, QUARTER_SOURCE.AUTHORITATIVE_API, 'HIGH');
    } else if (wrap && priorQuarter != null) {
      this._apply(priorQuarter + 1, QUARTER_SOURCE.DERIVED_CLOCK_WRAP, 'MEDIUM');
    } else if (priorQuarter != null) {
      const carriedSource = this.quarterSource === QUARTER_SOURCE.DERIVED_CLOCK_WRAP
        ? QUARTER_SOURCE.DERIVED_CLOCK_WRAP
        : QUARTER_SOURCE.CARRIED_FORWARD;
      this._apply(priorQuarter, carriedSource, carriedSource === QUARTER_SOURCE.DERIVED_CLOCK_WRAP ? 'MEDIUM' : 'LOW');
    } else {
      this._apply(null, QUARTER_SOURCE.UNAVAILABLE, 'LOW');
    }

    const directQuarter = memoryQuarter ?? apiQuarter;
    const directQuarterStaleSuspect = wrap && directQuarter != null && priorQuarter != null &&
      directQuarter === priorQuarter;

    // Period high-water bookkeeping: a new period (wrap or direct quarter
    // change) starts a fresh high-water mark at the current clock.
    const periodChanged = wrap || (priorQuarter != null && this.resolvedQuarter !== priorQuarter);
    if (clock != null) {
      if (periodChanged || this.periodHighWater == null || clock > this.periodHighWater) {
        this.periodHighWater = clock;
      }
    }

    const previousPhase = this.phase;
    let phase = phaseFromQuarter(this.resolvedQuarter);
    let lifecycle = lifecycleForState(raw);

    if (!lifecycle && this.resolvedQuarter === 4 && clock != null && clock <= 1) {
      phase = 'END_REGULATION_PENDING';
      lifecycle = previousPhase !== 'END_REGULATION_PENDING' ? 'END_REGULATION_PENDING' : null;
    }

    if (!lifecycle && this.resolvedQuarter === 3 && previousPhase === 'Q2') lifecycle = 'HALFTIME';

    if (lifecycle === 'FINAL') {
      phase = 'FINAL';
      if (this.finalEmitted) lifecycle = null;
      else this.finalEmitted = true;
    }

    this.phase = phase;
    this.previousClock = clock;

    const scoreDifferential = finite(raw.scoreDifferentialApi ?? raw.userScoreDifferential ?? raw.scoreDifferential);
    const scoreDifferentialSource =
      finite(raw.scoreDifferentialApi) != null
        ? SCORE_SOURCE.AUTHORITATIVE_API
        : (finite(raw.userScoreDifferential) != null || finite(raw.scoreDifferential) != null
          ? (raw.scoreDifferentialSource || SCORE_SOURCE.USER_RELATIVE_TELEMETRY)
          : SCORE_SOURCE.UNAVAILABLE);

    // Diagnostic only: GETQUARTER disagreeing with a valid memory quarter does
    // not change the resolved quarter or its confidence.
    const quarterEvidenceConflict = memoryQuarter != null && apiQuarter != null && memoryQuarter !== apiQuarter;
    const state = {
      ...raw,
      rawQuarter: memoryQuarter,
      apiQuarter,
      quarter: this.resolvedQuarter,
      quarterSource: this.quarterSource,
      quarterConfidence: this.quarterConfidence,
      quarterEvidenceConflict,
      gamePhase: phase,
      gameClockSeconds: clock ?? raw.gameClockSeconds,
      scoreDifferential,
      scoreDifferentialSource,
    };

    return {
      state,
      lifecycle,
      previousPhase,
      phase,
      quarter: this.resolvedQuarter,
      memoryQuarter,
      apiQuarter,
      directQuarter,
      quarterSource: this.quarterSource,
      quarterConfidence: this.quarterConfidence,
      quarterEvidenceConflict,
      clockWrapDetected: wrap,
      directQuarterStaleSuspect,
      periodHighWater: this.periodHighWater,
      scoreDifferential,
      scoreDifferentialSource,
    };
  }
}

module.exports = {
  QUARTER_SOURCE,
  SCORE_SOURCE,
  GamePhaseTracker,
  phaseFromQuarter,
};
