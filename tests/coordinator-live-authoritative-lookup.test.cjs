'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findPlay } = require('../src/coordinator/playbook-loader.cjs');
const { EaPlayKnowledgeStore } = require('../src/football/knowledge/ea-play-knowledge-store');
const {
  matchAuthoritativePlayContext,
  resolveAuthoritativeOffensivePlay,
  resolveFreshOffensiveAuthority,
  attachAuthoritativeIdentity,
} = require('../src/coordinator/authoritative-play-match.cjs');
const {
  authorityDiagnosticKey,
  formatAuthorityDiagnostic,
  logAuthorityTransition,
  printExecutionAdvice,
  buildOracleAudibleScope,
} = require('../src/coordinator/live-coordinator.cjs');

function artifact(entries) {
  const formations = {};
  const sets = {};
  const plays = {};
  for (const entry of entries) {
    const formationKey = `formation:${entry.formation}`;
    const setKey = `set:${entry.formation}/${entry.set}`;
    const playKey = `play:${entry.asset}`;
    formations[formationKey] ||= { name: entry.formation, assetPath: `Formation/${entry.formation}` };
    sets[setKey] ||= { name: entry.set, assetPath: `Set/${entry.formation}/${entry.set}`, positions: [] };
    plays[playKey] = {
      formationKey,
      setKey,
      play: { name: entry.name, playId: entry.playId, assetPath: entry.asset },
      players: [],
      provenance: { play: 'EA_AUTHORED' },
      resolution: { status: 'fully_resolved' },
    };
  }
  return { metadata: {}, formations, sets, assignments: {}, plays, unresolved: [] };
}

function call(name, set, id = 'live-1', available = true) {
  return { available, name, set, id };
}

test('bare-name findPlay fallback cannot donate DB Formation to ambiguous live Set+Play authority', () => {
  const playbook = {
    plays: [{
      id: 'db-pa-boot',
      name: 'PA Boot',
      formation: 'I Form Pro',
      formationName: 'I Form',
      membershipVerified: true,
      membershipSource: 'verified_current_overlay',
    }],
  };
  const liveCall = call('PA Boot', 'Pro', '999');
  const legacy = findPlay(playbook, { id: liveCall.id, name: liveCall.name, set: liveCall.set });
  assert.equal(legacy, playbook.plays[0], 'legacy findPlay should demonstrate the bare-name fallback');

  const store = new EaPlayKnowledgeStore({ document: artifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 1, asset: 'I_Form/Pro/PA_Boot' },
    { formation: 'Weak I', set: 'Pro', name: 'PA Boot', playId: 2, asset: 'Weak_I/Pro/PA_Boot' },
  ]) });

  const result = resolveAuthoritativeOffensivePlay({ store, playbook, liveCall });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reason, 'multiple_authoritative_structural_candidates');
  assert.equal(result.matchStrategy, 'set_play');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.playKey, undefined);
  assert.equal(result.evidence.formationName, undefined, 'name-only legacy metadata must not become Formation authority');
});

test('live Set+Play evidence resolves and preserves exact telemetry provenance', () => {
  const playbook = {
    plays: [{
      id: 'db-pa-boot',
      name: 'PA Boot',
      formation: 'I Form Pro',
      membershipVerified: true,
      membershipSource: 'verified_current_overlay',
    }],
  };
  const store = new EaPlayKnowledgeStore({ document: artifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 51, asset: 'I_Form/Pro/PA_Boot' },
  ]) });

  const result = resolveAuthoritativeOffensivePlay({
    store,
    playbook,
    liveCall: call('PA Boot', 'Pro', '12345'),
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.matchStrategy, 'set_play');
  assert.equal(result.playKey, 'play:I_Form/Pro/PA_Boot');
  assert.equal(result.formationName, 'I Form');
  assert.equal(result.setName, 'Pro');
  assert.equal(result.evidence.playName.source, 'live_telemetry.offensivePlay');
  assert.equal(result.evidence.setName.source, 'live_telemetry.offensiveSet');
  assert.equal(result.evidence.setName.semanticRole, 'set_name');
  assert.equal(result.evidence.livePlayId.authorityBearing, false);
  assert.equal(result.upstreamMatch.matchStrategy, 'live_set_play');
});

