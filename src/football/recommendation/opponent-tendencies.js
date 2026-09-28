const { classifyOffensiveStructure, classifyDefensiveStructure } = require('../analysis/structural-threat-model');

function confidenceFromSample(n) {
  if (n >= 20) return "HIGH";
  if (n >= 10) return "MEDIUM";
  if (n >= 5) return "LOW";
  return "VERY_LOW";
}

function bucketDistance(distance) {
  const d = Number(distance || 0);
  if (d <= 2) return "SHORT";
  if (d <= 6) return "MEDIUM";
  return "LONG";
}

function bucketField(yardLine) {
  const y = Number(yardLine);
  if (!Number.isFinite(y)) return "UNKNOWN";
  if (y <= 10) return "BACKED_UP";
  if (y < 50) return "OWN_TERRITORY";
  if (y < 80) return "PLUS_TERRITORY";
  return "RED_ZONE";
}

function classifyDefense(event) {
  const name = String(event.opponentPlay?.name || "").toLowerCase();
  const concepts = (event.opponentPlay?.concepts || []).map(x => String(x).toLowerCase());
  const all = [name, ...concepts].join(" ");

  const blitz = /\bblitz\b|\bpressure\b|\bzero\b/.test(all);
  const man = /\bman\b|\bcover\s*0\b|\bcover\s*1\b|\b2\s*man\b/.test(all);
  const zone = /\bzone\b|\bcover\s*[2346]\b|\bquarters\b|\bbuzz\b|\bsky\b|\bcloud\b/.test(all);

  return { blitz, man, zone, name: event.opponentPlay?.name || null };
}

function weightedProfile(rows, currentSignals, getSignals) {
  const scores = new Map();
  const evidence = [];
  const add = (key, weight, source) => {
    if (!key) return;
    scores.set(key, (scores.get(key) || 0) + weight);
    evidence.push({ key, weight, source });
  };

  const recent = rows.slice(-10);
  recent.forEach((row, index) => {
    const age = recent.length - 1 - index;
    const recency = 1.5 * Math.pow(0.72, age);
    for (const signal of getSignals(row)) add(signal.key || signal, recency * (Number(signal.weight) || 1), `history:${age}`);
  });

  const older = rows.slice(0, Math.max(0, rows.length - 10));
  for (const row of older) {
    for (const signal of getSignals(row)) add(signal.key || signal, 0.08 * (Number(signal.weight) || 1), 'background');
  }

  for (const signal of currentSignals || []) add(signal.key || signal, 3.0 * (Number(signal.weight) || 1), 'current');

  const total = [...scores.values()].reduce((sum, value) => sum + value, 0);
  const ordered = [...scores.entries()]
    .map(([key, score]) => ({ key, score, share: total ? score / total : 0 }))
    .sort((a, b) => b.score - a.score);

  return {
    sampleSize: rows.length,
    totalWeight: total,
    primary: ordered[0]?.key || null,
    signals: ordered,
    scores: Object.fromEntries(ordered.map(row => [row.key, row.score])),
    evidence,
  };
}

class OpponentTendencies {
  constructor(store, options = {}) {
    this.store = store;
    this.knowledge = options.knowledge || null;
  }

  summarize(situation = {}, options = {}) {
    const all = this.store.getAll();
    const targetDown = Number(situation.down || 0);
    const targetDistance = bucketDistance(situation.distance);
    const targetField = bucketField(situation.yardLine);
    const targetQuarter = Number(situation.quarter || 0);

    const filters = [
      {
        label: "down_distance_field",
        fn: e => Number(e.situation?.down || 0) === targetDown &&
          bucketDistance(e.situation?.distance) === targetDistance &&
          bucketField(e.situation?.yardLine) === targetField
      },
      {
        label: "down_distance",
        fn: e => Number(e.situation?.down || 0) === targetDown &&
          bucketDistance(e.situation?.distance) === targetDistance
      },
      {
        label: "down",
        fn: e => Number(e.situation?.down || 0) === targetDown
      },
      { label: "all_game", fn: () => true }
    ];

    let rows = [];
    let scope = "all_game";
    for (const f of filters) {
      const candidate = all.filter(f.fn);
      if (candidate.length >= (options.minSpecificSample || 3) || f.label === "all_game") {
        rows = candidate;
        scope = f.label;
        break;
      }
    }

    const classes = rows.map(classifyDefense);
    const count = classes.length;
    const rate = pred => count ? classes.filter(pred).length / count : null;
    const names = {};
    for (const c of classes) if (c.name) names[c.name] = (names[c.name] || 0) + 1;
    const topCalls = Object.entries(names)
      .sort((a,b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, attempts]) => ({ name, attempts, rate: attempts / Math.max(1, count) }));

