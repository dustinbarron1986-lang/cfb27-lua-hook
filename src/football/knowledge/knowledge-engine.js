const fs = require("fs");
const path = require("path");

const DEFAULT_COVERAGE_PATH = path.join(__dirname, "../../../data/knowledge/coverage_rules.json");
const DEFAULT_CONCEPT_PATH = path.join(__dirname, "../../../data/knowledge/concept_rules.json");

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAliasIndex(records) {
  const index = new Map();
  for (const [key, record] of Object.entries(records || {})) {
    const aliases = new Set([key, record.name, ...(record.aliases || [])].filter(Boolean));
    for (const alias of aliases) index.set(normalize(alias), key);
  }
  return index;
}

class KnowledgeEngine {
  constructor(options = {}) {
    this.coverageData = options.coverageData || loadJson(options.coveragePath || DEFAULT_COVERAGE_PATH);
    this.conceptData = options.conceptData || loadJson(options.conceptPath || DEFAULT_CONCEPT_PATH);
    this.coverageAliasIndex = buildAliasIndex(this.coverageData.coverages);
    this.conceptAliasIndex = buildAliasIndex(this.conceptData.concepts);
  }

  resolveCoverage(value) {
    const n = normalize(value);
    if (!n) return null;

    const exact = this.coverageAliasIndex.get(n);
    if (exact) return exact;

    // Conservative fuzzy fallback for live game strings such as "Cover 1 LB Blitz".
    if (/\bcover\s*0\b|\bzero\b/.test(n)) return "cover_0";
    if (/\bcover\s*2\s*man\b|\b2\s*man\b|\btwo\s*man\b/.test(n)) return "cover_2_man";
    if (/\bcover\s*1\b|\b1\s*robber\b|\bman\s*free\b/.test(n)) return "cover_1";
    if (/\bcover\s*6\b|\bquarter\s*quarter\s*half\b/.test(n)) return "cover_6";
    if (/\bcover\s*4\b|\bquarters\b/.test(n)) return "cover_4";
    if (/\bcover\s*3\b|\b3\s*(sky|buzz|cloud)\b/.test(n)) return "cover_3";
    if (/\bcover\s*2\b|\b2\s*zone\b/.test(n)) return "cover_2";
    return null;
  }

  resolveConcept(value) {
    const n = normalize(value);
    if (!n) return null;

    const exact = this.conceptAliasIndex.get(n);
    if (exact) return exact;

    const tests = [
      ["rpo_glance_post", /\brpo\b.*\b(glance|post)\b|\balert\s+(glance|post)\b/],
      ["rpo_bubble", /\brpo\b.*\bbubble\b/],
      ["four_verticals", /\b(4|four)\s*vert|\bverticals\b|\ball\s*go\b/],
      ["mesh", /\bmesh\b/],
      ["shallow", /\bshallow\b|\bdrive\b|\bdrag\b/],
      ["flood", /\bflood\b|\bsail\b/],
      ["smash", /\bsmash\b/],
      ["stick_spacing", /\bstick\b|\bspacing\b/],
      ["slants", /\bslant/],
      ["screen_bubble", /\bbubble\b|\bscreen\b/],
      ["inside_zone", /\binside\s*zone\b|\bsplit\s*zone\b/],
      ["outside_zone", /\boutside\s*zone\b|\bwide\s*zone\b|\bstretch\b/],
      ["counter", /\bcounter\b/],
      ["read_option", /\bread\s*option\b|\bzone\s*read\b|\bveer\b/]
    ];
    for (const [key, regex] of tests) if (regex.test(n)) return key;
    return null;
  }

  getCoverage(value) {
    const key = this.resolveCoverage(value);
    return key ? { key, ...this.coverageData.coverages[key] } : null;
  }

  getConcept(value) {
    const key = this.resolveConcept(value);
    return key ? { key, ...this.conceptData.concepts[key] } : null;
  }

  evaluateMatchup({ concept, coverage, pressure = false } = {}) {
    const c = this.getConcept(concept);
    const d = this.getCoverage(coverage);
    if (!c) {
      return {
        known: false,
        score: 0,
        confidence: "unknown",
        reason: `Unknown concept: ${concept || "(missing)"}`
      };
    }

    let score = 0;
    const reasons = [];
    if (d) {
      const fit = Number((c.coverage_fit || {})[d.key] || 0);
      score += fit;
      if (fit >= 3) reasons.push(`${c.key} strongly stresses the ${d.key} family`);
      else if (fit === 2) reasons.push(`${c.key} has a useful structural answer versus ${d.key}`);
      else if (fit === 1) reasons.push(`${c.key} is workable versus ${d.key} but is not a primary structural answer`);
      else if (fit < 0) reasons.push(`${c.key} is structurally risky versus ${d.key}`);
    }

    if (pressure) {
      const pressureFit = Number(c.pressure?.fit || 0);
      score += pressureFit;
      if (c.pressure?.note) reasons.push(c.pressure.note);
    }

    return {
      known: true,
      concept: c.key,
      coverage: d?.key || null,
      score,
      confidence: this._combinedConfidence(c.confidence, d?.confidence),
      reasons,
      readFamily: c.read_family,
      preSnapKeys: c.pre_snap_keys || [],
      postSnapGuidance: c.post_snap_guidance || [],
      stressPoints: c.primary_stress || []
    };
  }

  advise({ concept, coverage, defensivePlayName, pressure } = {}) {
    const detectedPressure = pressure != null
      ? Boolean(pressure)
      : /\bblitz\b|\bpressure\b|\bzero\b/i.test(String(defensivePlayName || coverage || ""));

    const result = this.evaluateMatchup({ concept, coverage: defensivePlayName || coverage, pressure: detectedPressure });
    if (!result.known) return result;

    const headline =
      result.score >= 5 ? "Strong matchup" :
      result.score >= 3 ? "Good matchup" :
      result.score >= 1 ? "Playable matchup" :
      result.score === 0 ? "Neutral/uncertain matchup" :
      "Risky matchup";

    return {
      ...result,
      pressureDetected: detectedPressure,
      headline,
      coaching: {
        preSnap: result.preSnapKeys.slice(0, 2),
        postSnap: result.postSnapGuidance.slice(0, 3)
      }
    };
  }

  rankConcepts({ concepts = [], coverage, defensivePlayName, pressure } = {}) {
    return concepts
      .map(concept => this.advise({ concept, coverage, defensivePlayName, pressure }))
      .filter(x => x.known)
      .sort((a, b) => b.score - a.score);
  }

  _combinedConfidence(a, b) {
    const rank = { unknown: 0, low: 1, medium: 2, high: 3 };
    const values = [a, b].filter(Boolean);
    if (!values.length) return "unknown";
    return values.reduce((min, v) => rank[v] < rank[min] ? v : min, values[0]);
  }
}

module.exports = {
  KnowledgeEngine,
  normalize
};
