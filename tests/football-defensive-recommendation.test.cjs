'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const { FootballEngine } = require('../src/football/engine');
const { loadPlaybooks, loadDefensePlaybookFromDatabase } = require('../src/coordinator/playbook-loader.cjs');
const { CoordinatorWindow } = require('../src/football/ui/coordinator-window');
const { printDefensiveRecommendation, snapToFootballEvent } = require('../src/coordinator/live-coordinator.cjs');

function sampleDefensePlaybook() {
  return loadPlaybooks(root, { useDatabase: false }).defense;
}

function shockHOptionPlay(engine) {
  const resolvedConcept = engine.knowledge.resolveConcept('Shock H Option');
  return {
    id: 'shock-h-option',
    name: 'Shock H Option',
    concepts: resolvedConcept ? [resolvedConcept] : [],
    primaryConcept: resolvedConcept,
  };
}

test('recommendDefenses() returns ranked candidates', () => {
  const engine = new FootballEngine();
  const defense = sampleDefensePlaybook();
  const offensePlay = shockHOptionPlay(engine);

  const ranked = engine.recommendDefenses({
    playbook: defense,
    offensePlay,
    situation: { down: 2, distance: 7, yardLine: 40 },
    limit: 3,
  });

  assert.equal(ranked.evaluated, defense.plays.length);
  assert.ok(ranked.recommendations.length > 0);
  assert.equal(ranked.recommendations[0].selectionPolicy, 'exact_offense_oracle_with_empirical_override');
});

test('catalog-resolved offensive concept influences theory scoring', () => {
  const engine = new FootballEngine();
  // Regression-tested Stage 1 mapping: Shock H Option -> choice_option.
  const resolved = engine.knowledge.resolveConcept('Shock H Option');
  assert.equal(resolved, 'choice_option');

  const offensePlay = shockHOptionPlay(engine);
  const defense = sampleDefensePlaybook();
  const ranked = engine.recommendDefenses({
    playbook: defense,
    offensePlay,
    situation: { down: 2, distance: 7, yardLine: 40 },
    limit: 3,
  });

  const coverThree = ranked.recommendations.find(r => r.play.name === 'Cover 3 Match');
  assert.ok(coverThree.components.bootstrapTheory !== 0, 'theory component should be non-zero when concept resolves');
});

test('exact CPU offensive play may influence the defensive recommendation', () => {
  const engine = new FootballEngine();
  const defense = sampleDefensePlaybook();
  const situation = { down: 2, distance: 7, yardLine: 40 };
  const coverThreeMatch = defense.plays.find(p => p.name === 'Cover 3 Match');

  const playA = { id: 'play-a', name: 'Play A', concepts: [] };
  const playB = { id: 'play-b', name: 'Play B', concepts: [] };

  // Seed history only for playA vs Cover 3 Match -- playB has no evidence.
  for (const yards of [12, 15]) {
    engine.recordPlay({ play: playA, opponentPlay: coverThreeMatch, situation, result: { yards, turnover: false } });
  }

  const rankedA = engine.recommendDefenses({ playbook: defense, offensePlay: playA, situation, limit: 3 });
  const rankedB = engine.recommendDefenses({ playbook: defense, offensePlay: playB, situation, limit: 3 });

  const coverThreeForA = rankedA.recommendations.find(r => r.play.name === 'Cover 3 Match');
  const coverThreeForB = rankedB.recommendations.find(r => r.play.name === 'Cover 3 Match');

  assert.equal(coverThreeForA.diagnostic.exactMatchup.attempts, 2);
  assert.equal(coverThreeForB.diagnostic.exactMatchup.attempts, 0);
  assert.notEqual(coverThreeForA.score, coverThreeForB.score);
});

test('exact matchup performance is consumed when present', () => {
  const engine = new FootballEngine();
  const defense = sampleDefensePlaybook();
  const situation = { down: 2, distance: 7, yardLine: 40 };
  const offensePlay = shockHOptionPlay(engine);
  const coverThreeMatch = defense.plays.find(p => p.name === 'Cover 3 Match');

  const cold = engine.recommendDefenses({ playbook: defense, offensePlay, situation, limit: 3 })
    .recommendations.find(r => r.play.name === 'Cover 3 Match');
  assert.equal(cold.diagnostic.exactMatchup.attempts, 0);

  for (const yards of [11, 9, 14, 8]) {
    engine.recordPlay({ play: offensePlay, opponentPlay: coverThreeMatch, situation, result: { yards, turnover: false } });
  }

  const learned = engine.recommendDefenses({ playbook: defense, offensePlay, situation, limit: 3 })
    .recommendations.find(r => r.play.name === 'Cover 3 Match');
  assert.equal(learned.diagnostic.exactMatchup.attempts, 4);
  assert.equal(learned.diagnostic.exactMatchup.defensiveSuccessRate, 0);
  assert.ok(learned.score < cold.score, 'a poor observed matchup should lower the score versus cold-start theory');
});

