#!/usr/bin/env node
'use strict';

// Compiles defensive playbook authority from EA playbook_def-*.XML exports.
//
// Every defensive play keeps: book, formation, set, play (id/name/type/
// classification) and its 11 player records (plyr_idx, position_type, x, y,
// depth, assignment ordinal). The assignment ordinal is resolved through the
// verified EA AssignRouteType table (data/knowledge/ea-assign-route-types.json,
// produced by scripts/research/derive-assign-route-types.cjs). Unknown ordinals
// stay unknown.
//
// Identical 11-player structures are stored once and referenced by index; the
// same play typically appears in many books.
//
// Usage:
//   node scripts/build-ea-defensive-play-knowledge.cjs <Playbooks dir> [output-json]

const fs = require('fs');
const path = require('path');
const { parsePlaybookXml, playbookIdFromFilename } = require('../src/football/knowledge/ea-playbook-xml');
const { loadRouteTypeTable, defensiveResponsibility } = require('../src/football/assignments/assign-route-type');

const REPO = path.resolve(__dirname, '..');

function readPlaybookNames(playbooksDir) {
  const file = path.join(playbooksDir, 'playbookdata.JSON');
  if (!fs.existsSync(file)) return {};
  const doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const out = {};
  for (const row of doc.Playbooks || []) {
    if (row.PlaybookIsOffense === 0) out[row.PlaybookID] = { name: row.PlaybookName, assetName: row.PlaybookAssetName };
  }
  return out;
}

function structureKey(players) {
  return players.map(p => [p.index, p.positionType, p.x, p.y, p.depth, p.assignmentRef].join(',')).join(';');
}

function buildDefensivePlayKnowledge(playbooksDir, options = {}) {
  const table = options.routeTypeTable || loadRouteTypeTable();
  const knownOrdinal = ordinal => {
    const row = table.ordinals?.[String(ordinal)];
    return Boolean(row) && defensiveResponsibility(row.name).category !== 'UNKNOWN';
  };
  const names = readPlaybookNames(playbooksDir);
  const structures = [];
  const structureIndex = new Map();
  const books = {};
  const totals = { plays: 0, fullyResolved: 0, partiallyResolved: 0, unresolved: 0, players: 0, knownPlayers: 0, nonElevenPlayer: 0 };

  for (const file of fs.readdirSync(playbooksDir).sort()) {
    const meta = playbookIdFromFilename(file);
    if (!meta || meta.side !== 'defense') continue;
    const parsed = parsePlaybookXml(fs.readFileSync(path.join(playbooksDir, file), 'utf8'));
    const stats = { plays: 0, fullyResolved: 0, partiallyResolved: 0, unresolved: 0 };
    const plays = [];
    for (const play of parsed.plays) {
      const players = [...play.players].sort((a, b) => a.index - b.index);
      const key = structureKey(players);
      let idx = structureIndex.get(key);
      if (idx == null) {
        idx = structures.length;
        structureIndex.set(key, idx);
        structures.push(players.map(p => [p.index, p.positionType, p.x, p.y, p.depth, p.assignmentRef]));
      }
      const known = players.filter(p => knownOrdinal(p.assignmentRef)).length;
      const status = players.length && known === players.length ? 'full' : (known > 0 ? 'partial' : 'none');
      stats.plays += 1;
      totals.plays += 1;
      totals.players += players.length;
      totals.knownPlayers += known;
      if (players.length !== 11) totals.nonElevenPlayer += 1;
      if (status === 'full') { stats.fullyResolved += 1; totals.fullyResolved += 1; }
      else if (status === 'partial') { stats.partiallyResolved += 1; totals.partiallyResolved += 1; }
      else { stats.unresolved += 1; totals.unresolved += 1; }
      plays.push([play.playId, play.formationId, play.setId, play.playName, play.playType, play.classification, idx]);
    }
    books[meta.id] = {
      name: names[meta.id]?.name || null,
      assetName: names[meta.id]?.assetName || null,
      sourceFile: `Playbooks/${file}`,
      formations: parsed.formations,
      plays,
      stats,
    };
  }

  const pct = (a, b) => (b ? Number(((a / b) * 100).toFixed(2)) : 0);
  return {
    metadata: {
      schemaVersion: 1,
      source: 'EA playbook_def XML + verified AssignRouteType bridge',
      generatedBy: 'scripts/build-ea-defensive-play-knowledge.cjs',
      generatedAt: new Date().toISOString(),
      routeTypeTableGeneratedAt: table.metadata?.generatedAt || null,
      resolutionLevel: 'ROUTE_TYPE',
      resolutionNote: 'Each defender resolves to an EA AssignRouteType (the authored responsibility class). The specific PositionAssignmentDefine instance is only available from defensive Frostbite PlayLibrary play assets, which have not been exported.',
      playerRow: ['index', 'positionType', 'x', 'y', 'depth', 'assignmentRef'],
      playRow: ['playId', 'formationId', 'setId', 'playName', 'playType', 'classification', 'structure'],
      bookCount: Object.keys(books).length,
      structureCount: structures.length,
      ...totals,
      fullyResolvedPct: pct(totals.fullyResolved, totals.plays),
      partiallyResolvedPct: pct(totals.partiallyResolved, totals.plays),
      unresolvedPct: pct(totals.unresolved, totals.plays),
      knownPlayerPct: pct(totals.knownPlayers, totals.players),
    },
    structures,
    books,
  };
}

function main(argv = process.argv.slice(2)) {
  const [playbooksDir, outArg] = argv;
  if (!playbooksDir) {
    console.error('Usage: node scripts/build-ea-defensive-play-knowledge.cjs <Playbooks dir> [output-json]');
    process.exitCode = 1;
    return null;
  }
  const result = buildDefensivePlayKnowledge(path.resolve(playbooksDir));
  const outPath = outArg ? path.resolve(outArg) : path.join(REPO, 'data', 'knowledge', 'ea-defensive-play-knowledge.json');
  fs.writeFileSync(outPath, JSON.stringify(result) + '\n', 'utf8');
  const m = result.metadata;
  console.log('=== EA DEFENSIVE PLAY KNOWLEDGE ===');
  console.log('Books:', m.bookCount, 'Plays:', m.plays, 'Unique structures:', m.structureCount);
  console.log(`Fully resolved: ${m.fullyResolved} (${m.fullyResolvedPct}%)`);
  console.log(`Partially resolved: ${m.partiallyResolved} (${m.partiallyResolvedPct}%)`);
  console.log(`Unresolved: ${m.unresolved} (${m.unresolvedPct}%)`);
  console.log(`Known defenders: ${m.knownPlayers}/${m.players} (${m.knownPlayerPct}%)`);
  console.log('Plays without exactly 11 players:', m.nonElevenPlayer);
  console.log('Output:', outPath, fs.statSync(outPath).size, 'bytes');
  return result;
}

if (require.main === module) main();

module.exports = { buildDefensivePlayKnowledge, main };
