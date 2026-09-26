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

function loadPlaybooks(repoRoot, config = {}) {
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
    offense: normalizePlaybook(readJson(offensePath), 'offense'),
    defense: normalizePlaybook(readJson(defensePath), 'defense'),
    paths: { offense: offensePath, defense: defensePath },
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

module.exports = { loadPlaybooks, findPlay, normalizePlaybook };
