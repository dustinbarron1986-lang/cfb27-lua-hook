'use strict';

const { classifyOffensiveStructure, classifyDefensiveStructure, normalize } = require('../analysis/structural-threat-model');
const { evaluateOffensiveCandidate, desiredOffensiveThreats } = require('./counter-model');

const ACTION = Object.freeze({
  STAY: 'STAY',
  PROTECTION: 'PROTECTION',
  HOT_ROUTE: 'HOT_ROUTE',
  PROTECTION_HOT_ROUTE: 'PROTECTION_HOT_ROUTE',
  AUDIBLE: 'AUDIBLE',
});

const HOT_ROUTE_MENU = Object.freeze([
  { route: 'SLANT', threatKeys: ['quick_horizontal', 'crossing'] },
  { route: 'DRAG', threatKeys: ['crossing', 'quick_horizontal'] },
  { route: 'FLAT', threatKeys: ['quick_horizontal', 'perimeter_access'] },
  { route: 'OUT', threatKeys: ['quick_horizontal', 'perimeter_access', 'flood'] },
  { route: 'IN', threatKeys: ['crossing', 'intermediate_middle'] },
  { route: 'CURL', threatKeys: ['intermediate_middle'] },
  { route: 'STREAK', threatKeys: ['vertical'] },
]);

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function friendly(value) {
  return String(value || '')
    .replace(/^AssignRouteType_/i, '')
    .replace(/^RR_/i, '')
    .replaceAll('_', ' ')
    .trim();
}

function sameFormation(a, b) {
  return normalize(a) === normalize(b);
}

function profileForDefense(defensiveCall, knowledge) {
  const current = classifyDefensiveStructure(defensiveCall || {}, knowledge);
  return { current, signals: [], scores: {}, sampleSize: 0 };
}

function historyScore(performanceStore, play, defensiveCall, situation) {
  if (!performanceStore || !play) return { score: 0, summary: null };
  let summary = null;
  if (defensiveCall?.id != null) {
    summary = performanceStore.summarizeMatchup(play.id, defensiveCall.id, situation || null);
  }
  if (!summary || summary.attempts < 2) {
    summary = performanceStore.summarizePlayInSituation(play.id, situation || {});
  }
  if (!summary || summary.attempts < 2 || summary.situationalSuccessRate == null) {
    return { score: 0, summary };
  }
  const success = (Number(summary.situationalSuccessRate) - 0.5) * 1.2;
  const negative = summary.negativePlayRate == null ? 0 : -Number(summary.negativePlayRate) * 0.45;
  const turnover = summary.turnoverRate == null ? 0 : -Number(summary.turnoverRate) * 0.65;
  return { score: success + negative + turnover, summary };
}

function structureWithThreats(base, addedThreats = []) {
  const threatKeys = unique([...(base?.threatKeys || []), ...addedThreats]);
  const existing = new Map((base?.threats || []).map(row => [row.key, row]));
  const threats = threatKeys.map(key => existing.get(key) || {
    key,
    weight: 1,
    provenance: 'HEURISTIC',
    evidence: ['pre-snap modification:' + key],
  });
  return {
    ...(base || {}),
    threats,
    threatKeys,
    primaryThreat: base?.primaryThreat || threatKeys[0] || null,
  };
}

function gradePlay({ play, structure, defenseProfile, knowledge, situation, performanceStore, defensiveCall }) {
  const candidate = {
    ...play,
    structural: structure || play?.structural || classifyOffensiveStructure(play, play?.authoritativeStructure || null),
  };
  const counter = evaluateOffensiveCandidate({
    defenseProfile,
    play: candidate,
    knowledge,
    situation: situation || {},
  });
  const history = historyScore(performanceStore, candidate, defensiveCall, situation);
  return {
    valid: counter.valid,
    fit: counter.fit,
    structuralScore: counter.score,
    historyScore: history.score,
    total: counter.score + history.score * 0.35,
    counter,
    history: history.summary,
    structure: candidate.structural,
  };
}

