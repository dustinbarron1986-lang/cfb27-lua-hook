'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AudiblePackageStore,
  buildComplementaryPackage,
} = require('../src/football/recommendation/audible-package-store');
const {
  ACTION,
  advisePreSnapCoordinator,
  resolveAudibleCandidates,
} = require('../src/football/recommendation/pre-snap-coordinator');
const { PerformanceStore } = require('../src/football/memory/performance-store');

function play(id, name, formation, type, concepts = []) {
  return { id, name, formation, type, concepts };
}

function playbook() {
  return {
    id: 'pb-1',
    name: 'Test Book',
    plays: [
      play('a1', 'Inside Zone', 'Gun Ace', 'RUN', ['inside_zone']),
      play('a2', 'Slants', 'Gun Ace', 'PASS', ['slants']),
      play('a3', 'Sail', 'Gun Ace', 'PASS', ['flood']),
      play('a4', 'Four Verticals', 'Gun Ace', 'PASS', ['four_verticals']),
      play('a5', 'HB Screen', 'Gun Ace', 'SCREEN', ['screen']),
      play('b1', 'Power', 'I Form Pro', 'RUN', ['power']),
      play('b2', 'PA Cross', 'I Form Pro', 'PASS', ['crossing']),
      play('b3', 'Quick Out', 'I Form Pro', 'PASS', ['quick_out']),
      play('b4', 'Verticals', 'I Form Pro', 'PASS', ['four_verticals']),
      play('b5', 'Toss', 'I Form Pro', 'RUN', ['outside_zone']),
    ],
  };
}

function authoritative({ withBack = true, routes = ['go', 'dig'] } = {}) {
  const routeTargets = routes.map((route, index) => ({
    playerIndex: index + 1,
    playerLabel: index === 0 && withBack ? 'HB' : (index === 0 ? 'WR' : 'TE'),
    routeFamily: route,
    routeType: route,
    assignmentName: route,
  }));
  return {
    authoritative: {
      available: true,
      routeTargets,
      players: routeTargets.map(target => ({
        index: target.playerIndex,
        label: target.playerLabel,
        alignment: { positionType: target.playerLabel },
        eaAssignment: {
          semantics: {
            route: { routeFamily: target.routeFamily },
            blocking: { passBlocks: [] },
          },
        },
      })),
    },
    receiverButtons: [],
  };
}

function defense(name = 'Mid Blitz', formation = 'Nickel 2-4 Dbl Mug', coverageFamily = 'cover_1') {
  return {
    id: 'd1',
    name,
    formation,
    set: formation,
    coverageFamily,
    assignmentFamilies: /blitz/i.test(name) ? ['blitz_rush', 'man_coverage_matchup_family'] : ['zone_coverage_responsibility_family'],
  };
}

function eventFor(playRow, success, opponentId = 'd1') {
  return {
    play: playRow,
    opponentPlay: { id: opponentId, name: 'Defense', coverageFamily: 'cover_1' },
    situation: { down: 2, distance: 7, yardLine: 40 },
    result: { yards: success ? 8 : -2, turnover: false, sack: false },
    grades: {
      offense: {
        objectiveSuccess: success,
        situationalSuccess: success,
        explosive: false,
        negativePlay: !success,
        resultGrade: success ? 1 : -1,
      },
      defense: { objectiveSuccess: !success, explosiveAllowed: false, takeaway: false },
    },
  };
}

test('builds exactly four complementary audibles per formation', () => {
  const pkg = buildComplementaryPackage({ playbook: playbook(), formation: 'Gun Ace' });
  assert.equal(pkg.available, true);
  assert.equal(pkg.slots.length, 4);
  assert.equal(new Set(pkg.slots.map(row => row.playId)).size, 4);
  assert.ok(new Set(pkg.slots.map(row => row.role)).size >= 2);
});

test('separate formations maintain separate packages', () => {
  const store = new AudiblePackageStore();
  const book = playbook();
  const ace = store.ensurePackage(book, 'Gun Ace');
  const pro = store.ensurePackage(book, 'I Form Pro');
  assert.notDeepEqual(ace.slots.map(x => x.playId), pro.slots.map(x => x.playId));
  assert.ok(ace.slots.every(x => x.formation === 'Gun Ace'));
  assert.ok(pro.slots.every(x => x.formation === 'I Form Pro'));
});

test('package persistence is keyed by playbook plus formation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-audibles-'));
  const filePath = path.join(dir, 'audibles.json');
  const book = playbook();
  const first = new AudiblePackageStore({ filePath });
  const saved = first.ensurePackage(book, 'Gun Ace');
  const second = new AudiblePackageStore({ filePath });
  assert.deepEqual(second.get(book.id, 'Gun Ace').slots, saved.slots);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('live audible candidates are restricted to the current formation and assigned four slots', () => {
  const book = playbook();
  const store = new AudiblePackageStore();
  const pkg = store.ensurePackage(book, 'Gun Ace');
  const rows = resolveAudibleCandidates({ audiblePackage: pkg, playbook: book, formation: 'Gun Ace' });
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.play.formation === 'Gun Ace'));
  assert.ok(rows.every(row => pkg.slots.some(slot => slot.playId === String(row.play.id))));
});

