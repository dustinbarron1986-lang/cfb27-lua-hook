'use strict';

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function translateRoute(route, start = {}) {
  if (!route?.points?.length) return null;
  const sx = finite(start.x, 0);
  const sy = finite(start.y, 0);
  return {
    source: 'ea_assignment_geometry',
    routeFamily: route.routeFamily || null,
    start: { x: sx, y: sy },
    points: route.points.map(point => ({
      ...point,
      relativeX: finite(point.x, 0),
      relativeY: finite(point.y, 0),
      x: Number((sx + finite(point.x, 0)).toFixed(3)),
      y: Number((sy + finite(point.y, 0)).toFixed(3)),
    })),
    segments: (route.segments || []).map(segment => ({
      ...segment,
      from: {
        x: Number((sx + finite(segment.from?.x, 0)).toFixed(3)),
        y: Number((sy + finite(segment.from?.y, 0)).toFixed(3)),
      },
      to: {
        x: Number((sx + finite(segment.to?.x, 0)).toFixed(3)),
        y: Number((sy + finite(segment.to?.y, 0)).toFixed(3)),
      },
    })),
    events: route.events || [],
    motion: route.motion || [],
    optionRoutes: route.optionRoutes || [],
    totalDistance: route.totalDistance ?? null,
    movementCost: route.movementCost ?? null,
    delayUnits: route.delayUnits ?? null,
    maxDepth: route.maxDepth ?? null,
  };
}

function buildPassingPlayArt(receivers = []) {
  const targets = [];
  for (const receiver of receivers || []) {
    const route = receiver?.eaAssignment?.semantics?.route || receiver?.assignmentRoute || null;
    const translated = translateRoute(route, { x: receiver?.x, y: receiver?.y });
    if (!translated) continue;
    targets.push({
      button: receiver.button || null,
      assignmentId: receiver.eaAssignment?.positionAssignId ?? null,
      legacyAssignmentId: receiver.assignment ?? null,
      assignmentName: receiver.eaAssignment?.shortName || receiver.assignmentName || null,
      routeType: receiver.eaAssignment?.routeType || receiver.assignmentRouteType || null,
      routeFamily: translated.routeFamily,
      geometry: translated,
    });
  }
  return {
    source: targets.length ? 'ea_assignment_geometry' : 'unavailable',
    exactAssignmentCount: targets.length,
    targets,
    timingCalibrated: false,
    timingNote: targets.length
      ? 'Route distances/directions are decoded from EA assignments; movementCost is relative and is not calibrated to seconds yet.'
      : null,
  };
}

module.exports = { translateRoute, buildPassingPlayArt };