test('concept-family / coverage-family performance is consumed when exact evidence is sparse', () => {
  const engine = new FootballEngine();
  const situation = { down: 2, distance: 7, yardLine: 40 };

  // Different exact offensive play id, same resolvable concept (choice_option),
  // recorded against a different-but-same-family defensive call id.
  const historicalOffense = { id: 'other-choice-option-play', name: 'Some Other Choice Option Play', concepts: ['choice_option'] };
  const historicalDefense = { id: 'other-cover-3-call', name: 'Cover 3 Buzz', concepts: ['cover_3'] };
  for (const yards of [12, 10, 13]) {
    engine.recordPlay({ play: historicalOffense, opponentPlay: historicalDefense, situation, result: { yards, turnover: false } });
  }

  const defense = sampleDefensePlaybook();
  const offensePlay = shockHOptionPlay(engine); // exact id has zero history
  const ranked = engine.recommendDefenses({ playbook: defense, offensePlay, situation, limit: 3 });
  const coverThreeMatch = ranked.recommendations.find(r => r.play.name === 'Cover 3 Match');

  assert.equal(coverThreeMatch.diagnostic.exactMatchup.attempts, 0);
  assert.ok(coverThreeMatch.diagnostic.familyMatchup.attempts > 0, 'family-level evidence should be found despite no exact evidence');
  assert.notEqual(coverThreeMatch.components.observedFamilyMatchup, 0);
});

test('cold-start recommendation clearly has low/no empirical evidence rather than fabricated history', () => {
  const engine = new FootballEngine();
  const defense = sampleDefensePlaybook();
  const offensePlay = shockHOptionPlay(engine);
  const ranked = engine.recommendDefenses({
    playbook: defense,
    offensePlay,
    situation: { down: 2, distance: 7, yardLine: 40 },
    limit: 3,
  });

  for (const rec of ranked.recommendations) {
    assert.equal(rec.diagnostic.exactMatchup.attempts, 0);
    assert.equal(rec.diagnostic.empiricalReliability, 0);
    assert.equal(rec.components.observedExactMatchup, 0);
    // Theory should carry the full weight of the score when there's no evidence.
    assert.equal(rec.components.bootstrapTheory, rec.score - rec.components.situation - rec.components.repetition);
  }
});

test('repetition penalty works', () => {
  const engine = new FootballEngine();
  const defense = sampleDefensePlaybook();
  const situation = { down: 2, distance: 7, yardLine: 40 };
  const offensePlay = shockHOptionPlay(engine);
  const midBlitz = defense.plays.find(p => p.name === 'Mid Blitz');

  const before = engine.recommendDefenses({ playbook: defense, offensePlay, situation, limit: 3 })
    .recommendations.find(r => r.play.name === 'Mid Blitz');
  // Note: recentDefenseRepetitionPenalty computes -hits * 0.65, which yields
  // -0 (not 0) when there are no hits -- assert.equal/-strictEqual use
  // Object.is semantics where -0 !== 0, so compare with a plain === instead.
  assert.ok(before.components.repetition === 0, `expected no penalty yet, got ${before.components.repetition}`);

  // Repeatedly call Mid Blitz recently -- recentDefenseRepetitionPenalty looks
  // at opponentPlay.id over the last 6 recorded events.
  for (let i = 0; i < 3; i += 1) {
    engine.recordPlay({ play: offensePlay, opponentPlay: midBlitz, situation, result: { yards: 2, turnover: false } });
  }

  const after = engine.recommendDefenses({ playbook: defense, offensePlay, situation, limit: 3 })
    .recommendations.find(r => r.play.name === 'Mid Blitz');
  assert.ok(after.components.repetition < 0, 'repeated recent calls should incur a penalty');
});

