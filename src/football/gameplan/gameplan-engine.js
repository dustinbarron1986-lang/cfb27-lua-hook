'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getGameplan, listGameplans } = require('./gameplan-definitions');
const { classifyOffensiveStructure, normalize } = require('../analysis/structural-threat-model');
const { strategicPlayScore, describeRisk } = require('./strategic-context');

const DEFAULT_TARGET_SIZE = 80;
const MIN_SITUATION_POOL = 12;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function playKey(play) {
  return String(play?.id ?? (String(play?.formation || '') + '::' + String(play?.name || '')));
}

function normalizeAggressiveness(value) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : 50;
}

function playText(play = {}) {
  return normalize([
    play.name,
    play.type,
    play.playKind,
    play.primaryConcept,
    play.presentationFamily,
    ...(play.concepts || []),
    ...(play.modifiers || []),
  ].filter(Boolean).join(' '));
}

function typeFamily(play, structure) {
  const raw = String(play?.type || play?.playKind || '').toUpperCase();
  if (raw === 'RUN') return 'run';
  if (raw === 'SCREEN') return 'screen';
  if (raw === 'RPO' || raw === 'OPTION') return 'hybrid';
  if (raw === 'PASS') return 'pass';
  const keys = new Set(structure?.threatKeys || []);
  if (keys.has('screen')) return 'screen';
  if (keys.has('qb_run_option')) return 'hybrid';
  if (keys.has('interior_run') || keys.has('gap_run') || keys.has('perimeter_run')) return 'run';
  if (keys.size) return 'pass';
  return 'unknown';
}

function presentationFor(play, structure) {
  const formation = play?.formation || null;
  const family = play?.presentationFamily || null;
  const modifierKeys = unique(structure?.modifierKeys || []).sort();
  const threatKeys = unique(structure?.threatKeys || []).sort();
  const authoritative = play?.authoritativeStructure || play?.eaAuthority || null;

  if (authoritative && formation) {
    return {
      key: normalize([formation, family || modifierKeys.join(' '), threatKeys.slice(0, 2).join(' ')].join(' :: ')),
      formation,
      family,
      confidence: 'HIGH',
      provenance: 'EA_AUTHORED_OR_RESOLVED_STRUCTURE',
    };
  }
  if (family && formation) {
    return {
      key: normalize([formation, family].join(' :: ')),
      formation,
      family,
      confidence: 'MEDIUM',
      provenance: 'CATALOG_PRESENTATION_FAMILY',
    };
  }
  return {
    key: normalize([formation, modifierKeys.join(' '), threatKeys.slice(0, 2).join(' ')].join(' :: ')),
    formation,
    family: null,
    confidence: formation ? 'LOW' : 'VERY_LOW',
    provenance: 'HEURISTIC_FORMATION_STRUCTURE',
  };
}

function describePlay(play = {}) {
  const structure = play.structural || classifyOffensiveStructure(play, play.authoritativeStructure || null);
  const threatKeys = unique(structure?.threatKeys || []);
  const modifierKeys = unique(structure?.modifierKeys || []);
  const threats = new Set(threatKeys);
  const modifiers = new Set(modifierKeys);
  const text = playText(play);
  const family = typeFamily(play, structure);
  const primaryThreat = structure?.primaryThreat || threatKeys[0] || null;

  const isPlayAction = modifiers.has('PLAY_ACTION') || /\bplay action\b|\bpa\b/.test(text);
  const isDoubleMove = /\bsluggo\b|\bout and up\b|\bcurl and go\b|\bstop and go\b|\bdouble move\b|\bstutter go\b/.test(text);
  const isShot = threats.has('vertical') || /\bshot\b|\bdeep\b/.test(text);
  const pressureAnswer = threats.has('quick_horizontal') || threats.has('screen') || threats.has('crossing');
  const constraint = threats.has('screen') || threats.has('perimeter_access') || threats.has('qb_run_option') ||
    modifiers.has('RPO_CONFLICT') || modifiers.has('OPTION');
  const shortRoute = threats.has('quick_horizontal') || threats.has('crossing') || threats.has('perimeter_access');
  const runLike = family === 'run' || (family === 'hybrid' && (
    threats.has('interior_run') || threats.has('gap_run') || threats.has('perimeter_run') || threats.has('qb_run_option')
  ));

  return {
    play,
    id: playKey(play),
    formation: play.formation || null,
    personnel: play.personnel || null,
    structure,
    threatKeys,
    modifierKeys,
    primaryThreat,
    typeFamily: family,
    text,
    isPlayAction,
    isDoubleMove,
    isShot,
    pressureAnswer,
    constraint,
    shortRoute,
    runLike,
    presentation: presentationFor(play, structure),
  };
}

function contribution(rows, label, score, reason) {
  if (!(score > 0)) return;
  rows.push({ label, score, reason });
}

