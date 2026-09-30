'use strict';

// Field direction, yards accounting, yards-to-goal, hash and flip, from
// verified telemetry only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  FieldDirectionTracker,
  FRAME,
  SOURCE,
  directionFromTransition,
  yardsToGoalFromDirection,
} = require('../src/coordinator/field-direction-tracker.cjs');
const { SnapReducer } = require('../src/coordinator/snap-reducer.cjs');
const { situationFromState } = require('../src/coordinator/live-coordinator.cjs');
const { fieldBoundaryGeometry, offenseDirection } = require('../src/football/analysis/situation-normalizer');
const { scoreSituation } = require('../src/football/recommendation/situation-scorer');
const { EaPlayKnowledgeStore } = require('../src/football/knowledge/ea-play-knowledge-store');
const { buildAuthoritativePlayStructure } = require('../src/football/analysis/authoritative-play-structure');
const { buildOffensiveProfile, derivedOrientation } = require('../src/football/analysis/offensive-profile');
const { flipRecommendation, hashGeometryScore, mirrorability } = require('../src/football/analysis/hash-geometry');

function s(overrides) {
  return { possession: 0, quarter: 1, down: 1, distance: 10, fieldX: -25, lineToGain: -15, lineToGainSource: 'PLACEHOLDER', ...overrides };
}

test('direction from down/distance: gain toward +x and toward -x', () => {
  // Real recorded Q1 snap: 1&10 at x=-25 lost 5 -> 2&15 at x=-30.
  assert.equal(directionFromTransition(s({ fieldX: -25 }), s({ down: 2, distance: 15, fieldX: -30 })), 1);
  // Same football play driving toward -x: 1&10 at x=+25 gained 7 -> 2&3 at x=+18.
  assert.equal(directionFromTransition(s({ fieldX: 25 }), s({ down: 2, distance: 3, fieldX: 18 })), -1);
  // First down gained by advancing past the line.
  assert.equal(directionFromTransition(s({ down: 2, distance: 4, fieldX: 10 }), s({ down: 1, distance: 10, fieldX: 3 })), -1);
  // Possession change, quarter change and inconsistent geometry prove nothing.
  assert.equal(directionFromTransition(s({}), s({ possession: 1, down: 1, fieldX: -10 })), null);
  assert.equal(directionFromTransition(s({}), s({ quarter: 2, down: 2, distance: 5, fieldX: -20 })), null);
  assert.equal(directionFromTransition(s({ fieldX: -25 }), s({ down: 2, distance: 5, fieldX: -24 })), null);
});

test('tracker learns the frame: physical ends swap between Q1 and Q2 and between possessions', () => {
  const t = new FieldDirectionTracker();
  assert.equal(t.direction(s({})).source, SOURCE.UNKNOWN);
  t.observeTransition(s({ fieldX: -25 }), s({ down: 2, distance: 3, fieldX: -18 }));
  assert.deepEqual([t.direction(s({})).direction, t.direction(s({})).source], [1, SOURCE.DOWN_DISTANCE]);
  // Opponent in Q1 drives toward -x -> PHYSICAL frame.
  t.observeTransition(s({ possession: 1, fieldX: 20 }), s({ possession: 1, down: 2, distance: 6, fieldX: 16 }));
  assert.equal(t.frame, FRAME.PHYSICAL);
  // Q2 user direction is predicted as the swap of Q1.
  const q2 = t.direction(s({ quarter: 2 }));
  assert.deepEqual([q2.direction, q2.source], [-1, SOURCE.FRAME_PHYSICAL]);
  // Q3 (after halftime) stays unknown until observed.
  assert.equal(t.direction(s({ quarter: 3 })).direction, null);
});

test('tracker learns an offense-relative frame when both possessions move toward +x', () => {
  const t = new FieldDirectionTracker();
  t.observeTransition(s({ fieldX: -25 }), s({ down: 2, distance: 3, fieldX: -18 }));
  t.observeTransition(s({ possession: 1, fieldX: -30 }), s({ possession: 1, down: 2, distance: 6, fieldX: -26 }));
  assert.equal(t.frame, FRAME.OFFENSE_RELATIVE);
  const q3 = t.direction(s({ quarter: 3, possession: 1 }));
  assert.deepEqual([q3.direction, q3.source], [1, SOURCE.FRAME_OFFENSE_RELATIVE]);
});

test('a Lua-verified lineToGain is preferred and the placeholder never implies a direction', () => {
  const t = new FieldDirectionTracker();
  const verified = t.direction(s({ fieldX: 20, lineToGain: 10, lineToGainSource: 'POSITION_BLOCK_VERIFIED' }));
  assert.deepEqual([verified.direction, verified.source], [-1, SOURCE.VERIFIED_LINE_TO_GAIN]);
  assert.equal(offenseDirection({ fieldX: 20, lineToGain: 30, lineToGainSource: 'PLACEHOLDER' }), null);
  assert.equal(situationFromState(s({ fieldX: 20, lineToGain: 30 })).offenseDirection, null);
});

test('completed-snap yards come from down/distance and do not flip sign with direction', () => {
  const base = { quarter: 1, gameClockSeconds: 598, playClockSeconds: 25, homeScore: 0, awayScore: 0, possession: 0 };
  const reducer = new SnapReducer();
  // Offense driving toward -x (no direction annotation available): 1&10 at +25
  // gains 7 to 2&3 at +18.
  reducer.ingest({ ...base, down: 1, distance: 10, fieldX: 25, lineToGain: 35 });
  const done = reducer.ingest({ ...base, gameClockSeconds: 590, playClockSeconds: 40, down: 2, distance: 3, fieldX: 18, lineToGain: 21 });
  assert.equal(done.type, 'completed_snap');
  assert.equal(done.snap.result.yards, 7);
  assert.equal(done.snap.result.yardsSource, 'DOWN_DISTANCE');
});

