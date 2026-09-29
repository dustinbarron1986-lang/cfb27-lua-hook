'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeSituation } = require('../analysis/situation-normalizer');

const DEFAULT_PATH = path.resolve(__dirname, '../../../data/football/football-priors-v1.json');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function coverageKey(value) {
  const text = String(value || '').toLowerCase().replace(/[_-]+/g, ' ');
  const match = text.match(/cover\s*([0-9])/);
  return match ? 'cover_' + match[1] : null;
}

function shellFamily(defense = {}) {
  const text = String([
    defense.coverageFamily,
    defense.name,
    ...(defense.assignmentFamilies || []),
  ].filter(Boolean).join(' ')).toLowerCase();
  if (/\bman\b|cover\s*0|cover\s*1/.test(text)) return 'man';
  if (/\bzone\b|cover\s*[2346]/.test(text)) return 'zone';
  return null;
}

function modeScore(row, mode) {
  if (!row || !['run','pass'].includes(mode)) return null;
  const candidate = row[mode];
  const alternative = row[mode === 'run' ? 'pass' : 'run'];
  if (!candidate || !alternative) return null;
  const epaEdge = Number(candidate.epa) - Number(alternative.epa);
  const successEdge = Number(candidate.success) - Number(alternative.success);
  const moneyDown = Number(row.down) >= 3;
  const epaWeight = moneyDown ? 0.40 : 0.65;
  const successWeight = moneyDown ? 0.60 : 0.35;
  const normalized = (
    clamp(epaEdge / 0.35, -1, 1) * epaWeight +
    clamp(successEdge / 0.20, -1, 1) * successWeight
  );
  let score = clamp(normalized * 1.8, -1.8, 1.8);
  const selectionBiasRisk = Number(candidate.usage) < 0.25;
  if (selectionBiasRisk && score > 0) score = Math.min(score, 0.55);
  return {
    mode,
    score: Number(score.toFixed(3)),
    usage: candidate.usage,
    success: candidate.success,
    epa: candidate.epa,
    alternative: mode === 'run' ? 'pass' : 'run',
    alternativeUsage: alternative.usage,
    alternativeSuccess: alternative.success,
    alternativeEpa: alternative.epa,
    epaEdge: Number(epaEdge.toFixed(3)),
    successEdge: Number(successEdge.toFixed(3)),
    selectionBiasRisk,
    requiresSupportingContext: selectionBiasRisk && Number(row.down) >= 3,
    provenance: 'EMPIRICAL_PRIOR',
  };
}

class EmpiricalPrior {
  constructor(options = {}) {
    this.filePath = options.filePath || DEFAULT_PATH;
    this.document = options.document || JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  matchSituation(situation = {}) {
    const s = normalizeSituation(situation);
    if (!Number.isFinite(s.down) || !Number.isFinite(s.yardsToGo)) return null;
    return (this.document.situation || []).find(row =>
      Number(row.down) === Number(s.down) &&
      Number(s.yardsToGo) >= Number(row.min) &&
      (row.max == null || Number(s.yardsToGo) <= Number(row.max))
    ) || null;
  }

  situationEvidence(situation = {}, profile = {}) {
    const row = this.matchSituation(situation);
    if (!row) return { available: false, score: 0, provenance: 'EMPIRICAL_PRIOR' };
    if (profile.decisionClass === 'hybrid') {
      const run = modeScore(row, 'run');
      const pass = modeScore(row, 'pass');
      const score = Number((((run?.score || 0) + (pass?.score || 0)) / 2).toFixed(3));
      return {
        available: true,
        rowId: row.id,
        n: row.n,
        mode: 'hybrid',
        score,
        branches: { run, pass },
        selectionBiasRisk: Boolean(run?.selectionBiasRisk && pass?.selectionBiasRisk),
        provenance: 'EMPIRICAL_PRIOR',
      };
    }
    const mode = profile.decisionClass === 'run' ? 'run' : 'pass';
    const evidence = modeScore(row, mode);
    return {
      available: Boolean(evidence),
      rowId: row.id,
      n: row.n,
      ...(evidence || { mode, score: 0 }),
      provenance: 'EMPIRICAL_PRIOR',
    };
  }

  routeCoverageEvidence(profile = {}, defense = {}) {
    const routes = profile.routes || [];
    if (!routes.length) return { available: false, score: 0, provenance: 'EMPIRICAL_PRIOR' };
    const exactCoverage = coverageKey(defense.coverageFamily || defense.name);
    if (exactCoverage) {
      const exact = (this.document.routeCoverage || [])
        .filter(row => row.coverage === exactCoverage && routes.includes(row.route))
        .sort((a,b) => Number(b.epa) - Number(a.epa));
      if (exact.length) {
        const top = exact[0];
        return {
          available: true,
          evidenceLevel: 'exact_route_cover_n',
          route: top.route,
          coverage: top.coverage,
          n: top.n,
          epa: top.epa,
          score: Number(clamp(Number(top.epa) / 0.8, -1, 1).toFixed(3)),
          provenance: 'EMPIRICAL_PRIOR',
        };
      }
    }

    const shell = shellFamily(defense);
    if (shell) {
      const broad = (this.document.routeShell || [])
        .filter(row => routes.includes(row.route) && Number.isFinite(Number(row[shell])))
        .sort((a,b) => Number(b[shell]) - Number(a[shell]));
      if (broad.length) {
        const top = broad[0];
        return {
          available: true,
          evidenceLevel: 'broad_man_zone',
          route: top.route,
          shell,
          epa: top[shell],
          score: Number(clamp(Number(top[shell]) / 0.8, -1, 1).toFixed(3)),
          provenance: 'EMPIRICAL_PRIOR',
        };
      }
    }
    return { available: false, score: 0, provenance: 'EMPIRICAL_PRIOR' };
  }
}

module.exports = {
  DEFAULT_PATH,
  EmpiricalPrior,
  coverageKey,
  shellFamily,
  modeScore,
};
