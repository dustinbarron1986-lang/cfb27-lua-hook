const path = require("path");

let KnowledgeEngine = null;
try {
  ({ KnowledgeEngine } = require("../knowledge/knowledge-engine"));
} catch (_) {
  KnowledgeEngine = null;
}

function detectConcept(play = {}) {
  const concepts = play.concepts || [];
  const preferred = [
    "rpo_glance_post", "rpo_bubble", "four_verticals", "mesh", "shallow",
    "flood", "smash", "stick_spacing", "slants", "screen_bubble",
    "inside_zone", "outside_zone", "counter", "read_option"
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
      advice
    };
  }
}

module.exports = { ExecutionAdvisor, detectConcept };