test('exact live id remains diagnostic-only and cannot rescue a Set+Play corpus miss', () => {
  const playbook = {
    plays: [{ id: '77', name: 'DB Play', formation: 'Singleback Ace' }],
  };
  const store = new EaPlayKnowledgeStore({ document: artifact([
    { formation: 'Singleback', set: 'Ace', name: 'PA Jet Sweep', playId: 77, asset: 'Singleback/Ace/PA_Jet_Sweep' },
  ]) });

  const result = resolveAuthoritativeOffensivePlay({
    store,
    playbook,
    liveCall: call('Different Play', 'Ace', '77'),
  });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'authoritative_structural_miss');
  assert.equal(result.matchStrategy, 'set_play');
  assert.equal(result.evidence.livePlayId.authorityBearing, false);
});

test('strict helper preserves multiple exact DB Set+Play matches without first-match Formation authority', () => {
  const playbook = {
    plays: [
      {
        id: 'a',
        name: 'PA Boot',
        setName: 'Pro',
        formationName: 'I Form',
        membershipVerified: true,
        membershipSource: 'verified_current_overlay',
      },
      {
        id: 'b',
        name: 'PA Boot',
        setName: 'Pro',
        formationName: 'Weak I',
        membershipVerified: true,
        membershipSource: 'verified_current_overlay',
      },
    ],
  };
  const match = matchAuthoritativePlayContext(playbook, call('PA Boot', 'Pro'));
  assert.equal(match.status, 'matched');
  assert.equal(match.authorityEligible, true);
  assert.equal(match.matchStrategy, 'live_set_play');
  assert.equal(match.candidates.length, 2);
  assert.equal(match.query.formationName, null);
  assert.equal(match.play, null);
});

test('actual live Set-name shapes resolve through authoritative Set+Play lookup', () => {
  const store = new EaPlayKnowledgeStore({ document: artifact([
    { formation: 'Singleback', set: 'Ace', name: 'PA Jet Sweep', playId: 101, asset: 'Singleback/Ace/PA_Jet_Sweep' },
    { formation: 'Singleback', set: 'Bunch', name: 'PA Boot Slide', playId: 102, asset: 'Singleback/Bunch/PA_Boot_Slide' },
    { formation: 'Singleback', set: 'Wing Pair', name: 'Spacing', playId: 103, asset: 'Singleback/Wing_Pair/Spacing' },
  ]) });
  const playbook = { plays: [] };

  for (const sample of [
    ['Ace', 'PA Jet Sweep', 'play:Singleback/Ace/PA_Jet_Sweep'],
    ['Bunch', 'PA Boot Slide', 'play:Singleback/Bunch/PA_Boot_Slide'],
    ['Wing Pair', 'Spacing', 'play:Singleback/Wing_Pair/Spacing'],
  ]) {
    const [setName, playName, expectedPlayKey] = sample;
    const result = resolveFreshOffensiveAuthority({
      store,
      playbook,
      liveCall: call(playName, setName),
      fresh: true,
    });
    assert.equal(result.status, 'resolved', `${setName} / ${playName}`);
    assert.equal(result.matchStrategy, 'set_play');
    assert.equal(result.playKey, expectedPlayKey);
  }
});

test('known College / Onside Kick Set+Play collision stays ambiguous with all candidates', () => {
  const store = new EaPlayKnowledgeStore({ document: artifact([
    { formation: 'Kickoff', set: 'College', name: 'Onside Kick', playId: 201, asset: 'Kickoff/College/Onside_Kick' },
    { formation: 'Kickoff', set: 'College', name: 'Onside Kick', playId: 202, asset: 'Kickoff/College/Nested/Onside_Kick' },
  ]) });

  const result = resolveFreshOffensiveAuthority({
    store,
    playbook: { plays: [] },
    liveCall: call('Onside Kick', 'College'),
    fresh: true,
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.matchStrategy, 'set_play');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.playKey, undefined);
  assert.deepEqual(
    new Set(result.candidates.map(candidate => candidate.playKey)),
    new Set(['play:Kickoff/College/Onside_Kick', 'play:Kickoff/College/Nested/Onside_Kick'])
  );
});

