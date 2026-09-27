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

test('bare-name findPlay fallback cannot donate DB structure to authoritative identity', () => {
  const playbook = {
    plays: [{
      id: 'db-pa-boot',
      name: 'PA Boot',
      formation: 'I Form Pro',
      formationName: 'I Form',
      setName: 'Pro',
      membershipVerified: true,
      membershipSource: 'verified_current_overlay',
    }],
  };
  const liveCall = call('PA Boot', 'Weak I Pro', '999');
  const legacy = findPlay(playbook, { id: liveCall.id, name: liveCall.name, set: liveCall.set });
  assert.equal(legacy, playbook.plays[0], 'legacy findPlay should demonstrate the bare-name fallback');

  const store = new EaPlayKnowledgeStore({ document: artifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 1, asset: 'I_Form/Pro/PA_Boot' },
  ]) });
  const result = resolveAuthoritativeOffensivePlay({ store, playbook, liveCall });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.reason, 'name_only_match_not_authority_bearing');
  assert.equal(result.matchStrategy, 'name_only');
  assert.equal(result.authorityEligible, false);
});

test('exact structural live evidence resolves and preserves evidence provenance', () => {
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
    liveCall: call('PA Boot', 'I Form Pro', '12345'),
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.playKey, 'play:I_Form/Pro/PA_Boot');
  assert.equal(result.evidence.playName.source, 'live_telemetry.offensivePlay');
  assert.equal(result.evidence.presentation.source, 'live_telemetry.offensiveSet');
  assert.equal(result.evidence.presentation.semanticRole, 'structural_presentation');
  assert.equal(result.evidence.livePlayId.authorityBearing, false);
  assert.equal(result.upstreamMatch.matchStrategy, 'exact_structural');
});

test('exact live id alone is diagnostic membership evidence, not authority-bearing', () => {
  const playbook = {
    plays: [{ id: '77', name: 'PA Boot', formation: 'I Form Pro' }],
  };
  const match = matchAuthoritativePlayContext(playbook, call('Different Play', 'Different Set', '77'));
  assert.equal(match.status, 'unresolved');
  assert.equal(match.matchStrategy, 'exact_live_id');
  assert.equal(match.reason, 'live_id_match_not_authority_bearing');
  assert.equal(match.authorityEligible, false);
});

test('strict membership helper is collision-aware for multiple exact structural matches', () => {
  const playbook = {
    plays: [
      { id: 'a', name: 'PA Boot', formation: 'I Form Pro' },
      { id: 'b', name: 'PA Boot', formation: 'I Form Pro' },
    ],
  };
  const match = matchAuthoritativePlayContext(playbook, call('PA Boot', 'I Form Pro'));
  assert.equal(match.status, 'ambiguous');
  assert.equal(match.reason, 'multiple_exact_structural_membership_matches');
  assert.equal(match.candidates.length, 2);
});

test('authoritative offensive identity is subordinate to existing offense freshness and call availability', () => {
  const playbook = { plays: [{ id: 'a', name: 'PA Boot', formation: 'I Form Pro' }] };
  const store = new EaPlayKnowledgeStore({ document: artifact([
    { formation: 'I Form', set: 'Pro', name: 'PA Boot', playId: 1, asset: 'I_Form/Pro/PA_Boot' },
  ]) });
  const liveCall = call('PA Boot', 'I Form Pro');

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

  const first = resolveFreshOffensiveAuthority({ store, playbook, liveCall: call('PA Boot', 'I Form Pro', '1'), fresh: true });
  const audible = resolveFreshOffensiveAuthority({ store, playbook, liveCall: call('HB Duo', 'I Form Pro', '2'), fresh: true });
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
    liveCall: call('PA Boot', 'I Form Pro'),
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
    liveCall: call('PA Boot', 'I Form Pro', 'unrelated-live-id'),
    fresh: true,
  });
  const enriched = attachAuthoritativeIdentity(selectedPlay, authority);
  assert.equal(enriched.id, selectedPlay.id);
  assert.equal(enriched.name, selectedPlay.name);
  assert.equal(enriched.formation, selectedPlay.formation);
  assert.equal(enriched.eaAuthority.playKey, 'play:I_Form/Pro/PA_Boot');
  assert.equal(enriched.eaAuthority.authoredPlayId, 1001);
});
