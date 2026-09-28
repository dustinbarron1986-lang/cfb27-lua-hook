let KnowledgeEngine = null;
try {
  ({ KnowledgeEngine } = require("../knowledge/knowledge-engine"));
} catch (_) {
  KnowledgeEngine = null;
}

let PlayKnowledgeStore = null;
try {
  ({ PlayKnowledgeStore } = require("../knowledge/play-knowledge-store"));
} catch (_) {
  PlayKnowledgeStore = null;
}

let buildNoviceGuide = null;
try {
  ({ buildNoviceGuide } = require("./novice-execution-guide"));
} catch (_) {
  buildNoviceGuide = null;
}

let advisePreSnapAudible = null;
try {
  ({ advisePreSnapAudible } = require("./pre-snap-audible-advisor"));
} catch (_) {
  advisePreSnapAudible = null;
}

let buildPassingPlayArt = null;
let deriveStructuralProgression = null;
let analyzeRunAssignments = null;
let buildAuthoritativePlayStructure = null;
let deriveRunExecution = null;
let deriveScreenExecution = null;
let deriveRpoExecution = null;
let authoritativeReceiverRows = null;
try {
  ({ buildPassingPlayArt } = require("../analysis/play-art-engine"));
  ({ deriveStructuralProgression } = require("../analysis/passing-progression-engine"));
  ({ analyzeRunAssignments } = require("../analysis/run-gap-engine"));
  ({
    buildAuthoritativePlayStructure,
    deriveRunExecution,
    deriveScreenExecution,
    deriveRpoExecution,
    authoritativeReceiverRows,
  } = require("../analysis/authoritative-play-structure"));
} catch (_) {
  buildPassingPlayArt = null;
  deriveStructuralProgression = null;
  analyzeRunAssignments = null;
  buildAuthoritativePlayStructure = null;
  deriveRunExecution = null;
  deriveScreenExecution = null;
  deriveRpoExecution = null;
  authoritativeReceiverRows = null;
}

function safeCreatePlayKnowledgeStore(options) {
  if (!PlayKnowledgeStore) return null;
  try {
    return new PlayKnowledgeStore(options || {});
  } catch (_) {
    return null;
  }
}

function detectConcept(play = {}) {
  if (play.primaryConcept && String(play.primaryConcept).trim()) {
    return String(play.primaryConcept).trim();
  }

  const concepts = play.concepts || [];
  const preferred = [
    "rpo_glance_post", "rpo_bubble", "four_verticals", "mesh", "shallow",
    "flood", "smash", "stick_spacing", "slants", "screen_bubble",
    "inside_zone", "outside_zone", "counter", "read_option",
    "choice_option", "corner"
  ];

  for (const p of preferred) {
    if (concepts.some(c => String(c).toLowerCase() === p)) return p;
  }
  return play.name || concepts[0] || null;
}

function unknownAdvice(concept) {
  return {
    known: false,
    concept: concept || null,
    headline: null,
    reasons: [],
    coaching: { preSnap: [], postSnap: [] },
    coverage: null,
    pressureDetected: false,
  };
}

class ExecutionAdvisor {
  constructor(options = {}) {
    this.knowledge = options.knowledgeEngine ||
      (KnowledgeEngine ? new KnowledgeEngine(options.knowledgeOptions || {}) : null);
    this.playKnowledge = options.playKnowledgeStore !== undefined
      ? options.playKnowledgeStore
      : safeCreatePlayKnowledgeStore(options.playKnowledgeOptions);
    this.eaPlayKnowledge = options.eaPlayKnowledgeStore || null;
  }

  _resolvePlayKnowledge(selectedPlay) {
    if (!this.playKnowledge) return null;
    if (selectedPlay?.sourcePlaybookId == null || !selectedPlay?.formation || !selectedPlay?.name) return null;
    try {
      return this.playKnowledge.resolve(selectedPlay.sourcePlaybookId, selectedPlay.formation, selectedPlay.name);
    } catch (_) {
      return null;
    }
  }

