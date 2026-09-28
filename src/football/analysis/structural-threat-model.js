'use strict';

const PROVENANCE = Object.freeze({
  EA_AUTHORED: 'EA_AUTHORED',
  DERIVED_STRUCTURAL: 'DERIVED_STRUCTURAL',
  HEURISTIC: 'HEURISTIC',
  LEGACY_FALLBACK: 'LEGACY_FALLBACK',
});

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function addSignal(map, key, weight, provenance, evidence) {
  if (!key) return;
  const prev = map.get(key) || { key, weight: 0, provenance, evidence: [] };
  prev.weight += Number(weight) || 0;
  if (prev.provenance !== PROVENANCE.EA_AUTHORED && provenance === PROVENANCE.EA_AUTHORED) prev.provenance = provenance;
  else if (prev.provenance === PROVENANCE.HEURISTIC && provenance === PROVENANCE.DERIVED_STRUCTURAL) prev.provenance = provenance;
  if (evidence) prev.evidence.push(evidence);
  map.set(key, prev);
}

function textFromPlay(play = {}, authoritative = null) {
  const authored = authoritative?.play || {};
  return normalize([
    play.name,
    play.type,
    play.playKind,
    play.primaryConcept,
    ...(play.concepts || []),
    ...(play.modifiers || []),
    authored.name,
    authored.offensePlayType,
    ...(authored.concepts || []),
  ].filter(Boolean).join(' '));
}

function authoritativeRouteFacts(authoritative) {
  const rows = [];
  let hasMotion = false;
  let hasLeadBlock = false;
  let hasPassBlock = false;
  for (const player of authoritative?.players || []) {
    const assignment = player?.assignment || {};
    const semantics = assignment.assignmentSemantics || {};
    const route = semantics.route;
    if (route) {
      rows.push({
        family: normalize(route.routeFamily || assignment.routeType || assignment.assignmentName),
        maxDepth: Number(route.maxDepth || 0),
        totalDistance: Number(route.totalDistance || 0),
      });
      if ((route.motion || []).length) hasMotion = true;
    }
    const blocking = semantics.blocking;
    if ((blocking?.leadBlocks || []).length) hasLeadBlock = true;
    if ((blocking?.passBlocks || []).length) hasPassBlock = true;
  }
  return { rows, hasMotion, hasLeadBlock, hasPassBlock };
}