function authoritativeRoutes(authoritativeKnowledge) {
  const structure = authoritativeKnowledge?.authoritative || null;
  const buttons = authoritativeKnowledge?.receiverButtons || [];
  return (structure?.routeTargets || []).map(target => {
    const button = buttons.find(row => Number(row.playerIndex) === Number(target.playerIndex))?.button || null;
    return {
      ...target,
      button,
      player: target.playerLabel || button || ('player ' + String(Number(target.playerIndex) + 1)),
    };
  });
}

function eligibleProtectors(authoritativeKnowledge) {
  const structure = authoritativeKnowledge?.authoritative || null;
  if (!structure?.available) return [];
  const routed = new Set((structure.routeTargets || []).map(target => Number(target.playerIndex)));
  return (structure.players || []).filter(player => {
    if (!routed.has(Number(player.index))) return false;
    const label = normalize(player.label || player.alignment?.positionType || '');
    if (!/(^| )(hb|rb|fb|te|halfback|running back|fullback|tight end)( |$)/.test(label)) return false;
    const passBlocks = player.eaAssignment?.semantics?.blocking?.passBlocks || [];
    return !passBlocks.length;
  }).map(player => ({
    playerIndex: player.index,
    player: player.label || player.alignment?.positionType || ('player ' + String(Number(player.index) + 1)),
    source: 'EA_AUTHORED_ASSIGNMENT',
  }));
}

function routeThreats(value) {
  const text = normalize(value);
  const keys = [];
  if (/slant|drag|cross|shallow/.test(text)) keys.push('crossing');
  if (/slant|drag|flat|out|swing|curl|quick/.test(text)) keys.push('quick_horizontal');
  if (/flat|out|swing/.test(text)) keys.push('perimeter_access');
  if (/corner|out|sail/.test(text)) keys.push('flood');
  if (/dig|in|post|seam|curl/.test(text)) keys.push('intermediate_middle');
  if (/go|streak|vertical|seam|post/.test(text)) keys.push('vertical');
  if (/screen|bubble/.test(text)) keys.push('screen');
  return unique(keys);
}

function bestHotRoute({ routes, excludedPlayerIndexes, baseStructure, baseGrade, defenseProfile, selectedPlay, knowledge, situation, performanceStore, defensiveCall }) {
  let best = null;
  for (const target of routes) {
    if (excludedPlayerIndexes.has(Number(target.playerIndex))) continue;
    for (const menu of HOT_ROUTE_MENU) {
      const structure = structureWithThreats(baseStructure, menu.threatKeys);
      const grade = gradePlay({
        play: selectedPlay,
        structure,
        defenseProfile,
        knowledge,
        situation,
        performanceStore,
        defensiveCall,
      });
      const gain = grade.structuralScore - baseGrade.structuralScore;
      if (!grade.valid) continue;
      if (gain < 0.65 && !(baseGrade.valid === false && grade.fit > baseGrade.fit + 0.08)) continue;
      const row = { target, menu, grade, gain };
      if (!best || row.grade.total > best.grade.total) best = row;
    }
  }
  return best;
}

function resolveAudibleCandidates({ audiblePackage, playbook, formation }) {
  if (!audiblePackage?.available || !Array.isArray(audiblePackage.slots)) return [];
  const plays = playbook?.plays || [];
  const rows = [];
  for (const slot of audiblePackage.slots) {
    if (!sameFormation(slot.formation || formation, formation)) continue;
    const play = plays.find(candidate =>
      sameFormation(candidate.formation, formation) &&
      (slot.playId != null ? String(candidate.id) === String(slot.playId) : String(candidate.name || '') === String(slot.playName || ''))
    );
    if (play) rows.push({ slot, play });
  }
  return rows;
}

