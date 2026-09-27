'use strict';

const { normalizeStructuralValue } = require('../football/knowledge/ea-play-knowledge-store');

function candidateSummary(play) {
  return {
    id: play?.id == null ? null : String(play.id),
    runtimeId: play?.runtimeId == null ? null : String(play.runtimeId),
    name: play?.name || null,
    formation: play?.formation || null,
    formationName: play?.formationName || null,
    setName: play?.setName || null,
    membershipVerified: play?.membershipVerified === true,
    membershipSource: play?.membershipSource || null,
  };
}

function liveEvidence(liveCall = {}) {
  return {
    playName: {
      value: liveCall.name || null,
      source: 'live_telemetry.offensivePlay',
    },
    setName: {
      value: liveCall.set || null,
      source: 'live_telemetry.offensiveSet',
      semanticRole: 'set_name',
    },
    livePlayId: {
      value: liveCall.id == null ? null : String(liveCall.id),
      source: 'live_telemetry.offensivePlayId',
      authorityBearing: false,
    },
  };
}

function exactIdMatches(playbook, liveCall) {
  if (liveCall?.id == null) return [];
  const id = String(liveCall.id);
  return (playbook?.plays || []).filter(play =>
    String(play?.id ?? '') === id || String(play?.runtimeId ?? '') === id
  );
}

function nameMatches(playbook, liveCall) {
  const name = normalizeStructuralValue(liveCall?.name);
  if (!name) return [];
  return (playbook?.plays || []).filter(play => normalizeStructuralValue(play?.name) === name);
}

function exactStructuralMatches(playbook, liveCall) {
  const name = normalizeStructuralValue(liveCall?.name);
  const setName = normalizeStructuralValue(liveCall?.set);
  if (!name || !setName) return [];
  return (playbook?.plays || []).filter(play =>
    normalizeStructuralValue(play?.name) === name &&
    normalizeStructuralValue(play?.setName) === setName
  );
}

function verifiedSeparateStructure(play) {
  const verified = play?.membershipVerified === true || play?.membershipSource === 'verified_current_overlay';
  if (!verified) return { formationName: null, setName: null, evidence: null };

  const formationName = play?.formationName || null;
  const setName = play?.setName || null;
  if (!formationName || !setName) return { formationName: null, setName: null, evidence: null };

  return {
    formationName,
    setName,
    evidence: {
      formationName: {
        value: formationName,
        source: 'exact_verified_db_match.formationName',
      },
      setName: {
        value: setName,
        source: 'exact_verified_db_match.setName',
      },
    },
  };
}

function unresolved(reason, matchStrategy, liveCall, candidates = []) {
  return {
    status: 'unresolved',
    reason,
    matchStrategy,
    authorityEligible: false,
    evidence: liveEvidence(liveCall),
    candidates: candidates.map(candidateSummary),
  };
}

function matchAuthoritativePlayContext(playbook, liveCall = {}) {
  const evidence = liveEvidence(liveCall);

  if (!liveCall.available) {
    return unresolved('offensive_call_unavailable', null, liveCall);
  }
  if (!normalizeStructuralValue(liveCall.name)) {
    return unresolved('missing_live_play_name', null, liveCall);
  }
  if (!normalizeStructuralValue(liveCall.set)) {
    return unresolved('missing_live_set_name', null, liveCall);
  }

  // Live offensiveSet is observed Set-name evidence. It is not a combined
  // Formation+Set presentation. A complete live Set+Play pair is therefore
  // sufficient to query the authoritative corpus directly. The active
  // playbook is consulted only for independently trustworthy, separately
  // represented Formation evidence; it is never required to make the live
  // Set+Play pair authority-eligible.
  const structural = exactStructuralMatches(playbook, liveCall);
  let verifiedStructure = { formationName: null, setName: null, evidence: null };

  if (structural.length === 1) {
    verifiedStructure = verifiedSeparateStructure(structural[0]);
  }

  const membership = {
    strategy: 'live_set_play',
    source: 'live_telemetry',
    exactVerifiedDbCandidateCount: structural.length,
    candidates: structural.map(candidateSummary),
  };

  return {
    status: 'matched',
    reason: null,
    matchStrategy: 'live_set_play',
    authorityEligible: true,
    play: structural.length === 1 ? structural[0] : null,
    evidence: {
      ...evidence,
      membership,
      ...(verifiedStructure.evidence || {}),
    },
    query: {
      playName: liveCall.name,
      setName: liveCall.set,
      formationName: verifiedStructure.formationName,
    },
    candidates: structural.map(candidateSummary),
  };
}

function resolveAuthoritativeOffensivePlay({ store, playbook, liveCall } = {}) {
  const match = matchAuthoritativePlayContext(playbook, liveCall);
  if (match.status === 'ambiguous') return match;
  if (!match.authorityEligible) return match;

  if (!store || typeof store.resolvePlay !== 'function') {
    return {
      status: 'unavailable',
      reason: 'store_missing',
      matchStrategy: match.matchStrategy,
      evidence: match.evidence,
    };
  }

  const resolved = store.resolvePlay({
    ...match.query,
    evidence: {
      ...match.evidence,
      authorityEligible: true,
      upstreamMatchStrategy: match.matchStrategy,
    },
  });

  return {
    ...resolved,
    upstreamMatch: {
      status: match.status,
      matchStrategy: match.matchStrategy,
      candidates: match.candidates || [],
    },
  };
}

function resolveFreshOffensiveAuthority({ store, playbook, liveCall, fresh } = {}) {
  if (!fresh) {
    return {
      status: 'unresolved',
      reason: 'offensive_call_not_fresh',
      matchStrategy: null,
      authorityEligible: false,
      evidence: liveEvidence(liveCall || {}),
      candidates: [],
    };
  }

  if (!liveCall?.available) {
    return unresolved('offensive_call_unavailable', null, liveCall || {});
  }

  return resolveAuthoritativeOffensivePlay({ store, playbook, liveCall });
}

function attachAuthoritativeIdentity(selectedPlay, authority) {
  if (!selectedPlay || authority?.status !== 'resolved') return selectedPlay;
  return {
    ...selectedPlay,
    eaAuthority: {
      playKey: authority.playKey,
      assetPath: authority.assetPath,
      authoredPlayId: authority.authoredPlayId ?? null,
      resolutionStatus: authority.resolutionStatus || null,
      matchStrategy: authority.matchStrategy || null,
    },
  };
}

module.exports = {
  candidateSummary,
  exactIdMatches,
  nameMatches,
  exactStructuralMatches,
  matchAuthoritativePlayContext,
  resolveAuthoritativeOffensivePlay,
  resolveFreshOffensiveAuthority,
  attachAuthoritativeIdentity,
};
