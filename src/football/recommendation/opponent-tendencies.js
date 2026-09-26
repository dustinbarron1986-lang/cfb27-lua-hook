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

class OpponentTendencies {
  constructor(store) {
    this.store = store;
  }

  summarize(situation = {}, options = {}) {
    const all = this.store.getAll();
    const targetDown = Number(situation.down || 0);
    const targetDistance = bucketDistance(situation.distance);
    const targetField = bucketField(situation.yardLine);
    const targetQuarter = Number(situation.quarter || 0);

    // Progressive fallback: most specific useful sample wins.
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

  scoreCandidate(play, tendency) {
    if (!tendency || !tendency.attempts) return { score: 0, reasons: [] };
    const concepts = new Set((play.concepts || []).map(x => String(x).toLowerCase()));
    const reasons = [];
    let score = 0;

    // IMPORTANT: these are historical tendencies only, never the current exact defensive call.
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

    // Scale tendency impact down when sample is tiny.
    const multiplier =
      tendency.confidence === "HIGH" ? 1 :
      tendency.confidence === "MEDIUM" ? 0.85 :
      tendency.confidence === "LOW" ? 0.65 : 0.35;

    return { score: score * multiplier, reasons };
  }
}

module.exports = { OpponentTendencies, bucketDistance, bucketField, classifyDefense };