function rankAudibles({ audiblePackage, playbook, formation, defenseProfile, knowledge, situation, performanceStore, defensiveCall }) {
  return resolveAudibleCandidates({ audiblePackage, playbook, formation })
    .map(row => {
      const structure = row.play.structural || classifyOffensiveStructure(row.play, row.play.authoritativeStructure || null);
      const grade = gradePlay({
        play: row.play,
        structure,
        defenseProfile,
        knowledge,
        situation,
        performanceStore,
        defensiveCall,
      });
      return { ...row, structure, grade };
    })
    .filter(row => row.grade.valid)
    .sort((a, b) => {
      const structuralGap = Number(b.grade.structuralScore) - Number(a.grade.structuralScore);
      if (Math.abs(structuralGap) >= 0.5) return structuralGap;
      if (b.grade.total !== a.grade.total) return b.grade.total - a.grade.total;
      return String(a.slot.slot).localeCompare(String(b.slot.slot));
    });
}

function bestBetFor({ authoritativeKnowledge, defenseProfile, protectedIndexes = new Set(), hotRoute = null }) {
  const routes = authoritativeRoutes(authoritativeKnowledge);
  if (!routes.length) return null;
  const current = defenseProfile?.current || {};
  if (!current.coverageFamily && !current.pressure) return null;

  const desired = desiredOffensiveThreats(defenseProfile);
  let best = null;
  for (const target of routes) {
    if (protectedIndexes.has(Number(target.playerIndex))) continue;
    const overridden = hotRoute && Number(hotRoute.target.playerIndex) === Number(target.playerIndex);
    const routeName = overridden
      ? hotRoute.menu.route
      : (target.routeFamily || target.routeType || target.assignmentName || null);
    const threats = new Set(overridden ? hotRoute.menu.threatKeys : routeThreats(routeName));
    let score = 0;
    const matched = [];
    for (const want of desired) {
      if (threats.has(want.key)) {
        score += want.weight;
        matched.push(want.key);
      }
    }
    if (current.pressure && (threats.has('quick_horizontal') || threats.has('screen'))) {
      score += 0.8;
      matched.push('pressure answer');
    }
    if (!best || score > best.score) best = { target, routeName, score, matched, overridden };
  }

  if (!best || best.score < 0.75) return null;
  const defenseName = current.coverageFamily || (current.pressure ? 'the identified pressure structure' : 'the defensive structure');
  const reason = 'EA-authored receiver identity plus the current defensive structure favors this route family against ' +
    defenseName + (best.matched.length ? ' (' + unique(best.matched).join(', ') + ')' : '') +
    '. Live leverage/player tracking is not available, so this is structural rather than matchup-exact.';
  return {
    calloutType: 'BEST_BET',
    player: best.target.button || best.target.player,
    playerIndex: best.target.playerIndex,
    route: friendly(best.routeName) || best.routeName,
    reason,
    confidence: best.overridden ? 'MEDIUM' : 'MEDIUM',
    source: best.overridden ? 'EA_PLAYER+HOT_ROUTE_CONFIG+DERIVED_DEFENSE_STRUCTURE' : 'EA_AUTHORED_ROUTE+DERIVED_DEFENSE_STRUCTURE',
  };
}

function makeResult({ action, baseGrade, finalGrade, defenseProfile, audiblePackage, protectedIndexes, hotRoute, authoritativeKnowledge, reasons, confidence, source }) {
  const bestBet = bestBetFor({
    authoritativeKnowledge,
    defenseProfile,
    protectedIndexes: protectedIndexes || new Set(),
    hotRoute: hotRoute || null,
  });
  return {
    available: true,
    decision: action.type,
    action,
    reason: reasons?.[0] || null,
    reasons: reasons || [],
    confidence: confidence || 'MEDIUM',
    source: source || 'DERIVED_STRUCTURAL',
    baseGrade,
    finalGrade,
    audiblePackage: audiblePackage?.available ? {
      playbookId: audiblePackage.playbookId,
      formation: audiblePackage.formation,
      slots: audiblePackage.slots,
    } : null,
    bestBet,
    callouts: bestBet ? [bestBet] : [],
  };
}