test('first-down yards use the annotated direction instead of the placeholder geometry', () => {
  const base = { quarter: 1, gameClockSeconds: 598, playClockSeconds: 25, homeScore: 0, awayScore: 0, possession: 0 };
  const reducer = new SnapReducer();
  reducer.ingest({ ...base, down: 2, distance: 4, fieldX: 10, lineToGain: 14, offenseDirection: -1, offenseDirectionSource: 'DOWN_DISTANCE' });
  const done = reducer.ingest({ ...base, gameClockSeconds: 580, playClockSeconds: 40, down: 1, distance: 10, fieldX: 2, lineToGain: 12, offenseDirection: -1 });
  assert.equal(done.snap.result.yards, 8);
  assert.equal(done.snap.result.firstDown, true);
});

test('yards to goal needs direction: the opponent 5 is red zone, never "backed up"', () => {
  assert.equal(yardsToGoalFromDirection(45, 1), 5);
  assert.equal(yardsToGoalFromDirection(45, -1), 95);
  assert.equal(yardsToGoalFromDirection(45, null), null);
  const nearGoal = situationFromState(s({ fieldX: 45, offenseDirection: 1, offenseDirectionSource: 'DOWN_DISTANCE' }));
  assert.equal(nearGoal.yardsToGoal, 5);
  const unknown = situationFromState(s({ fieldX: 45 }));
  assert.equal(unknown.yardsToGoal, null);
  // Marker number alone (yardLine 5) no longer triggers the backed-up bonus.
  const run = { id: 'r', name: 'Inside Zone', type: 'RUN', concepts: ['inside_zone'] };
  assert.ok(!scoreSituation(run, { down: 1, distance: 5, yardLine: 5, yardsToGoal: 5 }).reasons.includes('safer backed-up call'));
  assert.ok(scoreSituation(run, { down: 1, distance: 10, yardLine: 5, yardsToGoal: 95 }).reasons.includes('safer backed-up call'));
});

test('hash is offense-relative and reverses with direction of travel', () => {
  const toward = fieldBoundaryGeometry({ hash: 'left', offenseDirection: 1 });
  const away = fieldBoundaryGeometry({ hash: 'left', offenseDirection: -1 });
  assert.equal(toward.fieldSide, 'RIGHT');
  assert.equal(away.fieldSide, 'LEFT');
  const live = situationFromState(s({ hash: 'left', offenseDirection: -1 }));
  assert.equal(live.flags !== undefined, true);
  assert.equal(fieldBoundaryGeometry(live).fieldSide, 'LEFT');
});

const OFFENSE_ARTIFACT = path.resolve(__dirname, '..', 'data', 'knowledge', 'pro-style-ea-play-knowledge.json');
const offenseStore = new EaPlayKnowledgeStore({ filePath: OFFENSE_ARTIFACT });
const SKIP_OFFENSE = fs.existsSync(OFFENSE_ARTIFACT) ? false : 'offensive EA play knowledge not built (node scripts/build-ea-play-knowledge.cjs <Formations.zip> <Assignments.zip>)';
function authority(setName, playName) {
  const r = offenseStore.resolvePlay({ playName, setName, evidence: { authorityEligible: true, playName: { value: playName, source: 't' }, setName: { value: setName, source: 't' } } });
  return buildAuthoritativePlayStructure(offenseStore.expandPlay(r.playKey));
}

test('EA canFlip is preserved and becomes HIGH mirror evidence', { skip: SKIP_OFFENSE }, () => {
  const a = authority('Ace', 'PA Flood');
  assert.equal(a.play.canFlip, true);
  assert.deepEqual(mirrorability({}, a), { mirrorable: true, confidence: 'HIGH', provenance: 'EA_AUTHORED' });
});

test('orientation derives from authored route geometry or run hole; balanced plays stay unknown', { skip: SKIP_OFFENSE }, () => {
  const flood = authority('Ace', 'PA Flood');
  assert.equal(buildOffensiveProfile({ name: 'PA Flood' }, flood).orientationSide, 'LEFT');
  const power = authority('Ace', 'HB Power O');
  const powerProfile = buildOffensiveProfile({ name: 'HB Power O' }, power);
  assert.equal(powerProfile.orientationProvenance, 'DERIVED_EA_RUN_HOLE');
  assert.equal(derivedOrientation({}, authority('Ace', 'Skinny Posts'), 'pass'), null);
});

test('flip preserves the call: width concept toward the boundary flips to the field side', { skip: SKIP_OFFENSE }, () => {
  const flood = authority('Ace', 'PA Flood');
  const play = { name: 'PA Flood', normalizedProfile: buildOffensiveProfile({ name: 'PA Flood' }, flood) };
  // Left hash, driving toward +x: field is RIGHT; the flood is authored LEFT.
  const flip = flipRecommendation(play, { hash: 'left', offenseDirection: 1 }, flood);
  assert.equal(flip.recommend, true);
  assert.equal(flip.targetSide, 'RIGHT');
  assert.equal(flip.provenance, 'EA_AUTHORED');
  // Driving the other way the same hash puts the field LEFT: no flip.
  assert.equal(flipRecommendation(play, { hash: 'left', offenseDirection: -1 }, flood).recommend, false);
  // Unknown direction/hash: no geometry claim at all.
  assert.equal(hashGeometryScore(play, { hash: 'unknown' }, flood).available, false);
  assert.equal(flipRecommendation(play, { hash: 'left' }, flood).recommend, false);
});
