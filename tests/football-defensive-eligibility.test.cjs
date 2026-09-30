'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
  categorizeDefensivePlay,
  isDefensivelyEligible,
  NORMAL_SCRIMMAGE,
  PREVENT,
  GOAL_LINE,
  SPECIAL_TEAMS,
} = require('../src/football/recommendation/defensive-eligibility');

const { researchPath } = require('./helpers/research-paths.cjs');

const RAW_PLAYBOOKS_DIR = researchPath('Playbooks') || 'C:/CFB27Tools/Research/Playbooks';

function parseFormationNameToClassifications(xml) {
  const formIdToName = new Map();
  const formRe = /<formation form_name="([^"]+)" ord="\d+" form_id="(\d+)">/g;
  let fm;
  while ((fm = formRe.exec(xml))) formIdToName.set(fm[2], fm[1]);

  const result = new Map();
  const playRe = /<play play_id="\d+" formation_id="(\d+)" play_name="[^"]+" play_type="\d+" set_id="\d+" form_set_id="\d+" classification="(\d+)"/g;
  let pm;
  while ((pm = playRe.exec(xml))) {
    const formName = formIdToName.get(pm[1]) || `UNKNOWN_${pm[1]}`;
    const classification = Number(pm[2]);
    if (!result.has(formName)) result.set(formName, new Set());
    result.get(formName).add(classification);
  }
  return result;
}

// This is the evidence backing defensive-eligibility.js's documented table. It
// re-derives the mapping from the raw XML on every run: if a future playbook
// import ever breaks the "classification never crosses a category boundary"
// assumption, this test fails loudly instead of the ranker silently
// misclassifying plays.
test('classification never crosses a category boundary across the 36 raw defensive playbook exports', (t) => {
  if (!fs.existsSync(RAW_PLAYBOOKS_DIR)) {
    t.skip('raw Research/Playbooks XML corpus not present on this machine');
    return;
  }
  const files = fs.readdirSync(RAW_PLAYBOOKS_DIR).filter(f => /^playbook_def-\d+\.XML$/.test(f));
  assert.equal(files.length, 36, 'expected exactly 36 raw defensive playbook XML exports');

  const categoryOf = classification => {
    if (NORMAL_SCRIMMAGE.has(classification)) return 'normal';
    if (PREVENT.has(classification)) return 'prevent';
    if (GOAL_LINE.has(classification)) return 'goal_line';
    if (SPECIAL_TEAMS.has(classification)) return 'special_teams';
    return 'unrecognized';
  };

  // Known, documented exceptions -- all 5 are separately proven (next test)
  // to have zero presence in coordinator.db under any id or source_file, so
  // none of them can ever reach DefensiveSelectionEngine.rank() at runtime:
  //   - playbook_def-097.XML is an entirely different kind of playbook
  //     (drill/tutorial "ST ..." formations, e.g. "ST Acceleration Burst",
  //     "ST Blitz") whose classification values collide with ordinary
  //     scrimmage classifications used elsewhere (e.g. 19 also means
  //     "Nickel").
  //   - playbook_def-032/033/036/091.XML are ordinary-looking (non-drill)
  //     defensive schemes that were simply never imported, but each reuses a
  //     classification integer for a formation name ("3-4", "46", "Safety
  //     Kick Return") that a DIFFERENT integer denotes in the 31 reachable
  //     files -- i.e. classification is a per-export-local code, not a
  //     portable global enum, across the wider unreached corpus.
  const KNOWN_UNREACHABLE_EXPORTS = new Set([
    'playbook_def-032.XML',
    'playbook_def-033.XML',
    'playbook_def-036.XML',
    'playbook_def-091.XML',
    'playbook_def-097.XML',
  ]);

  const conflicts = [];
  for (const file of files) {
    if (KNOWN_UNREACHABLE_EXPORTS.has(file)) continue;
    const xml = fs.readFileSync(path.join(RAW_PLAYBOOKS_DIR, file), 'utf8');
    const formNameToClass = parseFormationNameToClassifications(xml);
    for (const [formName, classifications] of formNameToClass.entries()) {
      const categories = new Set([...classifications].map(categoryOf));
      if (categories.size > 1) {
        conflicts.push({ file, formName, classifications: [...classifications], categories: [...categories] });
      }
    }
  }

  assert.deepEqual(conflicts, [], `found classification/category conflicts: ${JSON.stringify(conflicts)}`);
});

