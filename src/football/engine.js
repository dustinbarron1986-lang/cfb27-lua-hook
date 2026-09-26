const { gradeOffensivePlay, gradeDefensivePlay } = require("./scoring/success");
const { PerformanceStore } = require("./memory/performance-store");
const { SequenceMemory } = require("./sequencing/sequence-memory");
const { OpponentTendencies } = require("./recommendation/opponent-tendencies");
const { PlaySelectionEngine } = require("./recommendation/play-selection-engine");
const { ExecutionAdvisor } = require("./recommendation/execution-advisor");

class FootballEngine {
  constructor(options = {}) {
    this.performance = new PerformanceStore();
    this.sequences = new SequenceMemory(this.performance);
    this.tendencies = new OpponentTendencies(this.performance);
    this.playSelection = new PlaySelectionEngine({
      store: this.performance,
      sequences: this.sequences,
      tendencies: this.tendencies
    });
    this.executionAdvisor = new ExecutionAdvisor(options.executionAdvisor || {});
  }

  recordPlay(event) {
    const enriched = {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
      grades: {
        offense: gradeOffensivePlay(event),
        defense: gradeDefensivePlay(event)
      }
    };
    this.performance.record(enriched);
    return enriched;
  }

  playSummary(playId) { return this.performance.summarizePlay(playId); }
  conceptSummary(concept) { return this.performance.summarizeConcept(concept); }
  sequenceLift(args) { return this.sequences.sequenceLift(args); }

  opponentTendency(situation, options) {
    return this.tendencies.summarize(situation, options);
  }

  recommendPlays({ playbook, situation, limit = 5 }) {
    // Deliberately does NOT accept/use the current exact defensive call.
    return this.playSelection.rank({ playbook, situation, limit });
  }

  adviseExecution({ selectedPlay, defensiveCall }) {
    // Deliberately post-selection: this is where exact live defense becomes relevant.
    return this.executionAdvisor.advise({ selectedPlay, defensiveCall });
  }
}

module.exports = { FootballEngine };
