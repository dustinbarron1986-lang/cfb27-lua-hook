'use strict';

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolvePath(repoRoot, configured, fallback) {
  const value = configured || fallback;
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function normalizePlaybook(doc, side) {
  const plays = Array.isArray(doc) ? doc : doc?.plays;
  if (!Array.isArray(plays)) throw new Error(`Invalid ${side} playbook: expected a plays array`);
  return {
    id: doc.id || `${side}-manual`,
    name: doc.name || `${side} manual playbook`,
    side: doc.side || side.toUpperCase(),
    status: doc.status || 'manual',
    plays: plays.map((play, index) => ({
      id: String(play.id ?? `${side}-${index}`),
      name: play.name || null,
      formation: play.formation || play.set || null,
      personnel: play.personnel || null,
      type: play.type || null,
      concepts: Array.isArray(play.concepts) ? play.concepts : [],
      presentationFamily: play.presentationFamily || null,
      setupBy: Array.isArray(play.setupBy) ? play.setupBy : [],
      ...play,
    })),
  };
}

function normalizeDatabasePlay(play) {
  // DatabasePlaybookRepository already returns a rich, normalized play object
  // (id, name, formation, concepts, primaryConcept, presentationFamily, etc.).
  // The one shape gap versus the sample-JSON loader is `setupBy` (sequencing/
  // setup-value data), which the recovered catalog/DB does not carry.
  // PlaySelectionEngine already treats a missing setupBy as "no setup value"
  // rather than inventing one, so this is a safe, explicit default, not a guess.
  return {
    setupBy: [],
    ...play,
    id: String(play.id),
  };
}

// Loads the offense playbook from the SQLite coordinator DB (data/coordinator.db)
// using the persisted playbook selection (data/coordinator-config.json), or an
// explicit config.offensePlaybookId override. Returns null (triggering the
// sample-JSON fallback below) whenever the DB, config, node:sqlite, or a usable
// playbook simply aren't available -- this must never throw during startup.
function loadOffensePlaybookFromDatabase(repoRoot, config) {
  let CoordinatorDatabase;
  let DatabasePlaybookRepository;
  let loadCoordinatorConfig;
  try {
    ({ CoordinatorDatabase } = require('../football/db/coordinator-database'));
    ({ DatabasePlaybookRepository } = require('../football/playbooks/database-playbook-repository'));
    ({ loadCoordinatorConfig } = require('../football/config/coordinator-config'));
  } catch (_) {
    return null;
  }

  const dbPath = resolvePath(repoRoot, config.coordinatorDatabase, 'data/coordinator.db');
  if (!fs.existsSync(dbPath)) return null;

  const configPath = resolvePath(repoRoot, config.coordinatorConfig, 'data/coordinator-config.json');
  const saved = loadCoordinatorConfig(configPath);
  const selector = config.offensePlaybookId ?? saved?.offensePlaybookId;
  if (selector == null) return null;

  let database = null;
  try {
    database = new CoordinatorDatabase({ dbPath, readOnly: true });
    const repo = new DatabasePlaybookRepository(database);
    const book = repo.get(selector, { side: 'offense' });
    if (!book || !Array.isArray(book.plays) || !book.plays.length) return null;

    return {
      id: String(book.id),
      name: book.name,
      side: 'OFFENSE',
      status: book.membershipSource,
      membershipVerified: book.membershipVerified,
      membershipSource: book.membershipSource,
      rawCatalogPlayCount: book.rawCatalogPlayCount,
      plays: book.plays.map(normalizeDatabasePlay),
    };
  } catch (_) {
    return null;
  } finally {
    if (database) database.close();
  }
}

// Unlike offense, there is no persisted/verified defensive playbook selection
// anywhere in the recovered data (no verified-membership overlay for any of the
// 41 defense playbooks in the DB, and the `games` table has no defense_playbook
// column) -- so, unlike loadOffensePlaybookFromDatabase, this NEVER activates by
// itself. It only loads from the DB when the caller explicitly names a playbook
// via config.defensePlaybookId, so we never guess which of the 41 catalog
// defense playbooks corresponds to the user's real active one.
function loadDefensePlaybookFromDatabase(repoRoot, config) {
  if (config.defensePlaybookId == null) return null;

  let CoordinatorDatabase;
  let DatabasePlaybookRepository;
  try {
    ({ CoordinatorDatabase } = require('../football/db/coordinator-database'));
    ({ DatabasePlaybookRepository } = require('../football/playbooks/database-playbook-repository'));
  } catch (_) {
    return null;
  }

  const dbPath = resolvePath(repoRoot, config.coordinatorDatabase, 'data/coordinator.db');
  if (!fs.existsSync(dbPath)) return null;

  let database = null;
  try {
    database = new CoordinatorDatabase({ dbPath, readOnly: true });
    const repo = new DatabasePlaybookRepository(database);
    const book = repo.get(config.defensePlaybookId, { side: 'defense' });
    if (!book || !Array.isArray(book.plays) || !book.plays.length) return null;

    return {
      id: String(book.id),
      name: book.name,
      side: 'DEFENSE',
      status: book.membershipSource,
      membershipVerified: book.membershipVerified,
      membershipSource: book.membershipSource,
      rawCatalogPlayCount: book.rawCatalogPlayCount,
      plays: book.plays.map(normalizeDatabasePlay),
    };
  } catch (_) {
    return null;
  } finally {
    if (database) database.close();
  }
}

function loadPlaybooks(repoRoot, config = {}) {
  const offenseFromDb = config.useDatabase === false
    ? null
    : loadOffensePlaybookFromDatabase(repoRoot, config);
  const defenseFromDb = config.useDatabase === false
    ? null
    : loadDefensePlaybookFromDatabase(repoRoot, config);

  const offensePath = resolvePath(
    repoRoot,
    config.offensePlaybook,
    'data/playbooks/offense/pro-style.sample.json'
  );
  const defensePath = resolvePath(
    repoRoot,
    config.defensePlaybook,
    'data/playbooks/defense/3-4-zone-pressure.sample.json'
  );

  return {
    offense: offenseFromDb || normalizePlaybook(readJson(offensePath), 'offense'),
    defense: defenseFromDb || normalizePlaybook(readJson(defensePath), 'defense'),
    paths: {
      offense: offenseFromDb ? `database:${offenseFromDb.id}` : offensePath,
      defense: defenseFromDb ? `database:${defenseFromDb.id}` : defensePath,
    },
  };
}

function findPlay(playbook, { id, name, set } = {}) {
  const idString = id == null ? null : String(id);
  const norm = value => String(value || '').trim().toLowerCase();
  const nameNorm = norm(name);
  const setNorm = norm(set);

  if (idString) {
    const byId = playbook.plays.find(p => String(p.id) === idString || String(p.runtimeId || '') === idString);
    if (byId) return byId;
  }
  if (nameNorm) {
    const exact = playbook.plays.find(p => norm(p.name) === nameNorm && (!setNorm || norm(p.formation) === setNorm));
    if (exact) return exact;
    const byName = playbook.plays.find(p => norm(p.name) === nameNorm);
    if (byName) return byName;
  }
  return null;
}

module.exports = {
  loadPlaybooks,
  findPlay,
  normalizePlaybook,
  loadOffensePlaybookFromDatabase,
  loadDefensePlaybookFromDatabase,
};
