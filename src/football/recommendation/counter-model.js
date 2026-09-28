'use strict';

const { classifyOffensiveStructure, classifyDefensiveStructure, normalize } = require('../analysis/structural-threat-model');

const DEFENSIVE_REQUIREMENTS = Object.freeze({
  interior_run: [['interior_fit', 1.4], ['edge_support', 0.35]],
  gap_run: [['interior_fit', 1.45], ['edge_support', 0.45]],
  perimeter_run: [['edge_support', 1.5], ['underneath_zone', 0.35]],
  qb_run_option: [['edge_support', 1.25], ['rpo_balance', 1.0], ['interior_fit', 0.45]],
  quick_horizontal: [['underneath_zone', 1.15], ['man_match', 0.7], ['screen_control', 0.45]],
  crossing: [['crossing_match', 1.3], ['underneath_zone', 0.6]],
  flood: [['flood_leverage', 1.35], ['explosive_protection', 0.7]],
  intermediate_middle: [['crossing_match', 0.95], ['explosive_protection', 0.75], ['underneath_zone', 0.55]],
  vertical: [['explosive_protection', 1.7]],
  screen: [['screen_control', 1.5], ['controlled_rush', 0.9]],
  perimeter_access: [['edge_support', 0.95], ['underneath_zone', 0.75]],
});

const MODIFIER_REQUIREMENTS = Object.freeze({
  RPO_CONFLICT: [['rpo_balance', 1.3], ['interior_fit', 0.55], ['edge_support', 0.55]],
  PLAY_ACTION: [['explosive_protection', 0.9], ['controlled_rush', 0.45]],
  OPTION: [['edge_support', 1.0], ['interior_fit', 0.65]],
  PULLER: [['interior_fit', 0.85], ['edge_support', 0.55]],
  MOTION: [['edge_support', 0.45], ['underneath_zone', 0.3]],
});

function addRequirement(map, key, weight, source) {
  if (!key || !(weight > 0)) return;
  const row = map.get(key) || { key, weight: 0, sources: [] };
  row.weight += weight;
  if (source) row.sources.push(source);
  map.set(key, row);
}

function defensiveRequirements(profile = {}) {
  const requirements = new Map();
  for (const signal of profile.signals || []) {
    const mapping = DEFENSIVE_REQUIREMENTS[signal.key] || [];
    for (const [key, factor] of mapping) addRequirement(requirements, key, signal.score * factor, signal.key);
  }
  for (const modifier of profile.current?.modifiers || []) {
    for (const [key, factor] of MODIFIER_REQUIREMENTS[modifier.key] || []) {
      addRequirement(requirements, key, 2.0 * (Number(modifier.weight) || 1) * factor, modifier.key);
    }
  }
  return [...requirements.values()].sort((a, b) => b.weight - a.weight);
}

function defensiveSituationGate(structure, situation = {}) {
  const down = Number(situation.down || 0);
  const distance = Number(situation.distance || 0);
  const flags = situation.flags || {};
  if ((down === 3 || down === 4) && distance >= 7) {
    if (!structure.capabilities.includes('explosive_protection') && !structure.capabilities.includes('pressure')) {
      return { valid: false, reason: 'long-yardage requires explosive protection or credible pressure' };
    }
  }
  if (distance > 0 && distance <= 2 && structure.package.lightPackage && !structure.capabilities.includes('interior_fit')) {
    return { valid: false, reason: 'light package lacks short-yardage interior integrity' };
  }
  if (flags.goalToGo && structure.package.lightPackage && !structure.capabilities.includes('interior_fit')) {
    return { valid: false, reason: 'goal-to-go rejects a light package without interior fit support' };
  }
  return { valid: true, reason: null };
}

function evaluateDefensiveCandidate({ profile, play, knowledge, situation }) {
  const structure = play?.structural || classifyDefensiveStructure(play, knowledge);
  const gate = defensiveSituationGate(structure, situation);
  const requirements = defensiveRequirements(profile);
  const capabilities = new Set(structure.capabilities || []);
  let matched = 0;
  let total = 0;
  const matchedRequirements = [];
  const missingRequirements = [];
  for (const requirement of requirements) {
    total += requirement.weight;
    if (capabilities.has(requirement.key)) {
      matched += requirement.weight;
      matchedRequirements.push(requirement.key);
    } else {
      missingRequirements.push(requirement.key);
    }
  }

  let fit = total ? matched / total : 0.5;
  let penalty = 0;
  const threatScores = profile?.scores || {};
  if ((threatScores.screen || 0) > 0 && structure.pressure && !capabilities.has('controlled_rush')) penalty -= 0.22;
  if ((threatScores.interior_run || 0) + (threatScores.gap_run || 0) > 2 && structure.package.lightPackage && !capabilities.has('interior_fit')) penalty -= 0.28;
  if ((threatScores.vertical || 0) > 2 && !capabilities.has('explosive_protection')) penalty -= 0.35;
  fit = Math.max(0, Math.min(1, fit + penalty));

  const hasRequirements = requirements.length > 0;
  const strategicallyValid = gate.valid && (!hasRequirements || fit >= 0.18);
  return {
    valid: strategicallyValid,
    gate,
    fit,
    score: fit * 6,
    structure,
    requirements,
    matchedRequirements,
    missingRequirements,
    reasons: [
      ...(gate.reason ? [gate.reason] : []),
      ...(matchedRequirements.length ? [`counter requirements matched: ${matchedRequirements.slice(0, 4).join(', ')}`] : []),
    ],
  };
}

