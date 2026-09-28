'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FootballEngine } = require('../src/football/engine');
const { getGameplan } = require('../src/football/gameplan/gameplan-definitions');
const {
  GameplanEngine,
  SetupState,
  describePlay,
  gameplanFit,
  staticSituationTags,
  situationBuckets,
  relationshipBetween,
  generateCallSheet,
  aggressionModifier,
} = require('../src/football/gameplan/gameplan-engine');

function p(id, name, formation, type, concepts = [], extra = {}) {
  return {
    id: String(id),
    name,
    formation,
    type,
    concepts,
    ...extra,
  };
}

function largePlaybook() {
  const formations = ['Gun Spread', 'Gun Trips', 'Singleback Ace', 'I Form Pro', 'Strong I', 'Pistol Trips'];
  const templates = [
    ['Inside Zone', 'RUN', ['inside_zone']],
    ['Power O', 'RUN', ['power']],
    ['Mesh', 'PASS', ['mesh']],
    ['Spacing', 'PASS', ['spacing']],
    ['Four Verticals Shot', 'PASS', ['vertical', 'deep_shot']],
    ['PA Post Shot', 'PASS', ['play_action', 'vertical', 'deep_shot']],
    ['RPO Bubble', 'RPO', ['rpo', 'bubble', 'zone_read']],
    ['HB Screen', 'SCREEN', ['screen']],
    ['Levels', 'PASS', ['levels']],
    ['Out and Up Shot', 'PASS', ['out_and_up', 'deep_shot']],
  ];
  const plays = [];
  let id = 1;
  for (let round = 0; round < 12; round += 1) {
    for (let i = 0; i < templates.length; i += 1) {
      const [name, type, concepts] = templates[i];
      const formation = formations[(round + i) % formations.length];
      plays.push(p(id++, name + ' ' + round, formation, type, concepts, {
        presentationFamily: i % 2 === 0 ? 'family-' + (i % 4) : null,
      }));
    }
  }
  return { id: 'pb-large', name: 'Synthetic Multiple', plays };
}

function successEvent(play, success = true, possession = 0) {
  return {
    play,
    opponentPlay: { id: 'd1', name: 'Cover 3 Sky', coverageFamily: 'cover_3' },
    situation: { possession, down: 1, distance: 10, yardLine: 40 },
    result: { yards: success ? 7 : -2, turnover: false, sack: false },
    grades: {
      offense: {
        situationalSuccess: success,
        objectiveSuccess: success,
        explosive: false,
        negativePlay: !success,
        resultGrade: success ? 1 : -1,
      },
      defense: { objectiveSuccess: !success, explosiveAllowed: false, takeaway: false },
    },
  };
}

test('call sheet targets approximately 80 plays when the selected playbook is large enough', () => {
  const book = largePlaybook();
  const sheet = generateCallSheet({ playbook: book, gameplanId: 'balanced_multiple', targetSize: 80 });
  assert.equal(sheet.actualSize, 80);
  assert.ok(sheet.actualSize >= 70 && sheet.actualSize <= 90);
});

test('call sheet contains only plays from the selected playbook', () => {
  const book = largePlaybook();
  const ids = new Set(book.plays.map(play => String(play.id)));
  const sheet = generateCallSheet({ playbook: book, gameplanId: 'air_raid', targetSize: 80 });
  assert.ok(sheet.entries.every(entry => ids.has(String(entry.playId))));
});