test('the drill/tutorial export (097) and 4 other raw exports are confirmed unreachable at runtime', () => {
  const { CoordinatorDatabase } = require('../src/football/db/coordinator-database');
  const database = new CoordinatorDatabase({ dbPath: path.resolve(root, 'data/coordinator.db'), readOnly: true });
  try {
    const excludedFileNumbers = ['032', '033', '036', '091', '097'];
    for (const n of excludedFileNumbers) {
      const byId = database.db.prepare('SELECT id FROM playbooks WHERE id = ?').get(Number(n));
      const bySourceFile = database.db.prepare('SELECT id FROM playbooks WHERE source_file LIKE ?').all(`%playbook_def-${n}.XML`);
      assert.equal(byId, undefined, `playbook_def-${n}.XML (id ${Number(n)}) unexpectedly has a playbooks row`);
      assert.equal(bySourceFile.length, 0, `playbook_def-${n}.XML unexpectedly referenced by a playbooks.source_file`);
    }

    const totalDefenseBooks = database.db.prepare("SELECT COUNT(*) AS n FROM playbooks WHERE side = 'defense'").get().n;
    assert.equal(totalDefenseBooks, 41, 'expected 41 defense playbook rows (31 reachable/non-empty + 10 hidden/empty)');
  } finally {
    database.close();
  }
});

test('categorizeDefensivePlay: recognizes every documented bucket', () => {
  assert.equal(categorizeDefensivePlay({ classification: 13 }), 'normal'); // 3-4
  assert.equal(categorizeDefensivePlay({ classification: 19 }), 'normal'); // Nickel
  assert.equal(categorizeDefensivePlay({ classification: 21 }), 'prevent');
  assert.equal(categorizeDefensivePlay({ classification: 23 }), 'goal_line');
  assert.equal(categorizeDefensivePlay({ classification: 26 }), 'special_teams'); // Special
  assert.equal(categorizeDefensivePlay({ classification: 29 }), 'special_teams'); // Kick Return
  assert.equal(categorizeDefensivePlay({ classification: 37 }), 'special_teams'); // Safety Kick Return
});

test('categorizeDefensivePlay: fail-safe excludes an unrecognized-but-present classification', () => {
  assert.equal(categorizeDefensivePlay({ classification: 9999 }), 'unknown');
  assert.equal(isDefensivelyEligible({ classification: 9999 }, { down: 1, distance: 10 }), false);
});

test('categorizeDefensivePlay: a play with no classification metadata at all passes through as normal', () => {
  // Hand-authored sample/legacy playbooks (no DB import) never carry
  // classification -- eligibility gating must not apply to them.
  assert.equal(categorizeDefensivePlay({ id: 'sample-play', name: 'Mid Blitz' }), 'normal');
  assert.equal(isDefensivelyEligible({ id: 'sample-play', name: 'Mid Blitz' }, { down: 1, distance: 10 }), true);
});

test('isDefensivelyEligible: special teams is never eligible regardless of situation', () => {
  const punt = { classification: 25 };
  assert.equal(isDefensivelyEligible(punt, { down: 4, distance: 10 }), false);
  assert.equal(isDefensivelyEligible(punt, { down: 4, distance: 10, flags: { goalToGo: true } }), false);
});

test('isDefensivelyEligible: goal line requires an explicit verified goalToGo flag, never a yardLine computation', () => {
  const goalLine = { classification: 23 };
  assert.equal(isDefensivelyEligible(goalLine, { down: 1, distance: 2 }), false);
  assert.equal(isDefensivelyEligible(goalLine, { down: 1, distance: 2, yardLine: 99 }), false, 'must not infer goalToGo from yardLine');
  assert.equal(isDefensivelyEligible(goalLine, { down: 1, distance: 2, flags: {} }), false);
  assert.equal(isDefensivelyEligible(goalLine, { down: 1, distance: 2, flags: { goalToGo: true } }), true);
});

test('isDefensivelyEligible: prevent requires long yardage AND two/four-minute context, never yardLine', () => {
  const prevent = { classification: 21 };
  assert.equal(isDefensivelyEligible(prevent, { down: 3, distance: 9 }), false, 'plain 3rd & long alone is not enough');
  assert.equal(isDefensivelyEligible(prevent, { down: 3, distance: 9, flags: { longYardage: true } }), false);
  assert.equal(isDefensivelyEligible(prevent, { down: 3, distance: 9, flags: { longYardage: true, twoMinute: true } }), true);
  assert.equal(isDefensivelyEligible(prevent, { down: 3, distance: 9, flags: { longYardage: true, fourMinute: true } }), true);
  // Offline fallback (no pre-computed flags) uses only distance/quarter/clockSeconds/scoreDifferential.
  assert.equal(isDefensivelyEligible(prevent, { distance: 9, quarter: 2, clockSeconds: 90 }), true);
  assert.equal(isDefensivelyEligible(prevent, { distance: 9, quarter: 1, clockSeconds: 90 }), false);
  assert.equal(isDefensivelyEligible(prevent, { distance: 3, quarter: 2, clockSeconds: 90 }), false);
});
