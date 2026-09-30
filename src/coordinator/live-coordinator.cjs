'use strict';

const fs = require('fs');
const path = require('path');
const sdk = require('../../packages/sdk');
const { FootballEngine } = require('../football/engine');
const { toFootballEvent, deriveSituation } = require('../football/integration/telemetry-adapter.example');
const { CoordinatorWindow } = require('../football/ui/coordinator-window');
const { SnapReducer, callFromState } = require('./snap-reducer.cjs');
const {
  loadPlaybooks,
  findPlay,
  loadOffensePlaybookFromDatabase,
  loadDefensePlaybookFromDatabase,
} = require('./playbook-loader.cjs');
const { loadCoordinatorConfig, saveCoordinatorConfig } = require('../football/config/coordinator-config');
const { EaPlayKnowledgeStore } = require('../football/knowledge/ea-play-knowledge-store');
const {
  resolveAuthoritativeDefense,
  attachDefensiveAuthority,
  OpponentDefenseBookTracker,
  defensiveAuthorityLogLine,
} = require('../football/analysis/authoritative-defense');
const { EaDefensivePlayStore } = require('../football/knowledge/ea-defensive-play-store');
const { coverageFamilyFromAuthority } = require('../football/analysis/structural-threat-model');
const { GamePhaseTracker } = require('./game-phase-tracker.cjs');
const { oracleStrategicDecision } = require('../football/gameplan/strategic-context');
const {
  resolveFreshOffensiveAuthority,
  attachAuthoritativeIdentity,
} = require('./authoritative-play-match.cjs');

let CoordinatorDatabase = null;
let DatabasePlaybookRepository = null;
try {
  ({ CoordinatorDatabase } = require('../football/db/coordinator-database'));
  ({ DatabasePlaybookRepository } = require('../football/playbooks/database-playbook-repository'));
} catch (_) {
  CoordinatorDatabase = null;
  DatabasePlaybookRepository = null;
}

function fmtClock(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return '--:--';
  return `${Math.floor(n / 60)}:${String(Math.max(0, Math.floor(n % 60))).padStart(2, '0')}`;
}

function downText(down) {
  return ({1:'1st',2:'2nd',3:'3rd',4:'4th'})[Number(down)] || `${down}th`;
}

// Distinguishes a real DB-backed playbook from the small hand-authored sample
// fallback -- important because the sample defense playbook happens to be
// named "3-4 Zone Pressure" (2 plays), which must never be confused with the
// real DB playbook "3-4" (id 503, 222 plays). loadOffense/DefensePlaybookFromDatabase()
// always set membershipSource; the sample loader never does.
function playbookLogLine(label, book) {
  if (!book) return `[COORD] ${label} playbook: none selected`;
  const source = book.membershipSource ? 'database' : 'sample-fallback';
  return `[COORD] ${label} playbook: ${book.name} (id=${book.id}, ${book.plays.length} plays, ${source})`;
}

