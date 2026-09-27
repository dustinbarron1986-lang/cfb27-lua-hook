'use strict';

function number(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function refValue(value) {
  if (value && typeof value === 'object' && typeof value.ref === 'string') return value.ref;
  return typeof value === 'string' ? value : null;
}

function routeFamily(routeType) {
  const raw = String(routeType || '');
  return raw
    .replace(/^AssignRouteType_/, '')
    .replace(/^RR_/, '')
    .replace(/^RB_/, 'RB_')
    .toLowerCase() || null;
}

function directionVector(degrees, distance) {
  const rad = number(degrees, 0) * Math.PI / 180;
  const d = number(distance, 0);
  return { dx: Math.cos(rad) * d, dy: Math.sin(rad) * d };
}

function waypointPosition(waypoint) {
  const pos = waypoint?.position;
  if (!pos || typeof pos !== 'object') return null;
  return { x: number(pos.x, 0), y: number(pos.y, 0) };
}

function optionBranches(action) {
  const rows = action?.arrays?.optionRouteInfo || [];
  return rows.map(row => ({
    asset: refValue(row?.OptionRouteAsset),
    partitionGuid: row?.OptionRouteAsset?.partitionGuid || null,
    optionRouteId: row?.optionRouteId || null,
    coverage: row?.optionRouteCoverage ?? null,
  }));
}

function deriveRouteGeometry(record) {
  let x = 0;
  let y = 0;
  let totalDistance = 0;
  let movementCost = 0;
  let delayUnits = 0;
  const points = [{ x: 0, y: 0, kind: 'start' }];
  const segments = [];
  const events = [];
  const motion = [];
  const optionRoutes = [];

  for (const action of record.actions || []) {
    const f = action.fields || {};
    if (action.opcode === 'ID_RUNROUTE' || action.type === 'RunRouteAssignment') {
      const distance = number(f.distance, 0);
      const direction = number(f.direction, 0);
      const speed = number(f.speed, 100) || 100;
      const { dx, dy } = directionVector(direction, distance);
      const from = { x, y };
      x += dx;
      y += dy;
      totalDistance += distance;
      movementCost += distance * (100 / Math.max(1, speed));
      const to = { x, y };
      segments.push({ order: action.order, from, to, distance, direction, speed });
      points.push({ ...to, kind: 'route', order: action.order });
      continue;
    }
    if (action.opcode === 'ID_RECCUT' || action.type === 'ReceiverCutAssignment') {
      events.push({ order: action.order, type: 'cut', x, y, direction: f.direction || null, cutType: f.cutType || null });
      continue;
    }
    if (action.opcode === 'ID_DELAY' || action.type === 'DelayAssignment') {
      const time = number(f.time, 0);
      delayUnits += time;
      events.push({ order: action.order, type: 'delay', x, y, time });
      continue;
    }
    if (action.opcode === 'ID_RECGETOPEN' || action.type === 'GetOpenAssignment') {
      events.push({ order: action.order, type: 'get_open', x, y });
      continue;
    }
    if (action.opcode === 'ID_PASSBLOCK' || action.type === 'PassBlockAssignment') {
      events.push({ order: action.order, type: 'pass_block', x, y, time: number(f.time, 0), flags: f.flags || null });
      continue;
    }
    if (action.opcode === 'ID_OPTIONROUTE' || action.type === 'OptionRouteAssignment') {
      const branches = optionBranches(action);
      optionRoutes.push(...branches.map(branch => ({ ...branch, order: action.order, x, y })));
      events.push({ order: action.order, type: 'option_route', x, y, branches });
      continue;
    }
    if (action.opcode === 'ID_AUTOMOTION' || action.type === 'AutoMotionAssignment') {
      const waypoints = (action.arrays?.waypoints || []).map(waypoint => ({
        position: waypointPosition(waypoint),
        transitID: waypoint?.transitID ?? null,
        speed: number(waypoint?.speed, null),
        facingAngle: number(waypoint?.facingAngle, null),
        locoStyle: waypoint?.locoStyle || null,
        shouldFaceEndPoint: waypoint?.shouldFaceEndPoint ?? null,
      })).filter(row => row.position);
      motion.push({
        order: action.order,
        startEvent: f.startEvent || null,
        startDelay: number(f.startDelay, 0),
        endDelay: number(f.endDelay, 0),
        waypoints,
      });
    }
  }

  if (!segments.length && !motion.length && !optionRoutes.length) return null;
  return {
    routeFamily: routeFamily(record.routeType),
    points,
    segments,
    events,
    motion,
    optionRoutes,
    totalDistance: Number(totalDistance.toFixed(3)),
    movementCost: Number(movementCost.toFixed(3)),
    delayUnits: Number(delayUnits.toFixed(3)),
    finalPoint: { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) },
    maxDepth: Number(Math.max(0, ...points.map(point => point.y)).toFixed(3)),
  };
}

