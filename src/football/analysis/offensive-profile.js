'use strict';

const { classifyOffensiveStructure, normalize } = require('./structural-threat-model');
const { buildAuthoritativePlayStructure } = require('./authoritative-play-structure');

const PROVENANCE = Object.freeze({
  EA_AUTHORED: 'EA_AUTHORED',
  DERIVED: 'DERIVED',
  HEURISTIC: 'HEURISTIC',
  EMPIRICAL_PRIOR: 'EMPIRICAL_PRIOR',
  LOCAL_OBSERVED: 'LOCAL_OBSERVED',
});

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function canonicalRoute(value) {
  const cleaned = String(value || '')
    .replace(/^AssignRouteType_/i, '')
    .replace(/^RR_/i, '')
    .replace(/^RB_/i, '');
  const text = normalize(cleaned);
  if (!text) return null;
  if (/\bpost\b/.test(text)) return 'post';
  if (/\bcorner\b/.test(text)) return 'corner';
  if (/\b(go|streak|fade|vertical)\b/.test(text)) return 'go';
  if (/\bslant\b/.test(text)) return 'slant';
  if (/\b(dig|deep in|in route)\b/.test(text)) return 'in_dig';
  if (/\bdeep out\b/.test(text)) return 'deep_out';
  if (/\b(quick out|speed out)\b/.test(text)) return 'quick_out';
  if (/\b(drag|shallow|shallow ?cross)\b/.test(text)) return 'shallow_cross';
  if (/\b(hitch|curl|comeback)\b/.test(text)) return 'hitch_curl';
  if (/\bscreen\b|\bbubble\b/.test(text)) return 'screen';
  if (/\bswing\b/.test(text)) return 'swing';
  if (/\bflat\b/.test(text)) return 'flat';
  if (/\bwheel\b/.test(text)) return 'wheel';
  if (/\b(angle|texas)\b/.test(text)) return 'angle';
  return null;
}

function conceptFromText(text, table) {
  for (const [concept, pattern] of table) if (pattern.test(text)) return concept;
  return null;
}

const RUN_CONCEPTS = [
  ['inside_zone', /\binside zone\b|\bzone inside\b/],
  ['split_zone', /\bsplit zone\b|\bzone split\b/],
  ['outside_zone', /\b(outside|wide) zone\b|\bstretch\b/],
  ['duo', /\bduo\b/],
  ['power', /\bpower\b/],
  ['counter', /\bcounter\b|\bgt\b/],
  ['trap', /\btrap\b/],
  ['wham', /\bwham\b/],
  ['sweep', /\bsweep\b/],
  ['toss', /\btoss\b/],
  ['jet', /\bjet\b/],
  ['read_option', /\bread option\b|\bzone read\b|\bveer\b/],
];

const PASS_CONCEPTS = [
  ['mesh', /\bmesh\b/],
  ['drive', /\bdrive\b/],
  ['flood_sail', /\bflood\b|\bsail\b/],
  ['levels', /\blevels\b/],
  ['smash', /\bsmash\b/],
  ['spacing', /\bspacing\b/],
  ['stick', /\bstick\b/],
  ['four_verticals', /\bfour verticals\b|\b4 verts?\b|\bverts\b/],
];

function fieldStressFromRoutes(routes) {
  const stress = [];
  for (const route of routes || []) {
    if (['quick_out','flat','swing','screen'].includes(route)) stress.push('short_outside','horizontal','sideline');
    if (route === 'shallow_cross') stress.push('horizontal','short_middle');
    if (route === 'slant' || route === 'hitch_curl' || route === 'angle') stress.push('short_middle');
    if (route === 'in_dig') stress.push('intermediate_middle');
    if (route === 'deep_out' || route === 'corner') stress.push('intermediate_outside','sideline');
    if (route === 'post') stress.push('deep_middle');
    if (route === 'go' || route === 'wheel') stress.push('vertical','deep_outside');
  }
  return unique(stress);
}

function inferRunFamily(runConcept) {
  if (!runConcept) return 'unknown';
  if (['inside_zone','split_zone','outside_zone'].includes(runConcept)) return 'zone';
  if (['power','counter','trap','wham'].includes(runConcept)) return 'gap';
  if (runConcept === 'duo') return 'man_duo';
  if (['sweep','toss','jet'].includes(runConcept)) return 'perimeter';
  if (runConcept === 'read_option') return 'option';
  if (runConcept === 'draw') return 'draw';
  return 'unknown';
}