function gameplanFit(playOrDescription, gameplan) {
  const desc = playOrDescription?.play ? playOrDescription : describePlay(playOrDescription);
  const plan = gameplan || getGameplan('balanced_multiple');
  const rows = [];

  contribution(rows, 'type', plan.typeWeights?.[desc.typeFamily] || 0,
    plan.typeWeights?.[desc.typeFamily] ? plan.name + ' values this play type.' : null);

  for (const key of desc.threatKeys) {
    const weight = Number(plan.threatWeights?.[key] || 0);
    contribution(rows, 'threat:' + key, weight, weight ? plan.name + ' emphasizes ' + key.replaceAll('_', ' ') + '.' : null);
  }
  for (const key of desc.modifierKeys) {
    const weight = Number(plan.modifierWeights?.[key] || 0);
    contribution(rows, 'modifier:' + key, weight, weight ? plan.name + ' values ' + key.replaceAll('_', ' ').toLowerCase() + '.' : null);
  }

  const conceptTokens = new Set([
    ...(desc.play?.concepts || []),
    desc.play?.primaryConcept,
    desc.play?.conceptFamily,
  ].filter(Boolean).map(normalize));
  for (const [needle, weight] of Object.entries(plan.conceptWeights || {})) {
    const normalizedNeedle = normalize(needle);
    if (normalizedNeedle && conceptTokens.has(normalizedNeedle)) {
      contribution(rows, 'concept:' + needle, Number(weight) || 0, plan.name + ' exact canonical concept match: ' + needle.replaceAll('_', ' ') + '.');
    }
  }

  const formation = normalize(desc.formation);
  for (const [needle, weight] of plan.formationWeights || []) {
    if (formation.includes(normalize(needle))) {
      contribution(rows, 'formation:' + needle, Number(weight) || 0, plan.name + ' formation preference: ' + needle + '.');
    }
  }

  const score = rows.reduce((sum, row) => sum + row.score, 0);
  const reasons = rows.sort((a, b) => b.score - a.score).slice(0, 3).map(row => row.reason).filter(Boolean);
  return { score: Number(score.toFixed(3)), reasons, contributions: rows };
}

function staticSituationTags(desc) {
  const tags = new Set(['NORMAL_EARLY_DOWN']);
  const threats = new Set(desc.threatKeys);
  const passLike = desc.typeFamily === 'pass' || desc.typeFamily === 'screen' || desc.typeFamily === 'hybrid';
  const safeShort = desc.runLike || threats.has('quick_horizontal') || threats.has('crossing') || threats.has('screen');
  const conversion = passLike && (
    threats.has('quick_horizontal') || threats.has('crossing') || threats.has('flood') ||
    threats.has('intermediate_middle') || threats.has('screen') || threats.has('vertical')
  );

  if (desc.runLike || desc.isPlayAction || desc.isShot) tags.add('SECOND_SHORT');
  if (safeShort || threats.has('intermediate_middle') || threats.has('flood')) tags.add('SECOND_MEDIUM');
  if (passLike || threats.has('screen')) tags.add('SECOND_LONG');
  if (safeShort) tags.add('THIRD_SHORT');
  if (conversion || desc.runLike) tags.add('THIRD_MEDIUM');
  if (passLike && (conversion || desc.isShot)) tags.add('THIRD_LONG');
  if (safeShort) tags.add('FOURTH_SHORT');

  if (desc.runLike || threats.has('quick_horizontal') || threats.has('crossing') || threats.has('intermediate_middle')) {
    tags.add('RED_ZONE');
  }
  if (desc.runLike || threats.has('quick_horizontal') || threats.has('crossing')) tags.add('LOW_RED_ZONE');
  if (desc.runLike || threats.has('quick_horizontal') || threats.has('screen')) tags.add('BACKED_UP');
  if (passLike && (threats.has('quick_horizontal') || threats.has('crossing') || threats.has('perimeter_access') || threats.has('flood'))) {
    tags.add('TWO_MINUTE');
  }
  const risk = describeRisk(desc.play);
  if (risk.runLike || risk.possessionPass) tags.add('FOUR_MINUTE');
  if (desc.isShot) tags.add('SHOT_PLAY');
  if (desc.pressureAnswer) tags.add('PRESSURE_ANSWER');
  if (desc.constraint) tags.add('CHANGEUP_CONSTRAINT');
  if (desc.isPlayAction || desc.isDoubleMove || desc.isShot) tags.add('SETUP_PAYOFF');

  return [...tags];
}

function isStrongSituationBucket(bucket) {
  return ['THIRD_LONG','FOURTH_SHORT','RED_ZONE','LOW_RED_ZONE','BACKED_UP','TWO_MINUTE','FOUR_MINUTE','END_GAME'].includes(bucket);
}

function isNeutralSituation(situation = {}) {
  const flags = situation.flags || {};
  const down = Number(situation.down || 0);
  const distance = Number(situation.distance || 0);
  return (down === 1 || down === 2) &&
    distance > 0 && distance <= 8 &&
    !flags.redZone && !flags.goalToGo && !flags.backedUp &&
    !flags.twoMinute && !flags.fourMinute &&
    !flags.trailingLate && !flags.leadingLate;
}

function situationBuckets(situation = {}) {
  const down = Number(situation.down || 0);
  const distance = Number(situation.distance || 0);
  const yardLine = Number(situation.yardLine);
  const flags = situation.flags || {};
  const buckets = [];

  if (down <= 1) buckets.push('NORMAL_EARLY_DOWN');
  if (down === 2) {
    if (distance <= 3) buckets.push('SECOND_SHORT');
    else if (distance <= 7) buckets.push('SECOND_MEDIUM');
    else buckets.push('SECOND_LONG');
  }
  if (down === 3) {
    if (distance <= 2) buckets.push('THIRD_SHORT');
    else if (distance <= 6) buckets.push('THIRD_MEDIUM');
    else buckets.push('THIRD_LONG');
  }
  if (down === 4) {
    if (distance <= 2) buckets.push('FOURTH_SHORT');
    else if (distance <= 6) buckets.push('THIRD_MEDIUM');
    else buckets.push('THIRD_LONG');
  }

  if (flags.goalToGo || (Number.isFinite(yardLine) && yardLine >= 90)) buckets.push('LOW_RED_ZONE');
  else if (flags.redZone || (Number.isFinite(yardLine) && yardLine >= 80)) buckets.push('RED_ZONE');
  if (flags.backedUp || (Number.isFinite(yardLine) && yardLine <= 10)) buckets.push('BACKED_UP');
  if (flags.twoMinute) buckets.push('TWO_MINUTE');
  if (flags.fourMinute) buckets.push('FOUR_MINUTE');

  return unique(buckets.length ? buckets : ['NORMAL_EARLY_DOWN']);
}

