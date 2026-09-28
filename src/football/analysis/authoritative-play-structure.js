'use strict';

const { translateRoute } = require('./play-art-engine');

const PROVENANCE = Object.freeze({
  EA_AUTHORED: 'EA_AUTHORED',
  DERIVED_STRUCTURAL: 'DERIVED_STRUCTURAL',
});

function clean(value) {
  return String(value || '').trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function actionOpcode(action) {
  return clean(action?.opcode || action?.type);
}

function startingAlignment(set, index) {
  const positions = set?.positions || [];
  return positions.find(row => Number(row?.index) === Number(index)) || positions[index] || null;
}

function positionLabel(alignment, player) {
  return clean(
    alignment?.positionType ||
    alignment?.depthPosition ||
    alignment?.packagePosition ||
    player?.assignment?.assignmentName ||
    `slot ${Number(player?.index ?? 0) + 1}`
  );
}

function normalizedEaAssignment(record) {
  if (!record) return null;
  const semantics = record.assignmentSemantics || record.semantics || null;
  return {
    positionAssignId: record.positionAssignId ?? null,
    shortName: record.assignmentName || record.shortName || null,
    routeType: record.routeType || null,
    assetPath: record.assignmentAssetPath || record.assetPath || null,
    source: record.source || PROVENANCE.EA_AUTHORED,
    actions: record.assignmentActions || record.actions || [],
    semantics,
  };
}

function classifyPlay(play, players) {
  const offensePlayType = clean(play?.offensePlayType);
  const qbActions = players
    .flatMap(player => player.actionOpcodes || [])
    .filter(opcode => /HANDOFF|SCRAMBLE|DROPBACK|PASS|OPTION/i.test(opcode));

  const rpo = /RPO/i.test(offensePlayType) || qbActions.includes('ID_HANDOFF_OPTION');
  const screen = /PassScreen/i.test(offensePlayType);
  const playAction = /PassPlayAction/i.test(offensePlayType) || qbActions.includes('ID_HANDOFF_FAKE');
  const run = !rpo && !screen && /Run/i.test(offensePlayType);
  const kind = rpo ? 'rpo' : screen ? 'screen' : run ? 'run' : 'pass';

  return {
    kind,
    offensePlayType: offensePlayType || null,
    rpo,
    screen,
    playAction,
    run,
    pass: !run,
    qbActions: [...new Set(qbActions)],
    source: PROVENANCE.EA_AUTHORED,
  };
}

function buildRouteTarget(player) {
  const route = player.eaAssignment?.semantics?.route || null;
  if (!route) return null;
  const translated = translateRoute(route, {
    x: finiteOrNull(player.alignment?.x) ?? 0,
    y: finiteOrNull(player.alignment?.y) ?? 0,
  });
  if (!translated) return null;

  return {
    button: null,
    playerIndex: player.index,
    playerLabel: player.label,
    positionType: player.alignment?.positionType || player.alignment?.depthPosition || null,
    startX: finiteOrNull(player.alignment?.x),
    startY: finiteOrNull(player.alignment?.y),
    assignmentId: player.eaAssignment?.positionAssignId ?? null,
    assignmentName: player.eaAssignment?.shortName || null,
    assignmentAssetPath: player.eaAssignment?.assetPath || null,
    routeType: player.eaAssignment?.routeType || null,
    routeFamily: translated.routeFamily,
    geometry: translated,
    source: PROVENANCE.EA_AUTHORED,
  };
}

function buildAuthoritativePlayStructure(expanded) {
  if (!expanded || expanded.status !== 'resolved') {
    return {
      available: false,
      status: expanded?.status || 'unavailable',
      reason: expanded?.reason || 'authoritative_play_not_expanded',
      provenance: null,
      players: [],
      playArt: { source: 'unavailable', exactAssignmentCount: 0, targets: [] },
    };
  }

  const players = (expanded.players || []).map(player => {
    const alignment = startingAlignment(expanded.set, player.index);
    const eaAssignment = normalizedEaAssignment(player.assignment);
    const actionOpcodes = (eaAssignment?.actions || []).map(actionOpcode).filter(Boolean);
    return {
      index: player.index,
      label: positionLabel(alignment, player),
      alignment,
      eaAssignment,
      actionOpcodes,
      resolutionStatus: player.resolutionStatus || null,
      specialTeamsUnresolved: Boolean(player.specialTeamsUnresolved),
      source: PROVENANCE.EA_AUTHORED,
    };
  });

  const classification = classifyPlay(expanded.play, players);
  const routeTargets = players.map(buildRouteTarget).filter(Boolean);
  const blockingPlayers = players.filter(player => Boolean(player.eaAssignment?.semantics?.blocking));
  const motionPlayers = players.filter(player => {
    const route = player.eaAssignment?.semantics?.route;
    return Boolean(route?.motion?.length);
  });

  return {
    available: true,
    status: 'reconstructed',
    playKey: expanded.playKey,
    provenance: {
      play: PROVENANCE.EA_AUTHORED,
      assignments: PROVENANCE.EA_AUTHORED,
      routeGeometry: PROVENANCE.EA_AUTHORED,
      progression: PROVENANCE.DERIVED_STRUCTURAL,
    },
    formation: expanded.formation || null,
    set: expanded.set || null,
    play: expanded.play || null,
    classification,
    players,
    routeTargets,
    blockingPlayers,
    motionPlayers,
    playArt: {
      source: routeTargets.length ? 'ea_assignment_geometry' : 'unavailable',
      exactAssignmentCount: routeTargets.length,
      targets: routeTargets,
      timingCalibrated: false,
      timingNote: routeTargets.length
        ? 'Route geometry is decoded from EA-authored assignments. Coordinator read order is derived structural, not EA-authored.'
        : null,
    },
    source: PROVENANCE.EA_AUTHORED,
  };
}

function friendlyEnum(value) {
  return clean(value)
    .replace(/^OffensePlayType_/i, '')
    .replace(/^BlockingGap_/i, '')
    .replace(/^BLOCKINGGAP_/i, '')
    .replaceAll('_', ' ')
    .trim();
}

function laneFromGap(gap, offensePlayType) {
  const raw = norm(gap);
  if (/outside|edge|d_gap/.test(raw)) return 'outside';
  if (/c_gap|b_gap/.test(raw)) return 'offGuard';
  if (/a_gap|inside/.test(raw)) return 'inside';

  const type = norm(offensePlayType);
  if (/stretch|outside|sweep|toss/.test(type)) return 'outside';
  if (/power|counter/.test(type)) return 'offGuard';
  if (/iso|duo|inside|zone/.test(type)) return 'inside';
  return null;
}

function deriveRunExecution(structure, runGap) {
  if (!structure?.available || structure.classification?.kind !== 'run') return null;

  const blockers = runGap?.blockers || [];
  const leadBlocks = blockers.filter(block => block.role === 'lead_block');
  const puller = leadBlocks.find(block => /pull/i.test(clean(block.assignmentName)));
  const keyBlock = puller || (leadBlocks.length === 1 ? leadBlocks[0] : null);
  const explicitGap = runGap?.primaryGap || null;
  const aim = explicitGap
    ? friendlyEnum(explicitGap)
    : 'the designed run track (EA numeric runHole is preserved but not decoded here)';

  const offenseType = clean(structure.play?.offensePlayType);
  let cut = 'Press the designed track, read the lead-block leverage, then get vertical through the first clean lane.';
  if (/Zone/i.test(offenseType)) {
    cut = 'Press the designed track; bend behind leverage if the front closes it, and bounce only when the edge is actually won.';
  } else if (/Power|Counter/i.test(offenseType)) {
    cut = 'Stay behind the pull/lead block, cut directly off its leverage, then get vertical.';
  } else if (/ISO|Duo/i.test(offenseType)) {
    cut = 'Press the lead block, choose the clean side of that block, then get vertical without drifting sideways.';
  } else if (/Stretch|Sweep|Toss/i.test(offenseType)) {
    cut = 'Stretch the edge until force leverage declares, then plant and get vertical through the first clean lane.';
  }

  const key = keyBlock
    ? (keyBlock.assignmentName || keyBlock.player || 'the lead blocker')
    : (leadBlocks.length > 1 ? 'the lead-block combination' : 'the first decisive play-side block');

  return {
    available: Boolean(blockers.length || structure.play?.runHole != null || offenseType),
    status: 'derived_structural',
    provenance: PROVENANCE.DERIVED_STRUCTURAL,
    mode: 'run',
    family: friendlyEnum(offenseType) || 'run',
    headline: `Aim for ${aim}.`,
    watch: `Key ${key}.`,
    steps: [cut],
    lane: laneFromGap(explicitGap, offenseType),
    structuralSummary: {
      run: friendlyEnum(offenseType) || 'run',
      aim,
      key,
      cut,
    },
    evidence: {
      offensePlayType: structure.play?.offensePlayType || null,
      runHole: structure.play?.runHole ?? null,
      primaryGap: explicitGap,
      leadBlockCount: leadBlocks.length,
      blockerCount: blockers.length,
    },
  };
}

function authoritativeReceiverRows(structure) {
  return (structure?.routeTargets || []).map(target => {
    const player = structure.players.find(row => row.index === target.playerIndex) || null;
    return {
      button: null,
      playerIndex: target.playerIndex,
      playerLabel: target.playerLabel,
      x: target.startX,
      y: target.startY,
      assignment: null,
      assignment_meaning: null,
      assignment_confidence: 'high',
      eaAssignmentStatus: 'resolved_exact_identity',
      eaAssignment: player?.eaAssignment || null,
    };
  });
}


function friendlyTarget(target) {
  return String(target?.routeFamily || target?.routeType || target?.assignmentName || 'attached route')
    .replace(/^AssignRouteType_/i, '')
    .replace(/^RR_/i, '')
    .replaceAll('_', ' ')
    .trim();
}

function targetRead(target, number, detail) {
  return {
    number: String(number),
    button: null,
    label: friendlyTarget(target),
    detail,
    timing: null,
    assignmentId: target?.assignmentId ?? null,
    assignmentName: target?.assignmentName || null,
    playerIndex: target?.playerIndex ?? null,
    playerLabel: target?.playerLabel || null,
  };
}

function deriveScreenExecution(structure) {
  if (!structure?.available || !structure.classification?.screen) return null;
  const candidates = structure.routeTargets.filter(target => {
    const text = norm([target.routeFamily, target.routeType, target.assignmentName].filter(Boolean).join(' '));
    return /screen|slip|bubble/.test(text);
  });
  const targets = candidates.length ? candidates : structure.routeTargets;
  const ambiguous = targets.length !== 1;
  return {
    available: targets.length > 0,
    status: targets.length ? 'derived_structural' : 'insufficient_assignment_geometry',
    provenance: PROVENANCE.DERIVED_STRUCTURAL,
    mode: 'screen',
    relationship: 'screen_release',
    keyDefenderRole: 'first defender disrupting the screen release/lane',
    ambiguous,
    reads: targets.map((target, index) => targetRead(
      target,
      index + 1,
      ambiguous
        ? 'EA assignments expose multiple plausible screen attachments; preserve the ambiguity rather than inventing one target.'
        : 'Let the rush declare, then deliver to the EA-authored screen attachment behind its releasing blockers.'
    )),
    alert: null,
    outlet: null,
    timingCalibrated: false,
    warning: ambiguous
      ? 'Screen path is coordinator-derived from EA assignments and the exact intended target remains ambiguous.'
      : 'Screen target structure is derived from EA-authored assignments; the read instruction is coordinator-derived, not EA-authored.',
  };
}

function deriveRpoExecution(structure) {
  if (!structure?.available || !structure.classification?.rpo) return null;
  const attachments = structure.routeTargets.filter(target => {
    const text = norm([target.routeFamily, target.routeType, target.assignmentName].filter(Boolean).join(' '));
    return /slant|glance|post|bubble|screen|flat|out|stick/.test(text);
  });
  const targets = attachments.length ? attachments : structure.routeTargets;
  const ambiguous = targets.length !== 1;
  const reads = targets.map((target, index) => targetRead(
    target,
    index + 1,
    'If the conflict defender inserts into the run fit, throw the attached EA-authored route into the space he vacates.'
  ));
  reads.push({
    number: String(reads.length + 1),
    button: null,
    label: 'give',
    detail: 'If the conflict defender stays with the pass attachment, give the run. Exact live defender identity requires player tracking.',
    timing: null,
    assignmentId: null,
    assignmentName: null,
    playerIndex: null,
    playerLabel: null,
  });
  return {
    available: targets.length > 0 && structure.classification.qbActions.includes('ID_HANDOFF_OPTION'),
    status: targets.length ? 'derived_structural' : 'insufficient_assignment_geometry',
    provenance: PROVENANCE.DERIVED_STRUCTURAL,
    mode: 'rpo',
    relationship: 'run_pass_conflict',
    keyDefenderRole: 'run/pass conflict defender (LB or overhang depending on attachment)',
    ambiguous,
    reads,
    alert: null,
    outlet: null,
    timingCalibrated: false,
    warning: 'RPO decision is coordinator-derived from EA-authored handoff-option and pass-attachment assignments; exact conflict-defender identity is not known without player tracking.',
  };
}


module.exports = {
  PROVENANCE,
  buildAuthoritativePlayStructure,
  deriveRunExecution,
  deriveScreenExecution,
  deriveRpoExecution,
  authoritativeReceiverRows,
  friendlyEnum,
  laneFromGap,
};
