'use strict';

const GAMEPLANS = Object.freeze({
  balanced_multiple: Object.freeze({
    id: 'balanced_multiple',
    name: 'Balanced Multiple',
    description: 'Broad menu with enough run, quick game, intermediate, constraint, and shot answers to let opponent/situation evidence steer the call.',
    typeWeights: { run: 0.8, pass: 0.8, hybrid: 0.8, screen: 0.7 },
    threatWeights: {
      interior_run: 0.9, gap_run: 0.8, perimeter_run: 0.75, qb_run_option: 0.65,
      quick_horizontal: 0.9, crossing: 0.9, flood: 0.8, intermediate_middle: 0.85,
      vertical: 0.75, screen: 0.7, perimeter_access: 0.75,
    },
    modifierWeights: { PLAY_ACTION: 0.65, RPO_CONFLICT: 0.55, MOTION: 0.35, OPTION: 0.45, PULLER: 0.35 },
    conceptWeights: { mesh: 0.35, levels: 0.35, spacing: 0.35, zone: 0.25, power: 0.25, counter: 0.25 },
    formationWeights: [],
    aggressionStyle: 'balanced',
  }),
  air_raid: Object.freeze({
    id: 'air_raid',
    name: 'Air Raid',
    description: 'Pass-first core built around repeated quick/intermediate concepts, crossers, spacing, and answers to box/pressure structure.',
    typeWeights: { run: 0.15, pass: 1.2, hybrid: 0.65, screen: 0.85 },
    threatWeights: {
      crossing: 1.35, quick_horizontal: 1.25, intermediate_middle: 1.05, flood: 0.9,
      vertical: 0.85, screen: 0.8, perimeter_access: 0.75, interior_run: 0.35,
      gap_run: 0.15, perimeter_run: 0.2, qb_run_option: 0.25,
    },
    modifierWeights: { PLAY_ACTION: 0.25, RPO_CONFLICT: 0.45, MOTION: 0.25, OPTION: 0.15, PULLER: 0.05 },
    conceptWeights: { mesh: 1.3, shallow: 1.2, stick: 1.15, spacing: 1.15, cross: 1.0, y_cross: 1.05, quick: 0.8 },
    formationWeights: [['gun', 0.55], ['spread', 0.4], ['empty', 0.35]],
    aggressionStyle: 'pass',
  }),
  west_coast_rhythm: Object.freeze({
    id: 'west_coast_rhythm',
    name: 'West Coast / Rhythm',
    description: 'Quick and intermediate rhythm passing with RB involvement, spacing, levels, drags, slants, and efficient chain-moving answers.',
    typeWeights: { run: 0.45, pass: 1.05, hybrid: 0.55, screen: 0.8 },
    threatWeights: {
      quick_horizontal: 1.35, crossing: 1.2, intermediate_middle: 1.05, perimeter_access: 0.9,
      screen: 0.85, flood: 0.65, interior_run: 0.45, gap_run: 0.3, perimeter_run: 0.3,
      vertical: 0.35, qb_run_option: 0.2,
    },
    modifierWeights: { PLAY_ACTION: 0.45, RPO_CONFLICT: 0.3, MOTION: 0.3, OPTION: 0.1, PULLER: 0.1 },
    conceptWeights: { slant: 1.0, out: 0.9, drag: 1.0, spacing: 1.1, levels: 1.05, stick: 0.9, swing: 0.7 },
    formationWeights: [['singleback', 0.3], ['gun', 0.25], ['split', 0.2]],
    aggressionStyle: 'rhythm',
  }),
  vertical_attack: Object.freeze({
    id: 'vertical_attack',
    name: 'Vertical Attack',
    description: 'Vertical stress, posts, corners, seams, play-action shots, double moves, and intermediate calls that manipulate safeties.',
    typeWeights: { run: 0.25, pass: 1.15, hybrid: 0.45, screen: 0.25 },
    threatWeights: {
      vertical: 1.55, intermediate_middle: 1.2, flood: 0.9, crossing: 0.65,
      quick_horizontal: 0.35, screen: 0.2, perimeter_access: 0.3, interior_run: 0.35,
      gap_run: 0.3, perimeter_run: 0.25, qb_run_option: 0.15,
    },
    modifierWeights: { PLAY_ACTION: 1.05, MOTION: 0.35, RPO_CONFLICT: 0.15, OPTION: 0.05, PULLER: 0.15 },
    conceptWeights: { vertical: 1.0, verts: 1.0, post: 0.9, corner: 0.85, seam: 0.8, shot: 1.0, double: 0.8 },
    formationWeights: [['singleback', 0.25], ['gun', 0.2], ['trips', 0.2], ['bunch', 0.15]],
    aggressionStyle: 'vertical',
  }),
  spread_option_rpo: Object.freeze({
    id: 'spread_option_rpo',
    name: 'Spread Option / RPO',
    description: 'Conflict-player football: zone read, RPOs, QB option/run, access throws, and perimeter constraints from spread structures.',
    typeWeights: { run: 0.6, pass: 0.55, hybrid: 1.25, screen: 0.75 },
    threatWeights: {
      qb_run_option: 1.5, perimeter_access: 1.25, interior_run: 1.0, quick_horizontal: 1.0,
      perimeter_run: 0.85, screen: 0.8, crossing: 0.55, intermediate_middle: 0.45,
      flood: 0.35, gap_run: 0.45, vertical: 0.35,
    },
    modifierWeights: { RPO_CONFLICT: 1.5, OPTION: 1.3, MOTION: 0.7, PLAY_ACTION: 0.35, PULLER: 0.35 },
    conceptWeights: { rpo: 1.3, read: 1.0, option: 1.0, bubble: 0.9, glance: 0.8, zone: 0.65 },
    formationWeights: [['gun', 0.55], ['pistol', 0.4], ['spread', 0.45], ['trips', 0.2]],
    aggressionStyle: 'option',
  }),
  ground_control: Object.freeze({
    id: 'ground_control',
    name: 'Ground Control',
    description: 'Run-first identity built around inside zone, duo, power, counter, perimeter complements, and play action earned by established runs.',
    typeWeights: { run: 1.25, pass: 0.3, hybrid: 0.55, screen: 0.35 },
    threatWeights: {
      interior_run: 1.45, gap_run: 1.35, perimeter_run: 0.95, qb_run_option: 0.45,
      quick_horizontal: 0.35, crossing: 0.4, flood: 0.35, intermediate_middle: 0.45,
      vertical: 0.35, screen: 0.45, perimeter_access: 0.5,
    },
    modifierWeights: { PLAY_ACTION: 0.95, PULLER: 0.85, MOTION: 0.35, RPO_CONFLICT: 0.3, OPTION: 0.25 },
    conceptWeights: { inside_zone: 1.1, zone: 0.75, duo: 1.1, power: 1.0, counter: 1.0, stretch: 0.6, toss: 0.5 },
    formationWeights: [['singleback', 0.45], ['i form', 0.5], ['strong', 0.45], ['pistol', 0.2]],
    aggressionStyle: 'run',
  }),
  power_pro_style: Object.freeze({
    id: 'power_pro_style',
    name: 'Power / Pro Style',
    description: 'Heavier personnel and formations, downhill gap runs, play action, and vertical/intermediate complements.',
    typeWeights: { run: 1.05, pass: 0.5, hybrid: 0.35, screen: 0.25 },
    threatWeights: {
      gap_run: 1.5, interior_run: 1.15, perimeter_run: 0.65, intermediate_middle: 0.8,
      vertical: 0.75, flood: 0.6, crossing: 0.5, quick_horizontal: 0.35,
      screen: 0.3, perimeter_access: 0.3, qb_run_option: 0.15,
    },
    modifierWeights: { PLAY_ACTION: 1.25, PULLER: 1.05, MOTION: 0.25, RPO_CONFLICT: 0.1, OPTION: 0.05 },
    conceptWeights: { power: 1.15, counter: 1.05, iso: 0.9, duo: 0.8, trap: 0.75, play_action: 0.85 },
    formationWeights: [['i form', 0.8], ['strong', 0.75], ['singleback', 0.6], ['weak', 0.5], ['goal line', 0.25]],
    aggressionStyle: 'run_pa',
  }),
});

function listGameplans() {
  return Object.values(GAMEPLANS).map(plan => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
  }));
}

function getGameplan(id) {
  return GAMEPLANS[id] || GAMEPLANS.balanced_multiple;
}

module.exports = { GAMEPLANS, listGameplans, getGameplan };
