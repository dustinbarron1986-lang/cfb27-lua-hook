const fs = require('fs');
const path = require('path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  throw new Error(
    'CFB27 Coordinator persistent storage requires Node.js with the built-in node:sqlite module (Node 22.5+ recommended). ' +
    `Original error: ${error.message}`
  );
}

const DEFAULT_DB_PATH = path.join(__dirname, '../../../data/coordinator.db');
const DEFAULT_INDEX_PATH = path.join(__dirname, '../../../data/playbooks/cfb27-playbook-index.json');
const SCHEMA_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function json(value) {
  return JSON.stringify(value == null ? null : value);
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

class CoordinatorDatabase {
  constructor(options = {}) {
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.indexPath = options.indexPath || DEFAULT_INDEX_PATH;
    this.readOnly = Boolean(options.readOnly);

    if (!this.readOnly) fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath, { readOnly: this.readOnly });
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (!this.readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this._ensureSchema();
      this._ensureStaticCatalog();
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS playbooks (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        side TEXT NOT NULL,
        sort_order INTEGER,
        visible INTEGER NOT NULL DEFAULT 1,
        show_on_custom INTEGER NOT NULL DEFAULT 1,
        asset_name TEXT,
        source_file TEXT,
        play_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_playbooks_side_name ON playbooks(side, name);

      CREATE TABLE IF NOT EXISTS plays (
        catalog_id TEXT PRIMARY KEY,
        side TEXT NOT NULL,
        name TEXT NOT NULL,
        play_kind TEXT,
        play_type INTEGER,
        classification INTEGER,
        formation_id INTEGER,
        set_id INTEGER,
        run_hole TEXT,
        primary_concept TEXT,
        concepts_json TEXT NOT NULL DEFAULT '[]',
        modifiers_json TEXT NOT NULL DEFAULT '[]',
        assignment_families_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_plays_name ON plays(name);
      CREATE INDEX IF NOT EXISTS idx_plays_side_name ON plays(side, name);
      CREATE INDEX IF NOT EXISTS idx_plays_set ON plays(set_id);

      CREATE TABLE IF NOT EXISTS playbook_plays (
        playbook_id INTEGER NOT NULL,
        catalog_id TEXT NOT NULL,
        PRIMARY KEY (playbook_id, catalog_id),
        FOREIGN KEY(playbook_id) REFERENCES playbooks(id) ON DELETE CASCADE,
        FOREIGN KEY(catalog_id) REFERENCES plays(catalog_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_playbook_plays_catalog ON playbook_plays(catalog_id);

      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT UNIQUE,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        offense_playbook_id INTEGER,
        offense_playbook_name TEXT,
        opponent_name TEXT,
        notes TEXT,
        FOREIGN KEY(offense_playbook_id) REFERENCES playbooks(id)
      );

      CREATE TABLE IF NOT EXISTS snaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER NOT NULL,
        sequence_no INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        quarter INTEGER,
        game_clock INTEGER,
        play_clock INTEGER,
        down INTEGER,
        distance INTEGER,
        field_x INTEGER,
        yard_line INTEGER,
        possession INTEGER,
        home_score INTEGER,
        away_score INTEGER,
        offensive_play_id TEXT,
        offensive_play_name TEXT,
        offensive_formation TEXT,
        offensive_concept TEXT,
        defensive_play_id TEXT,
        defensive_play_name TEXT,
        defensive_formation TEXT,
        defensive_family TEXT,
        yards REAL,
        first_down INTEGER,
        touchdown INTEGER,
        turnover INTEGER,
        change_of_possession INTEGER,
        result_confidence TEXT,
        event_json TEXT NOT NULL,
        UNIQUE(game_id, sequence_no),
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_snaps_game_seq ON snaps(game_id, sequence_no);
      CREATE INDEX IF NOT EXISTS idx_snaps_off_play ON snaps(offensive_play_name);
      CREATE INDEX IF NOT EXISTS idx_snaps_def_play ON snaps(defensive_play_name);

      CREATE TABLE IF NOT EXISTS play_locators (
        playbook_id INTEGER NOT NULL,
        play_name TEXT NOT NULL,
        formation_name TEXT NOT NULL,
        observations INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(playbook_id, play_name, formation_name),
        FOREIGN KEY(playbook_id) REFERENCES playbooks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_play_locators_lookup
        ON play_locators(playbook_id, play_name, observations DESC);

      CREATE TABLE IF NOT EXISTS game_summaries (
        game_id INTEGER PRIMARY KEY,
        generated_at TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
      );
    `);

    this.setMetadata('schema_version', String(SCHEMA_VERSION));
  }

  _ensureStaticCatalog() {
    const current = this.getMetadata('static_catalog_loaded');
    if (current === '1') return;
    if (!fs.existsSync(this.indexPath)) {
      throw new Error(`Playbook index not found: ${this.indexPath}`);
    }

    const index = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    const playbooks = index.playbooks || [];
    const plays = index.plays || {};

    const insertBook = this.db.prepare(`
      INSERT OR REPLACE INTO playbooks
      (id, name, side, sort_order, visible, show_on_custom, asset_name, source_file, play_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPlay = this.db.prepare(`
      INSERT OR REPLACE INTO plays
      (catalog_id, side, name, play_kind, play_type, classification, formation_id, set_id, run_hole,
       primary_concept, concepts_json, modifiers_json, assignment_families_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const link = this.db.prepare(`
      INSERT OR IGNORE INTO playbook_plays(playbook_id, catalog_id) VALUES (?, ?)
    `);

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const [catalogId, play] of Object.entries(plays)) {
        insertPlay.run(
          catalogId,
          play.side || 'unknown',
          play.name || '',
          play.type || null,
          play.playType ?? null,
          play.classification ?? null,
          play.formationId ?? null,
          play.setId ?? null,
          play.runHole == null ? null : String(play.runHole),
          play.primaryConcept || null,
          json(play.concepts || []),
          json(play.modifiers || []),
          json(play.assignmentFamilies || [])
        );
      }

      for (const book of playbooks) {
        insertBook.run(
          Number(book.id),
          book.name || String(book.id),
          book.side || 'unknown',
          Number(book.order || 0),
          book.visible === false ? 0 : 1,
          book.showOnCustom === false ? 0 : 1,
          book.assetName || null,
          book.sourceFile || null,
          (book.playIds || []).length
        );
        for (const catalogId of book.playIds || []) link.run(Number(book.id), catalogId);
      }

      this.setMetadata('static_catalog_loaded', '1');
      this.setMetadata('static_catalog_loaded_at', nowIso());
      this.setMetadata('static_catalog_playbooks', String(playbooks.length));
      this.setMetadata('static_catalog_plays', String(Object.keys(plays).length));
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  getMetadata(key) {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(String(key));
    return row ? row.value : null;
  }

  setMetadata(key, value) {
    this.db.prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key), String(value));
  }

  listPlaybooks({ side = 'offense', visibleOnly = true } = {}) {
    const where = [];
    const args = [];
    if (side) { where.push('side = ?'); args.push(String(side)); }
    if (visibleOnly) where.push('visible = 1');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT id, name, side, sort_order AS sortOrder, visible, source_file AS sourceFile, play_count AS playCount
      FROM playbooks ${clause}
      ORDER BY sort_order, name
    `).all(...args).map(row => ({ ...row, visible: Boolean(row.visible), available: Number(row.playCount) > 0 }));
  }

  resolvePlaybook(selector, { side = null, visibleOnly = false } = {}) {
    if (selector == null || selector === '') return null;
    const raw = String(selector).trim();
    const numeric = /^\d+$/.test(raw);
    const clauses = [numeric ? 'id = ?' : 'lower(name) = lower(?)'];
    const args = [numeric ? Number(raw) : raw];
    if (side) { clauses.push('side = ?'); args.push(String(side)); }
    if (visibleOnly) clauses.push('visible = 1');
    return this.db.prepare(`SELECT * FROM playbooks WHERE ${clauses.join(' AND ')} LIMIT 1`).get(...args) || null;
  }

  playbookPlays(playbookId) {
    const rows = this.db.prepare(`
      SELECT p.*
      FROM plays p
      JOIN playbook_plays pp ON pp.catalog_id = p.catalog_id
      WHERE pp.playbook_id = ?
      ORDER BY p.name, p.set_id, p.catalog_id
    `).all(Number(playbookId));
    return rows.map(row => ({
      catalogId: row.catalog_id,
      side: row.side,
      name: row.name,
      playKind: row.play_kind,
      playType: row.play_type,
      classification: row.classification,
      formationId: row.formation_id,
      setId: row.set_id,
      runHole: row.run_hole,
      primaryConcept: row.primary_concept,
      concepts: parseJson(row.concepts_json, []),
      modifiers: parseJson(row.modifiers_json, []),
      assignmentFamilies: parseJson(row.assignment_families_json, [])
    }));
  }

  catalogPlaysByName(name, { side = 'offense' } = {}) {
    const rows = this.db.prepare(`
      SELECT *
      FROM plays
      WHERE lower(name) = lower(?) AND (? IS NULL OR side = ?)
      ORDER BY catalog_id
    `).all(String(name || ''), side || null, side || null);
    return rows.map(row => ({
      catalogId: row.catalog_id,
      side: row.side,
      name: row.name,
      playKind: row.play_kind,
      playType: row.play_type,
      classification: row.classification,
      formationId: row.formation_id,
      setId: row.set_id,
      runHole: row.run_hole,
      primaryConcept: row.primary_concept,
      concepts: parseJson(row.concepts_json, []),
      modifiers: parseJson(row.modifiers_json, []),
      assignmentFamilies: parseJson(row.assignment_families_json, [])
    }));
  }

  staticStats() {
    const books = this.db.prepare('SELECT COUNT(*) AS n FROM playbooks').get().n;
    const plays = this.db.prepare('SELECT COUNT(*) AS n FROM plays').get().n;
    const links = this.db.prepare('SELECT COUNT(*) AS n FROM playbook_plays').get().n;
    return { playbooks: Number(books), plays: Number(plays), playbookPlayLinks: Number(links), dbPath: this.dbPath };
  }

  startGame({ externalId = null, offensePlaybookId = null, offensePlaybookName = null, opponentName = null, notes = null } = {}) {
    if (externalId) {
      const existing = this.db.prepare('SELECT * FROM games WHERE external_id = ?').get(String(externalId));
      if (existing) return existing;
    }
    const info = this.db.prepare(`
      INSERT INTO games(external_id, started_at, offense_playbook_id, offense_playbook_name, opponent_name, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      externalId == null ? null : String(externalId),
      nowIso(),
      offensePlaybookId == null ? null : Number(offensePlaybookId),
      offensePlaybookName || null,
      opponentName || null,
      notes || null
    );
    return this.getGame(Number(info.lastInsertRowid));
  }

  getGame(gameId) {
    return this.db.prepare('SELECT * FROM games WHERE id = ?').get(Number(gameId)) || null;
  }

  endGame(gameId) {
    this.db.prepare('UPDATE games SET ended_at = COALESCE(ended_at, ?) WHERE id = ?').run(nowIso(), Number(gameId));
    const summary = this.summarizeGame(gameId);
    this.db.prepare(`
      INSERT INTO game_summaries(game_id, generated_at, summary_json)
      VALUES (?, ?, ?)
      ON CONFLICT(game_id) DO UPDATE SET generated_at = excluded.generated_at, summary_json = excluded.summary_json
    `).run(Number(gameId), nowIso(), json(summary));
    return summary;
  }

  nextSequence(gameId) {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence_no), 0) + 1 AS n FROM snaps WHERE game_id = ?').get(Number(gameId));
    return Number(row.n || 1);
  }

  recordSnap(gameId, event, sequenceNo = null) {
    const seq = sequenceNo || this.nextSequence(gameId);
    const s = event.situation || {};
    const r = event.result || {};
    const p = event.play || {};
    const o = event.opponentPlay || {};
    const info = this.db.prepare(`
      INSERT INTO snaps(
        game_id, sequence_no, timestamp,
        quarter, game_clock, play_clock, down, distance, field_x, yard_line, possession, home_score, away_score,
        offensive_play_id, offensive_play_name, offensive_formation, offensive_concept,
        defensive_play_id, defensive_play_name, defensive_formation, defensive_family,
        yards, first_down, touchdown, turnover, change_of_possession, result_confidence, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(gameId), seq, event.timestamp || nowIso(),
      s.quarter ?? null, s.gameClockSeconds ?? s.clockSeconds ?? null, s.playClockSeconds ?? null,
      s.down ?? null, s.distance ?? null, s.fieldX ?? null, s.yardLine ?? null, s.possession ?? null,
      s.homeScore ?? null, s.awayScore ?? null,
      p.id == null ? null : String(p.id), p.name || null, p.formation || null, p.primaryConcept || p.concepts?.[0] || null,
      o.id == null ? null : String(o.id), o.name || null, o.formation || o.set || null,
      o.coverageFamily || o.family || null,
      r.yards ?? null, r.firstDown ? 1 : 0, r.touchdown ? 1 : 0, r.turnover ? 1 : 0,
      r.changeOfPossession ? 1 : 0, r.confidence || null, json(event)
    );
    return { id: Number(info.lastInsertRowid), sequenceNo: seq };
  }

  gameEvents(gameId) {
    const rows = this.db.prepare('SELECT event_json FROM snaps WHERE game_id = ? ORDER BY sequence_no').all(Number(gameId));
    return rows.map(row => parseJson(row.event_json, null)).filter(Boolean);
  }

  gameSnaps(gameId) {
    return this.db.prepare('SELECT * FROM snaps WHERE game_id = ? ORDER BY sequence_no').all(Number(gameId));
  }

  observePlayLocator(playbookId, playName, formationName) {
    if (!playbookId || !playName || !formationName) return;
    this.db.prepare(`
      INSERT INTO play_locators(playbook_id, play_name, formation_name, observations, last_seen_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(playbook_id, play_name, formation_name)
      DO UPDATE SET observations = observations + 1, last_seen_at = excluded.last_seen_at
    `).run(Number(playbookId), String(playName), String(formationName), nowIso());
  }

  playLocator(playbookId, playName) {
    return this.db.prepare(`
      SELECT formation_name AS formation, observations, last_seen_at AS lastSeenAt
      FROM play_locators
      WHERE playbook_id = ? AND lower(play_name) = lower(?)
      ORDER BY observations DESC, last_seen_at DESC
      LIMIT 1
    `).get(Number(playbookId), String(playName)) || null;
  }

  summarizeGame(gameId) {
    const game = this.getGame(gameId);
    const snaps = this.gameSnaps(gameId);
    const withYards = snaps.filter(s => Number.isFinite(Number(s.yards)));
    const totalYards = withYards.reduce((sum, s) => sum + Number(s.yards || 0), 0);
    const offensiveCalls = {};
    const defensiveCalls = {};
    const formations = {};

    for (const s of snaps) {
      if (s.offensive_play_name) offensiveCalls[s.offensive_play_name] = (offensiveCalls[s.offensive_play_name] || 0) + 1;
      if (s.defensive_play_name) defensiveCalls[s.defensive_play_name] = (defensiveCalls[s.defensive_play_name] || 0) + 1;
      if (s.offensive_formation) formations[s.offensive_formation] = (formations[s.offensive_formation] || 0) + 1;
    }

    const top = obj => Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, attempts]) => ({ name, attempts }));

    return {
      gameId: Number(gameId),
      startedAt: game?.started_at || null,
      endedAt: game?.ended_at || null,
      playbook: game?.offense_playbook_name || null,
      opponent: game?.opponent_name || null,
      snaps: snaps.length,
      snapsWithKnownYards: withYards.length,
      totalKnownYards: totalYards,
      avgKnownYards: withYards.length ? totalYards / withYards.length : null,
      firstDowns: snaps.filter(s => s.first_down).length,
      touchdowns: snaps.filter(s => s.touchdown).length,
      turnovers: snaps.filter(s => s.turnover).length,
      topOffensiveCalls: top(offensiveCalls),
      topDefensiveCalls: top(defensiveCalls),
      topOffensiveFormations: top(formations)
    };
  }
}

module.exports = { CoordinatorDatabase, DEFAULT_DB_PATH, DEFAULT_INDEX_PATH, SCHEMA_VERSION };
