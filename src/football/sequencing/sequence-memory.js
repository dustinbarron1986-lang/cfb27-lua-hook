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

// Relationship strength decides the payoff tier: a play-action or same-look
// counter is a real complement; "any pass from the same formation" is only a
// weak one and must not outrank repeating a working base play.
const RELATIONSHIP_TIER = Object.freeze({
  RUN_TO_PLAY_ACTION: 2,
  INSIDE_TO_OUTSIDE: 2,
  OUTSIDE_TO_INSIDE: 2,
  PASS_TO_SAME_LOOK_COUNTER: 2,
  RUN_TO_COMPLEMENTARY_PASS: 1,
});

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
      return { type: 'ESTABLISH', stage: 'ESTABLISH_BASE', formation: null, family: null, reason: 'No current-drive exposure yet; establish a credible base presentation.', confidence: 'LOW' };
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
        const setupFamily = playFamily(setup);
        const familyRows = fromFormation.filter(e => playFamily(e.play) === setupFamily);
        const latestSetupSucceeded = Boolean(familyRows[familyRows.length - 1]?.grades?.offense?.situationalSuccess);
        return {
          type: 'PAYOFF',
          // A working base play stays a first-class option (repeat what works);
          // after it is stopped, the complement leads. Payoff is never forced
          // merely because N calls have happened.
          stage: latestSetupSucceeded ? 'REPEAT_OR_PAYOFF' : 'PAYOFF_AFTER_STOP',
          formation,
          family: setupFamily,
          setupPlayId: setup.id,
          setupPlay: setup,
          latestSetupSucceeded,
          relationships: unique(complements.map(row => row.relation.relationship)),
          reason: latestSetupSucceeded
            ? 'The same presentation is working; repeating it and its complement are both credible.'
            : 'The same presentation was just stopped; a complementary answer from the same look is favored.',
          confidence: successful.length >= 2 ? 'MEDIUM' : 'LOW',
        };
      }
    }

    return {
      type: 'ESTABLISH',
      stage: 'ESTABLISH_SAME_LOOK',
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
      // intent() resolves the setup play once; the playbook lookup is only a
      // fallback for intents built elsewhere.
      const setup = intent.setupPlay || playbook.find(row => String(row.id) === String(intent.setupPlayId)) || {};
      const relation = relationshipBetween(setup, play);
      if (relation.relationship) {
        return {
          aligned: true,
          tier: RELATIONSHIP_TIER[relation.relationship] || 1,
          relationship: relation.relationship,
          reason: 'Candidate preserves the established presentation and supplies a discovered sequence complement.',
          provenance: relation.provenance,
        };
      }
      const sameLook = setup.formation && String(play.formation || '').toLowerCase() === String(setup.formation).toLowerCase();
      if (sameLook && playFamily(play) && playFamily(play) === intent.family) {
        return {
          aligned: true,
          tier: intent.latestSetupSucceeded ? 2 : 1,
          relationship: 'REPEAT_SUCCESSFUL_LOOK',
          reason: intent.latestSetupSucceeded
            ? 'Candidate repeats the working same-look answer; repetition is valid until the defense stops it.'
            : 'Candidate repeats the same-look answer that was just stopped.',
          provenance: 'DERIVED',
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
  RELATIONSHIP_TIER,
  SequenceMemory,
  confidenceFromSample,
  trailingUserDrive,
  playFamily,
  relationshipBetween,
};
