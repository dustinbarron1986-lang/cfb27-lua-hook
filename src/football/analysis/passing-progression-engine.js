'use strict';

function norm(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const MATURITY_ORDER = Object.freeze({ immediate: 0, quick: 1, early: 2, intermediate: 3, late: 4, ambiguous: 99 });

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function maturityOrdinal(bucket) {
  return MATURITY_ORDER[bucket] ?? MATURITY_ORDER.ambiguous;
}

function relativeCostBucket(value) {
  const n = finiteOrNull(value);
  if (n == null) return null;
  if (n <= 2.5) return 'immediate';
  if (n <= 5) return 'quick';
  if (n <= 8) return 'early';
  if (n <= 14) return 'intermediate';
  return 'late';
}

function relativeDepthBucket(value) {
  const n = finiteOrNull(value);
  if (n == null) return null;
  if (n <= 3) return 'immediate';
  if (n <= 6) return 'quick';
  if (n <= 9) return 'early';
  if (n <= 15) return 'intermediate';
  return 'late';
}

function shiftBucketLater(bucket, delayed) {
  if (!delayed || !bucket || bucket === 'ambiguous') return bucket;
  const order = ['immediate', 'quick', 'early', 'intermediate', 'late'];
  const index = order.indexOf(bucket);
  return index < 0 ? bucket : order[Math.min(order.length - 1, index + 1)];
}

function segmentAfterCut(route, cut) {
  if (!cut) return null;
  const cutOrder = finiteOrNull(cut.order);
  if (cutOrder == null) return null;
  return (route?.segments || [])
    .filter(segment => finiteOrNull(segment.order) != null && Number(segment.order) > cutOrder)
    .sort((a, b) => Number(a.order) - Number(b.order))[0] || null;
}

function reconstructedCutState(route, cut) {
  const cutOrder = finiteOrNull(cut?.order);
  if (cutOrder == null) return {
    distanceAtCut: finiteOrNull(cut?.distanceAtCut),
    movementCostAtCut: finiteOrNull(cut?.movementCostAtCut),
    delayUnitsAtCut: finiteOrNull(cut?.delayUnitsAtCut),
  };

  const priorSegments = (route?.segments || []).filter(segment => {
    const order = finiteOrNull(segment.order);
    return order != null && order < cutOrder;
  });
  const priorDelays = (route?.events || []).filter(event => {
    const order = finiteOrNull(event.order);
    return event?.type === 'delay' && order != null && order < cutOrder;
  });

  const reconstructedDistance = priorSegments.reduce((sum, segment) => sum + (finiteOrNull(segment.distance) ?? 0), 0);
  const reconstructedMovementCost = priorSegments.reduce((sum, segment) => {
    const distance = finiteOrNull(segment.distance) ?? 0;
    const speed = Math.max(1, finiteOrNull(segment.speed) ?? 100);
    return sum + distance * (100 / speed);
  }, 0);
  const reconstructedDelay = priorDelays.reduce((sum, event) => sum + (finiteOrNull(event.time) ?? 0), 0);

  return {
    distanceAtCut: finiteOrNull(cut?.distanceAtCut) ?? Number(reconstructedDistance.toFixed(3)),
    movementCostAtCut: finiteOrNull(cut?.movementCostAtCut) ?? Number(reconstructedMovementCost.toFixed(3)),
    delayUnitsAtCut: finiteOrNull(cut?.delayUnitsAtCut) ?? Number(reconstructedDelay.toFixed(3)),
  };
}

function primaryMeaningfulCut(route) {
  const cuts = (route?.events || []).filter(event => event?.type === 'cut')
    .sort((a, b) => (finiteOrNull(a.order) ?? 0) - (finiteOrNull(b.order) ?? 0));
  const optionAmbiguous = Boolean(route?.optionRoutes?.length || (route?.events || []).some(event => event?.type === 'option_route'));
  if (optionAmbiguous) return { cut: null, ambiguous: true, reason: 'option_route_branch_unknown' };
  if (!cuts.length) return { cut: null, ambiguous: false, reason: 'no_authored_cut' };
  const withPayoffSegment = cuts.filter(cut => segmentAfterCut(route, cut));
  const cut = (withPayoffSegment.length ? withPayoffSegment : cuts).at(-1) || null;
  return { cut, ambiguous: false, reason: cut ? 'final_meaningful_authored_cut' : 'no_meaningful_cut' };
}

function delayBeforeFirstMovement(route) {
  const firstOrder = (route?.segments || []).map(segment => finiteOrNull(segment.order))
    .filter(order => order != null).sort((a, b) => a - b)[0];
  if (firstOrder == null) return false;
  return (route?.events || []).some(event =>
    event?.type === 'delay' && finiteOrNull(event.order) != null &&
    Number(event.order) < firstOrder && (finiteOrNull(event.time) ?? 0) > 0
  );
}

function deriveRouteMaturity(target) {
  const route = target?.geometry || target?.eaAssignment?.semantics?.route || null;
  if (!route) return { bucket: 'ambiguous', source: 'missing_geometry', ambiguous: true, primaryBreak: null };

  const raw = norm(target?.routeFamily || route?.routeFamily || target?.routeType || '');
  const optionAmbiguous = Boolean(route?.optionRoutes?.length || (route?.events || []).some(event => event?.type === 'option_route'));

  if (/screen/.test(raw)) return { bucket: 'quick', source: 'screen_release', ambiguous: false, primaryBreak: null, relativeCost: null };
  if (optionAmbiguous) return {
    bucket: 'ambiguous', source: 'option_route_branch', ambiguous: true,
    reason: 'actual option branch is not known pre-snap', primaryBreak: null, relativeCost: null,
  };

  if (/flat|swing|arrow/.test(raw)) {
    const base = relativeDepthBucket(route.maxDepth) || 'quick';
    return {
      bucket: shiftBucketLater(base === 'intermediate' || base === 'late' ? 'quick' : base, delayBeforeFirstMovement(route)),
      source: 'release_shallow_window', ambiguous: false, primaryBreak: null, relativeCost: null,
    };
  }

  if (/streak|vertical|seam|go/.test(raw)) return {
    bucket: shiftBucketLater(relativeDepthBucket(route.maxDepth) || 'intermediate', delayBeforeFirstMovement(route)),
    source: 'depth_window', ambiguous: false, primaryBreak: null, relativeCost: null,
  };

  const primary = primaryMeaningfulCut(route);
  if (primary.cut) {
    const snapshot = reconstructedCutState(route, primary.cut);
    const relativeCost = snapshot.movementCostAtCut ?? snapshot.distanceAtCut;
    return {
      bucket: shiftBucketLater(relativeCostBucket(relativeCost) || relativeDepthBucket(primary.cut.y) || 'intermediate', (snapshot.delayUnitsAtCut ?? 0) > 0),
      source: primary.reason, ambiguous: false, primaryBreak: { ...primary.cut, ...snapshot }, relativeCost,
    };
  }

  if (/drag|shallow|cross/.test(raw)) return {
    bucket: shiftBucketLater(relativeDepthBucket(route.maxDepth) || 'early', delayBeforeFirstMovement(route)),
    source: 'crossing_space_depth', ambiguous: false, primaryBreak: null, relativeCost: null,
  };

  const fallbackCost = finiteOrNull(route.movementCost);
  return {
    bucket: shiftBucketLater(relativeCostBucket(fallbackCost) || relativeDepthBucket(route.maxDepth) || 'intermediate', delayBeforeFirstMovement(route)),
    source: fallbackCost == null ? 'depth_fallback' : 'whole_route_fallback',
    ambiguous: false, primaryBreak: null, relativeCost: fallbackCost,
  };
}

function deriveFootballRoute(target, maturity) {
  const route = target?.geometry || target?.eaAssignment?.semantics?.route || null;
  const raw = norm(target?.routeFamily || route?.routeFamily || target?.routeType || '');
  if (!/post|corner/.test(raw)) return { label: null, ambiguous: false, reason: 'not_post_corner_family' };
  if (maturity?.ambiguous || !maturity?.primaryBreak) return { label: null, ambiguous: true, reason: maturity?.reason || 'primary_break_unavailable' };

  const segment = segmentAfterCut(route, maturity.primaryBreak);
  if (!segment) return { label: null, ambiguous: true, reason: 'post_cut_segment_unavailable' };

  const startX = finiteOrNull(target?.startX ?? route?.start?.x) ?? 0;
  const cutX = startX + (finiteOrNull(maturity.primaryBreak.x) ?? 0);
  const fromX = finiteOrNull(segment.from?.x);
  const toX = finiteOrNull(segment.to?.x);
  const dx = fromX == null || toX == null ? null : toX - fromX;

  if (Math.abs(cutX) < 1.5) return { label: null, ambiguous: true, reason: 'primary_break_near_centerline', cutX, dx };
  if (dx == null || Math.abs(dx) < 0.75) return { label: null, ambiguous: true, reason: 'post_cut_lateral_movement_negligible', cutX, dx };

  const towardCenter = cutX * dx < 0;
  return {
    label: towardCenter ? 'Post' : 'Corner',
    ambiguous: false,
    reason: towardCenter ? 'primary_break_moves_toward_field_center' : 'primary_break_moves_away_from_field_center',
    cutX, dx,
  };
}

function titleRoute(value) {
  return String(value || 'route').replace(/^AssignRouteType_/i, '').replace(/^RR_/i, '')
    .replaceAll('_', ' ').trim().replace(/\b\w/g, char => char.toUpperCase());
}

function throwCue(item) {
  const traits = item?.traits?.traits || new Set();
  const maturity = item?.traits?.maturity || {};
  if (maturity.ambiguous) return 'branch-dependent; confirm the receiver break before committing';
  if (traits.has('flat')) return 'throw immediately after the release when leverage gives the flat';
  if (traits.has('stop')) return 'anticipate the final stop/return break rather than waiting for the route to finish';
  if (traits.has('dig') || (traits.has('in_break') && !traits.has('post'))) return 'anticipate the final inside break';
  if (traits.has('post')) return 'anticipate the break once safety leverage declares';
  if (traits.has('corner') || traits.has('out')) return 'anticipate the final outside break';
  if (traits.has('vertical')) return 'throw when depth and leverage create the window; do not wait for route completion';
  if (traits.has('cross')) return 'lead the receiver into crossing space as leverage clears';
  return maturity.primaryBreak ? 'anticipate the final meaningful break' : 'use the relative development window; do not wait for the full authored path to complete';
}

function routeTraits(target) {
  const route = target?.geometry || target?.eaAssignment?.semantics?.route || null;
  const raw = norm(target?.routeFamily || route?.routeFamily || target?.routeType || '');
  const traits = new Set();
  const add = (...names) => names.forEach(name => traits.add(name));

  if (/drag|shallow|cross/.test(raw)) add('cross', 'underneath');
  if (/slant|glance/.test(raw)) add('slant', 'in_break', 'quick');
  if (/dig|in_middle|deep_in|in_route|in$/.test(raw)) add('dig', 'in_break', 'intermediate');
  if (/post/.test(raw)) add('post', 'in_break', 'deep');
  if (/corner/.test(raw)) add('corner', 'out_break', 'deep');
  if (/out/.test(raw)) add('out', 'out_break');
  if (/flat|swing|arrow/.test(raw)) add('flat', 'underneath', 'quick');
  if (/curl|hook|hitch|comeback|stick/.test(raw)) add('stop', 'underneath');
  if (/streak|vertical|seam|go/.test(raw)) add('vertical', 'deep');
  if (/wheel/.test(raw)) add('wheel', 'deep');
  if (/whip|pivot|choice|option/.test(raw)) add('choice', 'separator');
  if (/screen/.test(raw)) add('screen', 'quick');

  const depth = finiteOrNull(route?.maxDepth);
  if (depth != null) {
    if (depth <= 6) add('underneath');
    else if (depth <= 14) add('intermediate');
    else add('deep');
  }

  const maturity = deriveRouteMaturity(target);
  if (['immediate', 'quick', 'early'].includes(maturity.bucket)) add('early');
  else if (maturity.bucket === 'intermediate') add('middle_timing');
  else if (maturity.bucket === 'late') add('late');

  const footballRoute = deriveFootballRoute(target, maturity);
  if (footballRoute.label === 'Post') {
    traits.delete('corner'); traits.delete('out_break'); add('post', 'in_break', 'deep');
  } else if (footballRoute.label === 'Corner') {
    traits.delete('post'); traits.delete('in_break'); add('corner', 'out_break', 'deep');
  }

  return {
    raw, rawEaRouteType: target?.routeType || null, traits, depth,
    cost: maturity.relativeCost ?? finiteOrNull(route?.movementCost),
    maturity, derivedFootballRoute: footballRoute.label, footballRouteEvidence: footballRoute,
  };
}

const COVERAGE_FIT = {
  cover_0: { cross: 4, slant: 3, choice: 4, separator: 3, underneath: 1, vertical: 1, late: -3 },
  cover_1: { cross: 4, choice: 3, slant: 2, separator: 3, dig: 1, vertical: 1, late: -1 },
  cover_2: { vertical: 3, post: 3, dig: 2, corner: 3, flat: 1, intermediate: 2, deep: 1 },
  cover_2_man: { cross: 4, choice: 3, underneath: 2, slant: 2, deep: -1, late: -2 },
  cover_3: { dig: 4, in_break: 3, flat: 2, vertical: 2, intermediate: 2, corner: -1, late: -1 },
  cover_4: { underneath: 4, cross: 3, stop: 3, dig: 2, deep: -3, late: -2 },
  cover_6: { underneath: 3, dig: 2, cross: 2, stop: 2, deep: -1 },
};

function scoreTarget(target, coverage, pressure) {
  const traits = routeTraits(target);
  const fit = COVERAGE_FIT[coverage] || {};
  let score = 0;
  const reasons = [];
  for (const trait of traits.traits) score += Number(fit[trait] || 0);

  if (traits.traits.has('early')) score += 1.2;
  if (traits.traits.has('middle_timing')) score += 0.4;
  if (traits.traits.has('late')) score -= 0.3;
  if (pressure) {
    if (traits.traits.has('quick') || traits.traits.has('underneath') || traits.traits.has('early')) score += 3;
    if (traits.traits.has('late') || traits.traits.has('deep')) score -= 4;
  }

  if (coverage && Object.keys(fit).length) {
    const strongest = [...traits.traits].map(trait => [trait, Number(fit[trait] || 0)]).sort((a, b) => b[1] - a[1])[0];
    if (strongest?.[1] > 0) reasons.push(`${strongest[0].replaceAll('_', ' ')} structure fits ${coverage.replaceAll('_', ' ')}`);
  }
  if (pressure && (traits.traits.has('quick') || traits.traits.has('underneath') || traits.traits.has('early'))) reasons.push('develops early enough to be a pressure answer');
  if (pressure && (traits.traits.has('late') || traits.traits.has('deep'))) reasons.push('de-emphasized because pressure can arrive before the route develops');

  return { score, traits, reasons, timing: traits.maturity.bucket || 'ambiguous' };
}

function friendlyRoute(target, traits = routeTraits(target)) {
  if (traits?.derivedFootballRoute) return traits.derivedFootballRoute;
  const raw = target?.routeFamily || target?.routeType || target?.assignmentName || 'route';
  return titleRoute(raw);
}

function sideOf(target) {
  const x = Number(target?.startX ?? target?.geometry?.start?.x);
  if (!Number.isFinite(x) || Math.abs(x) < 1) return 'middle';
  return x < 0 ? 'left' : 'right';
}

function enrichedTargets(targets, coverage, pressure) {
  return targets.map(target => ({
    target,
    side: sideOf(target),
    ...scoreTarget(target, coverage, pressure),
  }));
}

function firstWith(items, trait) {
  return items.find(item => item.traits.traits.has(trait)) || null;
}

function sameSide(items, side) {
  return items.filter(item => item.side === side || item.side === 'middle');
}

function detectRelationship(items) {
  const left = items.filter(item => item.side === 'left');
  const right = items.filter(item => item.side === 'right');
  for (const group of [left, right]) {
    const side = group[0]?.side;
    if (!side) continue;
    const flat = firstWith(group, 'flat');
    const outBreaker = group.find(item => item.traits.traits.has('out_break') && !item.traits.traits.has('flat'));
    const deep = group.find(item => item !== outBreaker && item !== flat && item.traits.traits.has('deep'));
    if (flat && outBreaker && deep) {
      return { family: 'flood', keyDefender: 'curl-flat / overhang defender', order: [flat, outBreaker, deep] };
    }

    const stop = firstWith(group, 'stop');
    const corner = firstWith(group, 'corner');
    if (stop && corner) return { family: 'smash', keyDefender: 'corner/flat defender', order: [stop, corner] };

    if (flat && stop) return { family: 'stick_flat', keyDefender: 'flat / overhang defender', order: [flat, stop] };
  }

  const crossers = items.filter(item => item.traits.traits.has('cross'));
  if (crossers.length >= 2 && new Set(crossers.map(item => item.side)).size >= 2) {
    return { family: 'mesh', keyDefender: 'first underneath defender carrying a crosser', order: crossers };
  }

  const shallow = crossers.find(item => item.traits.traits.has('underneath'));
  const dig = firstWith(items, 'dig');
  if (shallow && dig) return { family: 'drive', keyDefender: 'hook/curl defender between the shallow and dig', order: [shallow, dig] };

  const vertical = firstWith(items, 'vertical');
  if (vertical && dig) return { family: 'dagger', keyDefender: 'inside hook/safety leverage on the dig', order: [dig, vertical] };

  const inBreaks = items.filter(item => item.traits.traits.has('in_break'));
  if (inBreaks.length >= 2) {
    const depths = inBreaks.map(item => item.traits.depth ?? 0).sort((a, b) => a - b);
    if ((depths.at(-1) || 0) - (depths[0] || 0) >= 4) {
      return { family: 'levels', keyDefender: 'inside hook defender stretched between levels', order: [...inBreaks].sort((a,b)=>(a.traits.depth??0)-(b.traits.depth??0)) };
    }
  }

  return null;
}

function outletCandidate(items, used = new Set()) {
  return items.filter(item => !used.has(item))
    .filter(item => item.traits.traits.has('underneath') || item.traits.traits.has('flat'))
    .sort((a, b) => maturityOrdinal(a.traits.maturity?.bucket) - maturityOrdinal(b.traits.maturity?.bucket))[0] || null;
}

function alertCandidate(items, used = new Set()) {
  const counts = items.reduce((map, item) => map.set(item.side, (map.get(item.side) || 0) + 1), new Map());
  return items
    .filter(item => !used.has(item))
    .filter(item => item.traits.traits.has('deep') || item.traits.traits.has('post') || item.traits.traits.has('vertical'))
    .find(item => item.side !== 'middle' && counts.get(item.side) === 1) || null;
}

function readRow(item, index, relationship) {
  const window = item.timing || 'ambiguous';
  const coaching = `WINDOW: ${window}. THROW: ${throwCue(item)}.`;
  const context = item.reasons.length ? ` ${item.reasons.join('; ')}.` : '';
  return {
    number: String(index + 1), button: item.target.button || null,
    label: friendlyRoute(item.target, item.traits), detail: `${coaching}${context}`.trim(),
    score: Number(item.score.toFixed(3)), timing: window,
    maturitySource: item.traits.maturity?.source || null,
    maturityAmbiguous: Boolean(item.traits.maturity?.ambiguous),
    primaryBreakOrder: item.traits.maturity?.primaryBreak?.order ?? null,
    rawEaRouteType: item.traits.rawEaRouteType || null,
    derivedFootballRoute: item.traits.derivedFootballRoute || null,
    assignmentId: item.target.assignmentId ?? null,
    assignmentName: item.target.assignmentName || null,
    playerIndex: item.target.playerIndex ?? null,
    playerLabel: item.target.playerLabel || null,
    relationship: relationship || null,
  };
}

function deriveStructuralProgression({ playArt, coverage = null, pressure = false } = {}) {
  const targets = playArt?.targets || [];
  if (targets.length < 2) {
    return {
      available: false,
      status: 'insufficient_assignment_geometry',
      reads: [],
      coverage: coverage || null,
      pressure: Boolean(pressure),
    };
  }

  const items = enrichedTargets(targets, coverage, pressure);
  const relationship = detectRelationship(items);
  let ordered;

  if (relationship) {
    const structural = relationship.order.filter(Boolean);
    const used = new Set(structural);
    const remainder = items
      .filter(item => !used.has(item))
      .sort((a, b) => b.score - a.score || maturityOrdinal(a.traits.maturity?.bucket) - maturityOrdinal(b.traits.maturity?.bucket));
    ordered = [...structural, ...remainder];
  } else {
    ordered = [...items].sort((a, b) => b.score - a.score || maturityOrdinal(a.traits.maturity?.bucket) - maturityOrdinal(b.traits.maturity?.bucket));
  }

  const used = new Set((relationship?.order || []).filter(Boolean));
  const outlet = outletCandidate(items, used);
  const alert = alertCandidate(items, used);
  const reads = ordered.map((item, index) => readRow(item, index, relationship?.family || null));

  return {
    available: true,
    status: 'derived_structural',
    provenance: 'coordinator_derived_from_ea_assignments',
    relationship: relationship?.family || (items.length >= 3 ? 'multi_route_structure' : 'two_route_structure'),
    keyDefenderRole: relationship?.keyDefender || 'defender whose leverage changes the relationship between the first two routes',
    alert: alert ? {
      label: friendlyRoute(alert.target, alert.traits),
      assignmentId: alert.target.assignmentId ?? null,
      assignmentName: alert.target.assignmentName || null,
      playerIndex: alert.target.playerIndex ?? null,
      playerLabel: alert.target.playerLabel || null,
    } : null,
    outlet: outlet ? {
      label: friendlyRoute(outlet.target, outlet.traits),
      assignmentId: outlet.target.assignmentId ?? null,
      assignmentName: outlet.target.assignmentName || null,
      playerIndex: outlet.target.playerIndex ?? null,
      playerLabel: outlet.target.playerLabel || null,
    } : null,
    coverage: coverage || null,
    pressure: Boolean(pressure),
    timingCalibrated: false,
    ambiguous: !relationship || items.some(item => item.traits.maturity?.ambiguous),
    reads,
    warning: 'Coordinator-derived structural read order from EA-authored assignments; this is not an EA-authored progression. Route timing is relative until telemetry calibration is complete.',
  };
}

module.exports = { deriveStructuralProgression, deriveRouteMaturity, deriveFootballRoute, routeTraits, scoreTarget, detectRelationship };