    return {
      scope,
      attempts: count,
      confidence: confidenceFromSample(count),
      blitzRate: rate(x => x.blitz),
      manRate: rate(x => x.man),
      zoneRate: rate(x => x.zone),
      topCalls,
      context: {
        down: targetDown || null,
        distanceBucket: targetDistance,
        fieldBucket: targetField,
        quarter: targetQuarter || null
      }
    };
  }

  recentOffensiveThreats(currentPlay = null, options = {}) {
    const rows = this.store.getAll().filter(event => Number(event.situation?.possession) === 1);
    const current = classifyOffensiveStructure(currentPlay || {}, options.authoritativeStructure || currentPlay?.authoritativeStructure || null);
    const profile = weightedProfile(
      rows,
      current.threats,
      event => (event.play?.structural?.threats || classifyOffensiveStructure(event.play || {}).threats)
    );
    return { ...profile, current, mode: 'opponent_offense' };
  }

  recentDefensiveStructures(currentPlay = null) {
    const rows = this.store.getAll().filter(event => Number(event.situation?.possession) === 0);
    const current = classifyDefensiveStructure(currentPlay || {}, this.knowledge);
    const currentSignals = [
      ...(current.coverageFamily ? [{ key: current.coverageFamily, weight: 1.2 }] : []),
      ...(current.pressure ? [{ key: 'pressure', weight: 1.0 }] : []),
      ...(current.man ? [{ key: 'man', weight: 0.8 }] : []),
      ...(current.zone ? [{ key: 'zone', weight: 0.8 }] : []),
      ...current.weaknesses.map(key => ({ key, weight: 0.7 })),
    ];
    const profile = weightedProfile(
      rows,
      currentSignals,
      event => {
        const structural = event.opponentPlay?.structural || classifyDefensiveStructure(event.opponentPlay || {}, this.knowledge);
        return [
          ...(structural.coverageFamily ? [{ key: structural.coverageFamily, weight: 1.2 }] : []),
          ...(structural.pressure ? [{ key: 'pressure', weight: 1.0 }] : []),
          ...(structural.man ? [{ key: 'man', weight: 0.8 }] : []),
          ...(structural.zone ? [{ key: 'zone', weight: 0.8 }] : []),
          ...(structural.weaknesses || []).map(key => ({ key, weight: 0.7 })),
        ];
      }
    );
    return { ...profile, current, mode: 'opponent_defense' };
  }

  scoreCandidate(play, tendency) {
    if (!tendency || !tendency.attempts) return { score: 0, reasons: [] };
    const concepts = new Set((play.concepts || []).map(x => String(x).toLowerCase()));
    const reasons = [];
    let score = 0;

    if (tendency.manRate >= 0.60) {
      if (concepts.has("man_beater") || concepts.has("mesh") || concepts.has("crossers")) {
        score += 1.1; reasons.push(`historical tendency leans man (${Math.round(tendency.manRate * 100)}%)`);
      }
    }
    if (tendency.zoneRate >= 0.60) {
      if (concepts.has("zone_beater") || concepts.has("flood") || concepts.has("levels") || concepts.has("spacing")) {
        score += 1.0; reasons.push(`historical tendency leans zone (${Math.round(tendency.zoneRate * 100)}%)`);
      }
    }
    if (tendency.blitzRate >= 0.45) {
      if (concepts.has("quick_game") || concepts.has("screen") || concepts.has("slant") || concepts.has("mesh")) {
        score += 0.9; reasons.push(`historical pressure rate is elevated (${Math.round(tendency.blitzRate * 100)}%)`);
      }
      if (concepts.has("slow_developing") || concepts.has("deep_shot")) {
        score -= 0.7; reasons.push("historical pressure tendency adds risk to slow development");
      }
    }

    const multiplier =
      tendency.confidence === "HIGH" ? 1 :
      tendency.confidence === "MEDIUM" ? 0.85 :
      tendency.confidence === "LOW" ? 0.65 : 0.35;

    return { score: score * multiplier, reasons };
  }
}

module.exports = {
  OpponentTendencies,
  bucketDistance,
  bucketField,
  classifyDefense,
  weightedProfile,
};
