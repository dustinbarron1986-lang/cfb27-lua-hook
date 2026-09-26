#!/usr/bin/env node
'use strict';

// Builds data/playbooks/cfb27-play-locations.json -- a read-only sidecar index
// mapping (playbookId, formationId, setId) -> human-readable formation/set
// names, parsed directly from raw Frosty playbook XML exports.
//
// This does NOT touch coordinator.db, cfb27-playbook-index.json, or any
// checked-in catalog data -- it only produces a new, separate JSON file that
// DatabasePlaybookRepository joins in at read time.
//
// Usage:
//   node scripts/build-play-locations.cjs <path-to-raw-playbook-XML-directory>

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const sourceDir = argv[0];
  if (!sourceDir) {
    console.error('Usage: node scripts/build-play-locations.cjs <path-to-raw-playbook-XML-directory>');
    process.exit(1);
  }
  return { sourceDir: path.resolve(sourceDir) };
}

function playbookIdFromFilename(filename) {
  const m = filename.match(/^playbook_(def|off)-(\d+)\.XML$/i);
  if (!m) return null;
  return { side: m[1].toLowerCase() === 'def' ? 'defense' : 'offense', id: Number(m[2]) };
}

// Extracts form_id -> { name, sets: { set_id -> set_name } } from the raw
// <formation_set_list> block. Regex-based on purpose: the export format is a
// small, regular, already-verified structure, and the project has no XML
// parsing dependency today -- adding one just for this would be unjustified.
function parseFormationSetList(xmlText) {
  const formations = {};
  const listMatch = xmlText.match(/<formation_set_list>([\s\S]*?)<\/formation_set_list>/);
  if (!listMatch) return formations;

  const formRegex = /<formation\s+form_name="([^"]*)"\s+ord="[^"]*"\s+form_id="(-?\d+)"\s*>([\s\S]*?)<\/formation>/g;
  let fm;
  while ((fm = formRegex.exec(listMatch[1]))) {
    const [, formName, formId, body] = fm;
    if (!formations[formId]) formations[formId] = { name: formName, sets: {} };
    const setRegex = /<set\s+set_id="(-?\d+)"\s+set_name="([^"]*)"\s+form_id="(-?\d+)"\s+ord="[^"]*"\s*\/>/g;
    let sm;
    while ((sm = setRegex.exec(body))) {
      const [, setId, setName] = sm;
      formations[formId].sets[setId] = setName;
    }
  }
  return formations;
}

// Only formation_id/set_id are needed to join; play_name is captured purely
// for integrity-check reporting (unresolved-reference messages).
function parsePlays(xmlText) {
  const plays = [];
  const playRegex = /<play\b([^>]*?)\/?>/g;
  let pm;
  while ((pm = playRegex.exec(xmlText))) {
    const attrs = pm[1];
    const get = name => {
      const m = attrs.match(new RegExp(name + '="([^"]*)"'));
      return m ? m[1] : null;
    };
    const formationId = get('formation_id');
    const setId = get('set_id');
    if (formationId == null || setId == null) continue;
    plays.push({ playName: get('play_name'), formationId, setId });
  }
  return plays;
}