test('defensive recommendation does not mutate offensive recommendPlays() behavior', () => {
  const engine = new FootballEngine();
  const offensePlaybook = loadPlaybooks(root, { useDatabase: false }).offense;
  const situation = { down: 2, distance: 5, yardLine: 45 };

  const before = engine.recommendPlays({ playbook: offensePlaybook, situation, limit: 3 });

  const defense = sampleDefensePlaybook();
  engine.recommendDefenses({
    playbook: defense,
    offensePlay: shockHOptionPlay(engine),
    situation,
    limit: 3,
  });

  const after = engine.recommendPlays({ playbook: offensePlaybook, situation, limit: 3 });
  assert.deepEqual(before.recommendations.map(r => r.score), after.recommendations.map(r => r.score));
  // The offense-side no-oracle policy tag must remain unchanged.
  assert.equal(after.recommendations[0].selectionPolicy, 'pre_call_no_current_exact_defense');
});

test('unknown offensive play degrades gracefully rather than throwing', () => {
  const engine = new FootballEngine();
  const defense = sampleDefensePlaybook();
  const offensePlay = { id: 'totally-unknown-play', name: 'Totally Unknown Fictional Play', concepts: [] };

  let ranked;
  assert.doesNotThrow(() => {
    ranked = engine.recommendDefenses({
      playbook: defense,
      offensePlay,
      situation: { down: 1, distance: 10, yardLine: 25 },
      limit: 3,
    });
  });

  assert.ok(ranked.recommendations.length > 0);
  const top = ranked.recommendations[0];
  assert.equal(top.components.bootstrapTheory, 0);
  assert.ok(top.reasons.some(r => /no bootstrap theory match/.test(r)));
});

test('empty/missing defensive candidate set degrades gracefully', () => {
  const engine = new FootballEngine();
  const offensePlay = shockHOptionPlay(engine);

  let ranked;
  assert.doesNotThrow(() => {
    ranked = engine.recommendDefenses({
      playbook: { plays: [] },
      offensePlay,
      situation: { down: 2, distance: 7, yardLine: 40 },
      limit: 3,
    });
  });
  assert.equal(ranked.evaluated, 0);
  assert.deepEqual(ranked.recommendations, []);
});

test('live coordinator defense branch no longer emits the "not implemented" placeholder', () => {
  const source = fs.readFileSync(path.join(root, 'src/coordinator/live-coordinator.cjs'), 'utf8');
  assert.ok(!source.includes('Defensive play ranking is not implemented yet'));

  const engine = new FootballEngine();
  const playbooks = { offense: loadPlaybooks(root, { useDatabase: false }).offense, defense: sampleDefensePlaybook() };
  const logs = [];
  const io = { log: (...args) => logs.push(args.join(' ')) };
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });

  const state = {
    possession: 1,
    down: 2, distance: 7, yardLine: 40, fieldX: 40, quarter: 2, gameClockSeconds: 400,
    defensiveCallAvailable: false,
    offensiveCallAvailable: true, offensiveCallStatus: 'ok',
    offensiveSide: 1, offensiveSet: 'Gun Trio Y-Flex', offensivePlay: 'Shock H Option', offensivePlayId: 501,
  };

  printDefensiveRecommendation(engine, playbooks, state, null, { offense: true, defense: true }, io, coordinatorWindow);

  assert.ok(logs.some(l => l.includes('[DC] CALL:')));
  assert.ok(logs.includes('[DC] POOL: total=2 eligible=2 specialTeams=0 situational=0 unknown=0'));
  assert.ok(!logs.some(l => l.includes('not implemented yet')));
  assert.equal(coordinatorWindow.state.phase, 'defensive_huddle');
});

test('no recommendation display produces a fake completed snap', () => {
  const engine = new FootballEngine();
  const playbooks = { offense: loadPlaybooks(root, { useDatabase: false }).offense, defense: sampleDefensePlaybook() };
  const io = { log: () => {} };
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });

  const state = {
    possession: 1,
    down: 2, distance: 7, yardLine: 40, fieldX: 40, quarter: 2, gameClockSeconds: 400,
    offensiveCallAvailable: true, offensiveCallStatus: 'ok',
    offensiveSide: 1, offensiveSet: 'Gun Trio Y-Flex', offensivePlay: 'Shock H Option', offensivePlayId: 501,
  };

  const before = engine.performance.getAll().length;
  printDefensiveRecommendation(engine, playbooks, state, null, { offense: true, defense: true }, io, coordinatorWindow);
  const after = engine.performance.getAll().length;

  assert.equal(before, 0);
  assert.equal(after, 0);
});

