'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GamePhaseTracker, QUARTER_SOURCE } = require('../src/coordinator/game-phase-tracker.cjs');
const { deriveSituation } = require('../src/football/integration/telemetry-adapter.example');
const { getGameplan } = require('../src/football/gameplan/gameplan-definitions');
const {
  GameplanEngine,
  SetupState,
  describePlay,
  gameplanFit,
  generateCallSheet,
} = require('../src/football/gameplan/gameplan-engine');
const { usageSaturation } = require('../src/football/recommendation/play-selection-engine');
const { adjustmentCapabilities } = require('../src/football/recommendation/play-adjustment-capabilities');
const { oracleStrategicDecision, strategicPlayScore } = require('../src/football/gameplan/strategic-context');
const { FootballEngine } = require('../src/football/engine');

function p(id, name, formation, type, concepts = [], extra = {}) {
  return { id: String(id), name, formation, type, concepts, ...extra };
}

function syntheticGroundBook() {
  const plays = [];
  let id = 1;
  const forms = ['Singleback Ace', 'I Form Pro', 'Strong I', 'Gun Ace', 'Pistol Strong'];
  for (let i = 0; i < 45; i += 1) {
    const runNames = ['Inside Zone', 'Duo', 'Power O', 'Counter', 'HB Stretch', 'Toss'];
    const name = runNames[i % runNames.length] + ' ' + i;
    const concept = ['inside_zone', 'duo', 'power', 'counter', 'stretch', 'toss'][i % 6];
    plays.push(p(id++, name, forms[i % forms.length], 'RUN', [concept]));
  }
  for (let i = 0; i < 15; i += 1) {
    plays.push(p(id++, 'RPO Zone Alert Bubble ' + i, 'Gun Ace', 'RPO', ['rpo', 'inside_zone', 'bubble']));
  }
  for (let i = 0; i < 35; i += 1) {
    const names = ['Flood Trail', 'Mesh', 'Levels', 'Spacing', 'Drive Y Corner', 'PA Power G Drive', 'Four Verticals Shot'];
    const concepts = [
      ['flood', 'zone_beater'],
      ['mesh'],
      ['levels'],
      ['spacing'],
      ['crossers', 'corner'],
      ['play_action', 'power'],
      ['vertical', 'deep_shot'],
    ][i % 7];
    plays.push(p(id++, names[i % 7] + ' ' + i, forms[i % forms.length], 'PASS', concepts));
  }
  for (let i = 0; i < 10; i += 1) {
    plays.push(p(id++, 'HB Screen ' + i, 'Gun Ace', 'SCREEN', ['screen']));
  }
  return { id: 'ground-book', name: 'Ground Book', plays };
}

function recordEvent(play, success = true, situation = { possession: 0, down: 1, distance: 7, yardLine: 40, flags: {} }) {
  return {
    play,
    opponentPlay: { id: 'd', name: 'Cover 3 Sky', coverageFamily: 'cover_3' },
    situation,
    result: { yards: success ? 7 : 0, turnover: false, sack: false },
    grades: {
      offense: { situationalSuccess: success, objectiveSuccess: success, explosive: false, negativePlay: false, resultGrade: success ? 1 : 0 },
      defense: { objectiveSuccess: !success, explosiveAllowed: false, takeaway: false },
    },
  };
}

test('stale quarter=1 advances exactly once on a strong clock wrap', () => {
  const tracker = new GamePhaseTracker();
  assert.equal(tracker.resolve({ quarter: 1, gameClockSeconds: 600 }).quarter, 1);
  tracker.resolve({ quarter: 1, gameClockSeconds: 8 });
  const q2 = tracker.resolve({ quarter: 1, gameClockSeconds: 596 });
  assert.equal(q2.quarter, 2);
  assert.equal(q2.quarterSource, QUARTER_SOURCE.DERIVED_CLOCK_WRAP);
  const duplicate = tracker.resolve({ quarter: 1, gameClockSeconds: 596 });
  assert.equal(duplicate.quarter, 2);
});

