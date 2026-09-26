const fs = require('fs');
const path = require('path');

const DEFAULT_AUTO_PATH = path.join(__dirname, '../../../data/knowledge/pro-style-play-knowledge.json');
const DEFAULT_OVERRIDE_PATH = path.join(__dirname, '../../../data/knowledge/play-overrides.json');

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function keyFor(playbookId, formation, play) {
  return `${Number(playbookId)}|${normalize(formation)}|${normalize(play)}`;
}

function formationMatches(expected, actual) {
  const a = normalize(expected);
  const b = normalize(actual);
  if (!a || !b) return false;
  return a === b || a.endsWith(` ${b}`) || b.endsWith(` ${a}`);
}

class PlayKnowledgeStore {
  constructor(options = {}) {
    this.autoPath = options.autoPath || DEFAULT_AUTO_PATH;
    this.overridePath = options.overridePath || DEFAULT_OVERRIDE_PATH;
    this.auto = options.autoData || readJson(this.autoPath, { playbooks: {} });
    this.overrides = options.overrideData || readJson(this.overridePath, { plays: {} });
  }

  resolve(playbookId, formation, playName) {
    const id = String(Number(playbookId));
    const playNorm = normalize(playName);
    const book = this.auto.playbooks?.[id];
    const entries = book?.entries || {};

    let auto = entries[`${normalize(formation)}|${playNorm}`] || null;
    if (!auto && playNorm) {
      const candidates = Object.values(entries).filter(entry =>
        normalize(entry.play) === playNorm && formationMatches(entry.formation, formation)
      );
      if (candidates.length === 1) auto = candidates[0];
    }

    const exactOverrideKey = keyFor(playbookId, formation, playName);
    let override = this.overrides.plays?.[exactOverrideKey] || null;
    if (!override && playNorm) {
      const prefix = `${Number(playbookId)}|`;
      const candidates = Object.entries(this.overrides.plays || {})
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value)
        .filter(value => normalize(value.play) === playNorm && formationMatches(value.formation, formation));
      if (candidates.length === 1) override = candidates[0];
    }

    if (!auto && !override) return null;
    return {
      ...(auto || {}),
      ...(override || {}),
      source: override ? 'manual_override' : 'generated_audit',
      routeArtVerified: Boolean(override?.routeArtVerified),
      progressionVerified: Boolean(override?.progressionVerified),
      receiverButtons: override?.receiverButtons || auto?.receiverButtons || [],
      buttonMappingConfidence: override?.buttonMappingConfidence || auto?.buttonMappingConfidence || 'unknown'
    };
  }

  audit(playbookId) {
    const id = String(Number(playbookId));
    const entries = Object.values(this.auto.playbooks?.[id]?.entries || {});
    const counts = {
      total: entries.length,
      manualVerified: 0,
      uniqueCatalogCandidate: 0,
      ambiguousCatalogCandidates: 0,
      missingCatalogCandidate: 0,
      buttonMapHigh: 0,
      partialRouteKnowledge: 0,
      progressionVerified: 0
    };
    const issues = [];

    for (const entry of entries) {
      const resolved = this.resolve(playbookId, entry.formation, entry.play) || entry;
      if (resolved.source === 'manual_override' && resolved.routeArtVerified) counts.manualVerified += 1;
      if (entry.catalogStatus === 'unique_catalog_candidate') counts.uniqueCatalogCandidate += 1;
      if (entry.catalogStatus === 'ambiguous_catalog_candidates') counts.ambiguousCatalogCandidates += 1;
      if (entry.catalogStatus === 'missing_catalog_candidate') counts.missingCatalogCandidate += 1;
      if (resolved.buttonMappingConfidence === 'high') counts.buttonMapHigh += 1;
      if (resolved.routeKnowledge === 'partial') counts.partialRouteKnowledge += 1;
      if (resolved.progressionVerified) counts.progressionVerified += 1;

      if (!resolved.routeArtVerified || !resolved.progressionVerified) {
        issues.push({
          formation: entry.formation,
          play: entry.play,
          catalogStatus: entry.catalogStatus,
          buttonMappingConfidence: resolved.buttonMappingConfidence || 'unknown',
          routeArtVerified: Boolean(resolved.routeArtVerified),
          progressionVerified: Boolean(resolved.progressionVerified),
          candidateCount: entry.candidateCount || 0
        });
      }
    }

    return { counts, issues };
  }
}

module.exports = { PlayKnowledgeStore, normalizePlayKnowledgeName: normalize, playKnowledgeKey: keyFor };
