'use strict';

const QUARTER_SOURCE = Object.freeze({
  CONSENSUS: 'CONSENSUS',
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
    this.periodHighWater = null;
    this.phase = 'UNKNOWN';
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

  _apply(quarter, source, confidence) {
    this.resolvedQuarter = validQuarter(quarter);
    this.quarterSource = source;
    this.quarterConfidence = confidence;
  }

  resolve(raw = {}) {
    const memoryQuarter = validQuarter(raw.rawQuarter ?? raw.memoryQuarter ?? raw.quarter);
    const apiQuarter = validQuarter(raw.apiQuarter ?? raw.authoritativeQuarter);
    const clock = finite(raw.apiGameClockSeconds) ?? finite(raw.gameClockSeconds);
    const sourcesAgree = memoryQuarter != null && apiQuarter != null && memoryQuarter === apiQuarter;
    const sourceDisagreement = memoryQuarter != null && apiQuarter != null && memoryQuarter !== apiQuarter;

    if (clock != null && (this.periodHighWater == null || clock > this.periodHighWater)) {
      this.periodHighWater = clock;
    }

    const wrap = this._isStrongClockWrap(this.previousClock, clock);
    const priorQuarter = this.resolvedQuarter;

    if (wrap) {
      const base = priorQuarter ?? (sourcesAgree ? memoryQuarter : null) ?? memoryQuarter ?? apiQuarter ?? 1;
      const expected = Math.max(1, Number(base) + 1);
      const memoryMatches = memoryQuarter === expected;
      const apiMatches = apiQuarter === expected;

      if (memoryMatches && apiMatches) this._apply(expected, QUARTER_SOURCE.CONSENSUS, 'HIGH');
      else if (memoryMatches) this._apply(expected, QUARTER_SOURCE.MEMORY, 'HIGH');
      else if (apiMatches) this._apply(expected, QUARTER_SOURCE.AUTHORITATIVE_API, 'HIGH');
      else this._apply(expected, QUARTER_SOURCE.DERIVED_CLOCK_WRAP, 'MEDIUM');

      this.periodHighWater = clock;
    } else if (sourcesAgree) {
      if (priorQuarter == null || memoryQuarter >= priorQuarter) {
        this._apply(memoryQuarter, QUARTER_SOURCE.CONSENSUS, 'HIGH');
      } else {
        this._apply(priorQuarter, this.quarterSource, 'MEDIUM');
      }
    } else if (sourceDisagreement) {
      if (priorQuarter != null && memoryQuarter === priorQuarter && apiQuarter !== priorQuarter) {
        this._apply(priorQuarter, QUARTER_SOURCE.MEMORY, 'MEDIUM');
      } else if (priorQuarter != null && apiQuarter === priorQuarter && memoryQuarter !== priorQuarter) {
        this._apply(priorQuarter, QUARTER_SOURCE.AUTHORITATIVE_API, 'MEDIUM');
      } else if (priorQuarter != null) {
        this._apply(priorQuarter, this.quarterSource, 'LOW');
      } else {
        // At startup a disagreement is evidence of uncertainty, not evidence
        // that GETQUARTER is authoritative. Use memory as the conservative
        // candidate without applying a hard-coded offset.
        this._apply(memoryQuarter, QUARTER_SOURCE.MEMORY, 'LOW');
      }
    } else if (memoryQuarter != null) {
      if (priorQuarter == null || memoryQuarter >= priorQuarter) this._apply(memoryQuarter, QUARTER_SOURCE.MEMORY, 'MEDIUM');
      else this._apply(priorQuarter, this.quarterSource, 'LOW');
    } else if (apiQuarter != null) {
      if (priorQuarter == null || apiQuarter >= priorQuarter) {
        // Numeric validity alone does not earn HIGH confidence.
        this._apply(apiQuarter, QUARTER_SOURCE.AUTHORITATIVE_API, 'MEDIUM');
      } else {
        this._apply(priorQuarter, this.quarterSource, 'LOW');
      }
    } else if (priorQuarter != null) {
      this._apply(priorQuarter, this.quarterSource, 'LOW');
    } else {
      this._apply(null, QUARTER_SOURCE.UNAVAILABLE, 'LOW');
    }

    const previousPhase = this.phase;
    let phase = phaseFromQuarter(this.resolvedQuarter);
    let lifecycle = lifecycleForState(raw);

    if (!lifecycle && this.resolvedQuarter === 4 && clock != null && clock <= 1) {
      phase = 'END_REGULATION_PENDING';
      lifecycle = previousPhase !== 'END_REGULATION_PENDING' ? 'END_REGULATION_PENDING' : null;
    } else if (!lifecycle && this.resolvedQuarter != null && this.resolvedQuarter >= 5) {
      phase = phaseFromQuarter(this.resolvedQuarter);
    }

    if (!lifecycle && this.resolvedQuarter === 3 && previousPhase === 'Q2') lifecycle = 'HALFTIME';

    if (lifecycle === 'FINAL') {
      phase = 'FINAL';
      if (this.finalEmitted) lifecycle = null;
      else this.finalEmitted = true;
    }

    this.phase = phase;
    this.previousClock = clock;

    const directDiff = finite(raw.scoreDifferentialApi ?? raw.userScoreDifferential ?? raw.scoreDifferential);
    const scoreDifferential = directDiff;
    const scoreDifferentialSource =
      finite(raw.scoreDifferentialApi) != null
        ? SCORE_SOURCE.AUTHORITATIVE_API
        : (finite(raw.userScoreDifferential) != null || finite(raw.scoreDifferential) != null
          ? (raw.scoreDifferentialSource || SCORE_SOURCE.USER_RELATIVE_TELEMETRY)
          : SCORE_SOURCE.UNAVAILABLE);

    const quarterEvidenceConflict = sourceDisagreement && !wrap;
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
      quarterSource: this.quarterSource,
      quarterConfidence: this.quarterConfidence,
      quarterEvidenceConflict,
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