test('missing live Set or Play is insufficient evidence, not an authoritative corpus miss', () => {
  const store = new EaPlayKnowledgeStore({ document: artifact([
    { formation: 'Singleback', set: 'Ace', name: 'PA Jet Sweep', playId: 101, asset: 'Singleback/Ace/PA_Jet_Sweep' },
  ]) });
  const playbook = { plays: [] };

  const missingSet = resolveAuthoritativeOffensivePlay({
    store,
    playbook,
    liveCall: call('PA Jet Sweep', null),
  });
  assert.equal(missingSet.status, 'unresolved');
  assert.equal(missingSet.reason, 'missing_live_set_name');

  const missingPlay = resolveAuthoritativeOffensivePlay({
    store,
    playbook,
    liveCall: call(null, 'Ace'),
  });
  assert.equal(missingPlay.status, 'unresolved');
  assert.equal(missingPlay.reason, 'missing_live_play_name');
});

test('authoritative offensive identity is subordinate to existing offense freshness and call availability', () => {
  const playbook = { plays: [{ id: 'a', name: 'PA Boot', formation: 'I Form Pro' }] };
  const store = new EaPlayKnowledgeStore({ document: artifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 1, asset: 'I_Form/Pro/PA_Boot' },
  ]) });
  const liveCall = call('PA Boot', 'Pro');

  const stale = resolveFreshOffensiveAuthority({ store, playbook, liveCall, fresh: false });
  assert.equal(stale.status, 'unresolved');
  assert.equal(stale.reason, 'offensive_call_not_fresh');

  const fresh = resolveFreshOffensiveAuthority({ store, playbook, liveCall, fresh: true });
  assert.equal(fresh.status, 'resolved');

  const unavailable = resolveFreshOffensiveAuthority({
    store,
    playbook,
    liveCall: { ...liveCall, available: false },
    fresh: true,
  });
  assert.equal(unavailable.status, 'unresolved');
  assert.equal(unavailable.reason, 'offensive_call_unavailable');
});

test('audible A to B replaces canonical identity with no independent lifecycle or defense dependency', () => {
  const playbook = {
    plays: [
      { id: 'a', name: 'PA Boot', formation: 'I Form Pro' },
      { id: 'b', name: 'HB Duo', formation: 'I Form Pro' },
    ],
  };
  const store = new EaPlayKnowledgeStore({ document: artifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 1, asset: 'I_Form/Pro/PA_Boot' },
    { formation: 'I Form', set: 'Pro', name: 'HB Duo', playId: 2, asset: 'I_Form/Pro/HB_Duo' },
  ]) });

  const first = resolveFreshOffensiveAuthority({ store, playbook, liveCall: call('PA Boot', 'Pro', '1'), fresh: true });
  const audible = resolveFreshOffensiveAuthority({ store, playbook, liveCall: call('HB Duo', 'Pro', '2'), fresh: true });
  assert.equal(first.status, 'resolved');
  assert.equal(audible.status, 'resolved');
  assert.notEqual(first.playKey, audible.playKey);
  assert.equal(audible.playKey, 'play:I_Form/Pro/HB_Duo');
});

test('artifact failure leaves legacy selected play usable and only authority unavailable', () => {
  const playbook = { plays: [{ id: 'a', name: 'PA Boot', formation: 'I Form Pro' }] };
  const store = new EaPlayKnowledgeStore({ filePath: '/definitely/not/here.json' });
  const selectedPlay = findPlay(playbook, { name: 'PA Boot', set: 'I Form Pro' });
  const authority = resolveFreshOffensiveAuthority({
    store,
    playbook,
    liveCall: call('PA Boot', 'Pro'),
    fresh: true,
  });
  assert.equal(selectedPlay, playbook.plays[0]);
  assert.equal(authority.status, 'unavailable');
  assert.equal(attachAuthoritativeIdentity(selectedPlay, authority), selectedPlay);
});