test('CoordinatorWindow accepts/renders the defensive recommendation state', () => {
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });

  coordinatorWindow.showDefensiveRecommendation({
    available: true,
    cpuPlay: { name: 'Shock H Option', formation: 'Gun Trio Y-Flex' },
    play: { name: 'Mid Blitz', formation: 'Nickel 2-4 Dbl Mug' },
    reasons: ['this defense has held the concept below expected efficiency'],
  }, { quarter: 2, gameClockSeconds: 400, down: 2, distance: 7, yardLine: 40 });

  assert.equal(coordinatorWindow.state.phase, 'defensive_huddle');
  assert.equal(coordinatorWindow.state.cpuPlay, 'Shock H Option');
  assert.equal(coordinatorWindow.state.cpuFormation, 'Gun Trio Y-Flex');
  assert.equal(coordinatorWindow.state.call, 'Mid Blitz');
  assert.equal(coordinatorWindow.state.formation, 'Nickel 2-4 Dbl Mug');
  assert.deepEqual(coordinatorWindow.state.why, ['this defense has held the concept below expected efficiency']);

  coordinatorWindow.showDefensiveRecommendation({
    available: false,
    reason: 'No legal defensive recommendation is available.',
    cpuPlay: { name: 'Shock H Option', formation: 'Gun Trio Y-Flex' },
  }, { quarter: 2, gameClockSeconds: 400, down: 2, distance: 7, yardLine: 40 });

  assert.equal(coordinatorWindow.state.phase, 'defensive_unavailable');
  assert.equal(coordinatorWindow.state.call, null);
});

test('default playbook loading keeps the sample fallback when no defense selection is saved', () => {
  const playbooks = loadPlaybooks(root, {});
  assert.equal(playbooks.defense.plays.length, 2);
  assert.equal(playbooks.defense.status, 'sample-only');
});

test('an explicit defensePlaybookId override can load a real DB-backed defensive playbook', () => {
  const book = loadDefensePlaybookFromDatabase(root, { defensePlaybookId: '3-4' });
  assert.ok(book);
  assert.equal(book.name, '3-4');
  assert.ok(book.plays.length > 200, `expected a realistic full defensive play set, got ${book.plays.length}`);
  assert.equal(book.membershipVerified, false); // honestly reported: no verified overlay exists for defense

  const engine = new FootballEngine();
  const ranked = engine.recommendDefenses({
    playbook: book,
    offensePlay: shockHOptionPlay(engine),
    situation: { down: 2, distance: 7, yardLine: 40 },
    limit: 3,
  });
  // Fix A2: on an ordinary down with no goalToGo/long-yardage-clock flags,
  // evaluated/recommendations only cover eligible (ordinary scrimmage)
  // candidates -- Prevent/Goal Line/Special Teams/Kick Return are filtered
  // out before scoring. candidatePool.total still reports the full raw pool.
  assert.equal(ranked.candidatePool.total, book.plays.length);
  assert.equal(ranked.evaluated, ranked.candidatePool.eligible);
  assert.ok(ranked.evaluated < book.plays.length, 'situational/special-teams plays should have been excluded');
  assert.ok(ranked.recommendations.length > 0);
});

// --- Fix A1/A3: defensive event id normalization + repetition, exercised via
// the REAL live-coordinator bridge (snapToFootballEvent + recordPlay), not a
// hand-built event -- this is what actually failed before the fix, since the
// old "repetition penalty works" test above builds its event by hand with an
// already-matching id and never exercised snapToFootballEvent() at all.

function loadRealDefenseBook522() {
  const book = loadDefensePlaybookFromDatabase(root, { defensePlaybookId: 522 });
  assert.ok(book, 'expected playbook 522 to be loadable from the real coordinator.db');
  return book;
}

function completedSnapFixture({ offenseCall, defenseCall, serial = 1 }) {
  return {
    start: { down: 1, distance: 10, yardLine: 35, quarter: 1, gameClockSeconds: 800, playClockSeconds: 25, possession: 1 },
    end: { down: 2, distance: 7, yardLine: 38, quarter: 1, gameClockSeconds: 760, playClockSeconds: 25, possession: 1 },
    offenseCall,
    defenseCall,
    serial,
    result: { yards: 3, firstDown: false, touchdown: false, turnover: false, possessionChanged: false, pointsScored: 0 },
  };
}