function classifyOffensiveStructure(play = {}, authoritative = null) {
  const threats = new Map();
  const modifiers = new Map();
  const text = textFromPlay(play, authoritative);
  const authored = authoritative?.play || null;
  const authoredSource = authoritative?.status === 'resolved' ? PROVENANCE.EA_AUTHORED : PROVENANCE.DERIVED_STRUCTURAL;

  const signal = (key, regex, weight = 1, provenance = PROVENANCE.HEURISTIC) => {
    if (regex.test(text)) addSignal(threats, key, weight, provenance, `text:${key}`);
  };
  const modifier = (key, regex, weight = 1, provenance = PROVENANCE.HEURISTIC) => {
    if (regex.test(text)) addSignal(modifiers, key, weight, provenance, `text:${key}`);
  };

  signal('interior_run', /\binside zone\b|\bzone split\b|\bsplit zone\b|\bduo\b|\bdive\b|\biso\b|\binside run\b/, 1.1);
  signal('gap_run', /\bpower\b|\bcounter\b|\btrap\b|\bwham\b|\bbuck\b|\bgt\b/, 1.1);
  signal('perimeter_run', /\boutside zone\b|\bwide zone\b|\bstretch\b|\btoss\b|\bsweep\b|\bjet\b|\bend around\b/, 1.1);
  signal('qb_run_option', /\bread option\b|\bzone read\b|\bveer\b|\bpower read\b|\bspeed option\b|\bqb (draw|power|counter)\b/, 1.15);
  signal('screen', /\bscreen\b|\bbubble\b|\btunnel\b|\bmiddle screen\b/, 1.1);
  signal('quick_horizontal', /\bslant\b|\bstick\b|\bspacing\b|\bquick\b|\bbubble\b|\bflat\b|\bsmoke\b|\bspeed out\b/, 0.95);
  signal('crossing', /\bmesh\b|\bshallow\b|\bdrive\b|\bcross\b|\bdrag\b/, 1.05);
  signal('flood', /\bflood\b|\bsail\b/, 1.05);
  signal('intermediate_middle', /\bdig\b|\bseam\b|\blevels\b|\bmiddle\b|\bpost\b/, 0.85);
  signal('vertical', /\bverticals?\b|\bfour verts?\b|\b4 verts?\b|\ball go\b|\bgo route\b|\bshot\b/, 1.05);
  signal('perimeter_access', /\bbubble\b|\bsmoke\b|\bflat\b|\bspeed out\b|\bquick out\b|\bnow screen\b/, 0.9);

  modifier('RPO_CONFLICT', /\brpo\b|\bglance\b.*\bzone\b|\bzone\b.*\bstick\b/, 1.2);
  modifier('PLAY_ACTION', /\bplay action\b|\bpa\b/, 1.0);
  modifier('MOTION', /\bmotion\b|\bjet\b|\borbit\b/, 0.8);
  modifier('PULLER', /\bcounter\b|\bpower\b|\btrap\b|\bgt\b/, 0.8);
  modifier('OPTION', /\boption\b|\bveer\b|\bread\b/, 0.9);

  if (authored) {
    for (const concept of authored.concepts || []) {
      const n = normalize(concept);
      if (/screen|bubble/.test(n)) addSignal(threats, 'screen', 1.15, authoredSource, `authored-concept:${concept}`);
      if (/vertical|verts|four vertical/.test(n)) addSignal(threats, 'vertical', 1.15, authoredSource, `authored-concept:${concept}`);
      if (/flood|sail/.test(n)) addSignal(threats, 'flood', 1.15, authoredSource, `authored-concept:${concept}`);
      if (/mesh|cross|shallow|drive/.test(n)) addSignal(threats, 'crossing', 1.15, authoredSource, `authored-concept:${concept}`);
      if (/inside zone|duo/.test(n)) addSignal(threats, 'interior_run', 1.2, authoredSource, `authored-concept:${concept}`);
      if (/outside zone|stretch/.test(n)) addSignal(threats, 'perimeter_run', 1.2, authoredSource, `authored-concept:${concept}`);
    }
    if (authored.enableMotion === true || (authored.additionalPresnapMovements || []).length) {
      addSignal(modifiers, 'MOTION', 1.1, PROVENANCE.EA_AUTHORED, 'authored-motion');
    }
  }

  const routeFacts = authoritativeRouteFacts(authoritative);
  if (routeFacts.hasMotion) addSignal(modifiers, 'MOTION', 1.1, PROVENANCE.DERIVED_STRUCTURAL, 'assignment-motion');
  if (routeFacts.hasLeadBlock) {
    addSignal(modifiers, 'PULLER', 1.0, PROVENANCE.DERIVED_STRUCTURAL, 'lead-block-assignment');
    addSignal(threats, 'gap_run', 0.65, PROVENANCE.DERIVED_STRUCTURAL, 'lead-block-assignment');
  }
  if (routeFacts.hasPassBlock && !routeFacts.rows.length && /run/.test(text)) {
    addSignal(threats, 'interior_run', 0.25, PROVENANCE.DERIVED_STRUCTURAL, 'run-protection-structure');
  }
  for (const route of routeFacts.rows) {
    if (/drag|cross|shallow/.test(route.family)) addSignal(threats, 'crossing', 0.75, PROVENANCE.DERIVED_STRUCTURAL, `route:${route.family}`);
    if (/flat|bubble|out|swing/.test(route.family)) addSignal(threats, 'quick_horizontal', 0.55, PROVENANCE.DERIVED_STRUCTURAL, `route:${route.family}`);
    if (/screen/.test(route.family)) addSignal(threats, 'screen', 0.85, PROVENANCE.DERIVED_STRUCTURAL, `route:${route.family}`);
    if (route.maxDepth >= 18) addSignal(threats, 'vertical', 0.5, PROVENANCE.DERIVED_STRUCTURAL, `route-depth:${route.maxDepth}`);
    else if (route.maxDepth >= 9) addSignal(threats, 'intermediate_middle', 0.25, PROVENANCE.DERIVED_STRUCTURAL, `route-depth:${route.maxDepth}`);
  }

  if (/\brpo\b/.test(text)) {
    if (!threats.has('interior_run') && !threats.has('perimeter_run') && !threats.has('gap_run')) {
      addSignal(threats, 'interior_run', 0.6, PROVENANCE.DERIVED_STRUCTURAL, 'rpo-run-component');
    }
    if (!threats.has('quick_horizontal') && !threats.has('perimeter_access')) {
      addSignal(threats, 'perimeter_access', 0.55, PROVENANCE.DERIVED_STRUCTURAL, 'rpo-access-component');
    }
  }

  const orderedThreats = [...threats.values()].sort((a, b) => b.weight - a.weight);
  const orderedModifiers = [...modifiers.values()].sort((a, b) => b.weight - a.weight);
  return {
    side: 'offense',
    threats: orderedThreats,
    threatKeys: orderedThreats.map(x => x.key),
    modifiers: orderedModifiers,
    modifierKeys: orderedModifiers.map(x => x.key),
    primaryThreat: orderedThreats[0]?.key || null,
    provenance: authoritative?.status === 'resolved' ? PROVENANCE.DERIVED_STRUCTURAL : PROVENANCE.HEURISTIC,
  };
}

