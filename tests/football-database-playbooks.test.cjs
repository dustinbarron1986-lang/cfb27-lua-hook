'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(root, 'data', 'coordinator.db');

const { CoordinatorDatabase } = require('../src/football/db/coordinator-database');
const { DatabasePlaybookRepository } = require('../src/football/playbooks/database-playbook-repository');
const { VerifiedMembershipStore } = require('../src/football/playbooks/verified-membership');
const { loadCoordinatorConfig, saveCoordinatorConfig } = require('../src/football/config/coordinator-config');
const { loadPlaybooks, loadOffensePlaybookFromDatabase } = require('../src/coordinator/playbook-loader.cjs');
const { FootballEngine } = require('../src/football/engine');

function openReadOnlyDb() {
  return new CoordinatorDatabase({ dbPath, readOnly: true });
}

test('coordinator DB opens successfully from lua-hook/data with the expected static-catalog counts', () => {
  const database = openReadOnlyDb();
  try {
    const stats = database.staticStats();
    assert.equal(stats.playbooks, 194);
    assert.equal(stats.plays, 15476);
    assert.equal(stats.playbookPlayLinks, 73872);

    const locators = database.db.prepare('SELECT COUNT(*) AS n FROM play_locators').get().n;
    const games = database.db.prepare('SELECT COUNT(*) AS n FROM games').get().n;
    const snaps = database.db.prepare('SELECT COUNT(*) AS n FROM snaps').get().n;
    assert.equal(locators, 43);
    assert.equal(games, 11);
    assert.equal(snaps, 12);
  } finally {
    database.close();
  }
});

test('Pro Style (405) resolves and is membership-verified', () => {
  const database = openReadOnlyDb();
  try {
    const repo = new DatabasePlaybookRepository(database);
    const book = repo.resolve(405, { side: 'offense' });
    assert.ok(book);
    assert.equal(book.name, 'Pro Style');
    assert.equal(book.membershipVerified, true);
    assert.equal(book.exactRecommendationsAllowed, true);
  } finally {
    database.close();
  }
});

test('Southern Miss (295) resolves but is not membership-verified (recommendation-locked)', () => {
  const database = openReadOnlyDb();
  try {
    const repo = new DatabasePlaybookRepository(database);
    const book = repo.resolve(295, { side: 'offense' });
    assert.ok(book);
    assert.equal(book.name, 'Southern Miss');
    assert.equal(book.membershipVerified, false);
    assert.equal(book.exactRecommendationsAllowed, false);
  } finally {
    database.close();
  }
});

test('Pro Style contains a realistic full play set, not the 3-play sample', () => {
  const database = openReadOnlyDb();
  try {
    const repo = new DatabasePlaybookRepository(database);
    const book = repo.get(405, { side: 'offense' });
    assert.ok(book.plays.length > 400, `expected hundreds of verified plays, got ${book.plays.length}`);
    assert.equal(book.plays.length, 486);

    const paJetSweep = book.plays.find(p => p.name === 'PA JET SWEEP' && p.formation === 'Singleback Ace');
    assert.ok(paJetSweep, 'expected to find PA JET SWEEP under Singleback Ace');
  } finally {
    database.close();
  }
});

test('recommendations can be generated from a DB-loaded playbook', () => {
  const offense = loadOffensePlaybookFromDatabase(root, { offensePlaybookId: 405 });
  assert.ok(offense);
  assert.equal(offense.plays.length, 486);

  const engine = new FootballEngine();
  const ranked = engine.recommendPlays({
    playbook: offense,
    situation: { down: 2, distance: 5, yardLine: 45, quarter: 2, flags: {} },
    limit: 5,
  });

  assert.equal(ranked.evaluated, 486);
  assert.ok(ranked.recommendations.length > 0);
  assert.ok(ranked.recommendations[0].play.name);
  assert.equal(ranked.recommendations[0].selectionPolicy, 'pre_call_no_current_exact_defense');
});

test('sample JSON fallback still works when DB use is disabled', () => {
  const playbooks = loadPlaybooks(root, { useDatabase: false });
  assert.equal(playbooks.offense.plays.length, 3);
  assert.equal(playbooks.offense.status, 'sample-only');
});

test('sample JSON fallback still works when the DB has no usable selection', () => {
  const playbooks = loadPlaybooks(root, {
    coordinatorConfig: path.join(os.tmpdir(), `cfb27-nonexistent-config-${process.pid}.json`),
  });
  assert.equal(playbooks.offense.plays.length, 3);
});

test('persisted selected playbook can be read back', () => {
  const tmpConfigPath = path.join(os.tmpdir(), `cfb27-coordinator-config-test-${process.pid}.json`);
  try {
    saveCoordinatorConfig({ offensePlaybookId: 405, offensePlaybookName: 'Pro Style' }, tmpConfigPath);
    const reloaded = loadCoordinatorConfig(tmpConfigPath);
    assert.equal(reloaded.offensePlaybookId, 405);
    assert.equal(reloaded.offensePlaybookName, 'Pro Style');
  } finally {
    fs.rmSync(tmpConfigPath, { force: true });
  }
});

test('verified membership and locator data is preserved', () => {
  const membershipPath = path.join(root, 'data', 'playbooks', 'verified-memberships.json');
  const store = new VerifiedMembershipStore({ path: membershipPath });
  assert.equal(store.isVerified(405), true);
  assert.equal(store.isVerified(295), false);

  const stats = store.stats(405);
  assert.equal(stats.formations, 34);
  assert.equal(stats.playPaths, 486);

  const database = openReadOnlyDb();
  try {
    const locator = database.playLocator(405, 'PA Jet Sweep');
    assert.ok(locator);
    assert.equal(locator.formation, 'Ace');
  } finally {
    database.close();
  }
});

test('unknown/missing locator does not get invented', () => {
  const database = openReadOnlyDb();
  try {
    const locator = database.playLocator(405, 'Totally Fictional Play Nobody Has Ever Run');
    assert.equal(locator, null);
  } finally {
    database.close();
  }
});

test('no mutation of the recovery-source DB in the sibling brain-v0.9 repo', (t) => {
  const sourceDbPath = path.join(root, '..', 'cfb27-coordinator-brain-v0.9', 'data', 'coordinator.db');
  if (!fs.existsSync(sourceDbPath)) {
    t.skip('sibling recovery-source repo not present on this machine');
    return;
  }
  const knownGoodHash = '43e7f82cd16d24dcf05cec05e5863b709b4429e652b3872ba00a3a07a6f56ea7';
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(sourceDbPath)).digest('hex');
  assert.equal(actualHash, knownGoodHash);
});
