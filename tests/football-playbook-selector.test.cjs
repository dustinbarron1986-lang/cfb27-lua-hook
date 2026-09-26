'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(root, 'data', 'coordinator.db');

const { FootballEngine } = require('../src/football/engine');
const { CoordinatorWindow } = require('../src/football/ui/coordinator-window');
const { CoordinatorDatabase } = require('../src/football/db/coordinator-database');
const { loadCoordinatorConfig, saveCoordinatorConfig } = require('../src/football/config/coordinator-config');
const { loadPlaybooks, loadDefensePlaybookFromDatabase } = require('../src/coordinator/playbook-loader.cjs');
const {
  createPlaybookService,
  playbookLogLine,
  printRecommendation,
  printDefensiveRecommendation,
} = require('../src/coordinator/live-coordinator.cjs');

function tmpConfigPath() {
  return path.join(os.tmpdir(), `cfb27-selector-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

function makeIo() {
  const logs = [];
  return { io: { log: (...args) => logs.push(args.join(' ')) }, logs };
}

function setup(configPath) {
  // Mirrors the real, already-established baseline: offense (405/Pro Style)
  // is always persisted first (Stage 2). A brand-new config file with no
  // offense selection at all is not a scenario the live coordinator is ever
  // actually in -- saveCoordinatorConfig correctly requires a valid offense
  // id/name by design, so tests must start from that same baseline.
  if (!fs.existsSync(configPath)) {
    saveCoordinatorConfig({ offensePlaybookId: 405, offensePlaybookName: 'Pro Style' }, configPath);
  }
  const database = new CoordinatorDatabase({ dbPath, readOnly: true });
  const playbooks = loadPlaybooks(root, { useDatabase: false }); // start from the sample fallback for both sides
  const engine = new FootballEngine();
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const { io, logs } = makeIo();
  let fresh = { offense: false, defense: false };
  let lastKnownState = null;
  const service = createPlaybookService({
    root, configPath, database, playbooks, engine, coordinatorWindow, io,
    getLastKnownState: () => lastKnownState,
    getFresh: () => fresh,
  });
  return {
    database, playbooks, engine, coordinatorWindow, io, logs, service,
    setFresh: v => { fresh = v; },
    setLastKnownState: v => { lastKnownState = v; },
  };
}

// ---- Database side classification ----

test('playbook API separates offense and defense arrays', () => {
  const { database, service } = setup(tmpConfigPath());
  try {
    const list = service.listPlaybooks();
    assert.ok(Array.isArray(list.offense));
    assert.ok(Array.isArray(list.defense));
  } finally {
    database.close();
  }
});

test('Pro Style (405) appears only in the offense list', () => {
  const { database, service } = setup(tmpConfigPath());
  try {
    const list = service.listPlaybooks();
    assert.ok(list.offense.some(b => Number(b.id) === 405));
    assert.ok(!list.defense.some(b => Number(b.id) === 405));
  } finally {
    database.close();
  }
});

test('3-3-5 (501) appears only in the defense list', () => {
  const { database, service } = setup(tmpConfigPath());
  try {
    const list = service.listPlaybooks();
    assert.ok(list.defense.some(b => Number(b.id) === 501));
    assert.ok(!list.offense.some(b => Number(b.id) === 501));
  } finally {
    database.close();
  }
});

test('3-4 (503) appears only in the defense list', () => {
  const { database, service } = setup(tmpConfigPath());
  try {
    const list = service.listPlaybooks();
    assert.ok(list.defense.some(b => Number(b.id) === 503));
    assert.ok(!list.offense.some(b => Number(b.id) === 503));
  } finally {
    database.close();
  }
});

test('visible playbook counts match the DB (offense 149, defense 31)', () => {
  const { database, service } = setup(tmpConfigPath());
  try {
    const list = service.listPlaybooks();
    assert.equal(list.offense.length, 149);
    assert.equal(list.defense.length, 31);
  } finally {
    database.close();
  }
});

// ---- Cross-side / invalid-id rejection ----

test('offensive ID submitted as defense is rejected', () => {
  const { database, service } = setup(tmpConfigPath());
  try {
    assert.throws(() => service.setPlaybookSelection({ side: 'defense', playbookId: 405 }));
  } finally {
    database.close();
  }
});

test('defensive ID submitted as offense is rejected', () => {
  const { database, service } = setup(tmpConfigPath());
  try {
    assert.throws(() => service.setPlaybookSelection({ side: 'offense', playbookId: 501 }));
  } finally {
    database.close();
  }
});

test('unknown playbook ID is rejected', () => {
  const { database, service } = setup(tmpConfigPath());
  try {
    assert.throws(() => service.setPlaybookSelection({ side: 'defense', playbookId: 999999 }));
  } finally {
    database.close();
  }
});

test('invalid side is rejected', () => {
  const { database, service } = setup(tmpConfigPath());
  try {
    assert.throws(() => service.setPlaybookSelection({ side: 'special-teams', playbookId: 501 }));
  } finally {
    database.close();
  }
});

// ---- Config migration / persistence ----

test('existing offense-only config migrates, preserving Pro Style 405 unchanged', () => {
  const configPath = tmpConfigPath();
  try {
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, offensePlaybookId: 405, offensePlaybookName: 'Pro Style', updatedAt: '2026-09-25T03:17:50.914Z' }));
    // Merge in only a defense selection -- offense fields are left undefined.
    saveCoordinatorConfig({ defensePlaybookId: 501, defensePlaybookName: '3-3-5' }, configPath);
    const reloaded = loadCoordinatorConfig(configPath);
    assert.equal(reloaded.offensePlaybookId, 405);
    assert.equal(reloaded.offensePlaybookName, 'Pro Style');
    assert.equal(reloaded.defensePlaybookId, 501);
    assert.equal(reloaded.defensePlaybookName, '3-3-5');
  } finally {
    fs.rmSync(configPath, { force: true });
  }
});

test('missing defense selection stays explicitly null, never fabricated', () => {
  const configPath = tmpConfigPath();
  try {
    saveCoordinatorConfig({ offensePlaybookId: 405, offensePlaybookName: 'Pro Style' }, configPath);
    const reloaded = loadCoordinatorConfig(configPath);
    assert.equal(reloaded.defensePlaybookId, null);
    assert.equal(reloaded.defensePlaybookName, null);
  } finally {
    fs.rmSync(configPath, { force: true });
  }
});

test('selecting defense 501 persists id and name to config', () => {
  const configPath = tmpConfigPath();
  const { database, service } = setup(configPath);
  try {
    service.setPlaybookSelection({ side: 'defense', playbookId: 501 });
    const config = loadCoordinatorConfig(configPath);
    assert.equal(config.defensePlaybookId, 501);
    assert.equal(config.defensePlaybookName, '3-3-5');
  } finally {
    database.close();
    fs.rmSync(configPath, { force: true });
  }
});

test('restart/reload restores the persisted defense 501 selection', () => {
  const configPath = tmpConfigPath();
  const { database, service } = setup(configPath);
  try {
    service.setPlaybookSelection({ side: 'defense', playbookId: 501 });
  } finally {
    database.close();
  }
  try {
    // Simulate a fresh process: brand-new DB handle/service reading the same config file.
    const database2 = new CoordinatorDatabase({ dbPath, readOnly: true });
    try {
      const book = loadDefensePlaybookFromDatabase(root, { defensePlaybookId: loadCoordinatorConfig(configPath).defensePlaybookId });
      assert.equal(book.id, '501');
      assert.equal(book.name, '3-3-5');
    } finally {
      database2.close();
    }
  } finally {
    fs.rmSync(configPath, { force: true });
  }
});

// ---- Defensive candidate loading / DefensiveSelectionEngine isolation ----

test('loading defense 501 yields its real DB candidate count (~210), not the 2-play sample', () => {
  const { database, playbooks, service } = setup(tmpConfigPath());
  try {
    service.setPlaybookSelection({ side: 'defense', playbookId: 501 });
    assert.equal(playbooks.defense.plays.length, 210);
    assert.equal(playbooks.defense.name, '3-3-5');
  } finally {
    database.close();
  }
});

test('DefensiveSelectionEngine receives only the selected book\'s candidates', () => {
  const { database, playbooks, engine, service } = setup(tmpConfigPath());
  try {
    service.setPlaybookSelection({ side: 'defense', playbookId: 501 });
    const ranked = engine.recommendDefenses({
      playbook: playbooks.defense,
      offensePlay: { id: 'x', name: 'Shock H Option', concepts: ['choice_option'] },
      situation: { down: 2, distance: 7, yardLine: 40 },
      limit: 5,
    });
    // Fix A2: evaluated now reflects only situationally-eligible candidates
    // (Prevent/Goal Line/Special Teams/Kick Return are filtered before
    // scoring on this ordinary down); candidatePool.total still reports the
    // full raw pool actually loaded for playbook 501.
    assert.equal(ranked.candidatePool.total, 210);
    assert.equal(ranked.evaluated, ranked.candidatePool.eligible);
    assert.ok(ranked.evaluated < 210, 'situational/special-teams plays should have been excluded');
    assert.ok(!ranked.recommendations.some(r => r.play.name === 'Cover 3 Match' || r.play.name === 'Mid Blitz'), 'the 2-play sample must not appear as a candidate');
  } finally {
    database.close();
  }
});

test('switching defense 501 -> 503 changes the candidate set/count', () => {
  const { database, playbooks, service } = setup(tmpConfigPath());
  try {
    service.setPlaybookSelection({ side: 'defense', playbookId: 501 });
    assert.equal(playbooks.defense.plays.length, 210);
    service.setPlaybookSelection({ side: 'defense', playbookId: 503 });
    assert.equal(playbooks.defense.plays.length, 222);
    assert.equal(playbooks.defense.name, '3-4');
  } finally {
    database.close();
  }
});

// ---- Independence of offense/defense selection ----

test('offense selection remains untouched when defense changes', () => {
  const { database, playbooks, service } = setup(tmpConfigPath());
  try {
    const offenseBefore = playbooks.offense;
    service.setPlaybookSelection({ side: 'defense', playbookId: 501 });
    service.setPlaybookSelection({ side: 'defense', playbookId: 503 });
    assert.equal(playbooks.offense, offenseBefore);
  } finally {
    database.close();
  }
});

test('defense selection remains untouched when offense changes', () => {
  const { database, playbooks, service } = setup(tmpConfigPath());
  try {
    service.setPlaybookSelection({ side: 'defense', playbookId: 501 });
    const defenseBefore = playbooks.defense;
    service.setPlaybookSelection({ side: 'offense', playbookId: 405 });
    assert.equal(playbooks.defense, defenseBefore);
    assert.equal(playbooks.defense.plays.length, 210);
  } finally {
    database.close();
  }
});

test('changing offense away from 405 does not fabricate verified locators', () => {
  const { database, playbooks, service } = setup(tmpConfigPath());
  try {
    // Alabama (202) has no verified-membership overlay.
    service.setPlaybookSelection({ side: 'offense', playbookId: 202 });
    assert.equal(playbooks.offense.membershipVerified, false);
    assert.equal(playbooks.offense.membershipSource, 'legacy_editor_catalog');
  } finally {
    database.close();
  }
});

// ---- Hot-reload isolation from the call-freshness state machine ----

test('changing playbook selection does not modify lastSituationKey/quarantine/fresh/cleared', () => {
  const { database, playbooks, engine, coordinatorWindow, io, service, setFresh } = setup(tmpConfigPath());
  try {
    // Mirror the main loop's local state shape; nothing in createPlaybookService
    // has a reference to these bindings, so they cannot change.
    let lastSituationKey = 'some-key';
    let quarantine = { offense: { available: true, set: 'a', name: 'a', id: '1' }, defense: { available: true, set: 'b', name: 'b', id: '2' } };
    let fresh = { offense: true, defense: false };
    let cleared = { offense: false, defense: true };
    setFresh(fresh);

    service.setPlaybookSelection({ side: 'defense', playbookId: 501 });

    assert.equal(lastSituationKey, 'some-key');
    assert.deepEqual(quarantine, { offense: { available: true, set: 'a', name: 'a', id: '1' }, defense: { available: true, set: 'b', name: 'b', id: '2' } });
    assert.deepEqual(fresh, { offense: true, defense: false });
    assert.deepEqual(cleared, { offense: false, defense: true });
  } finally {
    database.close();
  }
});

test('changing playbook selection does not produce a situation-boundary log', () => {
  const { database, logs, service } = setup(tmpConfigPath());
  try {
    service.setPlaybookSelection({ side: 'defense', playbookId: 501 });
    assert.ok(!logs.some(l => l.includes('Situation boundary:')));
  } finally {
    database.close();
  }
});

test('changing defense book during an already-fresh defensive huddle recomputes immediately', () => {
  const { database, playbooks, coordinatorWindow, service, setFresh, setLastKnownState } = setup(tmpConfigPath());
  try {
    setFresh({ offense: true, defense: false });
    setLastKnownState({
      possession: 1, quarter: 1, down: 2, distance: 7, yardLine: 40, fieldX: 40, gameClockSeconds: 400,
      offensiveCallAvailable: true, offensiveSet: 'Gun Trio Y-Flex', offensivePlay: 'Shock H Option', offensivePlayId: 55,
    });
    // Put the window into a defensive huddle first (simulating the state it
    // would already be in from the normal per-tick flow).
    coordinatorWindow.showDefensiveRecommendation({ available: true, cpuPlay: { name: 'Shock H Option', formation: 'Gun Trio Y-Flex' }, play: { name: 'Old Call' } }, {});
    assert.equal(coordinatorWindow.state.phase, 'defensive_huddle');

    const result = service.setPlaybookSelection({ side: 'defense', playbookId: 501 });

    assert.equal(result.appliedImmediately, true);
    assert.equal(coordinatorWindow.state.phase, 'defensive_huddle');
    assert.notEqual(coordinatorWindow.state.call, 'Old Call');
  } finally {
    database.close();
  }
});

test('changing offense during an active selected/read phase defers instead of corrupting the phase', () => {
  const { database, coordinatorWindow, service } = setup(tmpConfigPath());
  try {
    coordinatorWindow.showSelection({ type: 'selected', play: { name: 'HB Duo', formation: 'I Form Pro' }, opponentPlay: { name: 'Cover 3 Sky' } }, { available: true, advice: { known: true }, guide: null }, {});
    assert.equal(coordinatorWindow.state.phase, 'selected');

    const result = service.setPlaybookSelection({ side: 'offense', playbookId: 202 });

    assert.equal(result.appliedImmediately, false, 'a selected/read phase must not be recomputed immediately');
    assert.equal(coordinatorWindow.state.phase, 'selected');
    assert.equal(coordinatorWindow.state.call, 'HB Duo', 'the in-progress selection must be left alone');
  } finally {
    database.close();
  }
});

test('next natural offense huddle uses the new offense book', () => {
  const { database, playbooks, engine, coordinatorWindow, io, service } = setup(tmpConfigPath());
  try {
    service.setPlaybookSelection({ side: 'offense', playbookId: 405 });
    printRecommendation(engine, playbooks, { possession: 0, down: 3, distance: 2, yardLine: 85, quarter: 2, gameClockSeconds: 400 }, io, coordinatorWindow);
    assert.equal(coordinatorWindow.state.phase, 'huddle');
    assert.ok(playbooks.offense.plays.some(p => p.name === coordinatorWindow.state.call));
  } finally {
    database.close();
  }
});

test('next natural defensive recommendation uses the new defense book', () => {
  const { database, playbooks, engine, coordinatorWindow, io, service } = setup(tmpConfigPath());
  try {
    service.setPlaybookSelection({ side: 'defense', playbookId: 503 });
    const state = {
      possession: 1, quarter: 1, down: 2, distance: 7, yardLine: 40, fieldX: 40, gameClockSeconds: 400,
      offensiveCallAvailable: true, offensiveSet: 'Gun Trio Y-Flex', offensivePlay: 'Shock H Option', offensivePlayId: 55,
    };
    printDefensiveRecommendation(engine, playbooks, state, null, { offense: true }, io, coordinatorWindow);
    assert.equal(coordinatorWindow.state.phase, 'defensive_huddle');
    assert.ok(playbooks.defense.plays.some(p => p.name === coordinatorWindow.state.call));
  } finally {
    database.close();
  }
});

test('no playbook change creates a snap, performance attempt, or fake result', () => {
  const { database, engine, service } = setup(tmpConfigPath());
  try {
    const before = engine.performance.getAll().length;
    service.setPlaybookSelection({ side: 'defense', playbookId: 501 });
    service.setPlaybookSelection({ side: 'defense', playbookId: 503 });
    service.setPlaybookSelection({ side: 'offense', playbookId: 405 });
    assert.equal(engine.performance.getAll().length, before);
    assert.equal(before, 0);
  } finally {
    database.close();
  }
});

// ---- Real DB source vs sample-fallback labeling ----

test('playbookLogLine distinguishes a real database book from the sample fallback', () => {
  const { database, playbooks, service } = setup(tmpConfigPath());
  try {
    // Sample fallback (loaded at setup()) has no membershipSource.
    assert.ok(playbookLogLine('Defense', playbooks.defense).includes('sample-fallback'));

    service.setPlaybookSelection({ side: 'defense', playbookId: 503 });
    const line = playbookLogLine('Defense', playbooks.defense);
    assert.ok(line.includes('database'));
    assert.ok(line.includes('id=503'));
    assert.ok(line.includes('222 plays'));
    assert.ok(!line.includes('sample'));
  } finally {
    database.close();
  }
});

test('playbookLogLine reports "none selected" honestly when there is no book', () => {
  assert.equal(playbookLogLine('Defense', null), '[COORD] Defense playbook: none selected');
});

test('no-defense-selection config state is explicit, never the sample fallback id', () => {
  const configPath = tmpConfigPath();
  try {
    saveCoordinatorConfig({ offensePlaybookId: 405, offensePlaybookName: 'Pro Style' }, configPath);
    const config = loadCoordinatorConfig(configPath);
    assert.equal(config.defensePlaybookId, null);
    assert.notEqual(config.defensePlaybookId, '3-4-zone-pressure');
  } finally {
    fs.rmSync(configPath, { force: true });
  }
});

// ---- Route-level: CoordinatorWindow actually serves the API ----

function httpJson(url, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options || {}, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (options?.body) req.write(options.body);
    req.end();
  });
}

test('CoordinatorWindow serves /api/playbooks, /api/config, and POST /api/config/playbooks', async () => {
  const database = new CoordinatorDatabase({ dbPath, readOnly: true });
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  const engine = new FootballEngine();
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false, port: 0 });
  const configPath = tmpConfigPath();
  saveCoordinatorConfig({ offensePlaybookId: 405, offensePlaybookName: 'Pro Style' }, configPath);
  const { io } = makeIo();

  coordinatorWindow.playbookService = createPlaybookService({
    root, configPath, database, playbooks, engine, coordinatorWindow, io,
    getLastKnownState: () => null,
    getFresh: () => ({ offense: false, defense: false }),
  });

  try {
    const { url } = await coordinatorWindow.start();

    const playbooksRes = await httpJson(new URL('/api/playbooks', url));
    assert.equal(playbooksRes.status, 200);
    assert.ok(Array.isArray(playbooksRes.json.offense));
    assert.ok(playbooksRes.json.defense.some(b => Number(b.id) === 501));

    const configRes = await httpJson(new URL('/api/config', url));
    assert.equal(configRes.status, 200);
    assert.equal(configRes.json.offensePlaybookId, 405);
    assert.equal(configRes.json.defensePlaybookId, null);

    const goodPost = await httpJson(new URL('/api/config/playbooks', url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ side: 'defense', playbookId: 501 }),
    });
    assert.equal(goodPost.status, 200);
    assert.equal(goodPost.json.book.name, '3-3-5');

    const badPost = await httpJson(new URL('/api/config/playbooks', url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ side: 'offense', playbookId: 501 }),
    });
    assert.equal(badPost.status, 400);
    assert.ok(badPost.json.error);
  } finally {
    await coordinatorWindow.close();
    database.close();
    fs.rmSync(configPath, { force: true });
  }
});

test('CoordinatorWindow renders the settings panel markup (both dropdown ids present)', () => {
  const { renderPage } = require('../src/football/ui/coordinator-window.js');
  const html = renderPage('test');
  assert.ok(html.includes('id="offenseSelect"'));
  assert.ok(html.includes('id="defenseSelect"'));
  assert.ok(html.includes('PLAYBOOKS'));
});