function relationshipBetween(core, candidate) {
  if (!core || !candidate || core.id === candidate.id) return null;
  if (!core.formation || String(core.formation) !== String(candidate.formation)) return null;

  let similarityScore = 0.35;
  let confidence = 'LOW';
  let provenance = 'HEURISTIC_FORMATION_STRUCTURE';
  if (core.presentation.family && candidate.presentation.family &&
      normalize(core.presentation.family) === normalize(candidate.presentation.family)) {
    similarityScore += 0.65;
    confidence = 'MEDIUM';
    provenance = 'CATALOG_PRESENTATION_FAMILY';
  } else if (core.presentation.key && candidate.presentation.key &&
             core.presentation.key === candidate.presentation.key &&
             core.presentation.confidence !== 'VERY_LOW') {
    similarityScore += 0.45;
    confidence = core.presentation.confidence;
    provenance = core.presentation.provenance;
  }

  if (core.runLike && candidate.isPlayAction) {
    return {
      type: 'PLAY_ACTION_PAYOFF',
      setupPlayId: core.id,
      score: 1.35 + similarityScore,
      confidence,
      provenance,
      reason: confidence === 'LOW'
        ? 'Play action from the same formation complements an established run look; exact early-action similarity is heuristic.'
        : 'Play action shares formation/presentation evidence with a run core and can serve as a payoff.',
    };
  }
  if (core.runLike && candidate.constraint) {
    return {
      type: 'CONSTRAINT',
      setupPlayId: core.id,
      score: 1.05 + similarityScore,
      confidence,
      provenance,
      reason: 'Same-formation constraint changes the point of attack after the defense has seen the run family.',
    };
  }
  if (core.shortRoute && candidate.isDoubleMove) {
    return {
      type: 'DOUBLE_MOVE_PAYOFF',
      setupPlayId: core.id,
      score: 1.25 + similarityScore,
      confidence,
      provenance,
      reason: confidence === 'LOW'
        ? 'Double-move naming plus same formation suggests a payoff from established short-route structure; stem similarity is not authoritative.'
        : 'Double-move payoff shares presentation evidence with an established short-route core.',
    };
  }
  if (core.primaryThreat && candidate.primaryThreat && core.primaryThreat !== candidate.primaryThreat) {
    return {
      type: 'COMPLEMENT',
      setupPlayId: core.id,
      score: 0.65 + similarityScore,
      confidence,
      provenance,
      reason: 'Same formation presents a different structural threat and can break a developing tendency.',
    };
  }
  return null;
}

function audiblePackageValue(audiblePackageStore, playbookId, formation) {
  if (!audiblePackageStore || !playbookId || !formation) return 0;
  const pkg = audiblePackageStore.get?.(playbookId, formation);
  if (!pkg?.available) return 0;
  return pkg.confirmed ? 0.22 : 0.06;
}

function bucketQuotas(planId) {
  const base = {
    THIRD_SHORT: 4,
    THIRD_MEDIUM: 5,
    THIRD_LONG: 5,
    RED_ZONE: 5,
    BACKED_UP: 3,
    TWO_MINUTE: 5,
    FOUR_MINUTE: 4,
    PRESSURE_ANSWER: 5,
    SHOT_PLAY: 5,
  };
  if (planId === 'ground_control' || planId === 'power_pro_style') {
    base.THIRD_SHORT = 7; base.FOUR_MINUTE = 7; base.SHOT_PLAY = 4; base.PRESSURE_ANSWER = 4;
  } else if (planId === 'air_raid' || planId === 'west_coast_rhythm') {
    base.THIRD_LONG = 7; base.TWO_MINUTE = 7; base.PRESSURE_ANSWER = 7;
  } else if (planId === 'vertical_attack') {
    base.SHOT_PLAY = 10; base.SECOND_SHORT = 6;
  } else if (planId === 'spread_option_rpo') {
    base.PRESSURE_ANSWER = 7; base.THIRD_SHORT = 6; base.RED_ZONE = 6;
  }
  return base;
}

