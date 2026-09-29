'use strict';

const QUARTER_SOURCE = Object.freeze({
  AUTHORITATIVE_API: 'AUTHORITATIVE_API',
  MEMORY: 'MEMORY',
  DERIVED_CLOCK_WRAP: 'DERIVED_CLOCK_WRAP',
  UNAVAILABLE: 'UNAVAILABLE',
});

const SCORE_SOURCE = Object.freeze({
  AUTHORITATIVE_API: 'AUTHORITATIVE_API',
  USER_RELATIVE_TELEMETRY: 'USER_RELATIVE_TELEMETRY',
  UNAVAILABLE: 'UNAVAILABLE',
});

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
    this.previousMemoryQuarter = null;
    this.periodHighWater = null;
    this.memoryStale = false;
    this.apiStale = false;
    this.lastWrapClock = null;
    this.phase = 'UNKNOWN';
    this.lastLifecycle = null;
    this.finalEmitted = false;
  }

  _isStrongClockWrap(previousClock, nextClock) {
    if (previousClock == null || nextClock == null) return false;
    const highWater = Math.max(Number(this.periodHighWater || 0), nextClock, previousClock);
    if (!(highWater > 0)) return false;
    const lowThreshold = Math.max(this.minWrapLowSeconds, highWater * 0.08);
    const highThreshold = highWater * this.wrapHighFraction;
    const largeJump = nextClock - previousClock >= Math.max(45, highWater * 0.45);
    return previousClock <= lowThreshold && nextClock >= highThreshold && largeJump;
  }

  resolve(raw = {}) {
    const memoryQuarter = validQuarter(raw.rawQuarter ?? raw.memoryQuarter ?? raw.quarter);
    const apiQuarter = validQuarter(raw.apiQuarter ?? raw.authoritativeQuarter);
    const clock = finite(raw.apiGameClockSeconds) ?? finite(raw.gameClockSeconds);

    if (clock != null && (this.periodHighWater == null || clock > this.periodHighWater)) {
      this.periodHighWater = clock;
    }

    const wrap = this._isStrongClockWrap(this.previousClock, clock);

    if (wrap) {
      const base = this.resolvedQuarter ?? apiQuarter ?? memoryQuarter ?? 1;
      const apiAdvanced = apiQuarter != null && apiQuarter > base;
      const memoryAdvanced = memoryQuarter != null && memoryQuarter > base;
      if (apiAdvanced) {
        this.resolvedQuarter = apiQuarter;
        this.quarterSource = QUARTER_SOURCE.AUTHORITATIVE_API;
        this.quarterConfidence = 'HIGH';
        this.apiStale = false;
        this.memoryStale = memoryQuarter != null && memoryQuarter !== apiQuarter;
      } else if (memoryAdvanced) {
        this.resolvedQuarter = memoryQuarter;
        this.quarterSource = QUARTER_SOURCE.MEMORY;
        this.quarterConfidence = 'MEDIUM';
        this.memoryStale = false;
        this.apiStale = apiQuarter != null && apiQuarter < memoryQuarter;
      } else {
        this.resolvedQuarter = Math.max(1, base + 1);
        this.quarterSource = QUARTER_SOURCE.DERIVED_CLOCK_WRAP;
        this.quarterConfidence = 'MEDIUM';
        this.memoryStale = memoryQuarter != null && memoryQuarter < this.resolvedQuarter;
        this.apiStale = apiQuarter != null && apiQuarter < this.resolvedQuarter;
      }
      this.lastWrapClock = clock;
      this.periodHighWater = clock;
    } else if (apiQuarter != null && (!this.apiStale || this.resolvedQuarter == null || apiQuarter >= this.resolvedQuarter)) {
      this.resolvedQuarter = apiQuarter;
      this.quarterSource = QUARTER_SOURCE.AUTHORITATIVE_API;
      this.quarterConfidence = 'HIGH';
      this.apiStale = false;
      this.memoryStale = memoryQuarter != null && memoryQuarter !== apiQuarter;
    } else if (this.resolvedQuarter == null && memoryQuarter != null) {
      this.resolvedQuarter = memoryQuarter;
      this.quarterSource = QUARTER_SOURCE.MEMORY;
      this.quarterConfidence = 'MEDIUM';
    } else if (!this.memoryStale && memoryQuarter != null && (
      this.resolvedQuarter == null || memoryQuarter >= this.resolvedQuarter
    )) {
      this.resolvedQuarter = memoryQuarter;
      this.quarterSource = QUARTER_SOURCE.MEMORY;
      this.quarterConfidence = 'MEDIUM';
    } else if (this.resolvedQuarter == null) {
      this.quarterSource = QUARTER_SOURCE.UNAVAILABLE;
      this.quarterConfidence = 'LOW';
    }

    const previousPhase = this.phase;
    const resolvedPhase = phaseFromQuarter(this.resolvedQuarter);
    let phase = resolvedPhase;
    let lifecycle = lifecycleForState(raw);

    // Once Q4 reaches the end, do not call the game FINAL without a verified
    // final signal. A subsequent Q5+ transition resolves this as overtime.
    if (!lifecycle && this.resolvedQuarter === 4 && clock != null && clock <= 1) {
      phase = 'END_REGULATION_PENDING';
      lifecycle = previousPhase !== 'END_REGULATION_PENDING' ? 'END_REGULATION_PENDING' : null;
    } else if (!lifecycle && this.resolvedQuarter != null && this.resolvedQuarter >= 5) {
      phase = phaseFromQuarter(this.resolvedQuarter);
    }

    // Halftime is emitted once when the authoritative/derived phase crosses
    // from the first half into Q3. It remains a lifecycle event rather than a
    // fake quarter value.
    if (!lifecycle && this.resolvedQuarter === 3 && previousPhase === 'Q2') {
      lifecycle = 'HALFTIME';
    }

    if (lifecycle === 'FINAL') {
      phase = 'FINAL';
      if (this.finalEmitted) lifecycle = null;
      else this.finalEmitted = true;
    }

    this.phase = phase;
    this.previousClock = clock;
    this.previousMemoryQuarter = memoryQuarter;

    const directDiff = finite(raw.scoreDifferentialApi ?? raw.userScoreDifferential ?? raw.scoreDifferential);
    const scoreDifferential = directDiff;
    const scoreDifferentialSource =
      finite(raw.scoreDifferentialApi) != null
        ? SCORE_SOURCE.AUTHORITATIVE_API
        : (finite(raw.userScoreDifferential) != null || finite(raw.scoreDifferential) != null
          ? (raw.scoreDifferentialSource || SCORE_SOURCE.USER_RELATIVE_TELEMETRY)
          : SCORE_SOURCE.UNAVAILABLE);

    const state = {
      ...raw,
      rawQuarter: memoryQuarter,
      quarter: this.resolvedQuarter,
      quarterSource: this.quarterSource,
      quarterConfidence: this.quarterConfidence,
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
      quarterSource: this.quarterSource,
      quarterConfidence: this.quarterConfidence,
      clockWrapDetected: wrap,
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