test('selected gameplan meaningfully changes call-sheet composition', () => {
  const book = largePlaybook();
  const air = generateCallSheet({ playbook: book, gameplanId: 'air_raid', targetSize: 80 });
  const ground = generateCallSheet({ playbook: book, gameplanId: 'ground_control', targetSize: 80 });
  const airIds = new Set(air.entries.map(entry => entry.playId));
  const groundIds = new Set(ground.entries.map(entry => entry.playId));
  const overlap = [...airIds].filter(id => groundIds.has(id)).length;
  assert.ok(overlap < 75, 'different philosophies should not collapse to nearly identical sheets');

  const airPass = air.entries.filter(entry => ['crossing', 'quick_horizontal', 'intermediate_middle', 'vertical'].some(k => entry.threatKeys.includes(k))).length;
  const groundRun = ground.entries.filter(entry => ['interior_run', 'gap_run', 'perimeter_run'].some(k => entry.threatKeys.includes(k))).length;
  assert.ok(airPass > 25);
  assert.ok(groundRun > 20);
});

test('situation filtering searches a call-sheet subset rather than the full sheet', () => {
  const book = largePlaybook();
  const engine = new GameplanEngine();
  engine.prepare(book, { gameplanId: 'balanced_multiple' });
  const scoped = engine.scopePlaybook(book, { down: 3, distance: 12, yardLine: 45, flags: { longYardage: true } });
  assert.equal(scoped.meta.applied, true);
  assert.ok(scoped.playbook.plays.length >= 12);
  assert.ok(scoped.playbook.plays.length < engine.getCallSheet(book).entries.length);
  assert.ok(scoped.meta.buckets.includes('THIRD_LONG'));
});

test('one play may belong to multiple legitimate situational buckets', () => {
  const play = p('q', 'Mesh Quick', 'Gun Spread', 'PASS', ['mesh', 'quick_game']);
  const tags = staticSituationTags(describePlay(play));
  assert.ok(tags.includes('THIRD_MEDIUM'));
  assert.ok(tags.includes('THIRD_LONG'));
  assert.ok(tags.includes('TWO_MINUTE'));
  assert.ok(tags.includes('PRESSURE_ANSWER'));
});

test('core run and same-formation play action form a payoff relationship without claiming exact similarity', () => {
  const run = describePlay(p('r1', 'Inside Zone', 'Singleback Ace', 'RUN', ['inside_zone']));
  const pa = describePlay(p('p1', 'PA Post Shot', 'Singleback Ace', 'PASS', ['play_action', 'deep_shot']));
  const relation = relationshipBetween(run, pa);
  assert.equal(relation.type, 'PLAY_ACTION_PAYOFF');
  assert.equal(relation.setupPlayId, run.id);
  assert.match(relation.reason, /heuristic|payoff/i);
});

test('same-formation run and perimeter constraint are represented as related calls', () => {
  const run = describePlay(p('r1', 'Inside Zone', 'Gun Trips', 'RUN', ['inside_zone']));
  const bubble = describePlay(p('c1', 'RPO Bubble', 'Gun Trips', 'RPO', ['rpo', 'bubble']));
  const relation = relationshipBetween(run, bubble);
  assert.equal(relation.type, 'CONSTRAINT');
});

test('successful runs increase a valid related PA payoff score instead of forcing the call', () => {
  const state = new SetupState();
  const run = p('r1', 'Inside Zone', 'Singleback Ace', 'RUN', ['inside_zone']);
  const pa = p('p1', 'PA Post Shot', 'Singleback Ace', 'PASS', ['play_action', 'vertical']);
  const before = state.score(pa, { relationships: [] });
  state.record(successEvent(run, true));
  state.record(successEvent(run, true));
  state.record(successEvent(run, true));
  const after = state.score(pa, { relationships: [{ type: 'PLAY_ACTION_PAYOFF', setupPlayId: 'r1', confidence: 'LOW' }] });
  assert.equal(before.components.setupValue, 0);
  assert.ok(after.components.setupValue > 0);
  assert.ok(after.components.payoffValue > 0);
});

