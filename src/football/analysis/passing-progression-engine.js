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
  if (/curl|hook|hitch|comeback/.test(raw)) add('stop', 'underneath');
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

  const ranked = targets
    .map(target => ({ target, ...scoreTarget(target, coverage, pressure) }))
    .sort((a, b) => b.score - a.score || (a.traits.cost ?? 999) - (b.traits.cost ?? 999));

  const reads = ranked.map((item, index) => ({
    number: String(index + 1),
    button: item.target.button || null,
    label: `${friendlyRoute(item.target)} — ${item.timing} window`,
    detail: item.reasons.length
      ? item.reasons.join('; ')
      : `structural ${item.timing} read based on decoded route geometry`,
    score: Number(item.score.toFixed(3)),
    timing: item.timing,
    assignmentId: item.target.assignmentId ?? null,
    assignmentName: item.target.assignmentName || null,
  }));

  return {
    available: true,
    status: 'derived_structural',
    provenance: 'coordinator_derived_from_ea_assignments',
    coverage: coverage || null,
    pressure: Boolean(pressure),
    timingCalibrated: false,
    reads,
    warning: 'This is a coordinator-derived structural read order, not an EA-authored progression. Route timing is relative until telemetry calibration is complete.',
  };
}

module.exports = { deriveStructuralProgression, routeTraits, scoreTarget };
