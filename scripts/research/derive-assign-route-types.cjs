#!/usr/bin/env node
'use strict';

// Derives and verifies the EA AssignRouteType ordinal -> name table that bridges
// playbook XML `assignment="N"` references to EA PositionAssignmentDefine assets.
//
// PROOF STRUCTURE
//   1. Offense (observed): compiled Frostbite play assets
//      (data/knowledge/pro-style-ea-play-knowledge.json) carry authoritative
//      per-slot assignment assets. Joining the same play (set_id + play name)
//      in playbook_off XML pairs every XML ordinal with the asset's routeType
//      name. Ordinals are accepted at >= 75% purity.
//   2. Enum order: the observed original block is ordered case-insensitively by
//      name; violations are counted and reported, never hidden.
//   3. Defense (original block): offense proves Block_Run and K_FG ordinals.
//      Every AssignRouteType_Def* name (except the appended Def_Man_N family)
//      sorts between them, and defensive playbooks use exactly the ordinals in
//      that gap. The names are assigned in case-insensitive order.
//   4. Defense (appended Def_Man_1..5): the only run of five consecutive
//      unexplained defensive ordinals, whose mean alignment x runs monotonically
//      from EA-left (+x) to EA-right (-x), matching MAN_COVER1..MAN_LAST.
//   5. Validation: every defensive assignment is checked against alignment
//      (Lt/Rt mirror, middle centred, deep zones deep, rushers on the line). The
//      same checks are re-run with the defensive block shifted by -1/+1; those
//      alternatives must FAIL, showing the validation discriminates.
//
// Usage:
//   node scripts/research/derive-assign-route-types.cjs <Playbooks dir> <Assignments dir> [output-json]

const fs = require('fs');
const path = require('path');
const { parsePlaybookXml, playbookIdFromFilename } = require('../../src/football/knowledge/ea-playbook-xml');

