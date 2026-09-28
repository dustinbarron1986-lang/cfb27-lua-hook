const fs = require("fs");
const path = require("path");

const DEFAULT_INDEX_PATH = path.join(__dirname, "../../../data/playbooks/cfb27-playbook-index.json");

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function confidenceForAgreement(best, total) {
  if (!total) return "unknown";
  const ratio = best / total;
  if (best >= 2 && ratio >= 0.70) return "high";
  if (ratio >= 0.45) return "medium";
  return "low";
}

class CatalogResolver {
  constructor(options = {}) {
    this.data = options.data || loadJson(options.indexPath || DEFAULT_INDEX_PATH);
    this.plays = this.data.plays || {};
    this.nameIndex = { offense: new Map(), defense: new Map() };

    for (const play of Object.values(this.plays)) {
      const side = play.side;
      if (!this.nameIndex[side]) continue;
      const key = normalize(play.name);
      if (!this.nameIndex[side].has(key)) this.nameIndex[side].set(key, []);
      this.nameIndex[side].get(key).push(play);
    }
  }

  lookup(name, side) {
    const index = this.nameIndex[side];
    if (!index) return [];
    return index.get(normalize(name)) || [];
  }

  resolveConcept(name) {
    const matches = this.lookup(name, "offense");
    if (!matches.length) return null;

    const counts = new Map();
    for (const match of matches) {
      const key = match.primaryConcept;
      if (!key || key === "dropback_pass" || key === "run") continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    if (!counts.size) {
      const kinds = matches.map(x => x.type).filter(Boolean);
      const pass = kinds.filter(x => x === "PASS").length;
      const run = kinds.filter(x => x === "RUN").length;
      if (pass > run) return { key: "dropback_pass", confidence: "low", source: "catalog" };
      if (run > pass) return { key: "run", confidence: "low", source: "catalog" };
      return null;
    }

    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [key, best] = ordered[0];
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    return {
      key,
      confidence: confidenceForAgreement(best, total),
      source: "catalog",
      matches: matches.length
    };
  }

  resolveCoverage(name) {
    const matches = this.lookup(name, "defense");
    if (!matches.length) return null;

    const n = normalize(name);
    const families = new Set(matches.flatMap(x => x.assignmentFamilies || []));
    const man = families.has("man_coverage_matchup_family");
    const zone = families.has("zone_coverage_responsibility_family");

    let key = null;
    if (/\bcover\s*0\b|\bzero\b|\bblitz\s*0\b|\bcross\s*0\b/.test(n)) key = "cover_0";
    else if (/\bcover\s*2\s*man\b|\b2\s*man\b/.test(n)) key = "cover_2_man";
    else if (man && (/\bcover\s*1\b|\bblitz\s*1\b|\bsaw\s*blitz\s*1\b|\bdog\s*1\b|\bbrave\b/.test(n))) key = "cover_1";
    else if (zone && (/\bcover\s*6\b|\bquarter\s*quarter\s*half\b/.test(n))) key = "cover_6";
    else if (zone && (/\bcover\s*4\b|\bquarters\b|\bblitz\s*4\b/.test(n))) key = "cover_4";
    else if (zone && (/\bcover\s*3\b|\b3\s+(?:double\s+)?(?:sky|buzz|cloud)\b|\boverload\s*3\b|\bblitz\s*3\b/.test(n))) key = "cover_3";
    else if (zone && (/\bcover\s*2\b|\btampa\s*2\b|\b2\s*trap\b|\bblitz\s*2\b/.test(n))) key = "cover_2";

    if (!key) return null;
    return { key, confidence: "medium", source: "catalog", matches: matches.length };
  }

  describeOffensivePlay(name) {
    const matches = this.lookup(name, "offense");
    if (!matches.length) return null;
    const resolved = this.resolveConcept(name);
    const concepts = [...new Set(matches.flatMap(x => x.concepts || []))];
    const modifiers = [...new Set(matches.flatMap(x => x.modifiers || []))];
    return {
      name,
      primaryConcept: resolved?.key || null,
      confidence: resolved?.confidence || "unknown",
      concepts,
      modifiers,
      variants: matches.length
    };
  }

  describeDefensivePlay(name) {
    const matches = this.lookup(name, "defense");
    if (!matches.length) return null;
    const resolved = this.resolveCoverage(name);
    const assignmentFamilies = [...new Set(matches.flatMap(x => x.assignmentFamilies || []))];
    const concepts = [...new Set(matches.flatMap(x => x.concepts || []))];
    const normalized = normalize(name);
    return {
      name,
      coverageFamily: resolved?.key || null,
      confidence: resolved?.confidence || "unknown",
      assignmentFamilies,
      concepts,
      pressure: /\b(blitz|pressure|fire|smoke|sting|zero|dog)\b/.test(normalized),
      playTypes: [...new Set(matches.map(x => x.playType).filter(x => x != null))],
      variants: matches.length,
      source: "catalog",
    };
  }
}

module.exports = { CatalogResolver, normalize };