function buildLocations(sourceDir) {
  const allFiles = fs.readdirSync(sourceDir).filter(f => /\.XML$/i.test(f)).sort();

  const playbooks = {};
  const pbKeySourceFile = {}; // pbKey -> first file that populated it (collision detection)
  const stats = {
    totalFiles: allFiles.length,
    defenseFiles: 0,
    offenseFiles: 0,
    unrecognizedFiles: [],
    totalPlaysInspected: 0,
    totalLocationMappings: 0,
    unresolvedFormationRefs: [],
    unresolvedSetRefs: [],
    intraPlaybookConflicts: [],
    // Raw Frosty exports use independent id sequences per side, so the same
    // numeric id can (rarely) appear in both a playbook_def-* and a
    // playbook_off-* file. The production DB's playbook id is a single global
    // primary key, so at most one side's data for that id is ever real -- but
    // this sidecar must never silently merge two unrelated files under one
    // key. Report it; don't guess which (if either) is authoritative here.
    crossFileIdCollisions: [],
  };

  for (const file of allFiles) {
    const meta = playbookIdFromFilename(file);
    if (!meta) {
      stats.unrecognizedFiles.push(file);
      continue;
    }
    if (meta.side === 'defense') stats.defenseFiles += 1;
    else stats.offenseFiles += 1;

    const text = fs.readFileSync(path.join(sourceDir, file), 'utf8');
    const formations = parseFormationSetList(text);
    const plays = parsePlays(text);

    const pbKey = String(meta.id);
    if (pbKeySourceFile[pbKey] && pbKeySourceFile[pbKey] !== file) {
      stats.crossFileIdCollisions.push({ playbookId: meta.id, files: [pbKeySourceFile[pbKey], file] });
    }
    pbKeySourceFile[pbKey] = file;
    if (!playbooks[pbKey]) playbooks[pbKey] = {};

    for (const play of plays) {
      stats.totalPlaysInspected += 1;

      const form = formations[play.formationId];
      if (!form) {
        stats.unresolvedFormationRefs.push({
          file, playbookId: meta.id, playName: play.playName, formationId: play.formationId,
        });
        continue;
      }

      const setName = form.sets[play.setId];
      if (setName === undefined) {
        stats.unresolvedSetRefs.push({
          file, playbookId: meta.id, playName: play.playName,
          formationId: play.formationId, setId: play.setId,
        });
        continue;
      }

      const key = `${play.formationId}:${play.setId}`;
      const entry = {
        formationId: Number(play.formationId),
        formationName: form.name,
        setId: Number(play.setId),
        setName,
      };
      const existing = playbooks[pbKey][key];
      if (existing) {
        if (existing.formationName !== entry.formationName || existing.setName !== entry.setName) {
          stats.intraPlaybookConflicts.push({ file, playbookId: meta.id, key, existing, new: entry });
        }
        continue; // keep the first-seen mapping; never silently overwrite with a conflicting one
      }
      playbooks[pbKey][key] = entry;
      stats.totalLocationMappings += 1;
    }
  }

  return { playbooks, stats };
}

// Playbook-id keys are integer-like strings, so JS/JSON already orders them
// numerically ascending regardless of insertion order. Composite
// "formId:setId" keys are NOT integer-like (they contain a colon), so they
// must be explicitly sorted for deterministic, byte-for-byte-identical output.
function sortedPlaybooks(playbooks) {
  const sorted = {};
  for (const id of Object.keys(playbooks).map(Number).sort((a, b) => a - b)) {
    const book = playbooks[String(id)];
    const sortedBook = {};
    for (const key of Object.keys(book).sort((a, b) => {
      const [af, as] = a.split(':').map(Number);
      const [bf, bs] = b.split(':').map(Number);
      return af - bf || as - bs;
    })) {
      sortedBook[key] = book[key];
    }
    sorted[String(id)] = sortedBook;
  }
  return sorted;
}

function main(argv) {
  const { sourceDir } = parseArgs(argv);
  const { playbooks, stats } = buildLocations(sourceDir);
  const sorted = sortedPlaybooks(playbooks);

  const output = {
    metadata: {
      schemaVersion: 1,
      source: 'Raw Frosty playbook XML export',
      sourceFileCount: stats.totalFiles,
    },
    playbooks: sorted,
  };

  const outPath = path.resolve(__dirname, '..', 'data', 'playbooks', 'cfb27-play-locations.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log('=== BUILD PLAY LOCATIONS ===');
  console.log('Source directory:', sourceDir);
  console.log('Output:', outPath);
  console.log('Total XML files found:', stats.totalFiles);
  console.log('  defense files:', stats.defenseFiles);
  console.log('  offense files:', stats.offenseFiles);
  if (stats.unrecognizedFiles.length) {
    console.log('  UNRECOGNIZED FILENAMES:', JSON.stringify(stats.unrecognizedFiles));
  }
  console.log('Total plays inspected:', stats.totalPlaysInspected);
  console.log('Total location mappings recorded:', stats.totalLocationMappings);
  console.log('Unresolved formation references:', stats.unresolvedFormationRefs.length);
  if (stats.unresolvedFormationRefs.length) {
    console.log(JSON.stringify(stats.unresolvedFormationRefs.slice(0, 20), null, 2));
  }
  console.log('Unresolved set references:', stats.unresolvedSetRefs.length);
  if (stats.unresolvedSetRefs.length) {
    console.log(JSON.stringify(stats.unresolvedSetRefs.slice(0, 20), null, 2));
  }
  console.log('Intra-playbook conflicts:', stats.intraPlaybookConflicts.length);
  if (stats.intraPlaybookConflicts.length) {
    console.log(JSON.stringify(stats.intraPlaybookConflicts.slice(0, 20), null, 2));
  }
  console.log('Cross-file playbook-id collisions (same numeric id, different files):', stats.crossFileIdCollisions.length);
  if (stats.crossFileIdCollisions.length) {
    console.log(JSON.stringify(stats.crossFileIdCollisions, null, 2));
  }

  return stats;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  main,
  buildLocations,
  parseFormationSetList,
  parsePlays,
  playbookIdFromFilename,
  sortedPlaybooks,
};