const REPO = path.resolve(__dirname, '..', '..');
const PREFIX = 'AssignRouteType_';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.xml$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function ciCompare(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

function norm(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function fieldValues(text, name) {
  return [...text.matchAll(new RegExp(`name="${name}">([^<]*)<`, 'g'))].map(m => m[1]).filter(Boolean);
}

function scanAssets(assignmentsDir) {
  const families = {};
  for (const file of walk(assignmentsDir)) {
    const text = fs.readFileSync(file, 'utf8');
    const routeType = fieldValues(text, 'routeType')[0] || null;
    if (!routeType) continue;
    const rel = path.relative(assignmentsDir, file).split(path.sep).join('/').replace(/\.xml$/i, '');
    const fam = families[routeType] || (families[routeType] = {
      count: 0, directories: {}, samples: [], zones: new Set(), strategies: new Set(), coverMan: new Set(), opcodes: new Set(),
    });
    fam.count += 1;
    const dir = rel.split('/')[0];
    fam.directories[dir] = (fam.directories[dir] || 0) + 1;
    if (fam.samples.length < 4) fam.samples.push(rel);
    for (const key of ['deepZone', 'hookZone', 'flatZone', 'curlFlatZone']) for (const v of fieldValues(text, key)) fam.zones.add(v);
    for (const v of fieldValues(text, 'ZoneStrategy')) fam.strategies.add(v);
    for (const v of fieldValues(text, 'coverMan')) fam.coverMan.add(v);
    for (const v of fieldValues(text, 'opCodeEX')) if (v !== 'ID_NONE') fam.opcodes.add(v);
  }
  const out = {};
  for (const [name, fam] of Object.entries(families)) {
    out[name] = {
      count: fam.count,
      directories: fam.directories,
      samples: fam.samples,
      zones: [...fam.zones].sort(),
      strategies: [...fam.strategies].sort(),
      coverMan: [...fam.coverMan].sort(),
      opcodes: [...fam.opcodes].sort(),
    };
  }
  return out;
}

function loadPlaybooks(playbooksDir, side) {
  const books = [];
  for (const file of fs.readdirSync(playbooksDir).sort()) {
    const meta = playbookIdFromFilename(file);
    if (!meta || meta.side !== side) continue;
    books.push({ file, id: meta.id, ...parsePlaybookXml(fs.readFileSync(path.join(playbooksDir, file), 'utf8')) });
  }
  return books;
}

function offensiveJoin(offenseBooks, knowledge) {
  const bySetAndName = new Map();
  for (const book of offenseBooks) {
    for (const play of book.plays) {
      const key = `${play.setId}|${norm(play.playName)}`;
      if (!bySetAndName.has(key)) bySetAndName.set(key, play);
    }
  }
  const pairs = {};
  let matchedPlays = 0;
  for (const entry of Object.values(knowledge.plays || {})) {
    const setId = knowledge.sets?.[entry.setKey]?.setId;
    const xmlPlay = bySetAndName.get(`${setId}|${norm(entry.play?.name)}`);
    if (!xmlPlay) continue;
    matchedPlays += 1;
    const refsByIndex = new Map(xmlPlay.players.map(p => [p.index, p.assignmentRef]));
    for (const player of entry.players || []) {
      const assignment = knowledge.assignments?.[player.assignmentKey];
      const ordinal = refsByIndex.get(player.index);
      if (ordinal == null || !assignment?.routeType) continue;
      const row = pairs[ordinal] || (pairs[ordinal] = {});
      row[assignment.routeType] = (row[assignment.routeType] || 0) + 1;
    }
  }
  const accepted = {};
  const rejected = {};
  for (const [ordinal, counts] of Object.entries(pairs)) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const [name, top] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const purity = top / total;
    const row = { name, observations: total, purity: Number(purity.toFixed(3)) };
    if (purity >= 0.75) accepted[ordinal] = row;
    else rejected[ordinal] = { ...row, counts };
  }
  return { accepted, rejected, matchedPlays, knowledgePlays: Object.keys(knowledge.plays || {}).length };
}

function enumOrderViolations(accepted, maxOrdinal) {
  const rows = Object.entries(accepted)
    .map(([ordinal, row]) => ({ ordinal: Number(ordinal), name: row.name }))
    .filter(row => row.ordinal < maxOrdinal)
    .sort((a, b) => a.ordinal - b.ordinal);
  const violations = [];
  for (let i = 1; i < rows.length; i += 1) {
    if (ciCompare(rows[i - 1].name, rows[i].name) > 0) violations.push({ before: rows[i - 1], after: rows[i] });
  }
  return { checked: rows.length, violations };
}

function defensiveAlignmentStats(defenseBooks) {
  const stats = {};
  for (const book of defenseBooks) {
    for (const play of book.plays) {
      for (const p of play.players) {
        if (p.assignmentRef == null) continue;
        const s = stats[p.assignmentRef] || (stats[p.assignmentRef] = { n: 0, sumX: 0, sumY: 0, posX: 0, negX: 0, positionTypes: {}, playNames: {} });
        s.n += 1;
        s.sumX += p.x ?? 0;
        s.sumY += p.y ?? 0;
        if ((p.x ?? 0) > 0.5) s.posX += 1;
        if ((p.x ?? 0) < -0.5) s.negX += 1;
        s.positionTypes[p.positionType] = (s.positionTypes[p.positionType] || 0) + 1;
        s.playNames[play.playName] = (s.playNames[play.playName] || 0) + 1;
      }
    }
  }
  const out = {};
  for (const [ordinal, s] of Object.entries(stats)) {
    out[ordinal] = {
      n: s.n,
      meanX: Number((s.sumX / s.n).toFixed(2)),
      meanY: Number((s.sumY / s.n).toFixed(2)),
      pctPosX: Number((s.posX / s.n).toFixed(3)),
      pctNegX: Number((s.negX / s.n).toFixed(3)),
      topPositionTypes: Object.entries(s.positionTypes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => [Number(k), v]),
      samplePlays: Object.entries(s.playNames).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k),
    };
  }
  return out;
}

// DL position types (NT/DT/DE family) observed in every defensive book.
const LINE_POSITION_TYPES = new Set([10, 11, 12, 13, 29, 30, 32]);