function advisePreSnapCoordinator({
  selectedPlay,
  defensiveCall,
  playbook,
  situation,
  audiblePackage,
  authoritativeKnowledge,
  knowledge,
  performanceStore,
} = {}) {
  if (!selectedPlay || !defensiveCall?.name) {
    return { available: false, reason: 'Selected play and exact defensive call are required.' };
  }

  const defenseProfile = profileForDefense(defensiveCall, knowledge);
  const defense = defenseProfile.current;
  const baseStructure = classifyOffensiveStructure(selectedPlay, authoritativeKnowledge?.authoritative || selectedPlay.authoritativeStructure || null);
  const baseGrade = gradePlay({
    play: selectedPlay,
    structure: baseStructure,
    defenseProfile,
    knowledge,
    situation,
    performanceStore,
    defensiveCall,
  });
  const routes = authoritativeRoutes(authoritativeKnowledge);
  const protectors = eligibleProtectors(authoritativeKnowledge);
  const pressure = Boolean(defense.pressure);
  const quickAnswer = (baseStructure.threatKeys || []).some(key =>
    ['quick_horizontal', 'screen', 'perimeter_access', 'crossing'].includes(key)
  );

  if (baseGrade.valid && baseGrade.fit >= 0.42 && (!pressure || quickAnswer)) {
    return makeResult({
      action: { type: ACTION.STAY, label: 'KEEP PLAY' },
      baseGrade,
      finalGrade: baseGrade,
      defenseProfile,
      audiblePackage,
      authoritativeKnowledge,
      reasons: [pressure
        ? 'Current play already carries a structurally credible quick pressure answer; no larger adjustment is justified.'
        : 'Current play remains a structurally valid answer to the revealed defense.'],
      confidence: defense.provenance === 'DERIVED_STRUCTURAL' ? 'HIGH' : 'MEDIUM',
      source: 'COUNTER_MODEL',
    });
  }

  const protector = pressure ? protectors[0] || null : null;
  if (protector && baseGrade.valid && baseGrade.fit >= 0.34) {
    const protectedIndexes = new Set([Number(protector.playerIndex)]);
    return makeResult({
      action: {
        type: ACTION.PROTECTION,
        label: 'KEEP PLAY — ' + protector.player + ' PASS PRO',
        player: protector.player,
        playerIndex: protector.playerIndex,
      },
      baseGrade,
      finalGrade: { ...baseGrade, pressureSafety: 'improved_one_blocker' },
      defenseProfile,
      audiblePackage,
      protectedIndexes,
      authoritativeKnowledge,
      reasons: [
        'Exact defensive structure identifies pressure and the EA-authored assignment map shows ' + protector.player + ' releasing as an eligible receiver.',
        'Keeping that player in adds one blocker. Exact rusher count/free-rusher identity is not exposed, so the coordinator does not claim the protection is numerically solved.',
      ],
      confidence: 'MEDIUM',
      source: 'EA_ASSIGNMENT+DERIVED_DEFENSE_STRUCTURE',
    });
  }

  const excluded = new Set();
  const hot = bestHotRoute({
    routes,
    excludedPlayerIndexes: excluded,
    baseStructure,
    baseGrade,
    defenseProfile,
    selectedPlay,
    knowledge,
    situation,
    performanceStore,
    defensiveCall,
  });

  if (hot && (!pressure || !protector)) {
    return makeResult({
      action: {
        type: ACTION.HOT_ROUTE,
        label: 'HOT ROUTE ' + (hot.target.button || hot.target.player) + ' → ' + hot.menu.route,
        player: hot.target.button || hot.target.player,
        playerIndex: hot.target.playerIndex,
        route: hot.menu.route,
      },
      baseGrade,
      finalGrade: hot.grade,
      defenseProfile,
      audiblePackage,
      hotRoute: hot,
      authoritativeKnowledge,
      reasons: [
        'The configured hot route adds a materially better structural counter (' + hot.menu.threatKeys.join(', ') + ') without changing formations.',
        pressure
          ? 'Pressure is identified, but live leverage is not tracked; this is a quick structural answer rather than a claimed free receiver.'
          : 'Coverage structure improves enough to justify the route change; live leverage is not tracked.',
      ],
      confidence: 'MEDIUM',
      source: 'HOT_ROUTE_CONFIG+COUNTER_MODEL',
    });
  }

  if (pressure && protector) {
    const protectedIndexes = new Set([Number(protector.playerIndex)]);
    const combinedHot = bestHotRoute({
      routes,
      excludedPlayerIndexes: protectedIndexes,
      baseStructure,
      baseGrade,
      defenseProfile,
      selectedPlay,
      knowledge,
      situation,
      performanceStore,
      defensiveCall,
    });
    if (combinedHot) {
      return makeResult({
        action: {
          type: ACTION.PROTECTION_HOT_ROUTE,
          label: 'KEEP PLAY — ' + protector.player + ' PASS PRO; HOT ROUTE ' +
            (combinedHot.target.button || combinedHot.target.player) + ' → ' + combinedHot.menu.route,
          protector: protector.player,
          protectorPlayerIndex: protector.playerIndex,
          hotRoutePlayer: combinedHot.target.button || combinedHot.target.player,
          hotRoutePlayerIndex: combinedHot.target.playerIndex,
          route: combinedHot.menu.route,
        },
        baseGrade,
        finalGrade: { ...combinedHot.grade, pressureSafety: 'improved_one_blocker' },
        defenseProfile,
        audiblePackage,
        protectedIndexes,
        hotRoute: combinedHot,
        authoritativeKnowledge,
        reasons: [
          'Protection alone does not repair the structural mismatch, so the smallest supported repair is one added blocker plus one route change.',
          protector.player + ' remains in protection and is removed from route/Best Bet consideration; the hot route is assigned to a different receiver.',
        ],
        confidence: 'MEDIUM',
        source: 'EA_ASSIGNMENT+HOT_ROUTE_CONFIG+COUNTER_MODEL',
      });
    }
  }

  const audibleRows = rankAudibles({
    audiblePackage,
    playbook,
    formation: selectedPlay.formation,
    defenseProfile,
    knowledge,
    situation,
    performanceStore,
    defensiveCall,
  });
  const bestAudible = audibleRows[0] || null;
  if (bestAudible && (
    !baseGrade.valid ||
    bestAudible.grade.structuralScore >= baseGrade.structuralScore + 0.55 ||
    (pressure && !quickAnswer && !protector && !hot)
  )) {
    return makeResult({
      action: {
        type: ACTION.AUDIBLE,
        label: 'AUDIBLE ' + String(bestAudible.slot.slot).replace('AUDIBLE_', '') + ' — ' + bestAudible.play.name,
        slot: bestAudible.slot.slot,
        play: {
          id: bestAudible.play.id,
          name: bestAudible.play.name,
          formation: bestAudible.play.formation,
        },
        role: bestAudible.slot.role,
      },
      baseGrade,
      finalGrade: bestAudible.grade,
      defenseProfile,
      audiblePackage,
      authoritativeKnowledge: null,
      reasons: [
        'The current play cannot be repaired by a smaller supported adjustment with enough confidence.',
        'This is the best structurally valid option among the four audibles assigned to the current formation; history only ranks candidates after structural validity.',
      ],
      confidence: 'MEDIUM',
      source: 'FORMATION_AUDIBLE_PACKAGE+COUNTER_MODEL',
    });
  }

  return makeResult({
    action: { type: ACTION.STAY, label: 'KEEP PLAY' },
    baseGrade,
    finalGrade: baseGrade,
    defenseProfile,
    audiblePackage,
    authoritativeKnowledge,
    reasons: [
      'No smaller adjustment or formation-specific audible has enough supported structural advantage to justify changing the call.',
    ],
    confidence: 'LOW',
    source: 'INSUFFICIENT_EVIDENCE',
  });
}

module.exports = {
  ACTION,
  HOT_ROUTE_MENU,
  advisePreSnapCoordinator,
  profileForDefense,
  gradePlay,
  authoritativeRoutes,
  eligibleProtectors,
  resolveAudibleCandidates,
  rankAudibles,
  bestBetFor,
};
