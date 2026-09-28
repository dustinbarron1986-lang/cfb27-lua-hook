const { gradeOffensivePlay, gradeDefensivePlay } = require("./scoring/success");
const { PerformanceStore } = require("./memory/performance-store");
const { RecommendationHistory } = require("./memory/recommendation-history");
const { SequenceMemory } = require("./sequencing/sequence-memory");
const { OpponentTendencies } = require("./recommendation/opponent-tendencies");
const { PlaySelectionEngine } = require("./recommendation/play-selection-engine");
const { ExecutionAdvisor } = require("./recommendation/execution-advisor");
const { DefensiveSelectionEngine } = require("./recommendation/defensive-selection-engine");
const { KnowledgeEngine } = require("./knowledge/knowledge-engine");
const { classifyOffensiveStructure, classifyDefensiveStructure } = require("./analysis/structural-threat-model");
const { AudiblePackageStore } = require("./recommendation/audible-package-store");

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
    this.audiblePackages = options.audiblePackageStore || new AudiblePackageStore({
      filePath: options.audiblePackagePath || null,
    });
    this.sequences = new SequenceMemory(this.performance);
    this.knowledge = options.knowledge || new KnowledgeEngine(options.knowledgeOptions || {});
    this.recommendationHistory = options.recommendationHistory || new RecommendationHistory();
    this.tendencies = new OpponentTendencies(this.performance, { knowledge: this.knowledge });
    this.playSelection = new PlaySelectionEngine({
      store: this.performance,
      sequences: this.sequences,
      tendencies: this.tendencies,
      knowledge: this.knowledge,
      recommendationHistory: this.recommendationHistory
    });

    this.executionAdvisor = new ExecutionAdvisor({
      knowledgeEngine: this.knowledge,
      ...(options.executionAdvisor || {})
    });

    this.defensiveSelection = new DefensiveSelectionEngine({
      store: this.performance,
      knowledge: this.knowledge,
      tendencies: this.tendencies,
      recommendationHistory: this.recommendationHistory
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
      play: {
        ...offensePlay,
        structural: offensePlay?.structural || classifyOffensiveStructure(
          offensePlay || {},
          offensePlay?.authoritativeStructure || null
        )
      },
      opponentPlay: defensePlay ? {
        ...defensePlay,
        structural: defensePlay.structural || classifyDefensiveStructure(defensePlay, this.knowledge)
      } : defensePlay,
      timestamp: event.timestamp || new Date().toISOString(),
    };
    enriched.grades = {
      offense: gradeOffensivePlay(enriched),
      defense: gradeDefensivePlay(enriched)
    };
    this.performance.record(enriched);
    return enriched;
  }

  recordRecommendation(side, recommendation, context = {}) {
    return this.recommendationHistory.record(side, recommendation, context);
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

    const descriptor = this.knowledge.catalogResolver?.describeDefensivePlay?.(play.name) || null;
    const coverageFamily =
      play.coverageFamily ||
      descriptor?.coverageFamily ||
      this.knowledge.resolveCoverage(play.name || (play.concepts || []).join(" ")) ||
      play.presentationFamily ||
      null;

    return {
      ...play,
      coverageFamily,
      assignmentFamilies: play.assignmentFamilies?.length ? play.assignmentFamilies : (descriptor?.assignmentFamilies || []),
      concepts: play.concepts?.length ? play.concepts : (descriptor?.concepts || [])
    };
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

  recommendPlays({ playbook, defensePlay = null, situation, limit = 5 }) {
    // ORACLE/OMNISCIENT mode: the exact CPU defensive call may define the
    // structural counter envelope. Missing defense data degrades to the
    // previous pre-call model rather than fabricating opponent structure.
    const normalizedDefense = defensePlay ? this._withObservedFamily(defensePlay, "defense") : null;
    return this.playSelection.rank({
      playbook,
      defensePlay: normalizedDefense,
      situation,
      limit
    });
  }

  recommendDefenses({ playbook, offensePlay, situation, limit = 5 }) {
    // Unlike recommendPlays, the exact CPU offensive call is the intentional
    // defensive-oracle MVP input here -- this restriction is offense-only.
    const normalizedOffense = this._withObservedFamily(offensePlay, "offense");
    const structuralOffense = {
      ...normalizedOffense,
      structural: normalizedOffense?.structural || classifyOffensiveStructure(
        normalizedOffense || {},
        normalizedOffense?.authoritativeStructure || null
      )
    };
    return this.defensiveSelection.rank({
      playbook,
      offensePlay: structuralOffense,
      situation,
      limit
    });
  }

  prepareAudiblePackages(playbook) {
    return this.audiblePackages.ensureForPlaybook(playbook);
  }

  getAudiblePackage(playbook, formation) {
    if (!playbook || !formation) return null;
    return this.audiblePackages.ensurePackage(playbook, formation);
  }

  listAudiblePackages(playbook) {
    return this.audiblePackages.ensureForPlaybook(playbook);
  }

  confirmAudiblePackage(playbook, formation, playIds) {
    return this.audiblePackages.confirmPackage({ playbook, formation, playIds });
  }

  reviewAudiblePackages(playbook, options = {}) {
    return this.audiblePackages.review({
      playbook,
      performanceStore: this.performance,
      ...options,
    });
  }

  adviseExecution({ selectedPlay, defensiveCall, playbook = null, situation = null }) {
    // Deliberately post-selection: this is where exact live defense becomes relevant.
    const audiblePackage = playbook && selectedPlay?.formation
      ? this.audiblePackages.ensurePackage(playbook, selectedPlay.formation)
      : null;
    return this.executionAdvisor.advise({
      selectedPlay,
      defensiveCall,
      audiblePackage,
      playbook,
      situation,
      performanceStore: this.performance,
    });
  }
}

module.exports = { FootballEngine };