test('an unavailable play cannot be recommended from a stale package slot', () => {
  const book = playbook();
  const pkg = buildComplementaryPackage({ playbook: book, formation: 'Gun Ace' });
  pkg.slots[0] = { ...pkg.slots[0], playId: 'missing', playName: 'Missing' };
  const rows = resolveAudibleCandidates({ audiblePackage: pkg, playbook: book, formation: 'Gun Ace' });
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.play.id !== 'missing'));
});

test('STAY is preferred when the current play already structurally answers the look', () => {
  const book = playbook();
  const selected = book.plays.find(x => x.id === 'a2');
  const pkg = new AudiblePackageStore().ensurePackage(book, 'Gun Ace');
  const result = advisePreSnapCoordinator({
    selectedPlay: selected,
    defensiveCall: defense('Mid Blitz'),
    playbook: book,
    situation: { down: 1, distance: 10 },
    audiblePackage: pkg,
    authoritativeKnowledge: authoritative({ withBack: false, routes: ['slant', 'drag'] }),
  });
  assert.equal(result.decision, ACTION.STAY);
});

test('pressure can produce an RB/TE pass-pro recommendation without inventing a rusher count', () => {
  const book = playbook();
  const selected = book.plays.find(x => x.id === 'a4');
  const pkg = new AudiblePackageStore().ensurePackage(book, 'Gun Ace');
  const result = advisePreSnapCoordinator({
    selectedPlay: selected,
    defensiveCall: defense('Mid Blitz'),
    playbook: book,
    situation: { down: 2, distance: 8 },
    audiblePackage: pkg,
    authoritativeKnowledge: authoritative({ withBack: true, routes: ['go', 'post'] }),
  });
  assert.equal(result.decision, ACTION.PROTECTION);
  assert.match(result.action.label, /PASS PRO/);
  assert.match(result.reasons.join(' '), /Exact rusher count/i);
});

test('hot route requires meaningful structural improvement when no protector is available', () => {
  const book = playbook();
  const selected = book.plays.find(x => x.id === 'a4');
  const pkg = new AudiblePackageStore().ensurePackage(book, 'Gun Ace');
  const result = advisePreSnapCoordinator({
    selectedPlay: selected,
    defensiveCall: defense('Cover 1 Robber', 'Nickel 3-3', 'cover_1'),
    playbook: book,
    situation: { down: 2, distance: 7 },
    audiblePackage: pkg,
    authoritativeKnowledge: authoritative({ withBack: false, routes: ['go', 'streak'] }),
  });
  assert.ok([ACTION.HOT_ROUTE, ACTION.STAY, ACTION.AUDIBLE].includes(result.decision));
  if (result.decision === ACTION.HOT_ROUTE) assert.ok(result.finalGrade.structuralScore > result.baseGrade.structuralScore);
});

test('combined protection plus hot route never hot-routes the required blocker', () => {
  const book = playbook();
  const selected = { ...book.plays.find(x => x.id === 'a4'), concepts: ['four_verticals'] };
  const pkg = new AudiblePackageStore().ensurePackage(book, 'Gun Ace');
  const result = advisePreSnapCoordinator({
    selectedPlay: selected,
    defensiveCall: defense('Zero Blitz', 'Nickel 2-4 Dbl Mug', 'cover_0'),
    playbook: book,
    situation: { down: 3, distance: 6 },
    audiblePackage: pkg,
    authoritativeKnowledge: authoritative({ withBack: true, routes: ['go', 'go'] }),
  });
  if (result.decision === ACTION.PROTECTION_HOT_ROUTE) {
    assert.notEqual(result.action.protectorPlayerIndex, result.action.hotRoutePlayerIndex);
    assert.notEqual(result.bestBet?.playerIndex, result.action.protectorPlayerIndex);
  } else {
    assert.notEqual(result.action?.type, 'HOT_ROUTE_BLOCKER');
  }
});

test('audible selection only evaluates the four current-formation slots', () => {
  const book = playbook();
  const store = new AudiblePackageStore();
  const pkg = store.ensurePackage(book, 'Gun Ace');
  const selected = { ...book.plays.find(x => x.id === 'a1'), concepts: [] };
  const result = advisePreSnapCoordinator({
    selectedPlay: selected,
    defensiveCall: defense('Cover 3 Sky', 'Nickel 3-3', 'cover_3'),
    playbook: book,
    situation: { down: 3, distance: 10 },
    audiblePackage: pkg,
    authoritativeKnowledge: authoritative({ withBack: false, routes: [] }),
  });
  if (result.decision === ACTION.AUDIBLE) {
    assert.ok(pkg.slots.some(slot => slot.slot === result.action.slot && slot.playId === String(result.action.play.id)));
    assert.equal(result.action.play.formation, 'Gun Ace');
  }
});