function validateDefensiveAssignment(nameByOrdinal, stats) {
  const failures = [];
  const byName = {};
  for (const [ordinal, name] of Object.entries(nameByOrdinal)) byName[name.replace(PREFIX, '')] = { ordinal, s: stats[ordinal] };
  for (const [short, row] of Object.entries(byName)) {
    if (!row.s) continue;
    if (/Deep/.test(short) && row.s.meanY < 7) failures.push(`${short}: deep zone meanY ${row.s.meanY} < 7`);
    if (/_Mid(_|$)/.test(short) && Math.abs(row.s.meanX) > 3) failures.push(`${short}: middle zone |meanX| ${row.s.meanX} > 3`);
    if (short === 'DefPass_Rush') {
      const line = row.s.topPositionTypes.filter(([pt]) => LINE_POSITION_TYPES.has(pt)).reduce((a, [, v]) => a + v, 0);
      if (line / row.s.n < 0.6 || row.s.meanY > 2.5) failures.push(`${short}: rushers not on the line`);
    }
    if (/Lt/.test(short)) {
      const mirror = byName[short.replace('Lt', 'Rt')];
      if (mirror?.s && row.s.pctPosX - mirror.s.pctPosX < 0.25) {
        failures.push(`${short}: Lt/Rt mirror not established (${row.s.pctPosX} vs ${mirror.s.pctPosX})`);
      }
    }
  }
  const manRows = Object.entries(byName)
    .filter(([short]) => /^Def_Man_\d$/.test(short))
    .sort((a, b) => a[0].localeCompare(b[0]));
  for (let i = 1; i < manRows.length; i += 1) {
    const prev = manRows[i - 1][1].s;
    const cur = manRows[i][1].s;
    if (prev && cur && !(prev.meanX > cur.meanX)) failures.push(`${manRows[i][0]}: man numbering not monotonic from EA-left`);
  }
  return failures;
}

function derive({ playbooksDir, assignmentsDir, knowledgePath }) {
  const assets = scanAssets(assignmentsDir);
  const offenseBooks = loadPlaybooks(playbooksDir, 'offense');
  const defenseBooks = loadPlaybooks(playbooksDir, 'defense');
  const knowledge = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'));

  const join = offensiveJoin(offenseBooks, knowledge);
  const ordinalOf = name => Number(Object.entries(join.accepted).find(([, row]) => row.name === PREFIX + name)?.[0]);
  const blockRun = ordinalOf('Block_Run');
  const kFg = ordinalOf('K_FG');
  if (!Number.isFinite(blockRun) || !Number.isFinite(kFg)) throw new Error('Offensive join did not prove Block_Run/K_FG ordinals');

  const order = enumOrderViolations(join.accepted, 105);

  const defNames = Object.keys(assets)
    .filter(name => name.startsWith(PREFIX + 'Def') && !/^AssignRouteType_Def_Man_\d$/.test(name))
    .sort(ciCompare);
  if (blockRun + defNames.length >= kFg) throw new Error('Defensive names do not fit between Block_Run and K_FG');

  const stats = defensiveAlignmentStats(defenseBooks);
  const usedDefensive = Object.keys(stats).map(Number).sort((a, b) => a - b);

  const blockFor = shift => {
    const map = {};
    defNames.forEach((name, i) => { map[blockRun + 1 + i + shift] = name; });
    return map;
  };

  const explained = new Set([...Object.keys(join.accepted).map(Number), ...Object.keys(blockFor(0)).map(Number)]);
  const leftover = usedDefensive.filter(o => !explained.has(o));
  const manNames = [1, 2, 3, 4, 5].map(n => `${PREFIX}Def_Man_${n}`).filter(name => assets[name]);
  let manBlock = {};
  for (let i = 0; i + 4 < leftover.length; i += 1) {
    const run = leftover.slice(i, i + 5);
    if (run[4] - run[0] !== 4) continue;
    const xs = run.map(o => stats[o].meanX);
    const monotonic = xs.every((x, k) => k === 0 || xs[k - 1] > x);
    if (monotonic && xs[0] > 5 && xs[4] < -5 && manNames.length === 5) {
      run.forEach((o, k) => { manBlock[o] = manNames[k]; });
      break;
    }
  }

  const defensiveMap = { ...blockFor(0), ...manBlock };
  const failures = validateDefensiveAssignment(defensiveMap, stats);
  const shiftTest = {};
  for (const shift of [-1, 1]) {
    shiftTest[shift] = validateDefensiveAssignment({ ...blockFor(shift), ...manBlock }, stats).length;
  }

  const ordinals = {};
  for (const [ordinal, row] of Object.entries(join.accepted)) {
    ordinals[ordinal] = {
      name: row.name,
      evidence: 'OFFENSIVE_FROSTBITE_JOIN',
      observations: row.observations,
      purity: row.purity,
      assetFamily: assets[row.name] ? { count: assets[row.name].count, samples: assets[row.name].samples } : null,
    };
  }
  for (const [ordinal, name] of Object.entries(defensiveMap)) {
    const family = assets[name];
    ordinals[ordinal] = {
      name,
      evidence: manBlock[ordinal] ? 'DEFENSIVE_APPENDED_MAN_BLOCK+ALIGNMENT' : 'DEFENSIVE_ENUM_BLOCK+ALIGNMENT',
      alignment: stats[ordinal] || null,
      assetFamily: family ? {
        count: family.count,
        directories: family.directories,
        samples: family.samples,
        zones: family.zones,
        strategies: family.strategies,
        coverMan: family.coverMan,
        opcodes: family.opcodes,
      } : null,
    };
  }

  const unresolvedDefensive = usedDefensive
    .filter(o => !ordinals[o])
    .map(o => ({ ordinal: o, uses: stats[o].n, samplePlays: stats[o].samplePlays }));

  return {
    metadata: {
      schemaVersion: 1,
      source: 'EA playbook XML + PositionAssignmentDefine assets + compiled Frostbite offensive plays',
      generatedBy: 'scripts/research/derive-assign-route-types.cjs',
      generatedAt: new Date().toISOString(),
      coordinateConvention: 'Shared field frame: +x is the offense right. EA Lt/Rt is each unit\'s own perspective (offensive Lt at -x, defensive Lt at +x).',
      offensiveJoin: {
        knowledgePlays: join.knowledgePlays,
        matchedPlays: join.matchedPlays,
        acceptedOrdinals: Object.keys(join.accepted).length,
        rejectedOrdinals: join.rejected,
      },
      enumOrder: order,
      defensiveBlock: { afterOrdinal: blockRun, beforeOrdinal: kFg, names: defNames.length },
      defensiveManBlock: Object.keys(manBlock).map(Number),
      validation: {
        failures,
        shiftedBlockFailureCounts: shiftTest,
        passed: failures.length === 0 && Object.values(shiftTest).every(count => count > 0),
      },
      unresolvedDefensiveOrdinals: unresolvedDefensive,
    },
    ordinals,
  };
}

