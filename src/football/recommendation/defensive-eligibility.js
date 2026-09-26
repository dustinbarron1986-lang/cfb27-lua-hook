// Defensive candidate eligibility, gated by the raw Frosty `classification`
// field carried on every play imported from the Research/Playbooks XML export
// (coordinator-database.js: plays.classification INTEGER, straight from
// <play ... classification="N"> in playbook_def-*.XML).
//
// EVIDENCE / SCOPE (do not extend this table without re-running the check):
// `classification` is NOT a stable, game-wide enum. Parsing all 36 raw
// playbook_def-*.XML files in Research/Playbooks and cross-referencing each
// play's classification against its own <formation_set_list> formation name
// shows two kinds of real conflicts:
//   1. playbook_def-097.XML is an entirely different kind of playbook (drill/
//      tutorial formations named "ST Acceleration Burst", "ST Blitz", "ST
//      Coverage Recognition", etc.) whose classification values (12,13,19,20,
//      21,22,23,26,30,31...) collide with ordinary scrimmage classifications
//      used elsewhere (e.g. 19 also means "Nickel").
//   2. Even among the ordinary (non-drill) files, the SAME formation name can
//      carry a DIFFERENT classification integer in different exported books:
//      "3-4" is classification 13 in some files but 11 in others; "46" is 31
//      in some but 12 in others; "Safety Kick Return" is 37 in some but 0 in
//      others.
// So classification is best read as a per-export-book-local code, not a
// portable global taxonomy, and must never be trusted for a playbook this
// table hasn't specifically verified.
//
// However: of those 36 raw files, only 31 are actually reachable at runtime --
// cross-checked against coordinator.db's `playbooks` table (side='defense'),
// playbook_def-032/033/036/091/097.XML have NO row under any id or
// source_file. They were never imported, so DatabasePlaybookRepository /
// loadDefensePlaybookFromDatabase / the live coordinator can never load them;
// they cannot reach DefensiveSelectionEngine.rank() through any code path.
// (032/033/036/091 look like ordinary, merely-unimported defensive schemes;
// 097 is the drill/tutorial book responsible for nearly all of the
// cross-category conflicts above.)
//
// Restricted to exactly those 31 imported, non-empty, visible=1 defense
// playbooks (ids 500-508, 512-533), classification is internally consistent
// for the coarse category this module cares about: no classification integer
// is ever shared between "ordinary scrimmage" and "situational/special
// teams" across any of the 31 files (verified by
// tests/football-defensive-eligibility.test.cjs, which re-derives this table
// from the raw XML on every run so a future playbook import that breaks this
// assumption fails loudly instead of silently misclassifying plays).
//
// Any classification value NOT in one of the buckets below is UNKNOWN and is
// excluded from the ordinary recommendation pool (fail-safe: prefer excluding
// a specialized/unrecognized package over letting it appear everywhere).

const NORMAL_SCRIMMAGE = new Set([12, 13, 15, 16, 19, 20, 22, 30, 31, 32]); // 4-3, 2-5, 3-4, 3-3-5, 4-2-5, Nickel, Dime, Dollar, 4-4, 46, 5-2
const PREVENT = new Set([21]); // Prevent
const GOAL_LINE = new Set([23]); // Goal Line Defense
const SPECIAL_TEAMS = new Set([24, 25, 26, 27, 28, 29, 37]); // Special (FG/punt block/return/safe), Kick Return, Safety Kick Return

function categorizeDefensivePlay(play) {
  // No classification metadata at all (play.classification is null/undefined)
  // means this play didn't come from the DB catalog import in the first place
  // -- e.g. the hand-authored sample/legacy fallback playbooks used when no
  // database is available. Eligibility gating is meaningless for those (they
  // were never observed to contain situational/special-teams noise), so they
  // pass through as ordinary. The fail-safe "exclude" behavior below is only
  // for a play that DOES carry a real classification integer that simply
  // isn't one this table has verified.
  if (play?.classification == null) return 'normal';
  const classification = Number(play.classification);
  if (!Number.isFinite(classification)) return 'normal';
  if (NORMAL_SCRIMMAGE.has(classification)) return 'normal';
  if (PREVENT.has(classification)) return 'prevent';
  if (GOAL_LINE.has(classification)) return 'goal_line';
  if (SPECIAL_TEAMS.has(classification)) return 'special_teams';
  return 'unknown';
}

// Conservative, situation-gated eligibility. Only `down`/`distance`/`quarter`/
// `clockSeconds`/`scoreDifferential` are trusted here -- NOT `yardLine`. Live
// telemetry's yardLine has been observed in signed/negative coordinates whose
// 0-100 (own goal line -> opponent goal line) convention is not verified, so
// this module never derives goal-to-go or field position from it. If that
// telemetry is verified in a later stage, this can be revisited.
function isDefensivelyEligible(play, situation = {}) {
  const category = categorizeDefensivePlay(play);

  if (category === 'normal') return true;
  if (category === 'unknown') return false;
  if (category === 'special_teams') return false;

  const flags = situation?.flags;

  if (category === 'goal_line') {
    // Only a verified upstream goalToGo flag gates this -- no independent
    // field-position computation is performed here (see module comment).
    return Boolean(flags?.goalToGo);
  }

  if (category === 'prevent') {
    if (flags) {
      return Boolean(flags.longYardage) && Boolean(flags.twoMinute || flags.fourMinute);
    }
    // No pre-computed flags supplied (e.g. an offline caller) -- fall back to
    // the same formulas deriveSituation() uses for longYardage/twoMinute/
    // fourMinute, using only distance/quarter/clockSeconds/scoreDifferential.
    const distance = Number(situation.distance);
    const quarter = Number(situation.quarter);
    const clockSeconds = Number(situation.clockSeconds);
    const scoreDifferential = Number(situation.scoreDifferential);
    if (![distance, quarter, clockSeconds].every(Number.isFinite)) return false;

    const longYardage = distance >= 7;
    const twoMinute = (quarter === 2 || quarter >= 4) && clockSeconds <= 120;
    const fourMinute = quarter >= 4 && clockSeconds <= 240 && Number.isFinite(scoreDifferential) && scoreDifferential > 0;
    return longYardage && (twoMinute || fourMinute);
  }

  return false;
}

module.exports = {
  NORMAL_SCRIMMAGE,
  PREVENT,
  GOAL_LINE,
  SPECIAL_TEAMS,
  categorizeDefensivePlay,
  isDefensivelyEligible,
};