function generateCallSheet({
  playbook,
  gameplanId = 'balanced_multiple',
  targetSize = DEFAULT_TARGET_SIZE,
  audiblePackageStore = null,
} = {}) {
  const plan = getGameplan(gameplanId);
  const plays = playbook?.plays || [];
  const target = Math.min(plays.length, Math.max(1, Math.round(targetSize || DEFAULT_TARGET_SIZE)));
  const described = plays.map(play => {
    const desc = describePlay(play);
    const fit = gameplanFit(desc, plan);
    return {
      ...desc,
      gameplanScore: fit.score,
      planReasons: fit.reasons,
      tags: staticSituationTags(desc),
      relationships: [],
      role: null,
      audibleFlexibility: audiblePackageValue(audiblePackageStore, playbook?.id, play.formation),
    };
  });

  const selected = new Map();
  const formationCounts = new Map();
  const add = (row, role = null) => {
    if (!row || selected.has(row.id) || selected.size >= target) return false;
    const clone = { ...row, role: role || row.role, tags: [...row.tags], relationships: [...(row.relationships || [])] };
    selected.set(row.id, clone);
    formationCounts.set(row.formation || '?', (formationCounts.get(row.formation || '?') || 0) + 1);
    return true;
  };

  const fitRanked = [...described].sort((a, b) =>
    b.gameplanScore - a.gameplanScore ||
    b.audibleFlexibility - a.audibleFlexibility ||
    a.id.localeCompare(b.id)
  );

  const coreTarget = Math.min(target, Math.max(10, Math.round(target * 0.30)));
  const coreThreatCounts = new Map();
  for (const row of fitRanked) {
    if (selected.size >= coreTarget) break;
    const formation = row.formation || '?';
    const formationCount = formationCounts.get(formation) || 0;
    const maxCoreFromFormation = Math.max(3, Math.ceil(coreTarget / 5));
    if (formationCount >= maxCoreFromFormation) continue;
    const threatCount = coreThreatCounts.get(row.primaryThreat || 'unknown') || 0;
    const diversityPenalty = threatCount >= 5 ? 0.9 : 0;
    if (row.gameplanScore - diversityPenalty < 0 && selected.size >= Math.floor(coreTarget * 0.7)) continue;
    if (add(row, 'CORE')) {
      coreThreatCounts.set(row.primaryThreat || 'unknown', threatCount + 1);
      selected.get(row.id).tags = unique([...selected.get(row.id).tags, 'CORE_CALL']);
    }
  }

  // Build relationships against the actual selected core, then deliberately
  // add complements/payoffs. This prevents the call sheet from becoming a
  // simple global top-N ranking.
  const coreRows = [...selected.values()];
  const relationshipCandidates = [];
  for (const row of described) {
    if (selected.has(row.id)) continue;
    const relationships = coreRows
      .map(core => relationshipBetween(core, row))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    if (!relationships.length) continue;
    relationshipCandidates.push({
      row: { ...row, relationships: relationships.slice(0, 3) },
      relationship: relationships[0],
      selectionScore: row.gameplanScore + relationships[0].score + row.audibleFlexibility,
    });
  }
  relationshipCandidates.sort((a, b) => b.selectionScore - a.selectionScore || a.row.id.localeCompare(b.row.id));

  const relationshipTarget = Math.min(target, Math.round(target * 0.62));
  for (const candidate of relationshipCandidates) {
    if (selected.size >= relationshipTarget) break;
    const formation = candidate.row.formation || '?';
    if ((formationCounts.get(formation) || 0) >= Math.max(7, Math.ceil(target / 8))) continue;
    if (add(candidate.row, candidate.relationship.type)) {
      const added = selected.get(candidate.row.id);
      const roleTag = candidate.relationship.type === 'CONSTRAINT'
        ? 'CHANGEUP_CONSTRAINT'
        : candidate.relationship.type === 'COMPLEMENT'
          ? 'COMPLEMENT'
          : 'SETUP_PAYOFF';
      added.tags = unique([...added.tags, roleTag, 'COMPLEMENT']);
    }
  }

  // Philosophy inventory accountability: the call sheet itself must contain
  // enough identity-bearing calls before live scoring begins. This is NOT a
  // rigid in-game run percentage; situation/counter gates still decide what is
  // appropriate on each snap.
  const identityTargets = plan.id === 'ground_control'
    ? { pureRun: Math.min(target, Math.round(target * 0.40)), runLike: Math.min(target, Math.round(target * 0.52)) }
    : (plan.id === 'power_pro_style'
      ? { pureRun: Math.min(target, Math.round(target * 0.34)), runLike: Math.min(target, Math.round(target * 0.46)) }
      : null);
  if (identityTargets) {
    const pureRunCount = () => [...selected.values()].filter(row => row.typeFamily === 'run').length;
    const runLikeCount = () => [...selected.values()].filter(row => row.runLike).length;
    for (const row of fitRanked.filter(row => row.typeFamily === 'run')) {
      if (pureRunCount() >= identityTargets.pureRun || selected.size >= target) break;
      add(row, row.role || 'CORE');
    }
    for (const row of fitRanked.filter(row => row.runLike)) {
      if (runLikeCount() >= identityTargets.runLike || selected.size >= target) break;
      add(row, row.role || 'CORE');
    }
  }

  // Ensure the sheet has real answers for common game situations. Plays can
  // count in multiple buckets; these are coverage floors, not rigid quotas.
  const quotas = bucketQuotas(plan.id);
  for (const [tag, quota] of Object.entries(quotas)) {
    let count = [...selected.values()].filter(row => row.tags.includes(tag)).length;
    if (count >= quota) continue;
    const candidates = fitRanked.filter(row => !selected.has(row.id) && row.tags.includes(tag));
    for (const row of candidates) {
      if (count >= quota || selected.size >= target) break;
      if (add(row, row.role || 'SITUATIONAL')) count += 1;
    }
  }

  // Fill remaining slots with plan fit, formation diversity, threat diversity,
  // and modest audible-package flexibility. This remains subordinate to the
  // identity established by the core/complement phases above.
  while (selected.size < target) {
    let best = null;
    const selectedThreats = new Map();
    for (const row of selected.values()) {
      selectedThreats.set(row.primaryThreat || 'unknown', (selectedThreats.get(row.primaryThreat || 'unknown') || 0) + 1);
    }
    for (const row of described) {
      if (selected.has(row.id)) continue;
      const formationCount = formationCounts.get(row.formation || '?') || 0;
      const threatCount = selectedThreats.get(row.primaryThreat || 'unknown') || 0;
      const diversity = 0.45 / (1 + formationCount) + 0.35 / (1 + threatCount);
      const score = row.gameplanScore + row.audibleFlexibility + diversity;
      if (!best || score > best.score || (score === best.score && row.id < best.row.id)) best = { row, score };
    }
    if (!best) break;
    add(best.row, 'DEPTH');
  }

  const entries = [...selected.values()].map((row, index) => ({
    order: index + 1,
    playId: row.id,
    playName: row.play?.name || null,
    formation: row.formation,
    personnel: row.personnel,
    role: row.role || 'DEPTH',
    tags: unique(row.tags),
    gameplanScore: row.gameplanScore,
    planReasons: row.planReasons,
    primaryThreat: row.primaryThreat,
    threatKeys: row.threatKeys,
    modifierKeys: row.modifierKeys,
    presentation: row.presentation,
    relationships: row.relationships || [],
    audibleFlexibility: row.audibleFlexibility,
  }));

  return {
    version: 1,
    playbookId: playbook?.id == null ? null : String(playbook.id),
    playbookName: playbook?.name || null,
    sourcePlayCount: plays.length,
    gameplanId: plan.id,
    gameplanName: plan.name,
    targetSize,
    actualSize: entries.length,
    generatedAt: new Date().toISOString(),
    entries,
  };
}