function buildOffensiveProfile(play = {}, authoritativeStructure = null) {
  const structure = play.structural || classifyOffensiveStructure(play, authoritativeStructure);
  const authority = authoritativeStructure?.available ? authoritativeStructure : null;
  const classification = authority?.classification || null;
  const raw = normalize([
    authority?.play?.offensePlayType,
    authority?.play?.name,
    ...(authority?.play?.concepts || []),
    play.primaryConcept,
    ...(play.concepts || []),
    play.name,
  ].filter(Boolean).join(' '));

  let decisionClass = 'pass';
  if (classification?.rpo || /\brpo\b|\boption\b/.test(raw)) decisionClass = 'hybrid';
  else if (classification?.run || String(play.type || '').toUpperCase() === 'RUN') decisionClass = 'run';

  let playMechanism = decisionClass === 'pass' ? 'dropback' : null;
  if (classification?.rpo || /\brpo\b/.test(raw)) playMechanism = 'rpo';
  else if (/\boption\b|\bread option\b/.test(raw)) playMechanism = 'option';
  else if (/\bdesigned qb run\b|\bqb (draw|power|counter)\b/.test(raw)) playMechanism = 'designed_qb_run';
  else if (classification?.screen || /\bscreen\b|\bbubble\b/.test(raw)) playMechanism = 'screen';
  else if (classification?.playAction || /\bplay action\b|\bpa\b/.test(raw)) playMechanism = 'play_action';

  const runConcept = conceptFromText(raw, RUN_CONCEPTS);
  let passConcept = conceptFromText(raw, PASS_CONCEPTS);
  const authoritativeRouteFamilies = (authority?.routeTargets || [])
    .map(row => canonicalRoute(row.routeFamily || row.routeType || row.assignmentName))
    .filter(Boolean);
  const routes = unique(authoritativeRouteFamilies);
  if (!routes.length) {
    for (const value of [play.primaryConcept, ...(play.concepts || []), play.name]) {
      const route = canonicalRoute(value);
      if (route) routes.push(route);
    }
  }

  if (!passConcept && authoritativeRouteFamilies.length) {
    const count = key => authoritativeRouteFamilies.filter(route => route === key).length;
    const verticals = authoritativeRouteFamilies.filter(route => ['go','wheel','post'].includes(route)).length;
    if (verticals >= 4) passConcept = 'four_verticals';
    else if (count('shallow_cross') >= 2) passConcept = 'mesh';
    else if (count('corner') >= 1 && (count('flat') + count('quick_out')) >= 1) passConcept = 'flood_sail';
    else if (count('corner') >= 1 && count('hitch_curl') >= 1) passConcept = 'smash';
    else if (count('in_dig') >= 1 && count('shallow_cross') >= 1) passConcept = 'levels';
  }

  const assignmentGapEvidence = (authority?.blockingPlayers || [])
    .some(player => (player.eaAssignment?.semantics?.blocking?.leadBlocks || []).length > 0);
  const inferredRunFamily = inferRunFamily(runConcept);
  const runFamily = inferredRunFamily !== 'unknown'
    ? inferredRunFamily
    : (decisionClass === 'run' && assignmentGapEvidence ? 'gap' : 'unknown');

  const modifiers = [];
  if (authority?.motionPlayers?.length || /\bmotion\b/.test(raw)) modifiers.push('motion');
  if (playMechanism === 'play_action') modifiers.push('play_action');
  if ((authority?.blockingPlayers || []).some(player => (player.eaAssignment?.semantics?.blocking?.leadBlocks || []).length)) modifiers.push('puller');
  if (playMechanism === 'rpo') modifiers.push('rpo');
  if (playMechanism === 'option') modifiers.push('option');

  const authoritative = Boolean(authority);
  return {
    decisionClass,
    playMechanism,
    runFamily,
    runConcept: runConcept || null,
    passConcept: passConcept || null,
    routes: unique(routes),
    fieldStress: fieldStressFromRoutes(routes),
    modifiers: unique(modifiers),
    threatKeys: structure?.threatKeys || [],
    primaryThreat: structure?.primaryThreat || null,
    formation: play.formation || authority?.set?.name || null,
    personnel: play.personnel || null,
    provenance: {
      decisionClass: authoritative ? PROVENANCE.EA_AUTHORED : PROVENANCE.DERIVED,
      playMechanism: authoritative ? PROVENANCE.EA_AUTHORED : PROVENANCE.DERIVED,
      runConcept: authoritative && runConcept ? PROVENANCE.DERIVED : (runConcept ? PROVENANCE.HEURISTIC : null),
      runFamily: assignmentGapEvidence && !runConcept ? PROVENANCE.DERIVED : (runConcept ? (authoritative ? PROVENANCE.DERIVED : PROVENANCE.HEURISTIC) : null),
      passConcept: authoritative && passConcept ? PROVENANCE.DERIVED : (passConcept ? PROVENANCE.HEURISTIC : null),
      routes: authority?.routeTargets?.length ? PROVENANCE.EA_AUTHORED : (routes.length ? PROVENANCE.HEURISTIC : null),
      fieldStress: routes.length ? PROVENANCE.DERIVED : null,
      modifiers: authoritative ? PROVENANCE.DERIVED : PROVENANCE.HEURISTIC,
    },
    authoritativeAvailable: authoritative,
    authoritativePlayKey: authority?.playKey || play.eaAuthority?.playKey || null,
  };
}

class OffensiveProfileProvider {
  constructor({ eaPlayKnowledgeStore = null } = {}) {
    this.store = eaPlayKnowledgeStore;
    this.cache = new Map();
  }

  _authority(play) {
    const playKey = play?.eaAuthority?.playKey || null;
    if (!playKey || !this.store || typeof this.store.expandPlay !== 'function') return null;
    if (this.cache.has(playKey)) return this.cache.get(playKey);
    let built = null;
    try {
      built = buildAuthoritativePlayStructure(this.store.expandPlay(playKey));
    } catch (_) {
      built = null;
    }
    this.cache.set(playKey, built?.available ? built : null);
    return this.cache.get(playKey);
  }

  profile(play) {
    return buildOffensiveProfile(play, this._authority(play));
  }
}

module.exports = {
  PROVENANCE,
  canonicalRoute,
  fieldStressFromRoutes,
  buildOffensiveProfile,
  OffensiveProfileProvider,
};
