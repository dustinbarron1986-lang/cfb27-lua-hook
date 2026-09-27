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
  const base = {
    down: state.down,
    distance: state.distance,
    yardLine: state.yardLine,
    quarter: state.quarter,
    clockSeconds: state.gameClockSeconds,
    playClockSeconds: state.playClockSeconds,
    possession: state.possession,
    offenseScore: null,
    defenseScore: null,
    scoreDifferential: 0,
  };
  base.flags = deriveSituation(base);
  return base;
}

function printRecommendation(engine, playbooks, state, io, coordinatorWindow) {
  if (state.possession !== 0) return;
  const ranked = engine.recommendPlays({
    playbook: playbooks.offense,
    situation: situationFromState(state),
    limit: 3,
  });
  const top = ranked.recommendations[0];
  if (!top) {
    coordinatorWindow.showRecommendation({
      available: false,
      reason: 'No legal recommendation is available.',
    }, state);
    return;
  }
  coordinatorWindow.showRecommendation({
    available: true,
    play: top.play,
    locator: {
      formation: top.play.formation,
    },
    reasons: top.reasons?.slice(0, 3) || [],
  }, state);
  io.log(`\n[OC] ${downText(state.down)} & ${state.distance} | Q${state.quarter} ${fmtClock(state.gameClockSeconds)}`);
  io.log(`[OC] CALL: ${top.play.formation || '?'} / ${top.play.name || top.play.id}  score=${top.score}`);
  if (top.reasons?.length) io.log(`[OC] WHY: ${top.reasons.slice(0, 3).join(' | ')}`);
  if (ranked.tendency?.attempts) {
    io.log(`[OC] TENDENCY: ${ranked.tendency.scope}, n=${ranked.tendency.attempts}, confidence=${ranked.tendency.confidence}`);
  }
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

function printExecutionAdvice(engine, playbooks, state, seenKey, fresh, io, coordinatorWindow) {
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

  const result = engine.adviseExecution({
    selectedPlay,
    defensiveCall: { id: defenseCall.id, set: defenseCall.set, name: defenseCall.name },
  });

  coordinatorWindow.showSelection({
    type: isAudible ? 'audible' : 'selected',
    play: selectedPlay,
    opponentPlay: {
      id: defenseCall.id,
      name: defenseCall.name,
      formation: defenseCall.set,
    },
  }, result, state);

  io.log(`\n[READ] ${offenseCall.set || '?'} / ${offenseCall.name} vs ${defenseCall.set || '?'} / ${defenseCall.name}`);
  if (!result.available) {
    io.log(`[READ] No detailed concept guidance yet (${result.reason || 'play not mapped to concept knowledge'}).`);
  } else {
    const advice = result.advice;
    io.log(`[READ] ${advice.headline}${advice.pressureDetected ? ' | PRESSURE' : ''}`);
    const pre = advice.coaching?.preSnap?.[0];
    const post = advice.coaching?.postSnap?.[0];
    if (pre) io.log(`[READ] KEY: ${pre}`);
    if (post) io.log(`[READ] AFTER SNAP: ${post}`);
  }
  return key;
}

function printDefensiveRecommendation(engine, playbooks, state, seenKey, fresh, io, coordinatorWindow) {
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
  const offensePlay = {
    id: cpu.id || cpu.name,
    name: cpu.name,
    formation: cpu.set,
    concepts: resolvedConcept ? [resolvedConcept] : [],
    primaryConcept: resolvedConcept,
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

  io.log(`\n[DC] ${downText(state.down)} & ${state.distance} | Q${state.quarter} ${fmtClock(state.gameClockSeconds)}`);
  io.log(`[DC] CPU CALL: ${cpu.set || '?'} / ${cpu.name}${resolvedConcept ? ` (concept: ${resolvedConcept})` : ''}`);
  io.log(`[DC] CALL: ${top.play.formation || '?'} / ${top.play.name}  score=${top.score}`);
  if (top.reasons?.length) io.log(`[DC] WHY: ${top.reasons.slice(0, 3).join(' | ')}`);
  return key;
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
  printRecommendation(engine, playbooks, current, io, coordinatorWindow);

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
    quarter: snap.start.quarter,
    clockSeconds: snap.start.gameClockSeconds,
    playClockSeconds: snap.start.playClockSeconds,
    possession: snap.start.possession,
    homeScore: snap.start.homeScore,
    awayScore: snap.start.awayScore,
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

// Builds the object CoordinatorWindow uses to serve /api/playbooks, /api/config,
// and POST /api/config/playbooks. Deliberately a plain closure inside
// runLiveCoordinator (not a standalone exported function) because it needs
// live read/write access to the same `playbooks`/`fresh`/`lastKnownState`
// bindings the main loop mutates each tick -- a snapshot passed in as a
// parameter would go stale immediately.
function createPlaybookService({ root, configPath, database, playbooks, engine, coordinatorWindow, io, getLastKnownState, getFresh }) {
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
    playbooks[side] = newBook;
    io.log(playbookLogLine(side === 'offense' ? 'Offense' : 'Defense', newBook));

    let appliedImmediately = false;
    const lastKnownState = getLastKnownState();
    if (side === 'offense' && lastKnownState && coordinatorWindow.state.phase === 'huddle') {
      printRecommendation(engine, playbooks, lastKnownState, io, coordinatorWindow);
      appliedImmediately = true;
    } else if (side === 'defense' && lastKnownState && coordinatorWindow.state.phase === 'defensive_huddle') {
      const fresh = getFresh();
      if (fresh.offense) {
        printDefensiveRecommendation(engine, playbooks, lastKnownState, null, fresh, io, coordinatorWindow);
        appliedImmediately = true;
      }
    }

    return { book: { id: newBook.id, name: newBook.name, playCount: newBook.plays.length }, appliedImmediately };
  }

  return { listPlaybooks, getConfig, setPlaybookSelection };
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
  const engine = new FootballEngine();
  const reducer = new SnapReducer();
  let lastSituationKey = null;
  let lastExecutionKey = null;
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
  });

  const after = await tailCursor(client);
  try {
    const ui = await coordinatorWindow.start();
    coordinatorWindow.setGameInfo({ playbook: playbooks.offense.name });
    io.log(`[COORD] Coordinator window: ${ui.url}`);
    io.log(`[COORD] Connected to CollegeFB27 pid=${game.pid}`);
    io.log(playbookLogLine('Offense', playbooks.offense));
    io.log(playbookLogLine('Defense', playbooks.defense));
    io.log('[COORD] Waiting for live coord.state telemetry...');

    for await (const event of sdk.followEvents(client, { after, pollMs: config.pollMs || 250, signal })) {
      if (event.type !== 'coord.state') continue;
      const state = event.payload;
      const reduced = reducer.ingest(state);
      if (reduced.type === 'ignored') continue;

      const current = reduced.type === 'completed_snap' ? reduced.nextState : reduced.state;
      if (current) {
        lastKnownState = current;
        coordinatorWindow.updateSituation(current);
        const situationKey = `${current.possession}|${current.quarter}|${current.down}|${current.distance}|${current.fieldX}|${current.lineToGain}`;
        if (situationKey !== lastSituationKey) {
          quarantine = handleNewSituation(engine, playbooks, current, lastSituationKey, situationKey, io, coordinatorWindow);
          fresh = { offense: false, defense: false };
          cleared = { offense: false, defense: false };
          lastSituationKey = situationKey;
          lastExecutionKey = null;
        }
        const previousFresh = fresh;
        ({ fresh, cleared } = updateFreshness(current, quarantine, fresh, cleared));
        logFreshnessTransitions(previousFresh, fresh, current, io);

        lastExecutionKey = printExecutionAdvice(engine, playbooks, current, lastExecutionKey, fresh, io, coordinatorWindow);
        lastExecutionKey = printDefensiveRecommendation(engine, playbooks, current, lastExecutionKey, fresh, io, coordinatorWindow);
      }

      if (reduced.type === 'completed_snap') {
        const footballEvent = snapToFootballEvent(reduced.snap, playbooks);
        const recorded = engine.recordPlay(footballEvent);
        if (reduced.snap.start.possession === 0) {
          coordinatorWindow.showResult({ event: footballEvent }, current);
          // showResult just overwrote the recommendation we computed above for this same
          // situation. Invalidate the dedup key so the next telemetry sample (~1s later)
          // re-triggers printRecommendation instead of leaving the window stuck on RESULT.
          lastSituationKey = null;
        }
        io.log(`\n[SNAP ${reduced.snap.serial}] ${recorded.play?.name || 'Unknown offense'} vs ${recorded.opponentPlay?.name || 'Unknown defense'}`);
        io.log(`[SNAP ${reduced.snap.serial}] result=${reduced.snap.result.yards >= 0 ? '+' : ''}${reduced.snap.result.yards} yd` +
          `${reduced.snap.result.firstDown ? ' FIRST DOWN' : ''}${reduced.snap.result.touchdown ? ' TD' : ''}${reduced.snap.result.turnover ? ' TURNOVER' : ''}`);
      }
    }
  } finally {
    await coordinatorWindow.close();
    if (playbookDatabase) {
      try { playbookDatabase.close(); } catch (_) { /* already closed or never opened */ }
    }
  }

  return { engine, reducer };
}

module.exports = {
  runLiveCoordinator,
  tailCursor,
  situationFromState,
  snapToFootballEvent,
  printRecommendation,
  printExecutionAdvice,
  printDefensiveRecommendation,
  handleNewSituation,
  updateSideFreshness,
  updateFreshness,
  logFreshnessTransitions,
  createPlaybookService,
  playbookLogLine,
};