test('PA payoff relationship prefers same formation/presentation evidence over an unrelated formation', () => {
  const run = describePlay(p('r1', 'Inside Zone', 'I Form Pro', 'RUN', ['inside_zone'], { presentationFamily: 'under-center-run' }));
  const same = describePlay(p('p1', 'PA Post Shot', 'I Form Pro', 'PASS', ['play_action', 'vertical'], { presentationFamily: 'under-center-run' }));
  const other = describePlay(p('p2', 'PA Post Shot', 'Gun Trips', 'PASS', ['play_action', 'vertical'], { presentationFamily: 'under-center-run' }));
  const related = relationshipBetween(run, same);
  assert.equal(related.type, 'PLAY_ACTION_PAYOFF');
  assert.equal(related.confidence, 'MEDIUM');
  assert.equal(relationshipBetween(run, other), null);
});

test('repeated short-route presentation increases an appropriate double-move payoff', () => {
  const state = new SetupState();
  const short = p('s1', 'Quick Out', 'Gun Trips', 'PASS', ['quick_out']);
  const doubleMove = p('d1', 'Out and Up Shot', 'Gun Trips', 'PASS', ['out_and_up', 'deep_shot']);
  state.record(successEvent(short, true));
  state.record(successEvent(short, true));
  state.record(successEvent(short, false));
  const scored = state.score(doubleMove, {
    relationships: [{ type: 'DOUBLE_MOVE_PAYOFF', setupPlayId: 's1', confidence: 'LOW' }],
  });
  assert.ok(scored.components.payoffValue > 0);
  assert.match(scored.reasons.join(' '), /double-move/i);
});

test('same-formation tendency breaker gains value after one family dominates the presentation', () => {
  const state = new SetupState();
  const run = p('r1', 'Inside Zone', 'Gun Ace', 'RUN', ['inside_zone']);
  for (let i = 0; i < 4; i += 1) state.record(successEvent({ ...run, id: 'r' + i }, i !== 3));
  const counter = p('x1', 'HB Screen', 'Gun Ace', 'SCREEN', ['screen']);
  const scored = state.score(counter, { relationships: [] });
  assert.ok(scored.components.tendencyBreakingValue > 0);
});

test('setup bonus does not rescue a structurally/situationally invalid ordinary run on 3rd-and-long', () => {
  const book = {
    id: 'gate-book',
    name: 'Gate Book',
    plays: [
      p('run', 'Inside Zone', 'Gun Ace', 'RUN', ['inside_zone']),
      p('mesh', 'Mesh', 'Gun Ace', 'PASS', ['mesh']),
      p('levels', 'Levels', 'Gun Ace', 'PASS', ['levels']),
      p('screen', 'HB Screen', 'Gun Ace', 'SCREEN', ['screen']),
    ],
  };
  const engine = new FootballEngine();
  engine.prepareGameplan(book, { gameplanId: 'ground_control' });
  const run = book.plays[0];
  for (let i = 0; i < 5; i += 1) engine.gameplans.record(successEvent(run, true));
  const ranked = engine.recommendPlays({
    playbook: book,
    situation: { down: 3, distance: 12, yardLine: 45, flags: { longYardage: true } },
    limit: 20,
  });
  assert.ok(!ranked.recommendations.some(row => row.play.id === 'run'));
});

test('aggressiveness changes risk expression without redefining the gameplan identity', () => {
  const plan = getGameplan('ground_control');
  const run = describePlay(p('r', 'Power O', 'I Form Pro', 'RUN', ['power']));
  const shot = describePlay(p('s', 'PA Post Shot', 'I Form Pro', 'PASS', ['play_action', 'deep_shot']));
  assert.ok(gameplanFit(run, plan).score > gameplanFit(shot, plan).score);
  const low = aggressionModifier(shot, plan, 20, { down: 2, distance: 2 });
  const high = aggressionModifier(shot, plan, 90, { down: 2, distance: 2 });
  assert.ok(high.score > low.score);
});

