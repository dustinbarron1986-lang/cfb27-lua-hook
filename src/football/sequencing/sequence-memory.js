'use strict';

function confidenceFromSample(n) {
  if (n >= 30) return "HIGH";
  if (n >= 12) return "MEDIUM";
  if (n >= 5) return "LOW";
  return "VERY_LOW";
}

function successRate(rows) {
  if (!rows.length) return null;
  return rows.reduce((s, x) => s + (x.grades?.offense?.situationalSuccess ? 1 : 0), 0) / rows.length;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function trailingUserDrive(events) {
  const rows = [];
  if (!events.length) return rows;

  // A drive is a contiguous possession block. If the most recent recorded
  // snap belongs to the opponent, the user's next drive has not recorded a
  // snap yet and prior-drive sequence exposure must not leak forward.
  const latestPossession = Number(events[events.length - 1]?.situation?.possession);
  if (Number.isFinite(latestPossession) && latestPossession !== 0) return rows;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (Number(event?.situation?.possession) !== 0) break;
    rows.unshift(event);
  }
  return rows;
}

function playFamily(play = {}) {
  const profile = play.normalizedProfile || {};
  return profile.runConcept || profile.passConcept || play.conceptFamily ||
    play.primaryConcept || play.presentationFamily || profile.primaryThreat || null;
}

function eventPresentation(event = {}) {
  const play = event.play || {};
  const profile = play.normalizedProfile || {};
  return {
    formation: play.formation || profile.formation || null,
    family: playFamily(play),
    decisionClass: profile.decisionClass || String(play.type || '').toLowerCase() || null,
    mechanism: profile.playMechanism || null,
    direction: play.runDirection || play.direction || play.side || null,
    hash: event.situation?.hash || null,
    fieldSide: event.situation?.fieldSide || event.situation?.hashGeometry?.fieldSide || null,
    boundarySide: event.situation?.boundarySide || event.situation?.hashGeometry?.boundarySide || null,
    success: Boolean(event.grades?.offense?.situationalSuccess),
  };
}

function relationshipBetween(setup = {}, candidate = {}) {
  const setupProfile = setup.normalizedProfile || {};
  const candidateProfile = candidate.normalizedProfile || {};
  const sameFormation = Boolean(setup.formation && candidate.formation &&
    String(setup.formation).toLowerCase() === String(candidate.formation).toLowerCase());
  const setupFamily = playFamily(setup);
  const candidateFamily = playFamily(candidate);

  if (!sameFormation) return { relationship: null, confidence: 'LOW', provenance: 'DERIVED' };
  if (setupProfile.decisionClass === 'run' && candidateProfile.playMechanism === 'play_action') {
    return { relationship: 'RUN_TO_PLAY_ACTION', confidence: 'MEDIUM', provenance: 'DERIVED' };
  }
  if (setupProfile.decisionClass === 'run' && candidateProfile.decisionClass === 'pass') {
    return { relationship: 'RUN_TO_COMPLEMENTARY_PASS', confidence: 'LOW', provenance: 'DERIVED' };
  }
  if (setupProfile.runFamily === 'zone' && candidateProfile.runFamily === 'perimeter') {
    return { relationship: 'INSIDE_TO_OUTSIDE', confidence: 'LOW', provenance: 'DERIVED' };
  }
  if (setupProfile.runFamily === 'perimeter' && ['zone','gap','man_duo'].includes(candidateProfile.runFamily)) {
    return { relationship: 'OUTSIDE_TO_INSIDE', confidence: 'LOW', provenance: 'DERIVED' };
  }
  if (setupProfile.decisionClass === 'pass' && candidateProfile.decisionClass === 'pass' &&
      setupFamily && candidateFamily && setupFamily !== candidateFamily) {
    return { relationship: 'PASS_TO_SAME_LOOK_COUNTER', confidence: 'LOW', provenance: 'DERIVED' };
  }
  return { relationship: null, confidence: 'VERY_LOW', provenance: 'DERIVED' };
}

class SequenceMemory {
  constructor(store) { this.store = store; }

