const { gradeOffensivePlay, gradeDefensivePlay } = require("./scoring/success");
const { PerformanceStore } = require("./memory/performance-store");
const { SequenceMemory } = require("./sequencing/sequence-memory");
const { OpponentTendencies } = require("./recommendation/opponent-tendencies");
const { PlaySelectionEngine } = require("./recommendation/play-selection-engine");
const { ExecutionAdvisor } = require("./recommendation/execution-advisor");
const { DefensiveSelectionEngine } = require("./recommendation/defensive-selection-engine");
const { KnowledgeEngine } = require("./knowledge/knowledge-engine");

let DatabasePlaybookRepository = null;
try {
  ({ DatabasePlaybookRepository } = require("./playbooks/database-playbook-repository"));
} catch (_) {
  DatabasePlaybookRepository = null;
}

class FootballEngine {
  constructor(options = {}) {
    this.playbooks =
      options.playbooks ||
      (options.database && DatabasePlaybookRepository
        ? new DatabasePlaybookRepository(options.database, options.playbookOptions || {})
        : null);

    this.performance = new PerformanceStore();
    this.sequences = new SequenceMemory(this.performance);
    this.tendencies = new OpponentTendencies(this.performance);
    this.playSelection = new PlaySelectionEngine({
      store: this.performance,
      sequences: this.sequences,
      tendencies: this.tendencies
    });

    this.knowledge = options.knowledge || new KnowledgeEngine(options.knowledgeOptions || {});

    this.executionAdvisor = new ExecutionAdvisor({
      knowledgeEngine: this.knowledge,
      ...(options.executionAdvisor || {})
    });

    this.defensiveSelection = new DefensiveSelectionEngine({
      store: this.performance,
      knowledge: this.knowledge
    });
  }

  recordPlay(event) {
    // Tag recorded plays with their resolved concept/coverage family (via the
    // Stage 1 catalog-first KnowledgeEngine) so DefensiveSelectionEngine's
    // family-matchup queries (PerformanceStore.summarizeFamilyMatchup) have
    // something to match against later, even though the exact-play id may
    // never repeat.
    const offensePlay = this._withObservedFamily(event.play, "offense");
    const defensePlay = this._withObservedFamily(event.opponentPlay, "defense");

    const enriched = {
      ...event,
      play: offensePlay,
      opponentPlay: defensePlay,
      timestamp: event.timestamp || new Date().toISOString(),
      grades: {
        offense: gradeOffensivePlay(event),
        defense: gradeDefensivePlay(event)
      }
    };
    this.performance.record(enriched);
    return enriched;
  }

  _withObservedFamily(play, side) {
    if (!play) return play;

    if (side === "offense") {
      let conceptFamily = play.conceptFamily || null;
      if (!conceptFamily) {
        for (const value of [...(play.concepts || []), play.name]) {
          conceptFamily = this.knowledge.resolveConcept(value);
          if (conceptFamily) break;
        }
      }
      return { ...play, conceptFamily: conceptFamily || play.presentationFamily || null };
    }

    const coverageFamily =
      play.coverageFamily ||
      this.knowledge.resolveCoverage(play.name || (play.concepts || []).join(" ")) ||
      play.presentationFamily ||
      null;

    return { ...play, coverageFamily };
  }

  playSummary(playId) { return this.performance.summarizePlay(playId); }
  conceptSummary(concept) { return this.performance.summarizeConcept(concept); }
  sequenceLift(args) { return this.sequences.sequenceLift(args); }

  opponentTendency(situation, options) {
    return this.tendencies.summarize(situation, options);
  }

  getPlaybook(selector, options = {}) {
    if (!this.playbooks) {
      throw new Error("FootballEngine cannot resolve playbooks without a playbook repository or database.");
    }
    return this.playbooks.get(selector, options);
  }

  recommendPlays({ playbook, situation, limit = 5 }) {
    // Deliberately does NOT accept/use the current exact defensive call.
    return this.playSelection.rank({ playbook, situation, limit });
  }

  recommendDefenses({ playbook, offensePlay, situation, limit = 5 }) {
    // Unlike recommendPlays, the exact CPU offensive call is the intentional
    // defensive-oracle MVP input here -- this restriction is offense-only.
    const normalizedOffense = this._withObservedFamily(offensePlay, "offense");
    return this.defensiveSelection.rank({
      playbook,
      offensePlay: normalizedOffense,
      situation,
      limit
    });
  }

  adviseExecution({ selectedPlay, defensiveCall }) {
    // Deliberately post-selection: this is where exact live defense becomes relevant.
    return this.executionAdvisor.advise({ selectedPlay, defensiveCall });
  }
}

module.exports = { FootballEngine };