test('confirmed audible package adds only a modest flexibility component', () => {
  const audibleStore = {
    get(playbookId, formation) {
      return formation === 'Gun Spread' ? { available: true, confirmed: true } : null;
    },
  };
  const book = { id: 'flex', name: 'Flex', plays: [p('1', 'Mesh', 'Gun Spread', 'PASS', ['mesh'])] };
  const engine = new GameplanEngine({ audiblePackageStore: audibleStore });
  engine.prepare(book, { gameplanId: 'air_raid' });
  const scored = engine.scoreCandidate(book.plays[0], { down: 1, distance: 10 });
  assert.equal(scored.components.audibleFlexibility, 0.22);
  assert.ok(scored.components.audibleFlexibility < scored.components.gameplanFit);
});

test('current-game setup state resets without erasing the persistent call sheet', () => {
  const book = largePlaybook();
  const engine = new GameplanEngine();
  engine.prepare(book, { gameplanId: 'balanced_multiple' });
  const sheetBefore = engine.getCallSheet(book);
  engine.record(successEvent(book.plays[0], true));
  assert.equal(engine.summary().setup.snaps, 1);
  engine.resetSession();
  assert.equal(engine.summary().setup.snaps, 0);
  assert.equal(engine.getCallSheet(book).generatedAt, sheetBefore.generatedAt);
});

test('pregame call sheet persists by playbook plus selected gameplan and can be reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-gameplan-'));
  const filePath = path.join(dir, 'gameplans.json');
  const book = largePlaybook();
  const first = new GameplanEngine({ filePath });
  const generated = first.prepare(book, { gameplanId: 'air_raid' });
  assert.equal(generated.reused, false);

  const second = new GameplanEngine({ filePath });
  const reused = second.prepare(book);
  assert.equal(reused.gameplanId, 'air_raid');
  assert.equal(reused.reused, true);
  assert.equal(second.getCallSheet(book).actualSize, 80);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('strategic WHY remains explicit and separate from tactical pre-snap advice', () => {
  const book = largePlaybook();
  const engine = new FootballEngine();
  engine.prepareGameplan(book, { gameplanId: 'air_raid', aggressiveness: 65 });
  const ranked = engine.recommendPlays({
    playbook: book,
    situation: { down: 1, distance: 10, yardLine: 35, flags: {} },
    limit: 3,
  });
  assert.equal(ranked.gameplan.gameplanName, 'Air Raid');
  assert.ok(ranked.recommendations[0].strategicWhy.length > 0);
  assert.ok(ranked.recommendations[0].diagnostic.strategy.components.gameplanFit > 0);
});

test('downstream pre-snap coordinator still exposes the established action hierarchy', () => {
  const book = {
    id: 'presnap',
    name: 'PreSnap',
    plays: [
      p('1', 'Slants', 'Gun Ace', 'PASS', ['slants']),
      p('2', 'Inside Zone', 'Gun Ace', 'RUN', ['inside_zone']),
      p('3', 'HB Screen', 'Gun Ace', 'SCREEN', ['screen']),
      p('4', 'Four Verticals', 'Gun Ace', 'PASS', ['vertical']),
    ],
  };
  const engine = new FootballEngine();
  const result = engine.adviseExecution({
    selectedPlay: book.plays[0],
    defensiveCall: { id: 'd', name: 'Cover 3 Sky', formation: 'Nickel', coverageFamily: 'cover_3' },
    playbook: book,
    situation: { down: 1, distance: 10, flags: {} },
  });
  assert.ok(['STAY', 'PROTECTION', 'HOT_ROUTE', 'PROTECTION_HOT_ROUTE', 'AUDIBLE'].includes(result.preSnap?.decision));
});

test('situation bucket helper distinguishes core down-and-distance and field-state contexts', () => {
  assert.deepEqual(situationBuckets({ down: 2, distance: 2, yardLine: 50, flags: {} }), ['SECOND_SHORT']);
  const rz = situationBuckets({ down: 3, distance: 4, yardLine: 92, flags: { goalToGo: true } });
  assert.ok(rz.includes('THIRD_MEDIUM'));
  assert.ok(rz.includes('LOW_RED_ZONE'));
});