function validSheet(sheet, playbook, gameplanId) {
  if (!sheet || String(sheet.playbookId) !== String(playbook?.id) || sheet.gameplanId !== gameplanId) return false;
  if (Number(sheet.sourcePlayCount) !== Number(playbook?.plays?.length || 0)) return false;
  const ids = new Set((playbook?.plays || []).map(playKey));
  return Array.isArray(sheet.entries) && sheet.entries.length > 0 &&
    sheet.entries.every(entry => ids.has(String(entry.playId)));
}

class SetupState {
  constructor() {
    this.rows = [];
  }

  reset() {
    this.rows = [];
  }

  record(event) {
    if (!event?.play) return null;
    if (event.situation?.possession != null && Number(event.situation.possession) !== 0) return null;
    const desc = describePlay(event.play);
    const row = {
      index: this.rows.length,
      playId: desc.id,
      playName: event.play.name || null,
      formation: desc.formation,
      primaryThreat: desc.primaryThreat,
      threatKeys: desc.threatKeys,
      modifierKeys: desc.modifierKeys,
      typeFamily: desc.typeFamily,
      runLike: desc.runLike,
      shortRoute: desc.shortRoute,
      isPlayAction: desc.isPlayAction,
      isDoubleMove: desc.isDoubleMove,
      isShot: desc.isShot,
      presentation: desc.presentation,
      success: Boolean(event.grades?.offense?.situationalSuccess),
      yards: Number(event.result?.yards || 0),
      defenseFamily: event.opponentPlay?.coverageFamily || event.opponentPlay?.structural?.coverageFamily || null,
      neutral: isNeutralSituation(event.situation || {}),
    };
    this.rows.push(row);
    return row;
  }

  score(play, entry = null) {
    const desc = describePlay(play);
    const sameFormation = this.rows.filter(row => row.formation && row.formation === desc.formation);
    const components = {
      sequencingValue: 0,
      setupValue: 0,
      payoffValue: 0,
      tendencyBreakingValue: 0,
    };
    const reasons = [];

    const paRelations = (entry?.relationships || []).filter(rel => rel.type === 'PLAY_ACTION_PAYOFF');
    const paSetupIds = new Set(paRelations.map(rel => String(rel.setupPlayId)));
    const successfulRuns = sameFormation.filter(row => row.runLike && row.success && paSetupIds.has(String(row.playId)));
    if (desc.isPlayAction && successfulRuns.length >= 2) {
      components.setupValue += Math.min(1.25, 0.30 * successfulRuns.length);
      components.payoffValue += Math.min(0.45, 0.10 * successfulRuns.length);
      const confidence = paRelations[0]?.confidence || 'LOW';
      reasons.push(
        successfulRuns.length + ' successful RELATED run calls from ' + desc.formation +
        ' have established this PA payoff; relationship confidence=' + confidence + '.'
      );
    }

    const doubleRelations = (entry?.relationships || []).filter(rel => rel.type === 'DOUBLE_MOVE_PAYOFF');
    const shortSetupIds = new Set(doubleRelations.map(rel => String(rel.setupPlayId)));
    const shortRoutes = sameFormation.filter(row => row.shortRoute && shortSetupIds.has(String(row.playId)));
    if (desc.isDoubleMove && shortRoutes.length >= 2) {
      components.payoffValue += Math.min(1.15, 0.28 * shortRoutes.length);
      const confidence = doubleRelations[0]?.confidence || 'LOW';
      reasons.push(
        shortRoutes.length + ' RELATED short/intermediate route presentations from ' + desc.formation +
        ' increase double-move payoff value; stem similarity confidence=' + confidence + '.'
      );
    }

    if (desc.presentation.key && desc.presentation.confidence !== 'VERY_LOW') {
      const similar = this.rows.filter(row =>
        row.presentation?.key &&
        row.presentation.key === desc.presentation.key &&
        row.playId !== desc.id
      );
      if (similar.length >= 2) {
        components.sequencingValue += Math.min(0.55, similar.length * 0.12);
        reasons.push(
          similar.length + ' related presentations have been shown; provenance=' + desc.presentation.provenance + '.'
        );
      }
    }

    if (sameFormation.length >= 3 && desc.primaryThreat) {
      const counts = new Map();
      for (const row of sameFormation) {
        if (!row.primaryThreat) continue;
        counts.set(row.primaryThreat, (counts.get(row.primaryThreat) || 0) + 1);
      }
      const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || null;
      if (dominant && dominant[1] / sameFormation.length >= 0.65 && dominant[0] !== desc.primaryThreat) {
        components.tendencyBreakingValue += 0.6;
        reasons.push(
          desc.formation + ' has shown ' + dominant[0].replaceAll('_', ' ') +
          ' on ' + dominant[1] + '/' + sameFormation.length +
          ' recorded calls; this valid different-family call can break that tendency.'
        );
      }
    }

    for (const relation of entry?.relationships || []) {
      const prior = this.rows.filter(row => row.playId === String(relation.setupPlayId));
      if (!prior.length) continue;
      components.sequencingValue += Math.min(0.45, prior.length * 0.12);
      reasons.push(
        'Related setup play has been shown ' + prior.length + ' time(s): ' +
        relation.type.replaceAll('_', ' ').toLowerCase() + ' (' + relation.confidence + ').'
      );
      break;
    }

    return {
      components,
      score: Object.values(components).reduce((sum, value) => sum + value, 0),
      reasons,
    };
  }