function main(argv = process.argv.slice(2)) {
  const [playbooksDir, assignmentsDir, outArg] = argv;
  if (!playbooksDir || !assignmentsDir) {
    console.error('Usage: node scripts/research/derive-assign-route-types.cjs <Playbooks dir> <Assignments dir> [output-json]');
    process.exitCode = 1;
    return null;
  }
  const result = derive({
    playbooksDir: path.resolve(playbooksDir),
    assignmentsDir: path.resolve(assignmentsDir),
    knowledgePath: path.join(REPO, 'data', 'knowledge', 'pro-style-ea-play-knowledge.json'),
  });
  const outPath = outArg ? path.resolve(outArg) : path.join(REPO, 'data', 'knowledge', 'ea-assign-route-types.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 1) + '\n', 'utf8');
  const m = result.metadata;
  console.log('=== EA AssignRouteType ORDINALS ===');
  console.log('Offensive plays joined:', m.offensiveJoin.matchedPlays, '/', m.offensiveJoin.knowledgePlays);
  console.log('Offensive ordinals accepted:', m.offensiveJoin.acceptedOrdinals, 'rejected:', Object.keys(m.offensiveJoin.rejectedOrdinals).length);
  console.log('Enum order violations:', m.enumOrder.violations.length, 'of', m.enumOrder.checked);
  console.log('Defensive block: ordinals', m.defensiveBlock.afterOrdinal + 1, '..', m.defensiveBlock.afterOrdinal + m.defensiveBlock.names);
  console.log('Defensive man block:', m.defensiveManBlock.join(','));
  console.log('Validation failures:', m.validation.failures.length, m.validation.failures);
  console.log('Shifted-block failure counts (must be > 0):', JSON.stringify(m.validation.shiftedBlockFailureCounts));
  console.log('Validation passed:', m.validation.passed);
  console.log('Unresolved defensive ordinals:', m.unresolvedDefensiveOrdinals.map(r => `${r.ordinal}(${r.uses})`).join(' '));
  console.log('Output:', outPath);
  if (!m.validation.passed) process.exitCode = 2;
  return result;
}

if (require.main === module) main();

module.exports = { derive, main, ciCompare };