function classifyDefensiveStructure(play = {}, knowledge = null) {
  const name = String(play.name || '');
  const text = normalize([name, play.formation, play.set, ...(play.concepts || []), ...(play.assignmentFamilies || [])].join(' '));
  const coverageFamily = play.coverageFamily || knowledge?.resolveCoverage?.(name) || null;
  const assignmentFamilies = unique(play.assignmentFamilies || []);
  const pressure = assignmentFamilies.includes('blitz_rush') || /\bblitz\b|\bpressure\b|\bfire\b|\bsmoke\b|\bsting\b|\bzero\b|\bdog\b/.test(text);
  const standardRush = assignmentFamilies.includes('standard_pass_rush');
  const robberMiddle = assignmentFamilies.includes('robber_hole_or_intermediate_middle_family');
  const man = coverageFamily === 'cover_0' || coverageFamily === 'cover_1' || coverageFamily === 'cover_2_man' || assignmentFamilies.includes('man_coverage_matchup_family');
  const zone = ['cover_2', 'cover_3', 'cover_4', 'cover_6'].includes(coverageFamily) || assignmentFamilies.includes('zone_coverage_responsibility_family');
  const formation = normalize(play.formation || play.set || '');
  const heavyFront = /\b4 3\b|\b4 4\b|\b5 2\b|\b3 4\b|\bgoal line\b/.test(formation);
  const balancedFront = /\b3 3 5\b|\b4 2 5\b|\bnickel 3 3\b/.test(formation);
  const lightPackage = /\bdime\b|\bdollar\b|\bprevent\b/.test(formation);
  const tags = new Set();
  const capabilities = new Set();
  const weaknesses = new Set();

  if (coverageFamily) tags.add(coverageFamily);
  if (pressure) { tags.add('pressure'); capabilities.add('pressure'); weaknesses.add('pressure_vacated_underneath'); }
  if (man) tags.add('man');
  if (zone) tags.add('zone');
  if (heavyFront) { tags.add('heavy_front'); capabilities.add('interior_fit'); capabilities.add('edge_support'); }
  if (balancedFront) { tags.add('balanced_front'); capabilities.add('interior_fit'); capabilities.add('edge_support'); }
  if (lightPackage) tags.add('light_package');

  if (['cover_2', 'cover_3', 'cover_4', 'cover_6', 'cover_2_man'].includes(coverageFamily) || zone) {
    // EA-authored zone-responsibility assignments are sufficient structural
    // evidence that this is not a pure all-out/no-help call, even when the
    // display name does not normalize to a specific Cover-N family.
    capabilities.add('explosive_protection');
  }
  if (zone) { capabilities.add('underneath_zone'); capabilities.add('screen_control'); }
  if (['cover_3', 'cover_4', 'cover_6'].includes(coverageFamily)) {
    capabilities.add('edge_support');
    capabilities.add('flood_leverage');
    capabilities.add('rpo_balance');
  }
  if (['cover_1', 'cover_4', 'cover_6'].includes(coverageFamily) || robberMiddle || /match|robber/.test(text)) capabilities.add('crossing_match');
  if (robberMiddle) capabilities.add('intermediate_middle_help');
  if (pressure || heavyFront || balancedFront) capabilities.add('interior_fit');
  if (!pressure && (standardRush || zone)) capabilities.add('controlled_rush');
  if (man) capabilities.add('man_match');

  if (coverageFamily === 'cover_0') weaknesses.add('no_deep_help');
  if (coverageFamily === 'cover_1') weaknesses.add('single_high_man');
  if (coverageFamily === 'cover_2') weaknesses.add('middle_hole_sideline');
  if (coverageFamily === 'cover_3') weaknesses.add('seams_flats');
  if (coverageFamily === 'cover_4') weaknesses.add('underneath_space');
  if (coverageFamily === 'cover_6') weaknesses.add('split_field_seams');
  if (coverageFamily === 'cover_2_man') weaknesses.add('underneath_man_leverage');

  return {
    side: 'defense',
    coverageFamily,
    pressure,
    man,
    zone,
    tags: [...tags],
    capabilities: [...capabilities],
    weaknesses: [...weaknesses],
    package: { heavyFront, balancedFront, lightPackage, formation: play.formation || play.set || null },
    provenance: assignmentFamilies.length ? PROVENANCE.DERIVED_STRUCTURAL : PROVENANCE.HEURISTIC,
  };
}

module.exports = {
  PROVENANCE,
  normalize,
  classifyOffensiveStructure,
  classifyDefensiveStructure,
};