test('resolved authority attaches exact canonical identity without changing legacy play fields', () => {
  const playbook = { plays: [{ id: 'legacy-a', name: 'PA Boot', formation: 'I Form Pro', concepts: ['boot'] }] };
  const store = new EaPlayKnowledgeStore({ document: artifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 1001, asset: 'I_Form/Pro/PA_Boot' },
  ]) });
  const selectedPlay = playbook.plays[0];
  const authority = resolveFreshOffensiveAuthority({
    store,
    playbook,
    liveCall: call('PA Boot', 'Pro', 'unrelated-live-id'),
    fresh: true,
  });
  const enriched = attachAuthoritativeIdentity(selectedPlay, authority);
  assert.equal(enriched.id, selectedPlay.id);
  assert.equal(enriched.name, selectedPlay.name);
  assert.equal(enriched.formation, selectedPlay.formation);
  assert.equal(enriched.eaAuthority.playKey, 'play:I_Form/Pro/PA_Boot');
  assert.equal(enriched.eaAuthority.authoredPlayId, 1001);
});


test('EA authority diagnostic logs only transitions and includes canonical evidence', () => {
  const logs = [];
  const io = { log: line => logs.push(line) };
  const liveCall = call('PA Boot', 'Pro', '999');
  const resolved = {
    status: 'resolved',
    matchStrategy: 'set_play',
    formationName: 'I Form',
    setName: 'Pro',
    playName: 'PA Boot',
    playKey: 'play:football/Gameplay/playbooks/PlayLibrary/Offense/I_Form/Pro/PA_Boot',
    authoredPlayId: 1234,
  };

  let key = null;
  key = logAuthorityTransition(resolved, liveCall, key, io);
  const repeated = logAuthorityTransition(resolved, liveCall, key, io);
  assert.equal(repeated, key);
  assert.equal(logs.length, 1);
  assert.equal(
    logs[0],
    '[EA-AUTH] resolved | live="Pro / PA Boot" | strategy=set_play | formation="I Form" | set="Pro" | play="PA Boot" | playKey="play:football/Gameplay/playbooks/PlayLibrary/Offense/I_Form/Pro/PA_Boot" | authoredPlayId=1234'
  );

  const audible = {
    ...resolved,
    playName: 'HB Duo',
    playKey: 'play:football/Gameplay/playbooks/PlayLibrary/Offense/I_Form/Pro/26_Duo',
    authoredPlayId: 5678,
  };
  key = logAuthorityTransition(audible, call('HB Duo', 'Pro', '1000'), key, io);
  assert.equal(logs.length, 2);
  assert.match(logs[1], /playKey="play:football\/Gameplay\/playbooks\/PlayLibrary\/Offense\/I_Form\/Pro\/26_Duo"/);
});

test('EA authority diagnostic reports failure reasons and deduplicates without affecting resolution objects', () => {
  const logs = [];
  const io = { log: line => logs.push(line) };
  const unresolved = {
    status: 'unresolved',
    reason: 'name_only_match_not_authority_bearing',
    matchStrategy: 'name_only',
    authorityEligible: false,
  };
  const liveA = call('PA Boot', 'Weak I Pro', '1');
  const before = JSON.stringify(unresolved);

  let key = logAuthorityTransition(unresolved, liveA, null, io);
  key = logAuthorityTransition(unresolved, liveA, key, io);
  assert.equal(logs.length, 1);
  assert.equal(JSON.stringify(unresolved), before);
  assert.equal(
    logs[0],
    '[EA-AUTH] unresolved | reason=name_only_match_not_authority_bearing | live="Weak I Pro / PA Boot" | strategy=name_only'
  );

  const notFound = {
    status: 'not_found',
    reason: 'authoritative_structural_miss',
    matchStrategy: 'set_play',
  };
  key = logAuthorityTransition(notFound, liveA, key, io);
  assert.equal(logs.length, 2);
  assert.match(logs[1], /^\[EA-AUTH\] not_found \| reason=authoritative_structural_miss/);

  const liveB = call('HB Stretch', 'Singleback Ace', '2');
  const sameFailureNewCallKey = logAuthorityTransition(notFound, liveB, key, io);
  assert.notEqual(sameFailureNewCallKey, key);
  assert.equal(logs.length, 3, 'a different live call is a diagnostic transition, not per-tick spam');

  assert.notEqual(authorityDiagnosticKey(unresolved, liveA), authorityDiagnosticKey(notFound, liveA));
  assert.match(formatAuthorityDiagnostic({ status: 'unavailable', reason: 'artifact_missing' }, liveA), /reason=artifact_missing/);
});