  sequenceLift({ targetPlayId, setupConcept, window = 6, minOccurrences = 1, setupSuccessOnly = true }) {
    const events = this.store.getAll();
    const baseline = events.filter(e => e.play?.id === targetPlayId);
    const qualified = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.play?.id !== targetPlayId) continue;
      const prior = events.slice(Math.max(0, i - window), i);
      const hits = prior.filter(p => {
        if (!(p.play?.concepts || []).includes(setupConcept)) return false;
        return !setupSuccessOnly || Boolean(p.grades?.offense?.situationalSuccess);
      });
      if (hits.length >= minOccurrences) qualified.push(e);
    }

    const baselineRate = successRate(baseline);
    const conditionalRate = successRate(qualified);
    return {
      targetPlayId,
      setupConcept,
      window,
      minOccurrences,
      baseline: { attempts: baseline.length, successRate: baselineRate },
      conditional: { attempts: qualified.length, successRate: conditionalRate },
      sequenceLift: baselineRate == null || conditionalRate == null ? null : conditionalRate - baselineRate,
      confidence: confidenceFromSample(qualified.length)
    };
  }

  setupStrength({ setupConcept, window = 6 }) {
    const events = this.store.getAll().slice(-window);
    let score = 0;
    for (const e of events) {
      if (!(e.play?.concepts || []).includes(setupConcept)) continue;
      score += 1;
      if (e.grades?.offense?.situationalSuccess) score += 2;
      if (e.grades?.offense?.explosive) score += 1;
    }
    return { concept: setupConcept, window, rawScore: score };
  }

  driveState() {
    const events = trailingUserDrive(this.store.getAll());
    const formations = {};
    const families = {};
    const decisionClasses = {};
    for (const event of events) {
      const row = eventPresentation(event);
      if (row.formation) formations[row.formation] = (formations[row.formation] || 0) + 1;
      if (row.family) families[row.family] = (families[row.family] || 0) + 1;
      if (row.decisionClass) decisionClasses[row.decisionClass] = (decisionClasses[row.decisionClass] || 0) + 1;
    }
    return {
      plays: events.length,
      formations,
      families,
      decisionClasses,
      rows: events.map(eventPresentation),
      provenance: 'LOCAL_OBSERVED',
    };
  }

  intent(playbook = []) {
    const events = trailingUserDrive(this.store.getAll());
    if (!events.length) {
      return { type: 'ESTABLISH', formation: null, family: null, reason: 'No current-drive exposure yet; establish a credible base presentation.', confidence: 'LOW' };
    }

    const rows = events.map(eventPresentation);
    const formationCounts = new Map();
    for (const row of rows) if (row.formation) formationCounts.set(row.formation, (formationCounts.get(row.formation) || 0) + 1);
    const [formation, count] = [...formationCounts.entries()].sort((a,b) => b[1]-a[1])[0] || [null,0];
    const fromFormation = formation ? events.filter(e => String(e.play?.formation || '') === String(formation)) : [];
    const successful = fromFormation.filter(e => e.grades?.offense?.situationalSuccess);
    const setup = successful[successful.length - 1]?.play || fromFormation[fromFormation.length - 1]?.play || events[events.length - 1]?.play;

    if (formation && count >= 2 && setup) {
      const complements = playbook
        .map(play => ({ play, relation: relationshipBetween(setup, play) }))
        .filter(row => row.relation.relationship);
      if (complements.length) {
        return {
          type: 'PAYOFF',
          formation,
          family: playFamily(setup),
          setupPlayId: setup.id,
          relationships: unique(complements.map(row => row.relation.relationship)),
          reason: 'The current drive has shown the same presentation enough to make a complementary answer credible.',
          confidence: successful.length >= 2 ? 'MEDIUM' : 'LOW',
        };
      }
    }

    return {
      type: 'ESTABLISH',
      formation,
      family: playFamily(setup),
      reason: successful.length
        ? 'Continue establishing a productive current-drive presentation until a credible complement emerges.'
        : 'Current-drive presentation is not yet established strongly enough to force a payoff.',
      confidence: 'LOW',
    };
  }

  candidateIntentFit(play, intent, playbook = []) {
    if (!intent) return { aligned: false, tier: 0, relationship: null, reason: null };
    if (intent.type === 'PAYOFF' && intent.setupPlayId != null) {
      const setup = playbook.find(row => String(row.id) === String(intent.setupPlayId));
      const relation = relationshipBetween(setup || {}, play);
      if (relation.relationship) {
        return {
          aligned: true,
          tier: 2,
          relationship: relation.relationship,
          reason: 'Candidate preserves the established presentation and supplies a discovered sequence complement.',
          provenance: relation.provenance,
        };
      }
    }
    if (intent.type === 'ESTABLISH' && intent.formation &&
        String(play.formation || '') === String(intent.formation)) {
      return {
        aligned: true,
        tier: 1,
        relationship: 'SAME_LOOK_ESTABLISHMENT',
        reason: 'Candidate continues the current-drive presentation without forcing artificial variety.',
        provenance: 'DERIVED',
      };
    }
    return { aligned: false, tier: 0, relationship: null, reason: null, provenance: 'DERIVED' };
  }
}

module.exports = {
  SequenceMemory,
  confidenceFromSample,
  trailingUserDrive,
  playFamily,
  relationshipBetween,
};