test('Fix A1: matched actual defensive call is normalized to its canonical catalog id', () => {
  const defenseBook = loadRealDefenseBook522();
  const edgePinch = defenseBook.plays.find(p => p.name === '1 Edge Pinch');
  assert.ok(edgePinch);
  assert.match(edgePinch.id, /^522:/); // canonical catalog id, not the raw telemetry id

  const playbooks = { offense: { plays: [] }, defense: defenseBook };
  const snap = completedSnapFixture({
    offenseCall: { available: true, set: 'Wing Trips Wk', name: 'Inside Zone Split', id: '9001' },
    // Raw live telemetry shape exactly as SnapReducer.callFromState() would
    // produce it: the in-game numeric play id ("45"), NOT the catalog id.
    defenseCall: { available: true, set: 'Grizzly', name: '1 Edge Pinch', id: '45' },
  });

  const event = snapToFootballEvent(snap, playbooks);
  assert.equal(event.opponentPlay.id, edgePinch.id);
  assert.notEqual(event.opponentPlay.id, '45');
});

test('Fix A1: unmatched defensive call preserves the honest raw telemetry representation', () => {
  const defenseBook = loadRealDefenseBook522();
  const playbooks = { offense: { plays: [] }, defense: defenseBook };
  const snap = completedSnapFixture({
    offenseCall: { available: true, set: 'Wing Trips Wk', name: 'Inside Zone Split', id: '9001' },
    defenseCall: { available: true, set: 'Some Unknown Set', name: 'Totally Unmatched Defensive Call', id: '999999' },
  });

  const event = snapToFootballEvent(snap, playbooks);
  // No fabricated catalog id -- the raw telemetry id/name stand untouched.
  assert.equal(event.opponentPlay.id, '999999');
  assert.equal(event.opponentPlay.name, 'Totally Unmatched Defensive Call');
});

test('Fix A1: history records the ACTUAL telemetry call, not the coordinator recommendation', () => {
  const defenseBook = loadRealDefenseBook522();
  const playbooks = { offense: { plays: [] }, defense: defenseBook };
  const engine = new FootballEngine();

  const recommended = engine.recommendDefenses({
    playbook: defenseBook,
    offensePlay: { id: 'cpu-off', name: 'Four Verticals', concepts: ['four_verticals'] },
    situation: { down: 3, distance: 9 },
    limit: 1,
  }).recommendations[0];
  assert.equal(recommended.play.name, 'Tampa Sim Pressure');

  // The user actually called a different defense than the one recommended.
  const tampa2 = defenseBook.plays.find(p => p.name === 'Tampa 2');
  assert.ok(tampa2);
  const snap = completedSnapFixture({
    offenseCall: { available: true, set: 'Bunch Wide', name: 'Four Verticals', id: '9002' },
    defenseCall: { available: true, set: tampa2.formation, name: 'Tampa 2', id: '105' },
  });

  const event = snapToFootballEvent(snap, playbooks);
  const recorded = engine.recordPlay(event);
  assert.equal(recorded.opponentPlay.id, tampa2.id);
  assert.notEqual(recorded.opponentPlay.name, recommended.play.name);
});

test('Fix A3: repetition penalty activates end-to-end for 3 actual repeated uses', () => {
  const defenseBook = loadRealDefenseBook522();
  const playbooks = { offense: { plays: [] }, defense: defenseBook };
  const engine = new FootballEngine();

  function rerank() {
    const ranked = engine.recommendDefenses({
      playbook: defenseBook,
      offensePlay: { id: 'cpu-off', name: 'Unresolved CPU Concept', concepts: [] },
      situation: { down: 1, distance: 10 },
      limit: 240,
    });
    return ranked.recommendations.find(r => r.play.name === '1 Edge Pinch');
  }

  const before = rerank();
  // recentDefenseRepetitionPenalty computes -hits * 0.65, which yields -0
  // (not 0) when there are no hits -- Object.is semantics make
  // assert.equal/-strictEqual treat -0 !== 0, so compare with a plain ===.
  assert.ok(before.components.repetition === 0, `expected no penalty yet, got ${before.components.repetition}`);

  const expectedPenalties = [-0.65, -1.3, -1.95];
  for (let i = 0; i < 3; i += 1) {
    const snap = completedSnapFixture({
      offenseCall: { available: true, set: 'Wing Trips Wk', name: 'Inside Zone Split', id: `900${i}` },
      defenseCall: { available: true, set: 'Grizzly', name: '1 Edge Pinch', id: '45' },
      serial: i + 1,
    });
    const event = snapToFootballEvent(snap, playbooks);
    engine.recordPlay(event);

    const after = rerank();
    assert.ok(
      Math.abs(after.components.repetition - expectedPenalties[i]) < 1e-9,
      `after use ${i + 1}: expected repetition ${expectedPenalties[i]}, got ${after.components.repetition}`
    );
  }
});