test('PowerShell READ diagnostics prefer actionable authoritative guide over known legacy advice', () => {
  const logs = [];
  const io = { log: line => logs.push(line) };
  const coordinatorWindow = { showSelection() {} };
  const playbooks = { offense: { plays: [{ id: 'live-off', name: 'PA Sail X Post', formation: 'Wing Slot', concepts: ['legacy_sail'] }] } };
  const state = {
    possession: 0, down: 1, fieldX: 25,
    offensiveCallAvailable: true, offensiveSet: 'Wing Slot', offensivePlay: 'PA Sail X Post', offensivePlayId: 'live-off',
    defensiveCallAvailable: true, defensiveSet: 'Nickel', defensivePlay: 'Cover 3 Sky', defensivePlayId: 'live-def',
  };
  const engine = { adviseExecution() {
    return {
      available: true, authority: { available: true },
      advice: { known: true, headline: 'LEGACY HEADLINE SHOULD NOT WIN',
        coaching: { preSnap: ['Choose/confirm the concept side.'], postSnap: ['Common teaching is deep-to-intermediate-to-short.'] } },
      guide: { mode: 'pass', progressionStatus: 'derived',
        reads: [{ number: '1', label: 'Flat', detail: 'KEY: curl-flat defender. WINDOW: quick. THROW: immediately after release.' }] },
    };
  } };

  printExecutionAdvice(engine, playbooks, state, null, { offense: true, defense: true }, io, coordinatorWindow,
    { status: 'resolved', playKey: 'play:test' });

  const authoritativeIndex = logs.findIndex(line => /DERIVED_STRUCTURAL/.test(line));
  const readIndex = logs.findIndex(line => /1: Flat/.test(line));
  const legacyIndex = logs.findIndex(line => /LEGACY HEADLINE SHOULD NOT WIN/.test(line));
  assert.ok(authoritativeIndex >= 0);
  assert.ok(readIndex > authoritativeIndex);
  assert.equal(legacyIndex, -1);
});


test('Oracle scope is current play plus only four confirmed audibles from the same formation', () => {
  const selected = { id: 'sel', name: 'MTN SPACING', formation: 'Gun Bunch Spread Nasty' };
  const same = [
    { id: 'a1', name: 'Quick Out', formation: 'Gun Bunch Spread Nasty' },
    { id: 'a2', name: 'Inside Zone', formation: 'Gun Bunch Spread Nasty' },
    { id: 'a3', name: 'Flood', formation: 'Gun Bunch Spread Nasty' },
    { id: 'a4', name: 'Verts', formation: 'Gun Bunch Spread Nasty' },
  ];
  const other = { id: 'x1', name: 'WEAK FLOOD', formation: 'I Form Slot' };
  const playbook = { id: 'pb', name: 'Pro Style', plays: [selected, ...same, other] };
  const pkg = {
    available: true,
    confirmed: true,
    formation: selected.formation,
    slots: same.map((play, index) => ({
      slot: 'AUDIBLE_' + (index + 1),
      playId: play.id,
      playName: play.name,
      formation: play.formation,
    })),
  };
  const scope = buildOracleAudibleScope(playbook, selected, pkg);
  assert.equal(scope.available, true);
  assert.deepEqual(scope.playbook.plays.map(play => play.id), ['sel', 'a1', 'a2', 'a3', 'a4']);
  assert.ok(scope.playbook.plays.every(play => play.formation === selected.formation));
  assert.ok(!scope.playbook.plays.some(play => play.id === 'x1'));
});

test('Oracle fails closed to KEEP when current formation audibles are not confirmed', () => {
  const selected = { id: 'sel', name: 'MTN SPACING', formation: 'Gun Bunch Spread Nasty' };
  const playbook = { id: 'pb', plays: [selected, { id: 'x1', name: 'WEAK FLOOD', formation: 'I Form Slot' }] };
  const scope = buildOracleAudibleScope(playbook, selected, {
    available: true,
    confirmed: false,
    formation: selected.formation,
    slots: [],
  });
  assert.equal(scope.available, false);
  assert.deepEqual(scope.playbook.plays.map(play => play.id), ['sel']);
  assert.match(scope.reason, /not confirmed/i);
});
