'use strict';

const fs = require('fs');
const path = require('path');
const sdk = require('../../packages/sdk');
const { FootballEngine } = require('../football/engine');
const { toFootballEvent, deriveSituation } = require('../football/integration/telemetry-adapter.example');
const { CoordinatorWindow } = require('../football/ui/coordinator-window');
const { SnapReducer, callFromState } = require('./snap-reducer.cjs');
const { loadPlaybooks, findPlay } = require('./playbook-loader.cjs');

function fmtClock(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return '--:--';
  return `${Math.floor(n / 60)}:${String(Math.max(0, Math.floor(n % 60))).padStart(2, '0')}`;
}

function downText(down) {
  return ({1:'1st',2:'2nd',3:'3rd',4:'4th'})[Number(down)] || `${down}th`;
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

function printExecutionAdvice(engine, playbooks, state, seenKey, io, coordinatorWindow) {
  if (state.possession !== 0) return seenKey;
  const offenseCall = callFromState(state, 'offense');
  const defenseCall = callFromState(state, 'defense');
  if (!offenseCall.available || !defenseCall.available || !offenseCall.name || !defenseCall.name) return seenKey;
  const key = `${state.down}|${state.fieldX}|${offenseCall.id}|${defenseCall.id}`;
  if (key === seenKey) return seenKey;

  const selectedPlay = findPlay(playbooks.offense, {
    id: offenseCall.id,
    name: offenseCall.name,
    set: offenseCall.set,
  }) || {
    id: offenseCall.id || offenseCall.name,
    name: offenseCall.name,
    formation: offenseCall.set,
    concepts: [],
  };

  const result = engine.adviseExecution({
    selectedPlay,
    defensiveCall: { id: defenseCall.id, set: defenseCall.set, name: defenseCall.name },
  });

  coordinatorWindow.showSelection({
    type: 'selected',
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
  if (off) event.play = { ...event.play, ...off, id: String(off.id) };
  return event;
}

async function runLiveCoordinator({ repoRoot, configPath, signal, io = console } = {}) {
  const root = repoRoot || path.resolve(__dirname, '../..');
  const config = parseConfig(root, configPath);
  const playbooks = loadPlaybooks(root, config);
  const game = await sdk.discoverGame();
  const client = sdk.createClient({ pid: game.pid });
  const engine = new FootballEngine();
  const reducer = new SnapReducer();
  const coordinatorWindow = new CoordinatorWindow({
    title: 'CFB 27 Offensive Coordinator',
    autoOpen: true,
  });
  let lastSituationKey = null;
  let lastExecutionKey = null;

  const after = await tailCursor(client);
  try {
    const ui = await coordinatorWindow.start();
    coordinatorWindow.setGameInfo({ playbook: playbooks.offense.name });
    io.log(`[COORD] Coordinator window: ${ui.url}`);
    io.log(`[COORD] Connected to CollegeFB27 pid=${game.pid}`);
    io.log(`[COORD] Offense playbook: ${playbooks.offense.name} (${playbooks.offense.plays.length} plays)`);
    io.log(`[COORD] Defense playbook: ${playbooks.defense.name} (${playbooks.defense.plays.length} plays)`);
    io.log('[COORD] Waiting for live coord.state telemetry...');

    for await (const event of sdk.followEvents(client, { after, pollMs: config.pollMs || 250, signal })) {
      if (event.type !== 'coord.state') continue;
      const state = event.payload;
      const reduced = reducer.ingest(state);
      if (reduced.type === 'ignored') continue;

      const current = reduced.type === 'completed_snap' ? reduced.nextState : reduced.state;
      if (current) {
        coordinatorWindow.updateSituation(current);
        const situationKey = `${current.possession}|${current.quarter}|${current.down}|${current.distance}|${current.fieldX}|${current.lineToGain}`;
        if (situationKey !== lastSituationKey) {
          printRecommendation(engine, playbooks, current, io, coordinatorWindow);
          lastSituationKey = situationKey;
          lastExecutionKey = null;
        }
        lastExecutionKey = printExecutionAdvice(engine, playbooks, current, lastExecutionKey, io, coordinatorWindow);

        if (current.possession === 1) {
          const cpu = callFromState(current, 'offense');
          if (cpu.available && cpu.name) {
            const cpuKey = `cpu|${current.down}|${current.fieldX}|${cpu.id}`;
            if (cpuKey !== lastExecutionKey) {
              io.log(`\n[DC] CPU CALL: ${cpu.set || '?'} / ${cpu.name}`);
              io.log('[DC] Defensive play ranking is not implemented yet; call shown for live diagnosis/tendency capture.');
              lastExecutionKey = cpuKey;
            }
          }
        }
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
  }

  return { engine, reducer };
}

module.exports = {
  runLiveCoordinator,
  tailCursor,
  situationFromState,
  snapToFootballEvent,
};