test('ordinary clock correction does not fabricate a quarter transition', () => {
  const tracker = new GamePhaseTracker();
  tracker.resolve({ quarter: 1, gameClockSeconds: 720 });
  tracker.resolve({ quarter: 1, gameClockSeconds: 510 });
  const corrected = tracker.resolve({ quarter: 1, gameClockSeconds: 545 });
  assert.equal(corrected.quarter, 1);
  assert.equal(corrected.clockWrapDetected, false);
});

test('derived quarter learns variable period high-water rather than assuming ten minutes', () => {
  const tracker = new GamePhaseTracker();
  tracker.resolve({ quarter: 1, gameClockSeconds: 900 });
  tracker.resolve({ quarter: 1, gameClockSeconds: 10 });
  const q2 = tracker.resolve({ quarter: 1, gameClockSeconds: 894 });
  assert.equal(q2.quarter, 2);
  assert.ok(q2.periodHighWater >= 894);
});

test('authoritative GETQUARTER value wins over stale memory quarter', () => {
  const tracker = new GamePhaseTracker();
  const row = tracker.resolve({ rawQuarter: 1, apiQuarter: 3, gameClockSeconds: 550 });
  assert.equal(row.quarter, 3);
  assert.equal(row.quarterSource, QUARTER_SOURCE.AUTHORITATIVE_API);
});

test('second clock wrap emits halftime lifecycle; third reaches Q4', () => {
  const tracker = new GamePhaseTracker();
  tracker.resolve({ quarter: 1, gameClockSeconds: 600 });
  tracker.resolve({ quarter: 1, gameClockSeconds: 5 });
  tracker.resolve({ quarter: 1, gameClockSeconds: 598 }); // Q2
  tracker.resolve({ quarter: 1, gameClockSeconds: 4 });
  const halftime = tracker.resolve({ quarter: 1, gameClockSeconds: 599 }); // Q3
  assert.equal(halftime.quarter, 3);
  assert.equal(halftime.lifecycle, 'HALFTIME');
  tracker.resolve({ quarter: 1, gameClockSeconds: 3 });
  const q4 = tracker.resolve({ quarter: 1, gameClockSeconds: 597 });
  assert.equal(q4.quarter, 4);
});

test('Q4 end is pending, then a wrap becomes OT1 without premature FINAL', () => {
  const tracker = new GamePhaseTracker();
  tracker.resolve({ apiQuarter: 4, gameClockSeconds: 40 });
  const pending = tracker.resolve({ apiQuarter: 4, gameClockSeconds: 0 });
  assert.equal(pending.phase, 'END_REGULATION_PENDING');
  assert.equal(pending.lifecycle, 'END_REGULATION_PENDING');
  const ot = tracker.resolve({ rawQuarter: 4, gameClockSeconds: 600 });
  assert.equal(ot.phase, 'OT1');
  assert.notEqual(ot.lifecycle, 'FINAL');
});

test('verified user-relative score differential reaches late-game situation flags', () => {
  const flags = deriveSituation({ quarter: 4, clockSeconds: 300, scoreDifferential: 14, down: 1, distance: 10, yardLine: 55 });
  assert.equal(flags.leadingLate, true);
  assert.equal(flags.fourMinute, true);
  const trailing = deriveSituation({ quarter: 4, clockSeconds: 180, scoreDifferential: -7, down: 2, distance: 8, yardLine: 45 });
  assert.equal(trailing.trailingLate, true);
  assert.equal(trailing.fourMinute, false);
});

test('Flood Trail cannot inherit Ground Control zone/run identity through substring contamination', () => {
  const play = p('flood', 'Flood Trail', 'Singleback Deuce Close', 'PASS', ['flood', 'zone_beater']);
  const desc = describePlay(play);
  const fit = gameplanFit(desc, getGameplan('ground_control'));
  assert.equal(desc.typeFamily, 'pass');
  assert.equal(desc.runLike, false);
  assert.ok(!fit.contributions.some(row => row.label === 'concept:zone'));
  assert.ok(!fit.reasons.some(reason => /core concept match: zone\b/i.test(reason)));
});

