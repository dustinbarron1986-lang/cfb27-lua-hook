'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { classifyOffensiveStructure, normalize } = require('../analysis/structural-threat-model');

const AUDIBLE_SLOTS = Object.freeze(['AUDIBLE_1', 'AUDIBLE_2', 'AUDIBLE_3', 'AUDIBLE_4']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sameFormation(left, right) {
  return normalize(left) === normalize(right);
}

function playId(play) {
  return play?.id == null ? null : String(play.id);
}

function formationPlays(playbook, formation) {
  return (playbook?.plays || []).filter(play => sameFormation(play.formation, formation));
}

function typeFamily(play, structure) {
  const type = String(play?.type || play?.playKind || '').toUpperCase();
  if (type === 'RUN') return 'run';
  if (type === 'PASS' || type === 'SCREEN') return 'pass';
  if (type === 'RPO' || type === 'OPTION') return 'hybrid';
  const keys = new Set(structure?.threatKeys || []);
  if (keys.has('interior_run') || keys.has('gap_run') || keys.has('perimeter_run') || keys.has('qb_run_option')) return 'run';
  if (keys.size) return 'pass';
  return 'unknown';
}

function describeCandidate(play) {
  const structure = play?.structural || classifyOffensiveStructure(play, play?.authoritativeStructure || null);
  const threatKeys = [...new Set(structure?.threatKeys || [])];
  return {
    play,
    structure,
    threatKeys,
    primaryThreat: structure?.primaryThreat || threatKeys[0] || null,
    typeFamily: typeFamily(play, structure),
  };
}

function slotReason(candidate, role, newThreats) {
  if (newThreats.length) {
    return 'Adds package coverage for ' + newThreats.slice(0, 3).join(', ') + '.';
  }
  if (role) {
    return 'Preserves a distinct ' + role.replaceAll('_', ' ') + ' answer within the formation.';
  }
  return 'Provides a distinct formation-valid alternative.';
}

function buildComplementaryPackage({ playbook, formation } = {}) {
  const candidates = formationPlays(playbook, formation)
    .map(describeCandidate)
    .filter(row => row.play?.id != null || row.play?.name)
    .sort((a, b) => {
      const left = String(a.play?.id ?? a.play?.name ?? '');
      const right = String(b.play?.id ?? b.play?.name ?? '');
      return left.localeCompare(right);
    });

  if (candidates.length < AUDIBLE_SLOTS.length) {
    return {
      available: false,
      reason: 'Formation has fewer than four distinct available plays; the coordinator will not invent or duplicate audibles.',
      playbookId: playbook?.id == null ? null : String(playbook.id),
      playbookName: playbook?.name || null,
      formation: formation || null,
      slots: [],
    };
  }

  const selected = [];
  const threatUse = new Map();
  const typeUse = new Map();

  while (selected.length < AUDIBLE_SLOTS.length) {
    let best = null;
    for (const candidate of candidates) {
      if (selected.some(row => playId(row.play) === playId(candidate.play))) continue;
      const threatKeys = candidate.threatKeys.length ? candidate.threatKeys : ['unclassified'];
      const novelty = threatKeys.reduce((score, key) => score + (1 / (1 + (threatUse.get(key) || 0))), 0);
      const typeNovelty = 1 / (1 + (typeUse.get(candidate.typeFamily) || 0));
      const classificationBonus = candidate.primaryThreat ? 0.2 : 0;
      const score = novelty + typeNovelty * 0.9 + classificationBonus;
      if (!best || score > best.score || (score === best.score &&
        String(candidate.play?.id ?? candidate.play?.name ?? '').localeCompare(String(best.candidate.play?.id ?? best.candidate.play?.name ?? '')) < 0)) {
        best = { candidate, score };
      }
    }
    if (!best) break;
    const candidate = best.candidate;
    const rolePool = candidate.threatKeys.length ? candidate.threatKeys : [candidate.typeFamily || 'unclassified'];
    const role = [...rolePool].sort((a, b) => (threatUse.get(a) || 0) - (threatUse.get(b) || 0))[0] || 'unclassified';
    const newThreats = candidate.threatKeys.filter(key => !threatUse.get(key));
    selected.push({ ...candidate, role, newThreats });
    for (const key of candidate.threatKeys) threatUse.set(key, (threatUse.get(key) || 0) + 1);
    typeUse.set(candidate.typeFamily, (typeUse.get(candidate.typeFamily) || 0) + 1);
  }

  if (selected.length !== AUDIBLE_SLOTS.length) {
    return {
      available: false,
      reason: 'Could not build four unique formation-valid audible slots.',
      playbookId: playbook?.id == null ? null : String(playbook.id),
      playbookName: playbook?.name || null,
      formation: formation || null,
      slots: [],
    };
  }

  return {
    available: true,
    playbookId: playbook?.id == null ? null : String(playbook.id),
    playbookName: playbook?.name || null,
    formation: formation || null,
    generatedAt: new Date().toISOString(),
    slots: selected.map((row, index) => ({
      slot: AUDIBLE_SLOTS[index],
      playId: playId(row.play),
      playName: row.play?.name || null,
      formation: row.play?.formation || formation || null,
      role: row.role,
      threatKeys: row.threatKeys,
      reason: slotReason(row, row.role, row.newThreats),
    })),
  };
}

function validatePackage({ playbook, formation, slots } = {}) {
  if (!Array.isArray(slots) || slots.length !== AUDIBLE_SLOTS.length) {
    return { valid: false, reason: 'An audible package must contain exactly four slots.' };
  }
  const plays = formationPlays(playbook, formation);
  const seen = new Set();
  for (const row of slots) {
    const id = row?.playId == null ? null : String(row.playId);
    const found = plays.find(play => id != null
      ? String(play.id) === id
      : String(play.name || '') === String(row?.playName || ''));
    if (!found) return { valid: false, reason: 'Every audible must resolve to an available play in the current formation.' };
    const key = String(found.id ?? found.name);
    if (seen.has(key)) return { valid: false, reason: 'Audible slots must reference four distinct plays.' };
    seen.add(key);
  }
  return { valid: true, reason: null };
}

class AudiblePackageStore {
  constructor({ filePath = null, initialData = null } = {}) {
    this.filePath = filePath || null;
    this.packages = new Map();
    const data = initialData || this._read();
    for (const pkg of data?.packages || []) {
      if (!pkg?.playbookId || !pkg?.formation) continue;
      this.packages.set(this._key(pkg.playbookId, pkg.formation), clone(pkg));
    }
  }

  _key(playbookId, formation) {
    return String(playbookId) + '::' + normalize(formation);
  }

  _read() {
    if (!this.filePath) return null;
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  _save() {
    if (!this.filePath) return;
    const body = {
      version: 1,
      packages: [...this.packages.values()],
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  get(playbookId, formation) {
    return clone(this.packages.get(this._key(playbookId, formation)) || null);
  }

  setPackage({ playbook, formation, slots } = {}) {
    const validation = validatePackage({ playbook, formation, slots });
    if (!validation.valid) throw new Error(validation.reason);
    const pkg = {
      available: true,
      playbookId: String(playbook.id),
      playbookName: playbook.name || null,
      formation,
      generatedAt: new Date().toISOString(),
      slots: slots.map((row, index) => ({
        ...clone(row),
        slot: AUDIBLE_SLOTS[index],
        formation,
      })),
    };
    this.packages.set(this._key(playbook.id, formation), pkg);
    this._save();
    return clone(pkg);
  }

  ensurePackage(playbook, formation) {
    if (!playbook?.id || !formation) {
      return { available: false, reason: 'Playbook and formation are required.', slots: [] };
    }
    const existing = this.get(playbook.id, formation);
    if (existing && validatePackage({ playbook, formation, slots: existing.slots }).valid) return existing;
    const generated = buildComplementaryPackage({ playbook, formation });
    if (!generated.available) return generated;
    this.packages.set(this._key(playbook.id, formation), generated);
    this._save();
    return clone(generated);
  }

  ensureForPlaybook(playbook) {
    const formations = [...new Set((playbook?.plays || []).map(play => play.formation).filter(Boolean))];
    const packages = [];
    const gaps = [];
    for (const formation of formations) {
      const pkg = this.ensurePackage(playbook, formation);
      if (pkg.available) packages.push(pkg);
      else gaps.push({ formation, reason: pkg.reason });
    }
    return { playbookId: playbook?.id == null ? null : String(playbook.id), packages, gaps };
  }

  review({ playbook, performanceStore, minAttempts = 3 } = {}) {
    if (!playbook?.id || !performanceStore) return [];
    const assigned = new Map();
    for (const pkg of this.packages.values()) {
      if (String(pkg.playbookId) !== String(playbook.id)) continue;
      assigned.set(normalize(pkg.formation), pkg);
    }

    const reviews = [];
    for (const pkg of assigned.values()) {
      const slotRows = pkg.slots.map(slot => ({
        slot,
        summary: performanceStore.summarizePlay(slot.playId),
      }));
      const packageAttempts = slotRows.reduce((sum, row) => sum + Number(row.summary?.attempts || 0), 0);
      if (!packageAttempts) continue;

      for (const row of slotRows) {
        const { slot, summary } = row;
        if (summary.attempts < minAttempts) {
          reviews.push({
            status: 'WATCH',
            formation: pkg.formation,
            currentAudible: slot.playName,
            audibleSlot: slot.slot,
            audibleRole: slot.role,
            attempts: summary.attempts,
            reason: 'Insufficient sample for replacement; keep collecting results.',
            proposedReplacement: null,
          });
          continue;
        }

        const success = summary.situationalSuccessRate;
        const negative = summary.negativePlayRate;
        const poor = (success != null && success <= 0.34) || (negative != null && negative >= 0.5);
        if (!poor) {
          reviews.push({
            status: 'KEEP',
            formation: pkg.formation,
            currentAudible: slot.playName,
            audibleSlot: slot.slot,
            audibleRole: slot.role,
            attempts: summary.attempts,
            reason: 'Meaningful usage does not show a replacement-level problem.',
            proposedReplacement: null,
          });
          continue;
        }

        const occupied = new Set(pkg.slots.map(item => String(item.playId)));
        const alternatives = formationPlays(playbook, pkg.formation)
          .filter(play => !occupied.has(String(play.id)))
          .map(play => ({ play, structure: play.structural || classifyOffensiveStructure(play, play.authoritativeStructure || null) }))
          .filter(item => !slot.role || (item.structure.threatKeys || []).includes(slot.role))
          .map(item => ({ ...item, summary: performanceStore.summarizePlay(item.play.id) }))
          .filter(item => item.summary.attempts >= minAttempts && item.summary.situationalSuccessRate != null)
          .sort((a, b) => Number(b.summary.situationalSuccessRate) - Number(a.summary.situationalSuccessRate));

        const replacement = alternatives.find(item => {
          if (success == null) return false;
          return Number(item.summary.situationalSuccessRate) >= Number(success) + 0.2;
        });

        reviews.push(replacement ? {
          status: 'REPLACE',
          formation: pkg.formation,
          currentAudible: slot.playName,
          audibleSlot: slot.slot,
          audibleRole: slot.role,
          attempts: summary.attempts,
          reason: 'Current audible has a meaningful poor sample and a same-role alternative has materially stronger observed success.',
          proposedReplacement: {
            playId: String(replacement.play.id),
            playName: replacement.play.name,
            formation: replacement.play.formation,
          },
        } : {
          status: 'WATCH',
          formation: pkg.formation,
          currentAudible: slot.playName,
          audibleSlot: slot.slot,
          audibleRole: slot.role,
          attempts: summary.attempts,
          reason: 'Current audible has struggled, but there is not enough same-role evidence to recommend a replacement yet.',
          proposedReplacement: null,
        });
      }
    }
    return reviews;
  }
}

module.exports = {
  AUDIBLE_SLOTS,
  AudiblePackageStore,
  buildComplementaryPackage,
  validatePackage,
  formationPlays,
};