function desiredOffensiveThreats(defenseProfile = {}) {
  const wanted = new Map();
  const add = (key, weight, source) => {
    const row = wanted.get(key) || { key, weight: 0, sources: [] };
    row.weight += weight;
    row.sources.push(source);
    wanted.set(key, row);
  };
  const current = defenseProfile.current || {};
  const family = current.coverageFamily;

  if (current.pressure) {
    add('quick_horizontal', 1.5, 'pressure');
    add('screen', 1.1, 'pressure');
    add('crossing', 0.8, 'pressure');
    add('perimeter_access', 0.7, 'pressure');
  }
  if (family === 'cover_0') {
    add('crossing', 1.4, family); add('quick_horizontal', 1.0, family); add('vertical', 0.8, family);
  } else if (family === 'cover_1') {
    add('crossing', 1.35, family); add('quick_horizontal', 0.8, family); add('intermediate_middle', 0.55, family);
  } else if (family === 'cover_2') {
    add('intermediate_middle', 1.25, family); add('flood', 1.0, family); add('vertical', 0.55, family);
  } else if (family === 'cover_3') {
    add('flood', 1.35, family); add('intermediate_middle', 1.0, family); add('perimeter_access', 0.65, family);
  } else if (family === 'cover_4') {
    add('quick_horizontal', 1.15, family); add('crossing', 0.9, family); add('interior_run', 0.75, family);
  } else if (family === 'cover_6') {
    add('flood', 1.05, family); add('crossing', 0.85, family); add('intermediate_middle', 0.85, family);
  } else if (family === 'cover_2_man') {
    add('crossing', 1.25, family); add('qb_run_option', 0.7, family); add('quick_horizontal', 0.55, family);
  }

  for (const weakness of current.weaknesses || []) {
    if (weakness === 'pressure_vacated_underneath') add('quick_horizontal', 0.8, weakness);
    if (weakness === 'no_deep_help') add('vertical', 0.7, weakness);
    if (weakness === 'seams_flats') { add('flood', 0.55, weakness); add('intermediate_middle', 0.45, weakness); }
    if (weakness === 'underneath_space') { add('quick_horizontal', 0.5, weakness); add('interior_run', 0.35, weakness); }
  }

  for (const signal of (defenseProfile.signals || []).slice(0, 4)) {
    const w = Math.min(0.45, signal.share || 0);
    if (signal.key === 'pressure') add('quick_horizontal', w, 'recent-pressure');
    if (signal.key === 'man') add('crossing', w, 'recent-man');
    if (signal.key === 'zone') add('flood', w, 'recent-zone');
  }

  return [...wanted.values()].sort((a, b) => b.weight - a.weight);
}

function offensiveSituationGate(play, structure, situation = {}) {
  const down = Number(situation.down || 0);
  const distance = Number(situation.distance || 0);
  const type = String(play?.type || play?.playKind || '').toUpperCase();
  const text = normalize([play?.name, ...(play?.concepts || [])].join(' '));
  const keys = new Set(structure.threatKeys || []);

  if ((down === 3 || down === 4) && distance >= 7) {
    const conversionPass = type === 'PASS' || keys.has('screen') || /draw/.test(text);
    if (!conversionPass) return { valid: false, reason: 'long-yardage money down rejects ordinary run calls' };
  }
  if (situation.flags?.trailingLate && situation.flags?.twoMinute && type === 'RUN' && !keys.has('perimeter_run')) {
    return { valid: false, reason: 'two-minute trailing context requires clock-efficient access' };
  }
  return { valid: true, reason: null };
}

function evaluateOffensiveCandidate({ defenseProfile, play, knowledge, situation }) {
  const structure = play?.structural || classifyOffensiveStructure(play);
  const gate = offensiveSituationGate(play, structure, situation);
  const desired = desiredOffensiveThreats(defenseProfile);
  const candidate = new Set(structure.threatKeys || []);
  let matched = 0;
  let total = 0;
  const matchedThreats = [];
  for (const want of desired) {
    total += want.weight;
    if (candidate.has(want.key)) {
      matched += want.weight;
      matchedThreats.push(want.key);
    }
  }

  let theoryBonus = 0;
  const coverage = defenseProfile.current?.coverageFamily || defenseProfile.current?.name || null;
  if (coverage && knowledge) {
    for (const concept of [...(play?.concepts || []), play?.primaryConcept, play?.name].filter(Boolean)) {
      const result = knowledge.evaluateMatchup?.({ concept, coverage, pressure: defenseProfile.current?.pressure });
      if (result?.known) theoryBonus = Math.max(theoryBonus, Math.max(-1, Math.min(1.5, Number(result.score || 0) / 3)));
    }
  }

  const fit = total ? matched / total : 0.5;
  const adjustedFit = Math.max(0, Math.min(1.25, fit + Math.max(0, theoryBonus) * 0.2));
  const strategicallyValid = gate.valid && (!desired.length || adjustedFit >= 0.16 || theoryBonus > 0.5);
  return {
    valid: strategicallyValid,
    gate,
    fit: adjustedFit,
    theoryBonus,
    score: adjustedFit * 6,
    structure,
    desired,
    matchedThreats,
    reasons: [
      ...(gate.reason ? [gate.reason] : []),
      ...(matchedThreats.length ? [`punishes current defense with: ${matchedThreats.slice(0, 4).join(', ')}`] : []),
      ...(theoryBonus > 0 ? ['legacy matchup knowledge agrees with the structural counter'] : []),
    ],
  };
}

module.exports = {
  DEFENSIVE_REQUIREMENTS,
  MODIFIER_REQUIREMENTS,
  defensiveRequirements,
  defensiveSituationGate,
  evaluateDefensiveCandidate,
  desiredOffensiveThreats,
  offensiveSituationGate,
  evaluateOffensiveCandidate,
};