test('Ground Control call sheet carries meaningful pure-run inventory', () => {
  const book = syntheticGroundBook();
  const sheet = generateCallSheet({ playbook: book, gameplanId: 'ground_control', targetSize: 80 });
  const byId = new Map(book.plays.map(play => [String(play.id), play]));
  const pureRuns = sheet.entries.filter(entry => String(byId.get(entry.playId)?.type).toUpperCase() === 'RUN').length;
  assert.equal(sheet.actualSize, 80);
  assert.ok(pureRuns >= 30, 'expected Ground Control to carry at least ~37% pure runs');
});

test('neutral Ground Control recommendation materially favors run/run-hybrid identity', () => {
  const book = syntheticGroundBook();
  const engine = new FootballEngine();
  engine.prepareGameplan(book, { gameplanId: 'ground_control' });
  const ranked = engine.recommendPlays({
    playbook: book,
    situation: { down: 1, distance: 7, yardLine: 45, quarter: 2, clockSeconds: 500, scoreDifferential: 0, flags: {} },
    limit: 5,
  });
  assert.ok(ranked.recommendations.length);
  const top3 = ranked.recommendations.slice(0, 3);
  assert.ok(top3.some(row => ['RUN','RPO','OPTION'].includes(String(row.play.type).toUpperCase())));
});

test('Ground Control still permits situational passes on third-and-long', () => {
  const book = syntheticGroundBook();
  const engine = new FootballEngine();
  engine.prepareGameplan(book, { gameplanId: 'ground_control' });
  const ranked = engine.recommendPlays({
    playbook: book,
    situation: { down: 3, distance: 12, yardLine: 45, quarter: 2, clockSeconds: 400, scoreDifferential: 0, flags: { longYardage: true } },
    limit: 5,
  });
  assert.ok(ranked.recommendations.some(row => ['PASS','SCREEN'].includes(String(row.play.type).toUpperCase())));
  assert.ok(!ranked.recommendations.some(row => String(row.play.type).toUpperCase() === 'RUN'));
});

test('exact-play saturation grows with game usage but strong exploit reduces rather than removes it', () => {
  const play = p('flood', 'Flood Trail', 'Singleback Deuce Close', 'PASS', ['flood']);
  const store = attempts => ({
    summarizePlay() { return { attempts, situationalSuccessRate: 0.62 }; },
  });
  const weak = { fit: 0.4, gate: { valid: true } };
  const strong = { fit: 0.9, gate: { valid: true } };
  const at10 = usageSaturation(store(10), play, weak, { flags: {} });
  const at20 = usageSaturation(store(20), play, weak, { flags: {} });
  const hammer = usageSaturation(store(20), play, strong, { flags: {} });
  assert.ok(at20.score < at10.score);
  assert.ok(hammer.score > at20.score);
  assert.equal(hammer.exploit, true);
  assert.match(hammer.reasons.join(' '), /REUSE/);
});

test('four-minute strategic scoring strongly favors a valid run over a shot while up 14', () => {
  const situation = { quarter: 4, clockSeconds: 300, scoreDifferential: 14, down: 1, distance: 10, flags: { fourMinute: true, leadingLate: true } };
  const run = p('r', '24 Zone Open', 'Singleback Ace', 'RUN', ['inside_zone']);
  const shot = p('p', 'PA Flood Shot', 'Singleback Ace', 'PASS', ['play_action', 'deep_shot', 'vertical']);
  assert.ok(strategicPlayScore(run, situation).score > strategicPlayScore(shot, situation).score + 1);
});

