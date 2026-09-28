'use strict';

function norm(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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

  const depth = Number(route?.maxDepth ?? 0);
  const cost = Number(route?.movementCost ?? 0);
  if (Number.isFinite(depth)) {
    if (depth <= 6) add('underneath');
    else if (depth <= 14) add('intermediate');
    else add('deep');
  }
  if (Number.isFinite(cost)) {
    if (cost <= 6) add('early');
    else if (cost <= 14) add('middle_timing');
    else add('late');
  }
  return { raw, traits, depth: Number.isFinite(depth) ? depth : null, cost: Number.isFinite(cost) ? cost : null };
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
    if (traits.traits.has('quick') || traits.traits.has('underneath')) score += 3;
    if (traits.traits.has('late') || traits.traits.has('deep')) score -= 4;
  }

  if (coverage && Object.keys(fit).length) {
    const strongest = [...traits.traits]
      .map(trait => [trait, Number(fit[trait] || 0)])
      .sort((a, b) => b[1] - a[1])[0];
    if (strongest?.[1] > 0) reasons.push(`${strongest[0].replaceAll('_', ' ')} structure fits ${coverage.replaceAll('_', ' ')}`);
  }
  if (pressure && (traits.traits.has('quick') || traits.traits.has('underneath'))) {
    reasons.push('develops early enough to be a pressure answer');
  }
  if (pressure && (traits.traits.has('late') || traits.traits.has('deep'))) {
    reasons.push('de-emphasized because pressure can arrive before the route develops');
  }

  const timing = traits.traits.has('early') ? 'early' : traits.traits.has('late') ? 'late' : 'intermediate';
  return { score, traits, reasons, timing };
}

function friendlyRoute(target) {
  const raw = target?.routeFamily || target?.routeType || target?.assignmentName || 'route';
  return String(raw).replace(/^AssignRouteType_/i, '').replace(/^RR_/i, '').replaceAll('_', ' ').trim();
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
  return items
    .filter(item => !used.has(item))
    .filter(item => item.traits.traits.has('underneath') || item.traits.traits.has('flat'))
    .sort((a, b) => (a.traits.cost ?? 999) - (b.traits.cost ?? 999))[0] || null;
}

function alertCandidate(items, used = new Set()) {
  const counts = items.reduce((map, item) => map.set(item.side, (map.get(item.side) || 0) + 1), new Map());
  return items
    .filter(item => !used.has(item))
    .filter(item => item.traits.traits.has('deep') || item.traits.traits.has('post') || item.traits.traits.has('vertical'))
    .find(item => item.side !== 'middle' && counts.get(item.side) === 1) || null;
}

function readRow(item, index, relationship) {
  return {
    number: String(index + 1),
    button: item.target.button || null,
    label: `${friendlyRoute(item.target)} — ${item.timing} window`,
    detail: item.reasons.length
      ? item.reasons.join('; ')
      : `${relationship ? relationship.replaceAll('_', ' ') + ' structural' : 'structural'} ${item.timing} read from decoded EA route geometry`,
    score: Number(item.score.toFixed(3)),
    timing: item.timing,
    assignmentId: item.target.assignmentId ?? null,
    assignmentName: item.target.assignmentName || null,
    playerIndex: item.target.playerIndex ?? null,
    playerLabel: item.target.playerLabel || null,
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
      .sort((a, b) => b.score - a.score || (a.traits.cost ?? 999) - (b.traits.cost ?? 999));
    ordered = [...structural, ...remainder];
  } else {
    ordered = [...items].sort((a, b) => b.score - a.score || (a.traits.cost ?? 999) - (b.traits.cost ?? 999));
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
      label: friendlyRoute(alert.target),
      assignmentId: alert.target.assignmentId ?? null,
      playerLabel: alert.target.playerLabel || null,
    } : null,
    outlet: outlet ? {
      label: friendlyRoute(outlet.target),
      assignmentId: outlet.target.assignmentId ?? null,
      playerLabel: outlet.target.playerLabel || null,
    } : null,
    coverage: coverage || null,
    pressure: Boolean(pressure),
    timingCalibrated: false,
    ambiguous: !relationship,
    reads,
    warning: 'Coordinator-derived structural read order from EA-authored assignments; EA does not author this read order here. Route timing is relative until telemetry calibration is complete.',
  };
}

module.exports = { deriveStructuralProgression, routeTraits, scoreTarget, detectRelationship };