  summary() {
    const formations = {};
    const concepts = {};
    const mix = { run: 0, hybrid: 0, pass: 0, screen: 0, playAction: 0, shot: 0 };
    const neutralMix = { run: 0, hybrid: 0, pass: 0, screen: 0, playAction: 0, shot: 0 };
    for (const row of this.rows) {
      if (row.formation) formations[row.formation] = (formations[row.formation] || 0) + 1;
      if (row.primaryThreat) concepts[row.primaryThreat] = (concepts[row.primaryThreat] || 0) + 1;
      const target = row.neutral ? neutralMix : null;
      const family = row.typeFamily === 'hybrid' ? 'hybrid' : row.typeFamily === 'screen' ? 'screen' : row.runLike ? 'run' : 'pass';
      mix[family] += 1;
      if (target) target[family] += 1;
      if (row.isPlayAction) { mix.playAction += 1; if (target) target.playAction += 1; }
      if (row.isShot) { mix.shot += 1; if (target) target.shot += 1; }
    }
    return { snaps: this.rows.length, formations, concepts, mix, neutralMix, rows: [...this.rows] };
  }
}

function aggressionModifier(desc, plan, aggressiveness, situation = {}) {
  const centered = (normalizeAggressiveness(aggressiveness) - 50) / 50;
  if (Math.abs(centered) < 0.01) return { score: 0, reasons: [] };

  const favorableShotDown = Number(situation.down) === 2 && Number(situation.distance) > 0 && Number(situation.distance) <= 3;
  let expression = 0;
  if (plan.aggressionStyle === 'vertical') expression = desc.isShot ? 0.65 : (desc.typeFamily === 'pass' ? 0.18 : -0.05);
  else if (plan.aggressionStyle === 'pass') expression = desc.isShot ? 0.42 : (desc.typeFamily === 'pass' ? 0.24 : -0.05);
  else if (plan.aggressionStyle === 'rhythm') expression = desc.isShot ? 0.22 : (desc.shortRoute ? 0.24 : 0);
  else if (plan.aggressionStyle === 'option') expression = desc.isShot ? 0.20 : (desc.constraint || desc.typeFamily === 'hybrid' ? 0.25 : 0);
  else if (plan.aggressionStyle === 'run_pa') expression = desc.isPlayAction || desc.isShot ? 0.30 : (desc.runLike ? 0.12 : 0);
  else if (plan.aggressionStyle === 'run') expression = desc.isPlayAction || desc.isShot ? 0.24 : (desc.runLike ? 0.14 : 0);
  else expression = desc.isShot ? 0.28 : (desc.pressureAnswer || desc.runLike ? 0.08 : 0);

  if (favorableShotDown && desc.isShot) expression += 0.18;
  const score = clamp(centered * expression, -0.65, 0.65);
  return {
    score,
    reasons: Math.abs(score) >= 0.08
      ? ['offensive aggressiveness ' + normalizeAggressiveness(aggressiveness) + '/100 modifies risk preference within ' + plan.name + '.']
      : [],
  };
}

class GameplanEngine {
  constructor({ filePath = null, audiblePackageStore = null, targetSize = DEFAULT_TARGET_SIZE } = {}) {
    this.filePath = filePath || null;
    this.audiblePackageStore = audiblePackageStore || null;
    this.targetSize = Math.max(1, Math.round(targetSize || DEFAULT_TARGET_SIZE));
    this.setup = new SetupState();
    this.active = null;
    this.data = this._read();
  }

