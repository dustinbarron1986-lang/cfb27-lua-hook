'use strict';

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validState(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const down = finite(raw.down);
  const quarter = finite(raw.quarter);
  const gameClock = finite(raw.gameClockSeconds);
  const playClock = finite(raw.playClockSeconds);
  const fieldX = finite(raw.fieldX);
  const lineToGain = finite(raw.lineToGain);
  return down != null && down >= 1 && down <= 4 &&
    quarter != null && quarter >= 1 && quarter <= 8 &&
    gameClock != null && gameClock >= 0 &&
    playClock != null && playClock >= 0 &&
    fieldX != null && lineToGain != null;
}

function normalizeState(raw) {
  if (!validState(raw)) return null;
  return {
    ...raw,
    gameClockSeconds: finite(raw.gameClockSeconds),
    playClockSeconds: finite(raw.playClockSeconds),
    homeScore: finite(raw.homeScore),
    awayScore: finite(raw.awayScore),
    quarter: finite(raw.quarter),
    possession: finite(raw.possession),
    down: finite(raw.down),
    distance: finite(raw.distance),
    yardsToGainExact: finite(raw.yardsToGainExact),
    fieldX: finite(raw.fieldX),
    fieldY: finite(raw.fieldY),
    lineToGain: finite(raw.lineToGain),
    yardLine: finite(raw.yardLine),
  };
}

function offenseDirection(start) {
  const delta = finite(start.lineToGain) - finite(start.fieldX);
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.01) return null;
  return Math.sign(delta);
}

function scoreForPossession(state, possession) {
  // Current telemetry's possession is user/opponent, not home/away. Until team-side
  // identity is separately known, score deltas are used only generically for TD/score detection.
  return {
    home: finite(state.homeScore) || 0,
    away: finite(state.awayScore) || 0,
    total: (finite(state.homeScore) || 0) + (finite(state.awayScore) || 0),
    possession,
  };
}

function callFromState(state, side) {
  const prefix = side === 'offense' ? 'offensive' : 'defensive';
  return {
    available: Boolean(state[`${prefix}CallAvailable`]),
    status: state[`${prefix}CallStatus`] || null,
    side: state[`${prefix}Side`] ?? null,
    set: state[`${prefix}Set`] || null,
    name: state[`${prefix}Play`] || null,
    id: state[`${prefix}PlayId`] == null ? null : String(state[`${prefix}PlayId`]),
  };
}

function transitionEvidence(start, next) {
  const downChanged = next.down !== start.down;
  const possessionChanged = next.possession !== start.possession;
  const quarterChanged = next.quarter !== start.quarter;
  const playClockReset = next.playClockSeconds >= 30 &&
    next.playClockSeconds >= start.playClockSeconds + 5;
  const lineReset = Math.abs(next.lineToGain - start.lineToGain) >= 0.75;
  const scoreChanged = next.homeScore !== start.homeScore || next.awayScore !== start.awayScore;
  const clockRan = next.gameClockSeconds < start.gameClockSeconds || quarterChanged;
  const fieldMoved = Math.abs(next.fieldX - start.fieldX) >= 0.35;
  const startDistance = finite(start.distance);
  const nextDistance = finite(next.distance);
  const distanceChanged = startDistance != null && nextDistance != null &&
    Math.abs(nextDistance - startDistance) >= 0.25;

  return {
    downChanged,
    possessionChanged,
    quarterChanged,
    playClockReset,
    lineReset,
    scoreChanged,
    clockRan,
    fieldMoved,
    distanceChanged,
    completed: possessionChanged || scoreChanged || downChanged ||
      (clockRan && fieldMoved && (playClockReset || lineReset)),
  };
}

// Accepted offensive penalties and other administrative no-snap resets can
// move the ball backward and increase the distance while repeating the same
// down. They must NOT become performance snaps. Do not require a particular
// play-clock value here: administrative restarts can use different clocks.
// The unchanged line-to-gain plus repeated down is the stronger football
// signature. Check this before generic completed-snap evidence because a
// post-snap accepted penalty may have run game clock even though the play is
// nullified for coordinator-learning purposes.
function isAdministrativeReset(start, next, evidence = transitionEvidence(start, next)) {
  const startDistance = finite(start.distance);
  const nextDistance = finite(next.distance);
  const distanceIncreased = startDistance != null && nextDistance != null &&
    nextDistance >= startDistance + 0.25;

  return next.possession === start.possession &&
    next.quarter === start.quarter &&
    next.down === start.down &&
    !evidence.scoreChanged &&
    evidence.fieldMoved &&
    !evidence.lineReset &&
    distanceIncreased;
}

function buildCompletedSnap(start, next) {
  const direction = offenseDirection(start);
  const rawYards = direction == null ? 0 : (next.fieldX - start.fieldX) * direction;
  const yards = Math.round(rawYards * 10) / 10;
  const possessionChanged = next.possession !== start.possession;
  const scoreBefore = scoreForPossession(start, start.possession);
  const scoreAfter = scoreForPossession(next, next.possession);
  const pointsScored = scoreAfter.total - scoreBefore.total;
  const touchdown = pointsScored >= 6;
  const turnover = possessionChanged && !touchdown;
  const firstDown = !possessionChanged && (next.down === 1) &&
    (start.down !== 1 || yards + 0.25 >= (start.yardsToGainExact ?? start.distance ?? Infinity));

  return {
    start,
    end: next,
    offenseCall: callFromState(start, 'offense'),
    defenseCall: callFromState(start, 'defense'),
    result: {
      yards,
      firstDown,
      touchdown,
      turnover,
      possessionChanged,
      pointsScored,
    },
  };
}

class SnapReducer {
  constructor() {
    this.anchor = null;
    this.last = null;
    this.serial = 0;
  }

  ingest(raw) {
    const next = normalizeState(raw);
    if (!next) return { type: 'ignored', reason: 'invalid_state' };

    if (!this.anchor || next.possession !== this.anchor.possession) {
      // A possession change may span an unknown number of unobserved plays (kickoff,
      // return, a whole missed drive while `down` was an invalid sentinel). Diffing
      // against the old anchor here would fabricate a bogus multi-play "snap".
      this.anchor = next;
      this.last = next;
      return { type: 'situation', state: next };
    }

    // During the pre-snap period, continuously refresh the anchor so the last selected
    // play/set and the lowest play clock are captured before the snap.
    const evidence = transitionEvidence(this.anchor, next);
    if (isAdministrativeReset(this.anchor, next, evidence)) {
      this.anchor = next;
      this.last = next;
      return { type: 'administrative_reset', state: next, evidence };
    }

    if (!evidence.completed) {
      const sameSituation = next.possession === this.anchor.possession &&
        next.down === this.anchor.down &&
        Math.abs(next.fieldX - this.anchor.fieldX) < 0.35 &&
        next.lineToGain === this.anchor.lineToGain;
      if (sameSituation) this.anchor = next;
      this.last = next;
      return { type: 'state', state: next };
    }

    const completed = buildCompletedSnap(this.anchor, next);
    completed.serial = ++this.serial;
    this.anchor = next;
    this.last = next;
    return { type: 'completed_snap', snap: completed, nextState: next, evidence };
  }
}

module.exports = {
  SnapReducer,
  normalizeState,
  validState,
  offenseDirection,
  transitionEvidence,
  isAdministrativeReset,
  buildCompletedSnap,
  callFromState,
};
