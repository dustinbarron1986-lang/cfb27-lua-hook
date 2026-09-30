'use strict';

// Parser for EA/Frosty playbook exports (Research/Playbooks/playbook_{off,def}-NNN.XML).
//
// The export is a small, regular, already-verified structure and the project has
// no XML dependency, so this is regex-based on purpose. It is the single parser
// for these files: scripts/build-play-locations.cjs and the defensive authority
// compiler both use it.
//
// Per-player `assignment` values are EA AssignRouteType enum ordinals (see
// src/football/assignments/assign-route-type.js), NOT positionAssignId values.

function attrsOf(text) {
  const out = {};
  for (const m of String(text || '').matchAll(/([A-Za-z_][\w]*)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function playbookIdFromFilename(filename) {
  const m = String(filename || '').match(/playbook_(def|off)-(\d+)\.XML$/i);
  if (!m) return null;
  return { side: m[1].toLowerCase() === 'def' ? 'defense' : 'offense', id: Number(m[2]) };
}

// form_id -> { name, sets: { set_id -> set_name } }
function parseFormationSetList(xmlText) {
  const formations = {};
  const listMatch = String(xmlText).match(/<formation_set_list>([\s\S]*?)<\/formation_set_list>/);
  if (!listMatch) return formations;
  for (const fm of listMatch[1].matchAll(/<formation\b([^>]*)>([\s\S]*?)<\/formation>/g)) {
    const fa = attrsOf(fm[1]);
    if (fa.form_id == null) continue;
    if (!formations[fa.form_id]) formations[fa.form_id] = { name: fa.form_name ?? '', sets: {} };
    for (const sm of fm[2].matchAll(/<set\b([^>]*?)\/?>/g)) {
      const sa = attrsOf(sm[1]);
      if (sa.set_id != null) formations[fa.form_id].sets[sa.set_id] = sa.set_name ?? '';
    }
  }
  return formations;
}

function parsePlayer(attrText) {
  const a = attrsOf(attrText);
  return {
    index: num(a.plyr_idx),
    assignmentRef: num(a.assignment),
    x: num(a.x),
    y: num(a.y),
    depth: num(a.depth),
    positionType: num(a.position_type),
  };
}

// Header-only parse (no player data) when `players: false`.
function parsePlays(xmlText, { players = true } = {}) {
  const plays = [];
  const text = String(xmlText);
  const re = players
    ? /<play\b([^>]*?)(?:\/>|>([\s\S]*?)<\/play>)/g
    : /<play\b([^>]*?)\/?>/g;
  for (const pm of text.matchAll(re)) {
    const a = attrsOf(pm[1]);
    if (a.formation_id == null || a.set_id == null) continue;
    const play = {
      playId: num(a.play_id),
      playName: a.play_name ?? null,
      formationId: a.formation_id,
      setId: a.set_id,
      playType: num(a.play_type),
      classification: num(a.classification),
    };
    if (players) {
      const body = pm[2] || '';
      const hole = body.match(/<run_data\b[^>]*hole_num="(-?\d+)"/);
      play.runHole = hole ? Number(hole[1]) : null;
      const data = body.match(/<player_data>([\s\S]*?)<\/player_data>/);
      play.players = data
        ? [...data[1].matchAll(/<player\b([^>]*?)\/?>/g)].map(m => parsePlayer(m[1]))
        : [];
    }
    plays.push(play);
  }
  return plays;
}

function parsePlaybookXml(xmlText, options = {}) {
  const formations = parseFormationSetList(xmlText);
  const plays = parsePlays(xmlText, options).map(play => {
    const formation = formations[play.formationId] || null;
    return {
      ...play,
      formationName: formation ? formation.name : null,
      setName: formation ? (formation.sets[play.setId] ?? null) : null,
    };
  });
  return { formations, plays };
}

module.exports = {
  attrsOf,
  playbookIdFromFilename,
  parseFormationSetList,
  parsePlays,
  parsePlaybookXml,
};