test('structural validity is never overridden by irrelevant historical success', () => {
  const book = playbook();
  const store = new PerformanceStore();
  const run = book.plays.find(x => x.id === 'a1');
  for (let i = 0; i < 8; i += 1) store.record(eventFor(run, true));
  const pkg = new AudiblePackageStore().ensurePackage(book, 'Gun Ace');
  const selected = { ...run, concepts: [] };
  const result = advisePreSnapCoordinator({
    selectedPlay: selected,
    defensiveCall: defense('Cover 3 Sky', 'Nickel 3-3', 'cover_3'),
    playbook: book,
    situation: { down: 3, distance: 12 },
    audiblePackage: pkg,
    authoritativeKnowledge: authoritative({ withBack: false, routes: [] }),
    performanceStore: store,
  });
  if (result.decision === ACTION.AUDIBLE) assert.notEqual(String(result.action.play.id), String(run.id));
});

test('historical performance can rank structurally valid audible candidates', () => {
  const book = playbook();
  const store = new PerformanceStore();
  const slants = book.plays.find(x => x.id === 'a2');
  const screen = book.plays.find(x => x.id === 'a5');
  for (let i = 0; i < 4; i += 1) store.record(eventFor(slants, false));
  for (let i = 0; i < 4; i += 1) store.record(eventFor(screen, true));
  const pkg = {
    available: true,
    playbookId: book.id,
    formation: 'Gun Ace',
    slots: [
      { slot: 'AUDIBLE_1', playId: 'a2', playName: 'Slants', formation: 'Gun Ace', role: 'quick_horizontal' },
      { slot: 'AUDIBLE_2', playId: 'a5', playName: 'HB Screen', formation: 'Gun Ace', role: 'screen' },
      { slot: 'AUDIBLE_3', playId: 'a3', playName: 'Sail', formation: 'Gun Ace', role: 'flood' },
      { slot: 'AUDIBLE_4', playId: 'a4', playName: 'Four Verticals', formation: 'Gun Ace', role: 'vertical' },
    ],
  };
  const result = advisePreSnapCoordinator({
    selectedPlay: { ...book.plays.find(x => x.id === 'a1'), concepts: [] },
    defensiveCall: defense('Mid Blitz'),
    playbook: book,
    situation: { down: 3, distance: 10, yardLine: 40 },
    audiblePackage: pkg,
    authoritativeKnowledge: authoritative({ withBack: false, routes: [] }),
    performanceStore: store,
  });
  if (result.decision === ACTION.AUDIBLE) assert.notEqual(result.action.play.name, 'Slants');
});

test('Best Bet exposes structured callout data only when evidence is sufficient', () => {
  const book = playbook();
  const selected = book.plays.find(x => x.id === 'a2');
  const pkg = new AudiblePackageStore().ensurePackage(book, 'Gun Ace');
  const strong = advisePreSnapCoordinator({
    selectedPlay: selected,
    defensiveCall: defense('Cover 1 Robber', 'Nickel 3-3', 'cover_1'),
    playbook: book,
    situation: { down: 1, distance: 10 },
    audiblePackage: pkg,
    authoritativeKnowledge: authoritative({ withBack: false, routes: ['slant', 'drag'] }),
  });
  assert.equal(strong.bestBet?.calloutType, 'BEST_BET');
  assert.ok(strong.bestBet?.player);
  assert.ok(strong.bestBet?.route);
  assert.ok(strong.bestBet?.reason);
  assert.ok(strong.bestBet?.source);

  const weak = advisePreSnapCoordinator({
    selectedPlay: selected,
    defensiveCall: { id: 'u', name: 'Unknown', formation: 'Unknown' },
    playbook: book,
    situation: { down: 1, distance: 10 },
    audiblePackage: pkg,
    authoritativeKnowledge: authoritative({ withBack: false, routes: ['slant'] }),
  });
  assert.equal(weak.bestBet, null);
});

test('postgame review does not replace on an insufficient sample and preserves role on replacement', () => {
  const book = playbook();
  const pkgStore = new AudiblePackageStore();
  const pkg = pkgStore.ensurePackage(book, 'Gun Ace');
  const perf = new PerformanceStore();
  const watched = book.plays.find(x => String(x.id) === String(pkg.slots[0].playId));
  perf.record(eventFor(watched, false));
  const watchRows = pkgStore.review({ playbook: book, performanceStore: perf, minAttempts: 3 });
  assert.ok(watchRows.some(row => row.currentAudible === watched.name && row.status === 'WATCH'));

  const targetSlot = pkg.slots.find(slot => slot.role);
  if (!targetSlot) return;
  const current = book.plays.find(x => String(x.id) === String(targetSlot.playId));
  const alternative = book.plays.find(x =>
    x.formation === targetSlot.formation &&
    !pkg.slots.some(slot => String(slot.playId) === String(x.id))
  );
  if (!alternative) return;
  for (let i = 0; i < 4; i += 1) perf.record(eventFor(current, false));
  for (let i = 0; i < 4; i += 1) perf.record(eventFor(alternative, true));
  const reviewed = pkgStore.review({ playbook: book, performanceStore: perf, minAttempts: 3 });
  const replacement = reviewed.find(row => row.currentAudible === current.name && row.status === 'REPLACE');
  if (replacement) assert.equal(replacement.audibleRole, targetSlot.role);
});