  _read() {
    if (!this.filePath) return { version: 1, selections: {}, sheets: {} };
    try {
      if (!fs.existsSync(this.filePath)) return { version: 1, selections: {}, sheets: {} };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        version: 1,
        selections: parsed?.selections && typeof parsed.selections === 'object' ? parsed.selections : {},
        sheets: parsed?.sheets && typeof parsed.sheets === 'object' ? parsed.sheets : {},
      };
    } catch (_) {
      return { version: 1, selections: {}, sheets: {} };
    }
  }

  _save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    const body = { ...this.data, updatedAt: new Date().toISOString() };
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  _sheetKey(playbookId, gameplanId) {
    return String(playbookId) + '::' + String(gameplanId);
  }

  listGameplans() {
    return listGameplans();
  }

  prepare(playbook, { gameplanId = null, aggressiveness = null } = {}) {
    if (!playbook?.id || !Array.isArray(playbook.plays)) {
      return { available: false, reason: 'A loaded offensive playbook is required.' };
    }
    const saved = this.data.selections[String(playbook.id)] || {};
    const plan = getGameplan(gameplanId || saved.gameplanId || 'balanced_multiple');
    const aggression = normalizeAggressiveness(aggressiveness == null ? saved.aggressiveness : aggressiveness);
    const key = this._sheetKey(playbook.id, plan.id);
    let sheet = this.data.sheets[key] || null;
    let reused = true;
    if (!validSheet(sheet, playbook, plan.id)) {
      sheet = generateCallSheet({
        playbook,
        gameplanId: plan.id,
        targetSize: this.targetSize,
        audiblePackageStore: this.audiblePackageStore,
      });
      this.data.sheets[key] = sheet;
      reused = false;
    }

    this.data.selections[String(playbook.id)] = {
      gameplanId: plan.id,
      aggressiveness: aggression,
      updatedAt: new Date().toISOString(),
    };
    this.active = {
      playbookId: String(playbook.id),
      playbookName: playbook.name || null,
      gameplan: plan,
      aggressiveness: aggression,
      sheet,
    };
    this._save();
    return { ...this.summary(), reused };
  }

  setSelection(playbook, { gameplanId, aggressiveness } = {}) {
    return this.prepare(playbook, { gameplanId, aggressiveness });
  }

  regenerate(playbook) {
    if (!this.active || String(playbook?.id) !== this.active.playbookId) {
      return this.prepare(playbook);
    }
    const key = this._sheetKey(playbook.id, this.active.gameplan.id);
    delete this.data.sheets[key];
    // Deliberately preserve this.setup: halftime philosophy/call-sheet changes
    // must not erase what the defense has already seen in this game.
    return this.prepare(playbook, {
      gameplanId: this.active.gameplan.id,
      aggressiveness: this.active.aggressiveness,
    });
  }

  updateAggressiveness(value) {
    if (!this.active || !Number.isFinite(Number(value))) return this.summary();
    this.active.aggressiveness = normalizeAggressiveness(value);
    return this.summary();
  }

  summary() {
    if (!this.active) {
      return {
        available: false,
        gameplans: this.listGameplans(),
        gameplanId: null,
        gameplanName: null,
        aggressiveness: 50,
        callSheetSize: 0,
      };
    }
    return {
      available: true,
      gameplans: this.listGameplans(),
      playbookId: this.active.playbookId,
      playbookName: this.active.playbookName,
      gameplanId: this.active.gameplan.id,
      gameplanName: this.active.gameplan.name,
      aggressiveness: this.active.aggressiveness,
      callSheetSize: this.active.sheet?.entries?.length || 0,
      generatedAt: this.active.sheet?.generatedAt || null,
      setup: this.setup.summary(),
    };
  }

  getCallSheet(playbook = null) {
    if (!this.active) return null;
    if (playbook?.id != null && String(playbook.id) !== this.active.playbookId) return null;
    return this.active.sheet;
  }

  scopePlaybook(playbook, situation = {}) {
    if (!this.active || String(playbook?.id) !== this.active.playbookId) {
      return { playbook, meta: { applied: false, reason: 'No active matching gameplan.' } };
    }
    const sheet = this.active.sheet;
    const buckets = situationBuckets(situation);
    const entryById = new Map(sheet.entries.map(entry => [String(entry.playId), entry]));
    const strongContext = buckets.some(isStrongSituationBucket);
    let eligibleEntries = sheet.entries.filter(entry =>
      entry.tags.some(tag => buckets.includes(tag)) ||
      (!strongContext && entry.tags.includes('CORE_CALL'))
    );
    if (eligibleEntries.length < MIN_SITUATION_POOL) {
      const seen = new Set(eligibleEntries.map(entry => String(entry.playId)));
      for (const entry of sheet.entries) {
        if (eligibleEntries.length >= Math.min(MIN_SITUATION_POOL, sheet.entries.length)) break;
        if (seen.has(String(entry.playId))) continue;
        eligibleEntries.push(entry);
        seen.add(String(entry.playId));
      }
    }

    const eligibleIds = new Set(eligibleEntries.map(entry => String(entry.playId)));
    const scopedPlays = (playbook.plays || []).filter(play => eligibleIds.has(playKey(play)));
    return {
      playbook: {
        ...playbook,
        plays: scopedPlays,
        gameplanCallSheet: {
          gameplanId: this.active.gameplan.id,
          buckets,
          total: sheet.entries.length,
          eligible: scopedPlays.length,
        },
      },
      meta: {
        applied: true,
        gameplanId: this.active.gameplan.id,
        gameplanName: this.active.gameplan.name,
        aggressiveness: this.active.aggressiveness,
        buckets,
        callSheetSize: sheet.entries.length,
        eligible: scopedPlays.length,
        entryById,
      },
    };
  }

  scoreCandidate(play, situation = {}) {
    if (!this.active) {
      return {
        score: 0,
        components: {},
        reasons: [],
        planReasons: [],
        entry: null,
      };
    }
    const entry = this.active.sheet.entries.find(row => String(row.playId) === playKey(play)) || null;
    if (!entry) {
      return { score: 0, components: {}, reasons: [], planReasons: [], entry: null };
    }

    const desc = describePlay(play);
    const setup = this.setup.score(play, entry);
    const aggression = aggressionModifier(desc, this.active.gameplan, this.active.aggressiveness, situation);
    const audibleFlexibility = audiblePackageValue(this.audiblePackageStore, this.active.playbookId, play.formation);
    const strategic = strategicPlayScore(play, situation);
    const setupSummary = this.setup.summary();
    const neutralTotal = setupSummary.neutralMix.run + setupSummary.neutralMix.hybrid + setupSummary.neutralMix.pass + setupSummary.neutralMix.screen;
    const runLikeNeutral = setupSummary.neutralMix.run + setupSummary.neutralMix.hybrid;
    const runLikeShare = neutralTotal ? runLikeNeutral / neutralTotal : null;
    let identityCorrection = 0;
    const identityReasons = [];
    if (this.active.gameplan.id === 'ground_control' && isNeutralSituation(situation) && neutralTotal >= 4) {
      const targetFloor = 0.52;
      const deficit = Math.max(0, targetFloor - Number(runLikeShare || 0));
      if (deficit > 0) {
        if (desc.runLike) identityCorrection = Math.min(1.4, deficit * 3.4);
        else if (desc.typeFamily === 'pass' && !desc.isPlayAction) identityCorrection = -Math.min(0.65, deficit * 1.4);
        if (Math.abs(identityCorrection) >= 0.08) {
          identityReasons.push(
            'Ground Control neutral run/run-hybrid mix is ' + Math.round((runLikeShare || 0) * 100) +
            '%; soft identity correction rewards valid run-like answers without overriding situation gates.'
          );
        }
      }
    }
    const components = {
      gameplanFit: clamp(Number(entry.gameplanScore || 0) * 0.34, -0.5, 2.1),
      callSheetMembership: 0.18,
      gameplanMixAccountability: identityCorrection,
      strategicSituation: strategic.score,
      sequencingValue: setup.components.sequencingValue,
      setupValue: setup.components.setupValue,
      payoffValue: setup.components.payoffValue,
      tendencyBreakingValue: setup.components.tendencyBreakingValue,
      aggression: aggression.score,
      audibleFlexibility,
    };
    return {
      score: Object.values(components).reduce((sum, value) => sum + Number(value || 0), 0),
      components,
      reasons: [
        ...identityReasons,
        ...strategic.reasons,
        ...setup.reasons,
        ...aggression.reasons,
        ...(audibleFlexibility >= 0.18 ? ['confirmed formation audible package adds modest tactical flexibility.'] : []),
      ],
      planReasons: entry.planReasons || [],
      entry,
      identity: {
        type: String(play.type || play.playKind || '').toUpperCase() || desc.typeFamily.toUpperCase(),
        core: [...new Set([...(play.concepts || []), play.primaryConcept].filter(Boolean).map(normalize))],
        threats: desc.threatKeys,
        provenance: play.authoritativeStructure ? 'AUTHORITATIVE' : (play.concepts?.length ? 'CATALOG' : desc.structure?.provenance || 'HEURISTIC'),
      },
      mix: { neutralTotal, runLikeShare },
    };
  }

  record(event) {
    return this.setup.record(event);
  }

  resetSession() {
    this.setup.reset();
    return this.summary();
  }

  halftimeReview({ performanceStore = null } = {}) {
    const setup = this.setup.summary();
    const exact = new Map();
    for (const row of setup.rows || []) {
      exact.set(row.playName || row.playId, (exact.get(row.playName || row.playId) || 0) + 1);
    }
    const mostUsedPlays = [...exact.entries()].sort((a,b) => b[1]-a[1]).slice(0,5).map(([play, attempts]) => ({ play, attempts }));
    const repetitionWarnings = mostUsedPlays.filter(row => row.attempts >= 6).map(row => ({
      play: row.play,
      attempts: row.attempts,
      reason: 'Exact play usage is high enough for diminishing-value/repetition review.',
    }));
    return {
      gameplan: this.active?.gameplan?.name || null,
      mix: setup.mix,
      neutralMix: setup.neutralMix,
      formations: setup.formations,
      concepts: setup.concepts,
      mostUsedPlays,
      repetitionWarnings,
      recommendations: this.review({ performanceStore }),
    };
  }

  review({ performanceStore = null } = {}) {
    if (!this.active || !performanceStore) return [];
    const reviews = [];
    const sheet = this.active.sheet;
    const usedByFormation = new Map();

    for (const entry of sheet.entries) {
      const summary = performanceStore.summarizePlay(entry.playId);
      if (!summary.attempts) continue;
      usedByFormation.set(entry.formation, (usedByFormation.get(entry.formation) || 0) + summary.attempts);

      if (summary.attempts >= 3 && summary.situationalSuccessRate != null && summary.situationalSuccessRate <= 0.34) {
        reviews.push({
          status: entry.role === 'CORE' ? 'WATCH' : 'REDUCE',
          play: entry.playName,
          formation: entry.formation,
          reason: 'Recorded situational success is ' + Math.round(summary.situationalSuccessRate * 100) +
            '% across ' + summary.attempts + ' calls; review usage without auto-mutating the gameplan.',
        });
      } else if (summary.attempts >= 2 && summary.situationalSuccessRate != null && summary.situationalSuccessRate >= 0.60) {
        const payoff = entry.tags.includes('SETUP_PAYOFF');
        reviews.push({
          status: payoff ? 'EXPAND' : 'KEEP',
          play: entry.playName,
          formation: entry.formation,
          reason: payoff
            ? 'Payoff/complement produced useful results after meaningful usage.'
            : 'Call produced consistently useful situations in this game.',
        });
      }
    }

    for (const [formation, attempts] of usedByFormation.entries()) {
      if (attempts < 4) continue;
      const formationEntries = sheet.entries.filter(entry => entry.formation === formation);
      if (!formationEntries.some(entry => entry.tags.includes('PRESSURE_ANSWER'))) {
        reviews.push({
          status: 'ADD',
          play: null,
          formation,
          reason: 'Frequently used formation lacks a call-sheet pressure answer; consider adding one if the playbook contains a valid option.',
        });
      }
    }

    const priority = { ADD: 0, EXPAND: 1, WATCH: 2, REDUCE: 3, KEEP: 4 };
    return reviews
      .sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9))
      .slice(0, 10);
  }
}

module.exports = {
  DEFAULT_TARGET_SIZE,
  GameplanEngine,
  SetupState,
  describePlay,
  gameplanFit,
  staticSituationTags,
  situationBuckets,
  relationshipBetween,
  generateCallSheet,
  validSheet,
  aggressionModifier,
  isNeutralSituation,
  isStrongSituationBucket,
};
