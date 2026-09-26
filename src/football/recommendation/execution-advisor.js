const path = require("path");

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

function safeCreatePlayKnowledgeStore(options) {
  if (!PlayKnowledgeStore) return null;
  try {
    return new PlayKnowledgeStore(options || {});
  } catch (_) {
    return null;
  }
}

function detectConcept(play = {}) {
  // The catalog's primaryConcept is exact, verified data for this specific play
  // (e.g. "Shock H Option" -> "choice_option") and must win over any whitelist
  // guess derived from the play's broader concepts[] tag list.
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

class ExecutionAdvisor {
  constructor(options = {}) {
    this.knowledge = options.knowledgeEngine ||
      (KnowledgeEngine ? new KnowledgeEngine(options.knowledgeOptions || {}) : null);
    this.playKnowledge = options.playKnowledgeStore !== undefined
      ? options.playKnowledgeStore
      : safeCreatePlayKnowledgeStore(options.playKnowledgeOptions);
  }

  // Conservative: only look up play-specific knowledge when the selected play
  // carries a known source playbook id (set by the DB-backed playbook
  // repository) plus a formation and name to key on. A sample-JSON play, an
  // unsupported/unverified playbook, or an unrecognized name all simply
  // resolve to null here -- buildNoviceGuide then falls back to concept-level
  // (estimated) guidance rather than guessing at exact knowledge.
  _resolvePlayKnowledge(selectedPlay) {
    if (!this.playKnowledge) return null;
    if (selectedPlay?.sourcePlaybookId == null || !selectedPlay?.formation || !selectedPlay?.name) return null;
    try {
      return this.playKnowledge.resolve(selectedPlay.sourcePlaybookId, selectedPlay.formation, selectedPlay.name);
    } catch (_) {
      return null;
    }
  }

  advise({ selectedPlay, defensiveCall }) {
    if (!selectedPlay) return { available: false, reason: "selected play is required" };
    if (!defensiveCall?.name) return { available: false, reason: "defensive call not known yet" };
    if (!this.knowledge) return { available: false, reason: "football knowledge engine is not installed" };

    const concept = detectConcept(selectedPlay);
    const advice = this.knowledge.advise({
      concept,
      defensivePlayName: defensiveCall.name
    });

    const playKnowledge = this._resolvePlayKnowledge(selectedPlay);
    const guide = buildNoviceGuide
      ? buildNoviceGuide({ selectedPlay, advice, defensiveCall, playKnowledge })
      : null;

    return {
      available: Boolean(advice?.known),
      phase: "post_selection_execution",
      selectedPlay: {
        id: selectedPlay.id,
        name: selectedPlay.name,
        formation: selectedPlay.formation,
        concepts: selectedPlay.concepts || []
      },
      defense: defensiveCall,
      advice,
      guide
    };
  }
}

module.exports = { ExecutionAdvisor, detectConcept };
