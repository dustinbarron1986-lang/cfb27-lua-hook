function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function average(rows, fn) {
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + finite(fn(row)), 0) / rows.length;
}

function emptySummary() {
  return {
    attempts: 0,
    objectiveSuccessRate: null,
    situationalSuccessRate: null,
    defensiveSuccessRate: null,
    avgYards: null,
    explosiveRate: null,
    explosiveAllowedRate: null,
    negativePlayRate: null,
    sackRate: null,
    turnoverRate: null,
    takeawayRate: null,
    resultGrade: null,
    lastResult: null
  };
}

class PerformanceStore {
  constructor(initialEvents = []) {
    this.events = Array.isArray(initialEvents) ? [...initialEvents] : [];
  }

  record(event) { this.events.push(event); }
  getAll() { return [...this.events]; }
  getRecent(limit = 10) { return this.events.slice(-Math.max(0, Number(limit) || 0)); }

  summarize(predicate = () => true) {
    const rows = this.events.filter(predicate);
    if (!rows.length) return emptySummary();

    const last = rows[rows.length - 1];
    return {
      attempts: rows.length,
      objectiveSuccessRate: average(rows, x => x.grades?.offense?.objectiveSuccess ? 1 : 0),
      situationalSuccessRate: average(rows, x => x.grades?.offense?.situationalSuccess ? 1 : 0),
      defensiveSuccessRate: average(rows, x => x.grades?.defense?.objectiveSuccess ? 1 : 0),
      avgYards: average(rows, x => x.result?.yards),
      explosiveRate: average(rows, x => x.grades?.offense?.explosive ? 1 : 0),
      explosiveAllowedRate: average(rows, x => x.grades?.defense?.explosiveAllowed ? 1 : 0),
      negativePlayRate: average(rows, x => x.grades?.offense?.negativePlay ? 1 : 0),
      sackRate: average(rows, x => x.result?.sack ? 1 : 0),
      turnoverRate: average(rows, x => x.result?.turnover ? 1 : 0),
      takeawayRate: average(rows, x => x.grades?.defense?.takeaway ? 1 : 0),
      resultGrade: average(rows, x => x.grades?.offense?.resultGrade),
      lastResult: {
        yards: finite(last.result?.yards),
        success: Boolean(last.grades?.offense?.situationalSuccess),
        defensiveSuccess: Boolean(last.grades?.defense?.objectiveSuccess),
        turnover: Boolean(last.result?.turnover),
        sack: Boolean(last.result?.sack)
      }
    };
  }

  summarizePlay(playId) {
    return this.summarize(x => String(x.play?.id) === String(playId));
  }

  summarizePlayInSituation(playId, situation = {}) {
    return this.summarize(x =>
      String(x.play?.id) === String(playId) &&
      this._sameSituationBucket(x.situation, situation)
    );
  }

  summarizeConcept(concept) {
    return this.summarize(x => (x.play?.concepts || []).includes(concept));
  }

  summarizeFormation(formation) {
    return this.summarize(x => x.play?.formation === formation);
  }

  summarizeDefensePlay(defensePlayId) {
    return this.summarize(x => String(x.opponentPlay?.id) === String(defensePlayId));
  }

  summarizeDefensePlayInSituation(defensePlayId, situation = {}) {
    return this.summarize(x =>
      String(x.opponentPlay?.id) === String(defensePlayId) &&
      this._sameSituationBucket(x.situation, situation)
    );
  }

  summarizeMatchup(offensePlayId, defensePlayId, situation = null) {
    return this.summarize(x => {
      const samePair =
        String(x.play?.id) === String(offensePlayId) &&
        String(x.opponentPlay?.id) === String(defensePlayId);
      if (!samePair) return false;
      return situation ? this._sameSituationBucket(x.situation, situation) : true;
    });
  }

  summarizeFamilyMatchup(offenseFamily, defenseFamily, situation = null) {
    if (!offenseFamily || !defenseFamily) return emptySummary();
    return this.summarize(x => {
      const sameFamily =
        String(x.play?.conceptFamily || x.play?.presentationFamily || "") === String(offenseFamily) &&
        String(x.opponentPlay?.coverageFamily || x.opponentPlay?.presentationFamily || "") === String(defenseFamily);
      if (!sameFamily) return false;
      return situation ? this._sameSituationBucket(x.situation, situation) : true;
    });
  }

  _sameSituationBucket(a = {}, b = {}) {
    if (Number(a.down) !== Number(b.down)) return false;

    const distanceBucket = value => {
      const d = Number(value);
      if (!Number.isFinite(d)) return "unknown";
      if (d >= 1 && d <= 3) return "short";
      if (d <= 6) return "medium";
      if (d <= 10) return "long";
      return "extra_long";
    };

    const fieldBucket = value => {
      const y = Number(value);
      if (!Number.isFinite(y)) return "unknown";
      if (y >= 80) return "red_zone";
      if (y <= 10) return "backed_up";
      if (y >= 50) return "plus";
      return "normal";
    };

    return distanceBucket(a.distance) === distanceBucket(b.distance) &&
      fieldBucket(a.yardLine) === fieldBucket(b.yardLine);
  }
}

module.exports = { PerformanceStore, emptySummary };
