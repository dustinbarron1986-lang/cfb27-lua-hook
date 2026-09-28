'use strict';

const BOX = Object.freeze({
  LIGHT: 'LIGHT',
  NEUTRAL: 'NEUTRAL',
  HEAVY: 'HEAVY',
});

const CONFIDENCE = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
});

const OFFENSE = Object.freeze({
  RUN: 'RUN',
  PASS: 'PASS',
  AMBIGUOUS: 'AMBIGUOUS',
});

function clean(value) {
  return String(value || '').trim();
}

function classifyDefensiveBox(defensiveCall = {}) {
  const set = clean(defensiveCall.set || defensiveCall.formation);
  const name = clean(defensiveCall.name);
  const text = [set, name].filter(Boolean).join(' ');

  if (/\b(goal\s*line|gl\s*6[- ]?2|6[- ]?2)\b/i.test(text)) {
    return {
      classification: BOX.HEAVY,
      confidence: CONFIDENCE.HIGH,
      provenance: 'HEURISTIC',
      reasons: ['explicit goal-line / 6-2 presentation strongly implies a condensed heavy box'],
    };
  }

  if (/\b(dime|dollar|prevent)\b/i.test(set)) {
    return {
      classification: BOX.LIGHT,
      confidence: CONFIDENCE.MEDIUM,
      provenance: 'HEURISTIC',
      reasons: ['sub-package presentation is lighter personnel, but no literal defender count is exposed'],
    };
  }

  if (/\b(dbl\s*mug|double\s*mug|load\s+(?:dbl|double)\s*mug|mug)\b/i.test(set)) {
    return {
      classification: BOX.HEAVY,
      confidence: CONFIDENCE.MEDIUM,
      provenance: 'HEURISTIC',
      reasons: ['mugged second-level presentation shows a heavy box picture without proving an exact defender count'],
    };
  }

  if (/\b(nickel|mint|3[- ]3|3[- ]4|4[- ]2[- ]5|4[- ]3|over|under|tite|grizzly)\b/i.test(set)) {
    return {
      classification: BOX.NEUTRAL,
      confidence: CONFIDENCE.MEDIUM,
      provenance: 'HEURISTIC',
      reasons: ['base/sub-package structure alone does not prove a light or heavy box'],
    };
  }

  return {
    classification: BOX.NEUTRAL,
    confidence: CONFIDENCE.LOW,
    provenance: 'HEURISTIC',
    reasons: ['available telemetry does not establish a trustworthy box tendency'],
  };
}

function normalizeOffenseIntent({ selectedPlay = {}, authoritativeClassification = null } = {}) {
  const authoritativeKind = clean(authoritativeClassification?.kind).toLowerCase();
  if (authoritativeKind === 'run') {
    return {
      family: OFFENSE.RUN,
      confidence: CONFIDENCE.HIGH,
      provenance: 'EA_AUTHORED',
      reasons: ['EA-authored play classification identifies a run'],
    };
  }
  if (authoritativeKind === 'pass' || authoritativeKind === 'screen') {
    return {
      family: OFFENSE.PASS,
      confidence: CONFIDENCE.HIGH,
      provenance: 'EA_AUTHORED',
      reasons: [authoritativeKind === 'screen'
        ? 'EA-authored play classification identifies a screen/pass family'
        : 'EA-authored play classification identifies a pass'],
    };
  }
  if (authoritativeKind === 'rpo') {
    return {
      family: OFFENSE.AMBIGUOUS,
      confidence: CONFIDENCE.HIGH,
      provenance: 'EA_AUTHORED',
      reasons: ['EA-authored classification identifies an RPO, so forcing run/pass would discard the option structure'],
    };
  }

  const type = clean(selectedPlay.type).toUpperCase();
  if (type === 'RUN') {
    return {
      family: OFFENSE.RUN,
      confidence: CONFIDENCE.MEDIUM,
      provenance: 'PLAY_METADATA',
      reasons: ['play metadata identifies a run'],
    };
  }
  if (type === 'PASS' || type === 'SCREEN') {
    return {
      family: OFFENSE.PASS,
      confidence: CONFIDENCE.MEDIUM,
      provenance: 'PLAY_METADATA',
      reasons: ['play metadata identifies a pass family'],
    };
  }
  if (type === 'RPO' || type === 'OPTION') {
    return {
      family: OFFENSE.AMBIGUOUS,
      confidence: CONFIDENCE.MEDIUM,
      provenance: 'PLAY_METADATA',
      reasons: ['play metadata identifies a hybrid/option family'],
    };
  }

  return {
    family: OFFENSE.AMBIGUOUS,
    confidence: CONFIDENCE.LOW,
    provenance: 'UNRESOLVED',
    reasons: ['run/pass family is not trustworthy from the available play metadata'],
  };
}

function advisePreSnapAudible({ selectedPlay = {}, authoritativeClassification = null, defensiveCall = {} } = {}) {
  const offense = normalizeOffenseIntent({ selectedPlay, authoritativeClassification });
  const box = classifyDefensiveBox(defensiveCall);

  if (offense.family === OFFENSE.AMBIGUOUS) {
    return {
      decision: 'KEEP',
      actionable: false,
      offense,
      box,
      reason: 'Keep the selected call: offensive family is hybrid or unresolved.',
    };
  }

  if (box.classification === BOX.NEUTRAL || box.confidence === CONFIDENCE.LOW) {
    return {
      decision: 'KEEP',
      actionable: false,
      offense,
      box,
      reason: 'Keep the selected call: the box read is neutral or too uncertain to justify an audible.',
    };
  }

  if (offense.family === OFFENSE.PASS && box.classification === BOX.LIGHT) {
    return {
      decision: 'RUN',
      actionable: true,
      offense,
      box,
      reason: 'Light box against a pass-family call creates a conservative run-check opportunity.',
    };
  }

  if (offense.family === OFFENSE.RUN && box.classification === BOX.HEAVY) {
    return {
      decision: 'PASS',
      actionable: true,
      offense,
      box,
      reason: 'Heavy box against a run-family call creates a conservative pass-check opportunity.',
    };
  }

  return {
    decision: 'KEEP',
    actionable: false,
    offense,
    box,
    reason: 'Keep the selected call: the current family already fits the inferred box tendency.',
  };
}

module.exports = {
  BOX,
  CONFIDENCE,
  OFFENSE,
  classifyDefensiveBox,
  normalizeOffenseIntent,
  advisePreSnapAudible,
};
