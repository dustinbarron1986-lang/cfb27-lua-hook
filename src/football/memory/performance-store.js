class PerformanceStore {
  constructor() { this.events = []; }
  record(event) { this.events.push(event); }
  getAll() { return [...this.events]; }

  summarize(predicate = () => true) {
    const rows = this.events.filter(predicate);
    if (!rows.length) return {
      attempts: 0, objectiveSuccessRate: null, situationalSuccessRate: null,
      avgYards: null, explosiveRate: null, turnoverRate: null
    };

    const avg = fn => rows.reduce((s, x) => s + Number(fn(x) || 0), 0) / rows.length;

    return {
      attempts: rows.length,
      objectiveSuccessRate: avg(x => x.grades?.offense?.objectiveSuccess ? 1 : 0),
      situationalSuccessRate: avg(x => x.grades?.offense?.situationalSuccess ? 1 : 0),
      avgYards: avg(x => x.result?.yards || 0),
      explosiveRate: avg(x => x.grades?.offense?.explosive ? 1 : 0),
      turnoverRate: avg(x => x.result?.turnover ? 1 : 0)
    };
  }

  summarizePlay(playId) { return this.summarize(x => x.play?.id === playId); }
  summarizeConcept(concept) { return this.summarize(x => (x.play?.concepts || []).includes(concept)); }
  summarizeFormation(formation) { return this.summarize(x => x.play?.formation === formation); }
}

module.exports = { PerformanceStore };