test('four-minute Oracle vetoes marginal pass audible but allows severe tactical escape', () => {
  const situation = { quarter: 4, clockSeconds: 300, scoreDifferential: 14, down: 1, distance: 10, flags: { fourMinute: true, leadingLate: true } };
  const run = p('r', '24 Zone Open', 'Singleback Ace', 'RUN', ['inside_zone']);
  const pass = p('p', 'PA Flood', 'Singleback Ace', 'PASS', ['play_action', 'flood']);
  const marginal = oracleStrategicDecision({ currentPlay: run, replacementPlay: pass, situation, tacticalDelta: 0.9, currentStructurallyValid: true });
  assert.equal(marginal.allow, false);
  assert.match(marginal.reason, /KEEP RUN|protect-the-lead/i);
  const severe = oracleStrategicDecision({ currentPlay: run, replacementPlay: pass, situation, tacticalDelta: null, currentStructurallyValid: false });
  assert.equal(severe.allow, true);
});

test('adjustment legality fails closed for RUN, RPO, and OPTION while preserving normal PASS hot routes', () => {
  assert.equal(adjustmentCapabilities(p('r','Inside Zone','Gun','RUN',['inside_zone'])).canHotRoute, false);
  assert.equal(adjustmentCapabilities(p('rpo','Zone Alert Bubble','Gun','RPO',['rpo','bubble'])).canHotRoute, false);
  assert.equal(adjustmentCapabilities(p('o','Read Option','Gun','OPTION',['read_option'])).canHotRoute, false);
  assert.equal(adjustmentCapabilities(p('p','Mesh','Gun','PASS',['mesh'])).canHotRoute, true);
});

test('established run only boosts RELATED PA payoff, not arbitrary same-formation PA', () => {
  const setup = new SetupState();
  const run = p('r1','Inside Zone','Singleback Ace','RUN',['inside_zone']);
  const related = p('pa1','PA Zone Post','Singleback Ace','PASS',['play_action','vertical']);
  const unrelated = p('pa2','PA Boot Other','Singleback Ace','PASS',['play_action','flood']);
  setup.record(recordEvent(run, true));
  setup.record(recordEvent(run, true));
  setup.record(recordEvent(run, true));
  const relatedScore = setup.score(related, { relationships: [{ type: 'PLAY_ACTION_PAYOFF', setupPlayId: 'r1', confidence: 'MEDIUM' }] });
  const unrelatedScore = setup.score(unrelated, { relationships: [] });
  assert.ok(relatedScore.components.setupValue > 0);
  assert.equal(unrelatedScore.components.setupValue, 0);
});

test('halftime gameplan switch preserves first-half setup memory and applies a new sheet immediately', () => {
  const book = syntheticGroundBook();
  const engine = new GameplanEngine();
  engine.prepare(book, { gameplanId: 'balanced_multiple' });
  engine.record(recordEvent(book.plays[0], true));
  assert.equal(engine.summary().setup.snaps, 1);
  const switched = engine.setSelection(book, { gameplanId: 'ground_control' });
  assert.equal(switched.gameplanId, 'ground_control');
  assert.equal(engine.summary().setup.snaps, 1);
  assert.equal(engine.getCallSheet(book).gameplanId, 'ground_control');
});

test('real-game regression fixture reaches Q4 with stale quarter and Ground Control does not lose run inventory', () => {
  const tracker = new GamePhaseTracker();
  const clocks = [600, 4, 598, 3, 599, 2, 597];
  let resolved = null;
  for (const gameClockSeconds of clocks) resolved = tracker.resolve({ quarter: 1, gameClockSeconds });
  assert.equal(resolved.quarter, 4);

  const book = syntheticGroundBook();
  const sheet = generateCallSheet({ playbook: book, gameplanId: 'ground_control', targetSize: 80 });
  const byId = new Map(book.plays.map(play => [String(play.id), play]));
  const runInventory = sheet.entries.filter(entry => ['RUN','RPO','OPTION'].includes(String(byId.get(entry.playId)?.type).toUpperCase())).length;
  assert.ok(runInventory >= 35);

  const late = deriveSituation({ quarter: resolved.quarter, clockSeconds: 300, scoreDifferential: 14, down: 1, distance: 10, yardLine: 50 });
  assert.equal(late.fourMinute, true);
});