  _resolveAuthoritativePlayKnowledge(selectedPlay, advice) {
    const playKey = selectedPlay?.eaAuthority?.playKey;
    if (!playKey || !this.eaPlayKnowledge || !buildAuthoritativePlayStructure) return null;

    let expanded;
    try {
      expanded = this.eaPlayKnowledge.expandPlay(playKey);
    } catch (_) {
      return null;
    }
    const structure = buildAuthoritativePlayStructure(expanded);
    if (!structure?.available) return null;

    const receiverButtons = authoritativeReceiverRows ? authoritativeReceiverRows(structure) : [];
    const enriched = {
      authoritative: structure,
      source: 'ea_authoritative_play',
      receiverButtons,
      assignmentPlayArt: structure.playArt,
      progressionVerified: false,
      routeArtVerified: false,
      routeKnowledge: structure.playArt?.exactAssignmentCount ? 'ea_assignment_geometry' : 'unknown',
    };

    const kind = structure.classification?.kind;
    if (kind === 'run') {
      if (analyzeRunAssignments) {
        const assignments = structure.players.map(player => ({
          player: player.label,
          position: player.label,
          eaAssignment: player.eaAssignment,
        }));
        enriched.runGap = analyzeRunAssignments(assignments, { runHole: structure.play?.runHole });
      }
      if (deriveRunExecution) enriched.structuralRun = deriveRunExecution(structure, enriched.runGap);
      return enriched;
    }

    if (kind === 'screen') {
      if (deriveScreenExecution) enriched.derivedProgression = deriveScreenExecution(structure);
      return enriched;
    }

    if (kind === 'rpo') {
      if (deriveRpoExecution) enriched.derivedProgression = deriveRpoExecution(structure);
      return enriched;
    }

    if (deriveStructuralProgression && structure.playArt?.exactAssignmentCount >= 2) {
      enriched.derivedProgression = deriveStructuralProgression({
        playArt: structure.playArt,
        coverage: advice?.coverage || null,
        pressure: Boolean(advice?.pressureDetected),
      });
      if (structure.classification?.playAction) {
        enriched.derivedProgression = {
          ...enriched.derivedProgression,
          playAction: true,
          playActionEvidence: structure.classification.qbActions.includes('ID_HANDOFF_FAKE')
            ? 'ID_HANDOFF_FAKE'
            : structure.play?.offensePlayType || null,
        };
      }
    }
    return enriched;
  }

  _deriveLegacyAssignmentKnowledge(selectedPlay, advice, playKnowledge) {
    if (!playKnowledge) return null;
    const enriched = { ...playKnowledge };

    if (selectedPlay?.type === 'RUN') {
      if (analyzeRunAssignments) {
        enriched.runGap = analyzeRunAssignments([], { runHole: selectedPlay.runHole });
      }
      return enriched;
    }

    if (!buildPassingPlayArt || !deriveStructuralProgression) return enriched;
    const art = buildPassingPlayArt(enriched.receiverButtons || []);
    enriched.assignmentPlayArt = art;
    if (art.exactAssignmentCount >= 2) {
      enriched.derivedProgression = deriveStructuralProgression({
        playArt: art,
        coverage: advice?.coverage || null,
        pressure: Boolean(advice?.pressureDetected),
      });
    }
    return enriched;
  }

  advise({ selectedPlay, defensiveCall }) {
    if (!selectedPlay) return { available: false, reason: "selected play is required" };
    if (!defensiveCall?.name) return { available: false, reason: "defensive call not known yet" };

    const concept = detectConcept(selectedPlay);
    let advice = unknownAdvice(concept);
    if (this.knowledge) {
      try {
        advice = this.knowledge.advise({
          concept,
          defensivePlayName: defensiveCall.name
        }) || advice;
      } catch (_) {
        advice = unknownAdvice(concept);
      }
    }

    const authoritative = this._resolveAuthoritativePlayKnowledge(selectedPlay, advice);
    const legacy = authoritative ? null : this._resolvePlayKnowledge(selectedPlay);
    const playKnowledge = authoritative || this._deriveLegacyAssignmentKnowledge(selectedPlay, advice, legacy);
    const guide = buildNoviceGuide
      ? buildNoviceGuide({ selectedPlay, advice, defensiveCall, playKnowledge })
      : null;
    const audible = advisePreSnapAudible
      ? advisePreSnapAudible({
          selectedPlay,
          authoritativeClassification: authoritative?.authoritative?.classification || null,
          defensiveCall,
        })
      : null;

    const authoritativeUseful = Boolean(
      authoritative?.structuralRun?.available ||
      authoritative?.derivedProgression?.available
    );
    const available = Boolean(advice?.known || authoritativeUseful);

    return {
      available,
      reason: available ? null : (this.knowledge ? 'play not mapped to concept or authoritative structural guidance' : 'football knowledge engine is not installed'),
      phase: "post_selection_execution",
      selectedPlay: {
        id: selectedPlay.id,
        name: selectedPlay.name,
        formation: selectedPlay.formation,
        concepts: selectedPlay.concepts || []
      },
      defense: defensiveCall,
      advice,
      guide,
      audible,
      authority: authoritative?.authoritative || null,
    };
  }
}

module.exports = { ExecutionAdvisor, detectConcept };