test('Fix A2: special-teams/situational packages are excluded from an ordinary 1st & 10 pool', () => {
  const defenseBook = loadRealDefenseBook522();
  const engine = new FootballEngine();
  const ranked = engine.recommendDefenses({
    playbook: defenseBook,
    offensePlay: { id: 'cpu-off', name: 'Unresolved CPU Concept', concepts: [] },
    situation: { down: 1, distance: 10 },
    limit: 240,
  });

  assert.equal(ranked.candidatePool.total, 240);
  assert.equal(ranked.candidatePool.excludedSpecialTeams, 24); // Special(14) + Kick Return(7) + Safety Kick Return(3)
  assert.equal(ranked.candidatePool.excludedSituational, 15); // Prevent(3) + Goal Line(12)
  assert.equal(ranked.candidatePool.excludedUnknown, 0);
  assert.equal(ranked.candidatePool.eligible, 201);
  assert.equal(ranked.evaluated, 201);

  const { categorizeDefensivePlay } = require('../src/football/recommendation/defensive-eligibility');
  for (const rec of ranked.recommendations) {
    assert.notEqual(categorizeDefensivePlay(rec.play), 'special_teams');
  }
});

test('Fix A2: Goal Line Defense is only eligible with a verified goalToGo flag', () => {
  const defenseBook = loadRealDefenseBook522();
  const engine = new FootballEngine();
  const situationNoFlags = { down: 1, distance: 2 };
  const rankedNoFlags = engine.recommendDefenses({
    playbook: defenseBook, offensePlay: { id: 'cpu', name: 'unknown', concepts: [] }, situation: situationNoFlags, limit: 240,
  });
  assert.equal(rankedNoFlags.candidatePool.eligible, 201);

  const situationGoalToGo = { down: 1, distance: 2, flags: { goalToGo: true } };
  const rankedGoalToGo = engine.recommendDefenses({
    playbook: defenseBook, offensePlay: { id: 'cpu', name: 'unknown', concepts: [] }, situation: situationGoalToGo, limit: 240,
  });
  assert.equal(rankedGoalToGo.candidatePool.eligible, 213); // 201 normal + 12 Goal Line
});

test('Fix A2: Prevent is only eligible in a verified long-yardage + two/four-minute context', () => {
  const defenseBook = loadRealDefenseBook522();
  const engine = new FootballEngine();

  const ordinaryThirdAndLong = { down: 3, distance: 9, flags: { longYardage: true, twoMinute: false, fourMinute: false } };
  const ranked1 = engine.recommendDefenses({
    playbook: defenseBook, offensePlay: { id: 'cpu', name: 'unknown', concepts: [] }, situation: ordinaryThirdAndLong, limit: 240,
  });
  assert.equal(ranked1.candidatePool.eligible, 201, 'ordinary 3rd & long must NOT make Prevent legal by itself');

  const twoMinuteThirdAndLong = { down: 3, distance: 9, flags: { longYardage: true, twoMinute: true, fourMinute: false } };
  const ranked2 = engine.recommendDefenses({
    playbook: defenseBook, offensePlay: { id: 'cpu', name: 'unknown', concepts: [] }, situation: twoMinuteThirdAndLong, limit: 240,
  });
  assert.equal(ranked2.candidatePool.eligible, 204); // 201 normal + 3 Prevent
});

test('Fix A2: known-good long-yardage four_verticals/Tampa Sim Pressure scoring advantage survives eligibility filtering', () => {
  const defenseBook = loadRealDefenseBook522();
  const engine = new FootballEngine();
  const ranked = engine.recommendDefenses({
    playbook: defenseBook,
    offensePlay: { id: 'cpu', name: 'Four Verticals', concepts: ['four_verticals'] },
    situation: { down: 3, distance: 9 },
    limit: 1,
  });
  const top = ranked.recommendations[0];
  assert.equal(top.play.name, 'Tampa Sim Pressure');
  assert.ok(top.components.situation > 0, 'long-yardage coverage-shell/pressure bonus should still apply');
  assert.ok(top.components.bootstrapTheory > 0, 'bootstrap theory should still favor this call vs verticals');
});