function deriveBlocking(record) {
  const passBlocks = [];
  const leadBlocks = [];
  const runBlocks = [];
  const movements = [];
  for (const action of record.actions || []) {
    const f = action.fields || {};
    if (action.opcode === 'ID_PASSBLOCK' || action.type === 'PassBlockAssignment') {
      passBlocks.push({ order: action.order, time: number(f.time, 0), flags: f.flags || null });
    } else if (action.opcode === 'ID_LEADBLOCK' || action.type === 'LeadBlockAssignment') {
      leadBlocks.push({ order: action.order, technique: f.blockingTechnique || null, gap: f.blockingGap || null });
    } else if (action.opcode === 'ID_RUNBLOCK' || action.type === 'RunBlockAssignment') {
      runBlocks.push({
        order: action.order,
        flags: f.flags || null,
        receiverBlockType: f.receiverBlockType || null,
        time: number(f.time, 0),
      });
    } else if (action.opcode === 'ID_MOVEDIRDIST' || action.opcode === 'ID_MOVEDIRDISTCONST' || action.type === 'MoveDirectionAssignment') {
      movements.push({
        order: action.order,
        distance: number(f.distance, null),
        direction: number(f.direction, null),
        speed: number(f.speed, null),
      });
    }
  }
  if (!passBlocks.length && !leadBlocks.length && !runBlocks.length) return null;
  return {
    passBlocks,
    leadBlocks,
    runBlocks,
    movements,
    designedGaps: [...new Set(leadBlocks.map(block => block.gap).filter(Boolean))],
    techniques: [...new Set(leadBlocks.map(block => block.technique).filter(Boolean))],
  };
}

function alignmentRows(action) {
  const f = action.fields || {};
  const rows = (action.arrays?.positionAlignments || []).map(row => ({
    depth: number(row?.depth, null),
    position: row?.position || null,
    technique: row?.technique || null,
  }));
  if (f.position || f.technique || f.alignment != null) {
    rows.push({
      depth: null,
      position: f.position || null,
      technique: f.technique || null,
      alignment: number(f.alignment, null),
    });
  }
  return rows;
}

function deriveDefense(record) {
  const zones = [];
  const man = [];
  const rush = [];
  const alignments = [];
  const disguise = [];
  for (const action of record.actions || []) {
    const f = action.fields || {};
    switch (action.opcode) {
      case 'ID_HOOKZONE':
        zones.push({ order: action.order, family: 'hook', zone: f.hookZone || null, strategy: f.ZoneStrategy || null });
        break;
      case 'ID_CURLFLATZONE':
        zones.push({ order: action.order, family: 'curl_flat', zone: f.curlFlatZone || null, strategy: f.ZoneStrategy || null });
        break;
      case 'ID_DEEPZONE':
        zones.push({ order: action.order, family: 'deep', zone: f.deepZone || null, strategy: f.ZoneStrategy || null });
        break;
      case 'ID_FLATZONE':
        zones.push({ order: action.order, family: 'flat', zone: f.flatZone || null, strategy: f.ZoneStrategy || null });
        break;
      case 'ID_MANCOVERAGE':
        man.push({
          order: action.order,
          coverMan: f.coverMan || null,
          shading: number(f.shading, null),
          bracketPlayPos: f.bracketPlayPos || null,
          bracketFieldSide: f.bracketFieldSide || null,
          bracketDepthPos: f.bracketDepthPos || null,
          bracketTechnique: f.bracketTechnique || null,
          bracketType: f.bracketType || null,
          bracketSide: f.bracketSide || null,
        });
        break;
      case 'ID_PASSRUSH':
        rush.push({
          order: action.order,
          gap: f.gap || null,
          loopGap: f.loopGap || null,
          direction: number(f.direction, null),
          distance: number(f.distance, null),
          readBlitzBlocker: f.readBlitzBlocker || null,
          readBlitzZoneNum: f.readBlitzZoneNum || null,
          stuntPartner: number(f.stuntPartner, null),
          isJetRush: Boolean(f.isJetRush),
          isLooper: Boolean(f.isLooper),
          isReadBlitz: Boolean(f.isReadBlitz),
          hasStuntData: Boolean(f.hasStuntData),
        });
        break;
      case 'ID_DEFALIGNMENT':
        alignments.push(...alignmentRows(action).map(row => ({ ...row, order: action.order })));
        break;
      case 'ID_SHOWBLITZ':
        disguise.push({ order: action.order, type: 'show_blitz', percentage: number(f.percentage, null) });
        break;
      default:
        break;
    }
  }
  if (!zones.length && !man.length && !rush.length && !alignments.length && !disguise.length) return null;
  return { zones, man, rush, alignments, disguise };
}

function deriveAssignmentSemantics(record) {
  return {
    route: deriveRouteGeometry(record),
    blocking: deriveBlocking(record),
    defense: deriveDefense(record),
  };
}

module.exports = {
  deriveAssignmentSemantics,
  deriveRouteGeometry,
  deriveBlocking,
  deriveDefense,
  routeFamily,
  directionVector,
};
