'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EmpiricalPrior } = require('../src/football/recommendation/empirical-prior');
const { distanceBand, normalizeSituation, fieldBoundaryGeometry } = require('../src/football/analysis/situation-normalizer');
const { buildOffensiveProfile, canonicalRoute } = require('../src/football/analysis/offensive-profile');

const prior = new EmpiricalPrior();

function profile(decisionClass, routes = []) {
  return { decisionClass, routes };
}

test('canonical distance bands use 1-3 / 4-6 / 7-10 / 11+', () => {
  assert.equal(distanceBand(1), 'short');
  assert.equal(distanceBand(3), 'short');
  assert.equal(distanceBand(4), 'medium');
  assert.equal(distanceBand(7), 'long');
  assert.equal(distanceBand(10), 'long');
  assert.equal(distanceBand(11), 'extra_long');
});

test('1st-and-10 empirical prior favors pass over run', () => {
  const pass = prior.situationEvidence({ down: 1, distance: 10 }, profile('pass'));
  const run = prior.situationEvidence({ down: 1, distance: 10 }, profile('run'));
  assert.ok(pass.score > run.score);
  assert.equal(pass.rowId, '1st_10');
});

test('2nd-and-short favors run and 2nd-and-medium is near neutral', () => {
  const shortRun = prior.situationEvidence({ down: 2, distance: 2 }, profile('run'));
  const shortPass = prior.situationEvidence({ down: 2, distance: 2 }, profile('pass'));
  assert.ok(shortRun.score > shortPass.score);

  const medRun = prior.situationEvidence({ down: 2, distance: 5 }, profile('run'));
  const medPass = prior.situationEvidence({ down: 2, distance: 5 }, profile('pass'));
  assert.ok(Math.abs(medRun.score) < 0.25);
  assert.ok(Math.abs(medPass.score) < 0.25);
});

test('2nd-and-long favors pass and 3rd-and-short materially favors run', () => {
  assert.ok(
    prior.situationEvidence({ down: 2, distance: 8 }, profile('pass')).score >
    prior.situationEvidence({ down: 2, distance: 8 }, profile('run')).score
  );
  assert.ok(
    prior.situationEvidence({ down: 3, distance: 2 }, profile('run')).score >
    prior.situationEvidence({ down: 3, distance: 2 }, profile('pass')).score
  );
});

test('rare long-yardage run efficiency is selection-bias marked and capped', () => {
  const third = prior.situationEvidence({ down: 3, distance: 8 }, profile('run'));
  const fourth = prior.situationEvidence({ down: 4, distance: 5 }, profile('run'));
  assert.equal(third.selectionBiasRisk, true);
  assert.equal(third.requiresSupportingContext, true);
  assert.ok(third.score <= 0.55);
  assert.equal(fourth.selectionBiasRisk, true);
  assert.ok(fourth.score <= 0.55);
});

test('hybrid/RPO evidence does not receive full run plus full pass bonuses', () => {
  const row = prior.matchSituation({ down: 3, distance: 2 });
  const run = prior.situationEvidence({ down: 3, distance: 2 }, profile('run'));
  const pass = prior.situationEvidence({ down: 3, distance: 2 }, profile('pass'));
  const hybrid = prior.situationEvidence({ down: 3, distance: 2 }, profile('hybrid'));
  assert.equal(row.id, '3rd_short');
  assert.equal(hybrid.score, Number(((run.score + pass.score) / 2).toFixed(3)));
  assert.ok(Math.abs(hybrid.score) <= Math.max(Math.abs(run.score), Math.abs(pass.score)));
});

test('exact Cover-N route evidence beats broad shell fallback', () => {
  const exact = prior.routeCoverageEvidence(profile('pass', ['corner']), { coverageFamily: 'cover_3' });
  const broad = prior.routeCoverageEvidence(profile('pass', ['corner']), { coverageFamily: 'zone' });
  assert.equal(exact.evidenceLevel, 'exact_route_cover_n');
  assert.equal(exact.route, 'corner');
  assert.equal(exact.n, 162);
  assert.equal(broad.evidenceLevel, 'broad_man_zone');
});

test('Cover 2 screen evidence is negative and Cover 3 corner is positive', () => {
  assert.ok(prior.routeCoverageEvidence(profile('pass', ['screen']), { coverageFamily: 'cover_2' }).score < 0);
  assert.ok(prior.routeCoverageEvidence(profile('pass', ['corner']), { coverageFamily: 'cover_3' }).score > 0);
});

test('yards-to-goal normalization cannot invert red zone and backed-up field position', () => {
  assert.equal(normalizeSituation({ yardLine: 85 }).yardsToGoal, 15);
  assert.equal(normalizeSituation({ yardLine: 85 }).fieldZone, 'red_zone');
  assert.equal(normalizeSituation({ yardLine: 5 }).yardsToGoal, 95);
  assert.equal(normalizeSituation({ yardLine: 5 }).fieldZone, 'backed_up');
});

test('hash geometry is offense-relative and direction-aware', () => {
  const plus = fieldBoundaryGeometry({ hash: 'left', offenseDirection: 1 });
  const minus = fieldBoundaryGeometry({ hash: 'left', offenseDirection: -1 });
  assert.equal(plus.hash, 'LEFT_HASH');
  assert.equal(plus.fieldSide, 'RIGHT');
  assert.equal(minus.fieldSide, 'LEFT');
  assert.notEqual(plus.fieldSide, minus.fieldSide);
});

test('authoritative route semantics drive canonical route vocabulary', () => {
  const authority = {
    available: true,
    playKey: 'play:test',
    classification: { run: false, rpo: false, screen: false, playAction: false },
    play: { offensePlayType: 'PassDropback', concepts: ['Mesh'] },
    routeTargets: [
      { routeFamily: 'corner' },
      { routeType: 'AssignRouteType_Post' },
    ],
    blockingPlayers: [],
    motionPlayers: [],
  };
  const p = buildOffensiveProfile({ type: 'PASS', name: 'Misleading Name' }, authority);
  assert.deepEqual(p.routes.sort(), ['corner','post']);
  assert.equal(p.passConcept, 'mesh');
  assert.equal(p.provenance.routes, 'EA_AUTHORED');
  assert.equal(canonicalRoute('AssignRouteType_ShallowCross'), 'shallow_cross');
});