function parseConfig(repoRoot, configPath) {
  if (!configPath) return {};
  const full = path.isAbsolute(configPath) ? configPath : path.resolve(repoRoot, configPath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

async function tailCursor(client) {
  let cursor = 0;
  for (let i = 0; i < 32; i += 1) {
    const page = await client.getEvents({ after: cursor, limit: 256 });
    const next = Number(page?.nextCursor || cursor);
    const events = Array.isArray(page?.events) ? page.events : [];
    if (!events.length || next <= cursor) return cursor;
    cursor = next;
    if (events.length < 256) return cursor;
  }
  return cursor;
}

function situationFromState(state) {
  const directDiff = Number(state?.scoreDifferential);
  const hasDirectDiff = Number.isFinite(directDiff);
  const userIsHome = typeof state?.userIsHome === 'boolean' ? state.userIsHome : null;
  const home = Number(state?.homeScore);
  const away = Number(state?.awayScore);
  const hasScores = Number.isFinite(home) && Number.isFinite(away);
  const offenseScore = userIsHome == null || !hasScores ? null : (userIsHome ? home : away);
  const defenseScore = userIsHome == null || !hasScores ? null : (userIsHome ? away : home);
  const base = {
    down: state.down,
    distance: state.distance,
    quarter: state.quarter,
    clockSeconds: state.gameClockSeconds,
    playClockSeconds: state.playClockSeconds,
    possession: state.possession,
    fieldX: state.fieldX,
    fieldY: state.fieldY,
    lineToGain: state.lineToGain,
    yardLine: state.yardLine,
    yardsToGoal: Number.isFinite(Number(state.yardLine)) ? Math.max(0, 100 - Number(state.yardLine)) : null,
    hash: state.hash || 'unknown',
    offenseDirection: Number.isFinite(Number(state.lineToGain)) && Number.isFinite(Number(state.fieldX)) && Math.abs(Number(state.lineToGain) - Number(state.fieldX)) > 0.01
      ? Math.sign(Number(state.lineToGain) - Number(state.fieldX))
      : null,
    offenseScore,
    defenseScore,
    scoreDifferential: hasDirectDiff
      ? directDiff
      : (offenseScore == null || defenseScore == null ? null : offenseScore - defenseScore),
    quarterSource: state.quarterSource || null,
    quarterConfidence: state.quarterConfidence || null,
    quarterEvidenceConflict: state.quarterEvidenceConflict === true,
    gamePhase: state.gamePhase || null,
    scoreDifferentialSource: state.scoreDifferentialSource || (userIsHome == null ? 'UNAVAILABLE' : 'VERIFIED_USER_HOME_AWAY'),
  };
  base.flags = deriveSituation(base);
  return base;
}

const ORACLE_CHANGE_THRESHOLD = 0.85;

function situationIdentityKey(state) {
  const situation = situationFromState(state || {});
  return [
    state?.possession ?? 'x',
    state?.quarter ?? 'x',
    state?.down ?? 'x',
    state?.distance ?? 'x',
    state?.fieldX ?? 'x',
    state?.lineToGain ?? 'x',
    situation.hash || 'UNKNOWN',
  ].join('|');
}

function isOffensiveScrimmageSituation(state) {
  if (Number(state?.possession) !== 0) return false;
  const down = Number(state?.down);
  const distance = Number(state?.distance);
  const fieldX = Number(state?.fieldX);
  const lineToGain = Number(state?.lineToGain);
  if (!Number.isFinite(down) || down < 1 || down > 4) return false;
  if (!Number.isFinite(distance) || distance < 0) return false;
  if (!Number.isFinite(fieldX) || !Number.isFinite(lineToGain)) return false;

  // A real scrimmage huddle has a meaningful line-to-gain geometry. This
  // prevents the kickoff/return transition from manufacturing an offensive
  // call before the first true down is established.
  const geometricDistance = Math.abs(lineToGain - fieldX);
  if (geometricDistance < 0.5) return false;
  if (distance > 0) {
    const tolerance = Math.max(2.5, distance * 0.35);
    if (Math.abs(geometricDistance - distance) > tolerance) return false;
  }
  return true;
}

// The exact CPU defensive call while the user is on offense. Its playbook is
// the OPPONENT's, so authority resolves against an explicitly configured
// opponent book, else the books narrowed by this game's earlier exact
// observations, else the whole exported corpus (see ea-defensive-play-store).
function exactDefenseFromState(engine, state, fresh = null, defensiveContext = null) {
  if (state?.possession !== 0 || fresh?.defense !== true) return null;
  const call = callFromState(state, 'defense');
  if (!call.available || !call.name) return null;
  const descriptor = engine.knowledge.catalogResolver?.describeDefensivePlay?.(call.name) || null;
  const authoritativeDefense = defensiveContext?.store
    ? resolveAuthoritativeDefense({
      defensiveStore: defensiveContext.store,
      liveCall: call,
      bookId: defensiveContext.bookId ?? null,
      candidateBookIds: defensiveContext.tracker?.candidates || null,
    })
    : { available: false, status: 'unavailable', reason: 'defensive_authority_store_unavailable' };
  const authoredCoverage = authoritativeDefense.available ? coverageFamilyFromAuthority(authoritativeDefense.summary) : null;
  return {
    id: call.id || call.name,
    name: call.name,
    formation: call.set,
    set: call.set,
    coverageFamily: authoredCoverage || descriptor?.coverageFamily || engine.knowledge.resolveCoverage(call.name) || null,
    assignmentFamilies: descriptor?.assignmentFamilies || [],
    concepts: descriptor?.concepts || [],
    authoritativeDefense,
  };
}

function samePlay(a, b) {
  if (!a || !b) return false;
  if (a.id != null && b.id != null && String(a.id) === String(b.id)) return true;
  return String(a.name || '') === String(b.name || '') &&
    String(a.formation || '') === String(b.formation || '');
}

function initialCoordinatorPlay(playbooks, coordinatorWindow) {
  const state = coordinatorWindow?.state || {};
  const plays = playbooks?.offense?.plays || [];
  if (state.coordinatorPlayId != null) {
    const byId = plays.find(play => String(play.id) === String(state.coordinatorPlayId));
    if (byId) return byId;
  }
  if (state.coordinatorCall) {
    return plays.find(play =>
      String(play.name || '') === String(state.coordinatorCall) &&
      (!state.coordinatorFormation || String(play.formation || '') === String(state.coordinatorFormation))
    ) || null;
  }
  return null;
}

function buildOracleAudibleScope(playbook, selectedPlay, audiblePackage) {
  const formation = selectedPlay?.formation || null;
  const keepOnly = {
    available: false,
    formation,
    playbook: { ...(playbook || {}), plays: selectedPlay ? [selectedPlay] : [] },
    audiblePlays: [],
  };

  if (!selectedPlay || !formation) {
    return { ...keepOnly, reason: 'The current selected play could not be resolved to a formation, so Oracle will not invent an audible.' };
  }
  if (!audiblePackage?.available) {
    return { ...keepOnly, reason: `No four-play audible package is available for ${formation}; Oracle is limited to KEEP.` };
  }
  if (audiblePackage.confirmed !== true) {
    return { ...keepOnly, reason: `The ${formation} audible package is not confirmed to match the in-game slots, so Oracle is limited to KEEP.` };
  }

  const allPlays = playbook?.plays || [];
  const audiblePlays = [];
  for (const slot of audiblePackage.slots || []) {
    const slotFormation = slot.formation || formation;
    if (String(slotFormation) !== String(formation)) {
      return { ...keepOnly, reason: `The confirmed audible package contains a play outside ${formation}; Oracle is limited to KEEP.` };
    }
    const found = allPlays.find(play =>
      String(play.formation || '') === String(formation) &&
      (slot.playId != null
        ? String(play.id) === String(slot.playId)
        : String(play.name || '') === String(slot.playName || ''))
    );
    if (!found) {
      return { ...keepOnly, reason: `A confirmed ${formation} audible no longer resolves in the active playbook; Oracle is limited to KEEP.` };
    }
    if (!audiblePlays.some(play => samePlay(play, found))) audiblePlays.push(found);
  }

  const scoped = [selectedPlay];
  for (const play of audiblePlays) {
    if (!scoped.some(existing => samePlay(existing, play))) scoped.push(play);
  }

  return {
    available: audiblePlays.length > 0,
    formation,
    playbook: { ...(playbook || {}), plays: scoped },
    audiblePlays,
    reason: audiblePlays.length
      ? null
      : `No confirmed audible alternatives resolve for ${formation}; Oracle is limited to KEEP.`,
  };
}

function decideOracleRecommendation(initialPlay, ranked, threshold = ORACLE_CHANGE_THRESHOLD) {
  const candidates = ranked?.strategicCandidates || ranked?.recommendations || [];
  const best = candidates[0] || null;
  if (!initialPlay || !best) {
    return {
      decision: 'KEEP',
      play: initialPlay || best?.play || null,
      replacement: null,
      scoreDelta: 0,
      reason: 'No materially better exact-defense alternative is available.',
    };
  }

  const initial = candidates.find(row => samePlay(row.play, initialPlay)) || null;
  if (!initial) {
    return {
      decision: 'CHANGE',
      play: initialPlay,
      replacement: best.play,
      scoreDelta: null,
      reason: 'The initial call is outside the exact-defense football-valid counter set.',
    };
  }

  if (samePlay(best.play, initialPlay)) {
    return {
      decision: 'KEEP',
      play: initialPlay,
      replacement: null,
      scoreDelta: 0,
      reason: 'The initial call remains the best exact counter to the revealed defense.',
    };
  }

  const delta = Number(best.score) - Number(initial.score);
  if (Number.isFinite(delta) && delta >= threshold) {
    return {
      decision: 'CHANGE',
      play: initialPlay,
      replacement: best.play,
      scoreDelta: delta,
      reason: `The revealed defense creates a materially better counter (+${delta.toFixed(2)}).`,
    };
  }

  return {
    decision: 'KEEP',
    play: initialPlay,
    replacement: null,
    scoreDelta: Number.isFinite(delta) ? delta : 0,
    reason: 'The exact-defense alternative is not materially better than the initial call.',
  };
}

function printRecommendation(engine, playbooks, state, io, coordinatorWindow) {
  if (!isOffensiveScrimmageSituation(state)) return null;
  if (Number.isFinite(Number(state?.offensiveAggressiveness))) {
    engine.updateOffensiveAggressiveness?.(Number(state.offensiveAggressiveness));
  }
  const situation = situationFromState(state);
  const ranked = engine.recommendPlays({
    playbook: playbooks.offense,
    defensePlay: null,
    situation,
    limit: 3,
  });
  const top = ranked.recommendations[0];
  if (!top) {
    coordinatorWindow.showRecommendation({
      available: false,
      reason: 'No legal recommendation is available.',
    }, state);
    return null;
  }
  const planReasons = top.strategicWhy?.length
    ? top.strategicWhy
    : (top.diagnostic?.strategy?.planReasons || []);
  coordinatorWindow.showRecommendation({
    available: true,
    play: top.play,
    locator: {
      formation: top.play.formation,
    },
    reasons: top.reasons?.slice(0, 3) || [],
    gameplanName: ranked.gameplan?.gameplanName || null,
    planReason: planReasons.slice(0, 2),
  }, state);
  engine.recordRecommendation?.('offense', top, {
    opponentPlay: null,
    situation,
    family: top.diagnostic?.counter?.structure?.primaryThreat || top.play.primaryConcept || top.play.presentationFamily || null,
  });
  io.log(`\n[OC] ${downText(state.down)} & ${state.distance} | Q${state.quarter} ${fmtClock(state.gameClockSeconds)}`);
  if (top.driveObjective?.objective) io.log(`[OC] OBJECTIVE: ${top.driveObjective.objective} | quarterConfidence=${state.quarterConfidence || 'UNSPECIFIED'}`);
  if (top.sequenceIntent) io.log(`[OC] SEQUENCE: ${top.sequenceIntent.stage || top.sequenceIntent.intent || top.sequenceIntent.reason || 'active'}`);
  const empirical = top.diagnostic?.empiricalSituation;
  if (empirical?.available) io.log(`[OC] SITUATION PRIOR: ${empirical.rowId || '?'} | ${String(empirical.mode || '?').toUpperCase()} ${Number(empirical.score || 0) >= 0 ? '+' : ''}${Number(empirical.score || 0).toFixed(3)}`);
  const hist = top.diagnostic?.historicalDefense;
  if (hist?.sampleSize) io.log(`[OC] HIST DEF: n=${hist.sampleSize} confidence=${hist.confidence} raw=${hist.rawStructuralScore} weight=${hist.appliedConfidenceWeight} applied=${hist.appliedContribution}`);
  if (situation.hash && situation.hash !== 'UNKNOWN') io.log(`[OC] HASH: ${situation.hash} | field=${situation.fieldSide || '?'} boundary=${situation.boundarySide || '?'}`);
  io.log(`[OC] CALL: ${top.play.formation || '?'} / ${top.play.name || top.play.id}  score=${top.score}`);
  if (ranked.gameplan?.gameplanName) {
    io.log(`[OC] GAMEPLAN: ${ranked.gameplan.gameplanName} | fullPlaybook=${ranked.callSheet?.eligible ?? playbooks.offense?.plays?.length ?? 0} | aggression=${ranked.gameplan.aggressiveness} | legacyCallSheet=${ranked.gameplan.callSheetSize} advisory-only`);
  }
  if (planReasons.length) io.log(`[OC] PLAN: ${planReasons.slice(0, 2).join(' | ')}`);
  if (top.reasons?.length) io.log(`[OC] WHY: ${top.reasons.slice(0, 3).join(' | ')}`);
  if (ranked.tendency?.attempts) {
    io.log(`[OC] TENDENCY: ${ranked.tendency.scope}, n=${ranked.tendency.attempts}, confidence=${ranked.tendency.confidence}`);
  }
  return top;
}

function printOracleRecommendation(engine, playbooks, state, exactDefense, io, coordinatorWindow, authoritativeOffense = null) {
  if (!exactDefense || !isOffensiveScrimmageSituation(state)) return null;

  // Production Oracle shares the ExecutionAdvisor pre-snap lifecycle. The
  // legacy reranker below is retained only for isolated test doubles that do
  // not expose adviseExecution().
  if (typeof engine.adviseExecution === 'function') {
    const offenseCall = callFromState(state, 'offense');
    if (!offenseCall.available || !offenseCall.name) return null;
    const selectedPlay = findPlay(playbooks.offense, { id: offenseCall.id, name: offenseCall.name, set: offenseCall.set });
    if (!selectedPlay) return null;
    const executionPlay = attachAuthoritativeIdentity(selectedPlay, authoritativeOffense);
    const advice = engine.adviseExecution({
      selectedPlay: executionPlay,
      defensiveCall: exactDefense,
      playbook: playbooks.offense,
      situation: situationFromState(state),
    });
    const pre = advice?.preSnap || null;
    const type = pre?.action?.type || 'STAY';
    const decision = type === 'AUDIBLE' ? 'CHANGE' : (type === 'STAY' ? 'KEEP' : 'ADJUST');
    const replacementPlay = pre?.action?.play
      ? (findPlay(playbooks.offense, pre.action.play) || pre.action.play)
      : null;
    const oracle = {
      decision,
      play: executionPlay,
      replacement: replacementPlay,
      adjustment: decision === 'ADJUST' ? pre?.action || null : null,
      scoreDelta: null,
      reason: pre?.reason || advice?.reason || 'No supported pre-snap change is justified.',
      preSnap: pre,
    };
    coordinatorWindow.showOracleRecommendation({
      decision,
      initialPlay: executionPlay,
      play: replacementPlay || executionPlay,
      defense: exactDefense,
      reason: oracle.reason,
      adjustment: oracle.adjustment,
    }, state);
    io.log(`[OC] CPU DEFENSE: ${exactDefense.formation || '?'} / ${exactDefense.name} (${exactDefense.coverageFamily || 'unresolved'})`);
    if (decision === 'CHANGE') {
      io.log(`[OC] ORACLE: AUDIBLE TO ${replacementPlay?.formation || '?'} / ${replacementPlay?.name || replacementPlay?.id || '?'}`);
    } else if (decision === 'ADJUST') {
      io.log(`[OC] ORACLE: ${pre?.action?.label || type}`);
    } else {
      io.log(`[OC] ORACLE: KEEP ${executionPlay.formation || '?'} / ${executionPlay.name || executionPlay.id}`);
    }
    io.log(`[OC] ORACLE WHY: ${oracle.reason}`);
    return oracle;
  }

  // Oracle is post-selection adaptation: reason from the user's current live
  // call, never from the coordinator's earlier Stage-1 recommendation.
  const offenseCall = callFromState(state, 'offense');
  if (!offenseCall.available || !offenseCall.name) return null;
  const initialPlay = findPlay(playbooks.offense, {
    id: offenseCall.id,
    name: offenseCall.name,
    set: offenseCall.set,
  });
  if (!initialPlay) return null;

  // An Oracle CHANGE is an audible. Its candidate universe is therefore KEEP
  // plus the four CONFIRMED in-game audibles for this exact formation.
  const audiblePackage = engine.getAudiblePackage?.(playbooks.offense, initialPlay.formation) || null;
  const scope = buildOracleAudibleScope(playbooks.offense, initialPlay, audiblePackage);

  let oracle;
  if (!scope.available) {
    oracle = {
      decision: 'KEEP',
      play: initialPlay,
      replacement: null,
      scoreDelta: 0,
      reason: scope.reason,
    };
  } else {
    const ranked = engine.recommendPlays({
      playbook: scope.playbook,
      defensePlay: exactDefense,
      situation: situationFromState(state),
      limit: scope.playbook.plays.length,
    });
    oracle = decideOracleRecommendation(initialPlay, ranked);

    if (oracle.decision === 'CHANGE') {
      const initialRow = (ranked.strategicCandidates || []).find(row => samePlay(row.play, initialPlay)) || null;
      const strategic = oracleStrategicDecision({
        currentPlay: initialPlay,
        replacementPlay: oracle.replacement,
        situation: situationFromState(state),
        tacticalDelta: oracle.scoreDelta,
        currentStructurallyValid: Boolean(initialRow?.diagnostic?.counter?.valid),
      });
      if (!strategic.allow) {
        oracle = {
          decision: 'KEEP',
          play: initialPlay,
          replacement: null,
          scoreDelta: oracle.scoreDelta,
          reason: strategic.reason,
          strategic,
        };
      } else if (strategic.reason) {
        oracle = { ...oracle, reason: strategic.reason + ' ' + oracle.reason, strategic };
      }
    }

    if (oracle.decision === 'CHANGE' &&
        !scope.audiblePlays.some(play => samePlay(play, oracle.replacement))) {
      oracle = {
        decision: 'KEEP',
        play: initialPlay,
        replacement: null,
        scoreDelta: 0,
        reason: 'No confirmed same-formation audible is materially better than the current play.',
      };
    } else if (oracle.decision === 'CHANGE') {
      oracle = {
        ...oracle,
        reason: oracle.scoreDelta == null
          ? `The current play is outside the exact-defense counter set; ${oracle.replacement?.name || 'the recommended audible'} is a confirmed ${initialPlay.formation} audible.`
          : `The revealed defense makes confirmed audible ${oracle.replacement?.name || ''} materially better (+${Number(oracle.scoreDelta).toFixed(2)}).`,
      };
    } else if (!oracle.strategic?.reason) {
      oracle = {
        ...oracle,
        reason: `No confirmed ${initialPlay.formation} audible is materially better than the current play.`,
      };
    }
  }

  coordinatorWindow.showOracleRecommendation({
    decision: oracle.decision,
    initialPlay,
    play: oracle.replacement || initialPlay,
    defense: exactDefense,
    reason: oracle.reason,
  }, state);

  io.log(`[OC] CPU DEFENSE: ${exactDefense.formation || '?'} / ${exactDefense.name} (${exactDefense.coverageFamily || 'unresolved'})`);
  if (oracle.decision === 'CHANGE') {
    io.log(`[OC] ORACLE: AUDIBLE TO ${oracle.replacement?.formation || '?'} / ${oracle.replacement?.name || oracle.replacement?.id}`);
    engine.recordRecommendation?.('offense', { play: oracle.replacement }, {
      opponentPlay: exactDefense,
      situation: situationFromState(state),
      family: oracle.replacement?.primaryConcept || oracle.replacement?.presentationFamily || null,
    });
  } else {
    io.log(`[OC] ORACLE: KEEP ${initialPlay.formation || '?'} / ${initialPlay.name || initialPlay.id}`);
  }
  io.log(`[OC] ORACLE WHY: ${oracle.reason}`);
  return oracle;
}

// Per-side call-generation freshness tracking. A situation boundary snapshots
// whatever offense/defense call is currently exposed as "quarantined" -- it
// may be stale leftover data from the play that just ended (this is exactly
// what happens across a kickoff/return -> first-scrimmage-down boundary).
// Each side independently proves itself fresh via any of:
//   - it differs from the quarantined snapshot, or
//   - it was unavailable at the boundary and has since become available, or
//   - it went unavailable at some point AFTER the boundary and has since come
//     back (a false->true transition is itself proof of a new generation,
//     even if the reappearing signature is identical to the boundary snapshot)
// Once fresh for a side, it latches true for the rest of that situation --
// audibles never re-quarantine it.
//
// Known limitation (accepted, not solved here): if a side's call remains
// continuously available across the boundary AND the legitimate new call is
// field-for-field identical to the quarantined snapshot the whole time,
// current telemetry cannot prove a new generation for that side. Execution
// advice/defensive recommendation may remain withheld until something
// changes. Closing this gap would require reverse-engineering a genuine
// call-generation/readiness signal -- a future READ-ONLY RE target, not
// something to work around with timers or hardcoded names here.
function updateSideFreshness(currentCall, quarantineCall, sideState) {
  if (sideState.fresh) return sideState;

  if (!currentCall.available) {
    return { fresh: false, cleared: true };
  }

  if (!quarantineCall.available) {
    return { fresh: true, cleared: sideState.cleared };
  }

  if (sideState.cleared) {
    return { fresh: true, cleared: true };
  }

  const changed =
    currentCall.set !== quarantineCall.set ||
    currentCall.name !== quarantineCall.name ||
    currentCall.id !== quarantineCall.id;

  return { fresh: changed, cleared: false };
}

function updateFreshness(current, quarantine, fresh, cleared) {
  const offenseCall = callFromState(current, 'offense');
  const defenseCall = callFromState(current, 'defense');

  const offenseNext = updateSideFreshness(offenseCall, quarantine.offense, { fresh: fresh.offense, cleared: cleared.offense });
  const defenseNext = updateSideFreshness(defenseCall, quarantine.defense, { fresh: fresh.defense, cleared: cleared.defense });

  return {
    fresh: { offense: offenseNext.fresh, defense: defenseNext.fresh },
    cleared: { offense: offenseNext.cleared, defense: defenseNext.cleared },
  };
}

function logFreshnessTransitions(previousFresh, nextFresh, current, io) {
  if (!previousFresh.offense && nextFresh.offense) {
    const c = callFromState(current, 'offense');
    io.log(`[COORD] Offensive call fresh: ${c.set || '?'} / ${c.name || '?'}`);
  }
  if (!previousFresh.defense && nextFresh.defense) {
    const c = callFromState(current, 'defense');
    io.log(`[COORD] Defensive call fresh: ${c.set || '?'} / ${c.name || '?'}`);
  }
}

function diagnosticValue(value) {
  return value == null ? 'null' : JSON.stringify(String(value));
}

function authorityDiagnosticKey(authority = {}, liveCall = {}) {
  return [
    authority.status || 'unresolved',
    authority.playKey || '',
    authority.reason || '',
    authority.matchStrategy || '',
    liveCall.set || '',
    liveCall.name || '',
  ].join('|');
}

function formatAuthorityDiagnostic(authority = {}, liveCall = {}) {
  const status = authority.status || 'unresolved';
  const live = `${liveCall.set || '?'} / ${liveCall.name || '?'}`;
  const parts = [`[EA-AUTH] ${status}`];

  if (status !== 'resolved') {
    parts.push(`reason=${authority.reason || 'unspecified'}`);
  }

  parts.push(`live=${diagnosticValue(live)}`);
  parts.push(`strategy=${authority.matchStrategy || 'none'}`);

  if (status === 'resolved') {
    parts.push(`formation=${diagnosticValue(authority.formationName || authority.normalizedQuery?.formationName)}`);
    parts.push(`set=${diagnosticValue(authority.setName || authority.normalizedQuery?.setName)}`);
    parts.push(`play=${diagnosticValue(authority.playName || authority.normalizedQuery?.playName || liveCall.name)}`);
    parts.push(`playKey=${diagnosticValue(authority.playKey)}`);
    parts.push(`authoredPlayId=${authority.authoredPlayId == null ? 'null' : authority.authoredPlayId}`);
  } else if (status === 'ambiguous') {
    parts.push(`candidates=${Array.isArray(authority.candidates) ? authority.candidates.length : 0}`);
  }

  return parts.join(' | ');
}

function logAuthorityTransition(authority, liveCall, previousKey, io) {
  const nextKey = authorityDiagnosticKey(authority, liveCall);
  if (nextKey === previousKey) return previousKey;
  io?.log?.(formatAuthorityDiagnostic(authority, liveCall));
  return nextKey;
}

function printExecutionAdvice(engine, playbooks, state, seenKey, fresh, io, coordinatorWindow, authoritativeOffense = null, exactDefense = null) {
  if (state.possession !== 0) return seenKey;
  if (!fresh.offense || !fresh.defense) return seenKey;
  const offenseCall = callFromState(state, 'offense');
  const defenseCall = callFromState(state, 'defense');
  if (!offenseCall.available || !defenseCall.available || !offenseCall.name || !defenseCall.name) return seenKey;
  const key = `${state.down}|${state.fieldX}|${offenseCall.id}|${defenseCall.id}`;
  if (key === seenKey) return seenKey;
  // lastExecutionKey is reset to null whenever the situation changes (see the
  // main loop below), so a non-null seenKey here means this is a change
  // within the same snap -- i.e. an audible, not the initial selection.
  const isAudible = seenKey != null;

  // Playbook-membership gate (defense-in-depth, not the freshness mechanism
  // itself): findPlay() already matches live calls to playbook plays by
  // formation/set + name (tolerant of DB-backed synthetic ids like
  // "405:verified:singleback-ace:pa-jet-sweep" vs the live numeric play id --
  // it only uses id as a first-choice shortcut, never a hard requirement). If
  // it can't find a match at all, the call structurally isn't a play in the
  // active offensive playbook (e.g. a kickoff/return call) -- prefer an
  // honest false-negative over synthesizing a fake selected play that would
  // replace a legitimate huddle recommendation.
  const selectedPlay = findPlay(playbooks.offense, {
    id: offenseCall.id,
    name: offenseCall.name,
    set: offenseCall.set,
  });
  if (!selectedPlay) return seenKey;

  // The legacy selectedPlay remains the execution-behavior source. The EA
  // identity is additive only, and is attached solely after the independent
  // strict authority path has resolved one canonical Play asset.
  const executionPlay = attachAuthoritativeIdentity(selectedPlay, authoritativeOffense);

  const result = engine.adviseExecution({
    selectedPlay: executionPlay,
    defensiveCall: exactDefense || { id: defenseCall.id, set: defenseCall.set, name: defenseCall.name },
    playbook: playbooks.offense,
    situation: situationFromState(state),
  });

  coordinatorWindow.showSelection({
    type: isAudible ? 'audible' : 'selected',
    play: executionPlay,
    opponentPlay: {
      id: defenseCall.id,
      name: defenseCall.name,
      formation: defenseCall.set,
    },
  }, result, state);

  io.log(`\n[READ] ${offenseCall.set || '?'} / ${offenseCall.name} vs ${defenseCall.set || '?'} / ${defenseCall.name}`);
  if (result.preSnap?.available) {
    const pre = result.preSnap;
    io.log(`[PRESNAP] ACTION: ${pre.action?.label || pre.decision || 'KEEP PLAY'}`);
    if (pre.reasons?.[0]) io.log(`[PRESNAP] WHY: ${pre.reasons[0]}`);
    if (pre.bestBet) io.log(`[PRESNAP] BEST BET: ${pre.bestBet.player} — ${pre.bestBet.route} | ${pre.bestBet.reason}`);
  } else if (result.audible) {
    const audible = result.audible;
    io.log(`[AUDIBLE] offense=${audible.offense?.family || 'AMBIGUOUS'}(${audible.offense?.confidence || 'LOW'}) | box=${audible.box?.classification || 'NEUTRAL'}(${audible.box?.confidence || 'LOW'}) | decision=${audible.decision || 'KEEP'} | provenance=${audible.box?.provenance || 'HEURISTIC'}`);
    if (audible.reason) io.log(`[AUDIBLE] ${audible.reason}`);
  }
  const authoritativeGuide = Boolean(
    result.authority?.available &&
    result.guide?.progressionStatus === 'derived' &&
    (result.guide.mode === 'run'
      ? (result.guide.headline || result.guide.watch || result.guide.steps?.length)
      : result.guide.reads?.length)
  );

  if (!result.available) {
    io.log(`[READ] No detailed execution guidance yet (${result.reason || 'play not mapped to available guidance'}).`);
  } else if (authoritativeGuide && result.guide?.mode === 'run') {
    io.log('[READ] Authoritative EA assignment structure available; run guidance is DERIVED_STRUCTURAL.');
    io.log(`[READ] ${result.guide.headline || 'Authoritative run structure available.'}`);
    if (result.guide.watch) io.log(`[READ] KEY: ${result.guide.watch}`);
    if (result.guide.steps?.[0]) io.log(`[READ] CUT: ${result.guide.steps[0]}`);
  } else if (authoritativeGuide && result.guide?.reads?.length) {
    io.log('[READ] Authoritative EA assignment structure available; read order is DERIVED_STRUCTURAL.');
    for (const read of result.guide.reads) {
      io.log(`[READ] ${read.number || 'READ'}: ${read.label || 'Read'}${read.detail ? ` — ${read.detail}` : ''}`);
    }
  } else if (result.advice?.known) {
    const advice = result.advice;
    io.log(`[READ] ${advice.headline}${advice.pressureDetected ? ' | PRESSURE' : ''}`);
    const pre = advice.coaching?.preSnap?.[0];
    const post = advice.coaching?.postSnap?.[0];
    if (pre) io.log(`[READ] KEY: ${pre}`);
    if (post) io.log(`[READ] AFTER SNAP: ${post}`);
  } else if (result.guide?.mode === 'run') {
    io.log(`[READ] ${result.guide.headline || 'Run guidance available.'}`);
    if (result.guide.watch) io.log(`[READ] KEY: ${result.guide.watch}`);
    if (result.guide.steps?.[0]) io.log(`[READ] CUT: ${result.guide.steps[0]}`);
  } else if (result.guide?.reads?.length) {
    for (const read of result.guide.reads) io.log(`[READ] ${read.number || 'READ'}: ${read.label || 'Read'}${read.detail ? ` — ${read.detail}` : ''}`);
  }
  return key;
}

function printDefensiveRecommendation(engine, playbooks, state, seenKey, fresh, io, coordinatorWindow, authoritativeOffenseStructure = null) {
  if (state.possession !== 1) return seenKey;
  // Only the CPU's offensive call needs to be fresh -- our candidates come
  // from the user's selected defensive playbook, not from the game's own
  // exposed defensive-call telemetry, and the CPU's call is never checked
  // against playbooks.offense (we don't know the opponent's playbook).
  if (!fresh.offense) return seenKey;
  const cpu = callFromState(state, 'offense');
  if (!cpu.available || !cpu.name) return seenKey;
  const key = `defense|${state.down}|${state.fieldX}|${cpu.id || cpu.name}`;
  if (key === seenKey) return seenKey;

  // Resolve the CPU's exact call to a concept via the Stage 1 catalog-first
  // KnowledgeEngine (the canonical resolver) rather than a second parser.
  const resolvedConcept = engine.knowledge.resolveConcept(cpu.name) || null;
  const authoredConcepts = authoritativeOffenseStructure?.play?.concepts || [];
  const offensePlay = {
    id: cpu.id || cpu.name,
    name: cpu.name,
    formation: cpu.set,
    type: authoritativeOffenseStructure?.play?.offensePlayType || null,
    concepts: authoredConcepts.length ? authoredConcepts : (resolvedConcept ? [resolvedConcept] : []),
    primaryConcept: authoredConcepts[0] || resolvedConcept,
    modifiers: authoritativeOffenseStructure?.play?.flowType ? [authoritativeOffenseStructure.play.flowType] : [],
    authoritativeStructure: authoritativeOffenseStructure?.status === 'resolved' ? authoritativeOffenseStructure : null,
  };

  const ranked = engine.recommendDefenses({
    playbook: playbooks.defense,
    offensePlay,
    situation: situationFromState(state),
    limit: 3,
  });
  const pool = ranked.candidatePool;
  io.log(`[DC] POOL: total=${pool.total} eligible=${pool.eligible} specialTeams=${pool.excludedSpecialTeams} situational=${pool.excludedSituational} unknown=${pool.excludedUnknown}`);
  const top = ranked.recommendations[0];

  if (!top) {
    coordinatorWindow.showDefensiveRecommendation({
      available: false,
      reason: 'No legal defensive recommendation is available.',
      cpuPlay: offensePlay,
    }, state);
    io.log(`\n[DC] CPU CALL: ${cpu.set || '?'} / ${cpu.name}`);
    io.log('[DC] No defensive candidates are loaded for this playbook.');
    return key;
  }

  coordinatorWindow.showDefensiveRecommendation({
    available: true,
    cpuPlay: offensePlay,
    play: top.play,
    locator: { formation: top.play.formation || null },
    reasons: top.reasons?.slice(0, 3) || [],
  }, state);
  engine.recordRecommendation?.('defense', top, {
    opponentPlay: offensePlay,
    situation: situationFromState(state),
    family: top.diagnostic?.defenseFamily || top.play.coverageFamily || top.play.presentationFamily || null,
  });

  io.log(`\n[DC] ${downText(state.down)} & ${state.distance} | Q${state.quarter} ${fmtClock(state.gameClockSeconds)}`);
  io.log(`[DC] CPU CALL: ${cpu.set || '?'} / ${cpu.name}${resolvedConcept ? ` (concept: ${resolvedConcept})` : ''}`);
  io.log(`[DC] CALL: ${top.play.formation || '?'} / ${top.play.name}  score=${top.score}`);
  if (top.reasons?.length) io.log(`[DC] WHY: ${top.reasons.slice(0, 3).join(' | ')}`);
  return key;
}

function rearmAfterAdministrativeReset(reduced, current, quarantine, io) {
  if (reduced?.type !== 'administrative_reset' || current?.possession !== 1) {
    return quarantine;
  }

  io?.log?.('[COORD] Administrative reset: re-arming CPU offensive call freshness');
  return {
    ...quarantine,
    offense: { available: false },
  };
}

function handleNewSituation(engine, playbooks, current, lastSituationKey, situationKey, io, coordinatorWindow) {
  // Only log when the key actually changed (never spam per-tick) -- this is
  // the diagnostic signal to confirm, in a live retest, that this reset path
  // truly fired at a given telemetry boundary.
  io.log(`[COORD] Situation boundary: ${lastSituationKey ?? '(none)'} -> ${situationKey}`);

  // A new situationKey means a new down/drive/special-teams boundary was
  // detected -- always clear stale selection/guide state here, regardless of
  // which side currently has the ball, so nothing from the previous play or
  // drive (e.g. a kickoff/return selection) can survive into it. Whichever of
  // printRecommendation/printDefensiveRecommendation is actually applicable
  // will immediately overwrite this in the same tick; if neither can (e.g. the
  // defensive call isn't available yet), the window is left in this honest
  // "pending" state instead of showing frozen data from an unrelated play.
  coordinatorWindow.showRecommendation({
    available: false,
    reason: 'New situation detected; recommendation pending.',
  }, current);

  // Stage 1: a real offensive scrimmage huddle gets its coordinator call
  // immediately. No selected offensive play and no fresh exact defense are
  // required. Kickoff/return states fail isOffensiveScrimmageSituation().
  if (isOffensiveScrimmageSituation(current)) {
    printRecommendation(engine, playbooks, current, io, coordinatorWindow);
  }

  // Snapshot whatever is currently exposed, per side, as the quarantined
  // baseline that updateSideFreshness() must see proof against before either
  // side is allowed to drive execution advice / a defensive recommendation.
  return {
    offense: callFromState(current, 'offense'),
    defense: callFromState(current, 'defense'),
  };
}

function snapToFootballEvent(snap, playbooks) {
  const off = findPlay(playbooks.offense, {
    id: snap.offenseCall.id,
    name: snap.offenseCall.name,
    set: snap.offenseCall.set,
  });
  const def = findPlay(playbooks.defense, {
    id: snap.defenseCall.id,
    name: snap.defenseCall.name,
    set: snap.defenseCall.set,
  });

  const raw = {
    offensePlayId: snap.offenseCall.id || snap.offenseCall.name || `unknown-off-${snap.serial}`,
    offensePlayName: snap.offenseCall.name,
    offenseFormation: snap.offenseCall.set,
    offensePlayType: off?.type || null,
    offenseConcepts: off?.concepts || [],
    defensePlayId: snap.defenseCall.id,
    defensePlayName: snap.defenseCall.name,
    defenseFormation: snap.defenseCall.set,
    defenseConcepts: def?.concepts || [],
    down: snap.start.down,
    distance: snap.start.distance,
    yardLine: snap.start.yardLine,
    yardsToGoal: Number.isFinite(Number(snap.start.yardLine)) ? Math.max(0, 100 - Number(snap.start.yardLine)) : null,
    fieldX: snap.start.fieldX,
    fieldY: snap.start.fieldY,
    lineToGain: snap.start.lineToGain,
    hash: snap.start.hash || 'unknown',
    offenseDirection: Number.isFinite(Number(snap.start.lineToGain)) && Number.isFinite(Number(snap.start.fieldX)) && Math.abs(Number(snap.start.lineToGain) - Number(snap.start.fieldX)) > 0.01
      ? Math.sign(Number(snap.start.lineToGain) - Number(snap.start.fieldX))
      : null,
    quarter: snap.start.quarter,
    clockSeconds: snap.start.gameClockSeconds,
    playClockSeconds: snap.start.playClockSeconds,
    possession: snap.start.possession,
    homeScore: snap.start.homeScore,
    awayScore: snap.start.awayScore,
    scoreDifferential: snap.start.scoreDifferential,
    scoreDifferentialSource: snap.start.scoreDifferentialSource,
    userIsHome: snap.start.userIsHome,
    yardsGained: snap.result.yards,
    firstDown: snap.result.firstDown,
    touchdown: snap.result.touchdown,
    turnover: snap.result.turnover,
  };

  const event = toFootballEvent(raw, {
    offensePlay: () => off || {},
    defensePlay: () => def || {},
  });
  // Preserve concepts/setup metadata when resolved from the active playbook.
  // Both sides get their canonical catalog id substituted for the raw
  // telemetry id ONLY when findPlay() actually matched a playbook entry --
  // this is what lets PerformanceStore's exact-id lookups (repetition
  // penalty, summarizeMatchup/summarizeDefensePlay) ever succeed, since
  // recommendDefenses() candidates are always keyed by that same catalog id
  // ("<playbookId>:<catalogId>"), never by the raw in-game numeric play id.
  // No match -> the raw telemetry id/name/formation stand untouched (no
  // fabricated id), same as before.
  if (off) event.play = { ...event.play, ...off, id: String(off.id) };
  if (def) event.opponentPlay = { ...event.opponentPlay, ...def, id: String(def.id) };
  return event;
}

function finalizeCompletedSnap(engine, reduced, playbooks, coordinatorWindow, io) {
  if (reduced?.type !== 'completed_snap') return null;
  const footballEvent = snapToFootballEvent(reduced.snap, playbooks);
  const recorded = engine.recordPlay(footballEvent);
  if (reduced.snap.start.possession === 0) {
    coordinatorWindow.showResult({ event: footballEvent }, reduced.nextState || reduced.state || null);
  }
  io.log(`\n[SNAP ${reduced.snap.serial}] ${recorded.play?.name || 'Unknown offense'} vs ${recorded.opponentPlay?.name || 'Unknown defense'}`);
  io.log(`[SNAP ${reduced.snap.serial}] result=${reduced.snap.result.yards >= 0 ? '+' : ''}${reduced.snap.result.yards} yd` +
    `${reduced.snap.result.firstDown ? ' FIRST DOWN' : ''}${reduced.snap.result.touchdown ? ' TD' : ''}${reduced.snap.result.turnover ? ' TURNOVER' : ''}`);
  return recorded;
}

// Builds the object CoordinatorWindow uses to serve /api/playbooks, /api/config,
// and POST /api/config/playbooks. Deliberately a plain closure inside
// runLiveCoordinator (not a standalone exported function) because it needs
// live read/write access to the same `playbooks`/`fresh`/`lastKnownState`
// bindings the main loop mutates each tick -- a snapshot passed in as a
// parameter would go stale immediately.
function createPlaybookService({ root, configPath, database, playbooks, engine, coordinatorWindow, io, getLastKnownState, getFresh, defensivePlayStore = null, getDefensiveContext = () => null }) {
  function listPlaybooks() {
    if (!database || !DatabasePlaybookRepository) return { offense: [], defense: [] };
    const repo = new DatabasePlaybookRepository(database);
    return {
      offense: repo.list({ side: 'offense', visibleOnly: true }),
      defense: repo.list({ side: 'defense', visibleOnly: true }),
    };
  }

  function getConfig() {
    return loadCoordinatorConfig(configPath) || {
      offensePlaybookId: null, offensePlaybookName: null,
      defensePlaybookId: null, defensePlaybookName: null,
    };
  }

  function listGameplans() {
    return {
      ...(engine.gameplanSummary?.() || {}),
      gameplans: engine.listGameplans?.() || [],
    };
  }

  function setGameplanSelection({ gameplanId, aggressiveness }) {
    const result = engine.setGameplanSelection?.(playbooks.offense, { gameplanId, aggressiveness });
    if (!result?.available) throw new Error(result?.reason || 'Gameplan selection is unavailable.');
    io.log(`[GAMEPLAN] ${result.gameplanName} | callSheet=${result.callSheetSize} | aggression=${result.aggressiveness}`);

    let appliedImmediately = false;
    const lastKnownState = getLastKnownState();
    if (lastKnownState && isOffensiveScrimmageSituation(lastKnownState)) {
      printRecommendation(engine, playbooks, lastKnownState, io, coordinatorWindow);
      appliedImmediately = true;
    }
    return { ...result, appliedImmediately };
  }

  function regenerateGameplan() {
    const result = engine.regenerateGameplan?.(playbooks.offense);
    if (!result?.available) throw new Error(result?.reason || 'Gameplan regeneration is unavailable.');
    io.log(`[GAMEPLAN] regenerated ${result.gameplanName} | callSheet=${result.callSheetSize}`);
    const lastKnownState = getLastKnownState();
    if (lastKnownState && isOffensiveScrimmageSituation(lastKnownState)) {
      printRecommendation(engine, playbooks, lastKnownState, io, coordinatorWindow);
    }
    return result;
  }

  function listAudiblePackages() {
    return engine.listAudiblePackages?.(playbooks.offense) || { packages: [], gaps: [] };
  }

  function confirmAudiblePackage({ formation, playIds }) {
    if (!formation) throw new Error('Formation is required.');
    const pkg = engine.confirmAudiblePackage?.(playbooks.offense, formation, playIds);
    if (!pkg) throw new Error('Audible package confirmation is unavailable.');
    io.log(`[AUDIBLES] confirmed ${formation}: ${pkg.slots.map(slot => slot.playName).join(' | ')}`);
    return pkg;
  }

  function setPlaybookSelection({ side, playbookId }) {
    if (side !== 'offense' && side !== 'defense') {
      throw new Error(`Invalid side: ${side}`);
    }
    if (!database || !DatabasePlaybookRepository) {
      throw new Error('Coordinator database is not available.');
    }
    const repo = new DatabasePlaybookRepository(database);
    const resolved = repo.resolve(playbookId, { side, visibleOnly: true });
    if (!resolved) {
      throw new Error(`No visible ${side} playbook with id ${playbookId}.`);
    }

    const loader = side === 'offense' ? loadOffensePlaybookFromDatabase : loadDefensePlaybookFromDatabase;
    const idKey = side === 'offense' ? 'offensePlaybookId' : 'defensePlaybookId';
    const newBook = loader(root, { [idKey]: resolved.id, useDatabase: true });
    if (!newBook) {
      throw new Error(`Failed to load ${side} playbook ${resolved.id} from the database.`);
    }

    saveCoordinatorConfig({
      [idKey]: resolved.id,
      [`${side}PlaybookName`]: resolved.name,
    }, configPath);

    // Mutate only the relevant shared property -- this is deliberately NOT a
    // situation boundary. lastSituationKey/quarantine/fresh/cleared/
    // SnapReducer/performance history are untouched; the new candidate pool
    // simply becomes authoritative for every subsequent tick that reads
    // playbooks.offense/playbooks.defense.
    if (side === 'defense' && defensivePlayStore) {
      const stats = attachDefensiveAuthority(newBook, defensivePlayStore);
      io.log(`[DEF-AUTH] book=${newBook.id} candidates annotated resolved=${stats.resolved} partial=${stats.partial} unresolved=${stats.unresolved}`);
    }
    playbooks[side] = newBook;
    if (side === 'offense') {
      engine.prepareAudiblePackages?.(newBook);
      engine.prepareGameplan?.(newBook);
    }
    io.log(playbookLogLine(side === 'offense' ? 'Offense' : 'Defense', newBook));

    let appliedImmediately = false;
    const lastKnownState = getLastKnownState();
    if (side === 'offense' && lastKnownState && isOffensiveScrimmageSituation(lastKnownState)) {
      const initial = printRecommendation(engine, playbooks, lastKnownState, io, coordinatorWindow);
      const fresh = getFresh();
      const exactDefense = exactDefenseFromState(engine, lastKnownState, fresh, getDefensiveContext());
      if (initial && exactDefense) {
        printOracleRecommendation(engine, playbooks, lastKnownState, exactDefense, io, coordinatorWindow);
      }
      appliedImmediately = Boolean(initial);
    } else if (side === 'defense' && lastKnownState && coordinatorWindow.state.phase === 'defensive_huddle') {
      const fresh = getFresh();
      if (fresh.offense) {
        printDefensiveRecommendation(engine, playbooks, lastKnownState, null, fresh, io, coordinatorWindow);
        appliedImmediately = true;
      }
    }

    return { book: { id: newBook.id, name: newBook.name, playCount: newBook.plays.length }, appliedImmediately };
  }

  return {
    listPlaybooks,
    getConfig,
    setPlaybookSelection,
    listGameplans,
    setGameplanSelection,
    regenerateGameplan,
    listAudiblePackages,
    confirmAudiblePackage,
  };
}

async function runLiveCoordinator({ repoRoot, configPath, signal, io = console } = {}) {
  const root = repoRoot || path.resolve(__dirname, '../..');
  const resolvedConfigPath = configPath
    ? (path.isAbsolute(configPath) ? configPath : path.resolve(root, configPath))
    : undefined; // undefined lets loadCoordinatorConfig/saveCoordinatorConfig use their own DEFAULT_CONFIG_PATH
  const config = parseConfig(root, configPath);
  const playbooks = loadPlaybooks(root, config);
  const game = await sdk.discoverGame();
  const client = sdk.createClient({ pid: game.pid });
  // Optional/read-only: the generated EA artifact is intentionally gitignored.
  // Missing/invalid data makes only the authority layer unavailable; legacy
  // coordinator selection/execution remains fully operational.
  // This single long-lived instance is shared by live identity resolution and
  // ExecutionAdvisor expansion; gameplay never rereads/parses the XML corpus.
  const authoritativePlayStore = new EaPlayKnowledgeStore({
    filePath: path.resolve(root, 'data/knowledge/pro-style-ea-play-knowledge.json'),
  });
  const engine = new FootballEngine({
    executionAdvisor: { eaPlayKnowledgeStore: authoritativePlayStore },
    audiblePackagePath: path.resolve(root, 'data/coordinator-audibles.json'),
    gameplanPath: path.resolve(root, 'data/coordinator-gameplans.json'),
  });
  const audiblePreparation = engine.prepareAudiblePackages(playbooks.offense);
  const gameplanPreparation = engine.prepareGameplan(playbooks.offense);
  // Compiled EA defensive playbook authority (checked in, ~0.8 MB, loaded
  // once). Missing data disables only the defensive authority layer.
  let defensivePlayStore = null;
  try {
    defensivePlayStore = EaDefensivePlayStore.load(path.resolve(root, 'data/knowledge/ea-defensive-play-knowledge.json'));
  } catch (error) {
    io.log(`[DEF-AUTH] defensive authority unavailable: ${error.message}`);
  }
  const opponentDefenseBooks = new OpponentDefenseBookTracker();
  const defensiveContext = () => (defensivePlayStore ? {
    store: defensivePlayStore,
    bookId: config.opponentDefensePlaybookId ?? null,
    tracker: opponentDefenseBooks,
  } : null);
  if (defensivePlayStore && playbooks.defense) {
    const stats = attachDefensiveAuthority(playbooks.defense, defensivePlayStore);
    io.log(`[DEF-AUTH] book=${playbooks.defense.id} candidates annotated resolved=${stats.resolved} partial=${stats.partial} unresolved=${stats.unresolved}`);
  }
  const reducer = new SnapReducer();
  const phaseTracker = new GamePhaseTracker();
  let lastSituationKey = null;
  let lastExecutionKey = null;
  let lastOracleRecommendationKey = null;
  // Diagnostic-only deduplication. This key never participates in freshness,
  // authority resolution, snap detection, performance recording, or advice.
  let lastAuthorityDiagnosticKey = null;
  let lastPhaseDiagnosticKey = null;
  let lastPhaseQuarter = null;
  let lastPhaseSource = null;
  let lastDefensiveAuthorityDiagnosticKey = null;
  let quarantine = { offense: { available: false }, defense: { available: false } };
  let fresh = { offense: false, defense: false };
  let cleared = { offense: false, defense: false };
  let lastKnownState = null;

  // Long-lived, read-only: used only for listing/validating playbooks for the
  // settings panel. Per-side loads still go through loadOffense/DefensePlaybookFromDatabase(),
  // which open/close their own short-lived connection, unchanged from Stage 2/3.
  let playbookDatabase = null;
  if (CoordinatorDatabase) {
    try {
      playbookDatabase = new CoordinatorDatabase({
        dbPath: path.isAbsolute(config.coordinatorDatabase || '') ? config.coordinatorDatabase : path.resolve(root, config.coordinatorDatabase || 'data/coordinator.db'),
        readOnly: true,
      });
    } catch (_) {
      playbookDatabase = null;
    }
  }

  const coordinatorWindow = new CoordinatorWindow({
    title: 'CFB 27 Offensive Coordinator',
    autoOpen: true,
  });
  coordinatorWindow.playbookService = createPlaybookService({
    root,
    configPath: resolvedConfigPath,
    database: playbookDatabase,
    playbooks,
    engine,
    coordinatorWindow,
    io,
    getLastKnownState: () => lastKnownState,
    getFresh: () => fresh,
    defensivePlayStore,
    getDefensiveContext: defensiveContext,
  });

  const after = await tailCursor(client);
  try {
    const ui = await coordinatorWindow.start();
    coordinatorWindow.setGameInfo({ playbook: playbooks.offense.name });
    io.log(`[COORD] Coordinator window: ${ui.url}`);
    io.log(`[COORD] Connected to CollegeFB27 pid=${game.pid}`);
    io.log(playbookLogLine('Offense', playbooks.offense));
    io.log(playbookLogLine('Defense', playbooks.defense));
    const confirmedAudibles = audiblePreparation.packages.filter(pkg => pkg.confirmed).length;
    io.log(`[AUDIBLES] prepared=${audiblePreparation.packages.length} formation packages confirmed=${confirmedAudibles}${audiblePreparation.gaps.length ? ` gaps=${audiblePreparation.gaps.length}` : ''}`);
    if (gameplanPreparation?.available) {
      io.log(`[GAMEPLAN] ${gameplanPreparation.gameplanName} | callSheet=${gameplanPreparation.callSheetSize} | aggression=${gameplanPreparation.aggressiveness} | ${gameplanPreparation.reused ? 'reused' : 'generated'}`);
    }
    io.log('[COORD] Waiting for live coord.state telemetry...');

    for await (const event of sdk.followEvents(client, { after, pollMs: config.pollMs || 250, signal })) {
      if (event.type !== 'coord.state') continue;
      const phaseResolved = phaseTracker.resolve(event.payload || {});
      const state = phaseResolved.state;
      const lifecycleEvent = phaseResolved.lifecycle;
      const phaseDiagnosticKey = [
        phaseResolved.memoryQuarter ?? 'x', phaseResolved.apiQuarter ?? 'x', phaseResolved.quarter ?? 'x',
        phaseResolved.quarterSource, phaseResolved.quarterConfidence,
        phaseResolved.quarterEvidenceConflict ? 'conflict' : 'agree',
        phaseResolved.clockWrapDetected ? 'wrap' : 'steady',
        phaseResolved.directQuarterStaleSuspect ? 'stale' : '', lifecycleEvent || '',
      ].join('|');
      if (phaseDiagnosticKey !== lastPhaseDiagnosticKey &&
          (phaseResolved.quarterEvidenceConflict || phaseResolved.clockWrapDetected || lifecycleEvent ||
           phaseResolved.quarter !== lastPhaseQuarter || phaseResolved.quarterSource !== lastPhaseSource)) {
        io.log(`[PHASE] directQuarter=${phaseResolved.memoryQuarter ?? '?'} api=${phaseResolved.apiQuarter ?? '?'} resolved=${phaseResolved.quarter ?? '?'} source=${phaseResolved.quarterSource} confidence=${phaseResolved.quarterConfidence} clock=${fmtClock(state.gameClockSeconds)} wrap=${phaseResolved.clockWrapDetected ? 'yes' : 'no'}${phaseResolved.directQuarterStaleSuspect ? ' staleSuspect=yes' : ''}`);
      }
      lastPhaseDiagnosticKey = phaseDiagnosticKey;
      lastPhaseQuarter = phaseResolved.quarter;
      lastPhaseSource = phaseResolved.quarterSource;
      if (lifecycleEvent) {
        io.log(`[GAME] ${lifecycleEvent} | phase=${phaseResolved.phase} | quarterSource=${phaseResolved.quarterSource} | scoreSource=${phaseResolved.scoreDifferentialSource}`);
      }
      const reduced = reducer.ingest(state);
      if (reduced.type === 'ignored') continue;

      // Finalize the PREVIOUS snap before ranking nextState. This makes the
      // first Stage-1 call for the new huddle see performance, sequence,
      // self-scout and resulting field/hash state.
      finalizeCompletedSnap(engine, reduced, playbooks, coordinatorWindow, io);

      const current = reduced.type === 'completed_snap' ? reduced.nextState : reduced.state;
      if (current) {
        lastKnownState = current;
        coordinatorWindow.updateSituation(current);
        if (current.quarterSource || current.scoreDifferentialSource) {
          coordinatorWindow.setTelemetryProvenance?.({
            quarterSource: current.quarterSource,
            quarterConfidence: current.quarterConfidence,
            scoreDifferentialSource: current.scoreDifferentialSource,
            gamePhase: current.gamePhase,
          });
        }
        const situationKey = situationIdentityKey(current);
        if (situationKey !== lastSituationKey) {
          quarantine = handleNewSituation(engine, playbooks, current, lastSituationKey, situationKey, io, coordinatorWindow);
          fresh = { offense: false, defense: false };
          cleared = { offense: false, defense: false };

          // An accepted penalty/administrative reset is positive evidence that
          // the previous CPU offensive call no longer belongs to the active
          // down, even if telemetry keeps exposing the same signature through
          // the transition. On the user-defense path, treat the offensive side
          // as a new generation so the DC is not left permanently pending.
          // The reducer emitted administrative_reset specifically so this does
          // not fabricate a completed snap or pollute performance history.
          quarantine = rearmAfterAdministrativeReset(reduced, current, quarantine, io);

          lastSituationKey = situationKey;
          lastExecutionKey = null;
          lastOracleRecommendationKey = null;
        }
        const previousFresh = fresh;
        ({ fresh, cleared } = updateFreshness(current, quarantine, fresh, cleared));
        logFreshnessTransitions(previousFresh, fresh, current, io);

        // Authoritative offensive identity is derived from the existing
        // offense freshness lifecycle, not from defense readiness and not from
        // an independent cache/TTL. A situation boundary resets fresh.offense;
        // stale/unavailable calls therefore cannot retain prior EA identity,
        // while an audible is re-resolved immediately from the new live call.
        const offensiveLiveCall = callFromState(current, 'offense');
        // The exact opponent offensive call is just as useful on defense as
        // the user's own selected play is on offense. The strict Set+Play
        // authority resolver is therefore shared by both possession paths.
        const authoritativeOffense = resolveFreshOffensiveAuthority({
          store: authoritativePlayStore,
          playbook: playbooks.offense,
          liveCall: offensiveLiveCall,
          fresh: fresh.offense,
        });
        const authoritativeOffenseStructure = authoritativeOffense?.status === 'resolved'
          ? authoritativePlayStore.expandPlay(authoritativeOffense.playKey)
          : null;

        lastAuthorityDiagnosticKey = logAuthorityTransition(
          authoritativeOffense,
          offensiveLiveCall,
          lastAuthorityDiagnosticKey,
          io
        );

        const exactDefense = exactDefenseFromState(engine, current, fresh, defensiveContext());
        if (exactDefense) {
          const auth = exactDefense.authoritativeDefense || {};
          const defKey = [exactDefense.set || '', exactDefense.name || '', auth.status || '', auth.playKey || '', auth.reason || ''].join('|');
          if (defKey !== lastDefensiveAuthorityDiagnosticKey) {
            io.log(defensiveAuthorityLogLine(auth, { bookId: config.opponentDefensePlaybookId ?? null }));
            // Narrow the opponent's book once per distinct exact call.
            if (defensivePlayStore && auth.resolution?.evidence !== 'EXACT_BOOK') {
              opponentDefenseBooks.observe(defensivePlayStore, { setName: exactDefense.set, playName: exactDefense.name });
            }
            lastDefensiveAuthorityDiagnosticKey = defKey;
          }
        }
        const oracleOffenseCall = callFromState(current, 'offense');
        if (current.possession === 0 && fresh.offense && exactDefense && oracleOffenseCall.available) {
          const oracleRecommendationKey = [
            current.quarter,
            current.down,
            current.distance,
            current.fieldX,
            oracleOffenseCall.set || '',
            oracleOffenseCall.name || '',
            oracleOffenseCall.id || '',
            exactDefense.id || exactDefense.name,
          ].join('|');
          if (oracleRecommendationKey !== lastOracleRecommendationKey) {
            printOracleRecommendation(engine, playbooks, current, exactDefense, io, coordinatorWindow, authoritativeOffense);
            lastOracleRecommendationKey = oracleRecommendationKey;
          }
        }

        lastExecutionKey = printExecutionAdvice(
          engine,
          playbooks,
          current,
          lastExecutionKey,
          fresh,
          io,
          coordinatorWindow,
          authoritativeOffense,
          exactDefense
        );
        lastExecutionKey = printDefensiveRecommendation(
          engine,
          playbooks,
          current,
          lastExecutionKey,
          fresh,
          io,
          coordinatorWindow,
          authoritativeOffenseStructure
        );
      }

      if (lifecycleEvent === 'FINAL') opponentDefenseBooks.reset();
      if (lifecycleEvent) {
        const review = lifecycleEvent === 'HALFTIME'
          ? engine.halftimeGameplanReview?.() || null
          : (lifecycleEvent === 'FINAL' ? engine.reviewGameplan?.() || [] : null);
        coordinatorWindow.showLifecycle?.({
          type: lifecycleEvent,
          phase: phaseResolved.phase,
          review,
          gameplan: engine.gameplanSummary?.() || null,
        }, state);
      }

    }
  } finally {
    const gameplanReview = engine.reviewGameplan?.() || [];
    for (const row of gameplanReview) {
      io.log(`[GAMEPLAN REVIEW] ${row.status} | ${row.formation || '?'}${row.play ? ' / ' + row.play : ''} | ${row.reason}`);
    }
    const audibleReview = engine.reviewAudiblePackages?.(playbooks.offense) || [];
    for (const row of audibleReview) {
      const replacement = row.proposedReplacement ? ` -> ${row.proposedReplacement.playName}` : '';
      io.log(`[AUDIBLE REVIEW] ${row.status} | ${row.formation} | ${row.audibleSlot} ${row.currentAudible}${replacement} | ${row.reason}`);
    }
    await coordinatorWindow.close();
    if (playbookDatabase) {
      try { playbookDatabase.close(); } catch (_) { /* already closed or never opened */ }
    }
  }

  return { engine, reducer, phaseTracker };
}

module.exports = {
  runLiveCoordinator,
  tailCursor,
  situationFromState,
  snapToFootballEvent,
  isOffensiveScrimmageSituation,
  buildOracleAudibleScope,
  printRecommendation,
  printOracleRecommendation,
  decideOracleRecommendation,
  exactDefenseFromState,
  printExecutionAdvice,
  printDefensiveRecommendation,
  handleNewSituation,
  updateSideFreshness,
  updateFreshness,
  logFreshnessTransitions,
  authorityDiagnosticKey,
  formatAuthorityDiagnostic,
  logAuthorityTransition,
  rearmAfterAdministrativeReset,
  createPlaybookService,
  playbookLogLine,
  situationIdentityKey,
  finalizeCompletedSnap,
  GamePhaseTracker,
};
