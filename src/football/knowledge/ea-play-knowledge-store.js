'use strict';

const fs = require('fs');
const path = require('path');

function normalizeStructuralValue(value) {
  if (value == null) return null;
  const normalized = String(value)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ');
  return normalized || null;
}

function pushMulti(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function uniqueValues(values) {
  return [...new Set(values || [])];
}

function intersectCandidateLists(lists) {
  if (!lists.length) return [];
  let current = new Set(lists[0]);
  for (const list of lists.slice(1)) {
    const next = new Set(list);
    current = new Set([...current].filter(value => next.has(value)));
  }
  return [...current];
}

function presentationAlias(formationName, setName) {
  const formation = normalizeStructuralValue(formationName);
  const set = normalizeStructuralValue(setName);
  return formation && set ? `${formation} ${set}` : null;
}

function tripleKey(formationName, setName, playName) {
  const formation = normalizeStructuralValue(formationName);
  const set = normalizeStructuralValue(setName);
  const play = normalizeStructuralValue(playName);
  return formation && set && play ? `${formation}\u0000${set}\u0000${play}` : null;
}

function setPlayKey(setName, playName) {
  const set = normalizeStructuralValue(setName);
  const play = normalizeStructuralValue(playName);
  return set && play ? `${set}\u0000${play}` : null;
}

function presentationPlayKey(presentation, playName) {
  const structural = normalizeStructuralValue(presentation);
  const play = normalizeStructuralValue(playName);
  return structural && play ? `${structural}\u0000${play}` : null;
}

class EaPlayKnowledgeStore {
  constructor(options = {}) {
    this.filePath = options.filePath || path.resolve(
      __dirname,
      '../../../data/knowledge/pro-style-ea-play-knowledge.json'
    );
    this.document = null;
    this.state = { available: false, reason: 'not_loaded', error: null };
    this.byTriple = new Map();
    this.bySetPlay = new Map();
    this.byPresentationPlay = new Map();
    this.byAuthoredPlayId = new Map();

    try {
      const document = options.document || JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this._load(document);
    } catch (error) {
      const missing = error && error.code === 'ENOENT';
      this.state = {
        available: false,
        reason: missing ? 'artifact_missing' : 'artifact_invalid',
        error: String(error?.message || error),
      };
    }
  }

  _load(document) {
    if (
      !document ||
      typeof document !== 'object' ||
      !document.plays || typeof document.plays !== 'object' ||
      !document.formations || typeof document.formations !== 'object' ||
      !document.sets || typeof document.sets !== 'object' ||
      !document.assignments || typeof document.assignments !== 'object'
    ) {
      throw new Error('EA play knowledge artifact is missing required runtime tables.');
    }

    this.document = document;
    for (const [playKey, entry] of Object.entries(document.plays)) {
      if (!entry?.play) continue;
      const formation = entry.formationKey ? document.formations[entry.formationKey] : null;
      const set = entry.setKey ? document.sets[entry.setKey] : null;
      const playName = entry.play.name || null;

      const triple = tripleKey(formation?.name, set?.name, playName);
      if (triple) pushMulti(this.byTriple, triple, playKey);

      const setPlay = setPlayKey(set?.name, playName);
      if (setPlay) pushMulti(this.bySetPlay, setPlay, playKey);

      const presentation = presentationAlias(formation?.name, set?.name);
      const presentationKey = presentationPlayKey(presentation, playName);
      if (presentationKey) pushMulti(this.byPresentationPlay, presentationKey, playKey);

      if (entry.play.playId != null) {
        pushMulti(this.byAuthoredPlayId, String(entry.play.playId), playKey);
      }
    }

    for (const map of [this.byTriple, this.bySetPlay, this.byPresentationPlay, this.byAuthoredPlayId]) {
      for (const [key, values] of map) map.set(key, uniqueValues(values));
    }

    this.state = { available: true, reason: null, error: null };
  }

  available() {
    return this.state.available;
  }

  availability() {
    return { ...this.state, filePath: this.filePath };
  }

  diagnosticAuthoredPlayId(playId) {
    if (!this.available()) return [];
    if (playId == null) return [];
    return [...(this.byAuthoredPlayId.get(String(playId)) || [])];
  }

  _candidateSummary(playKey) {
    const entry = this.document?.plays?.[playKey];
    const formation = entry?.formationKey ? this.document.formations[entry.formationKey] : null;
    const set = entry?.setKey ? this.document.sets[entry.setKey] : null;
    return {
      playKey,
      assetPath: entry?.play?.assetPath || null,
      authoredPlayId: entry?.play?.playId ?? null,
      playName: entry?.play?.name || null,
      formationName: formation?.name || null,
      setName: set?.name || null,
      resolutionStatus: entry?.resolution?.status || null,
    };
  }

  resolvePlay(query = {}) {
    const evidence = query.evidence || {};
    if (!this.available()) {
      return {
        status: 'unavailable',
        reason: this.state.reason,
        error: this.state.error,
        evidence,
      };
    }

    if (evidence.authorityEligible !== true) {
      return {
        status: 'unresolved',
        reason: 'insufficient_evidence',
        evidence,
      };
    }

    const playName = normalizeStructuralValue(query.playName);
    const formationName = normalizeStructuralValue(query.formationName);
    const setName = normalizeStructuralValue(query.setName);
    const presentation = normalizeStructuralValue(query.presentation);

    if (!playName || (!setName && !presentation)) {
      return {
        status: 'unresolved',
        reason: 'insufficient_evidence',
        evidence,
      };
    }

    const candidateLists = [];
    const strategies = [];

    if (setName) {
      const key = setPlayKey(setName, playName);
      candidateLists.push(this.bySetPlay.get(key) || []);
      strategies.push('set_play');
    }

    if (formationName && setName) {
      const key = tripleKey(formationName, setName, playName);
      candidateLists.push(this.byTriple.get(key) || []);
      strategies.push('formation_set_play');
    }

    if (presentation) {
      const key = presentationPlayKey(presentation, playName);
      candidateLists.push(this.byPresentationPlay.get(key) || []);
      strategies.push('formation_set_presentation_play');
    }

    const candidateKeys = uniqueValues(intersectCandidateLists(candidateLists));
    const matchStrategy = strategies.length > 1 ? 'structural_intersection' : strategies[0];
    const normalizedQuery = {
      playName,
      formationName: formationName || null,
      setName: setName || null,
      presentation: presentation || null,
    };

    if (!candidateKeys.length) {
      return {
        status: 'not_found',
        reason: 'authoritative_structural_miss',
        matchStrategy,
        normalizedQuery,
        evidence,
        candidates: [],
      };
    }

    if (candidateKeys.length > 1) {
      return {
        status: 'ambiguous',
        reason: 'multiple_authoritative_structural_candidates',
        matchStrategy,
        normalizedQuery,
        evidence,
        candidates: candidateKeys.map(key => this._candidateSummary(key)),
      };
    }

    const playKey = candidateKeys[0];
    const summary = this._candidateSummary(playKey);
    return {
      status: 'resolved',
      matchStrategy,
      normalizedQuery,
      evidence,
      ...summary,
    };
  }

  expandPlay(playKey) {
    if (!this.available()) {
      return {
        status: 'unavailable',
        reason: this.state.reason,
        error: this.state.error,
      };
    }

    const entry = this.document.plays[playKey];
    if (!entry) return { status: 'not_found', reason: 'play_key_not_found', playKey };

    const formation = entry.formationKey ? this.document.formations[entry.formationKey] || null : null;
    const set = entry.setKey ? this.document.sets[entry.setKey] || null : null;
    const players = (entry.players || []).map(player => ({
      ...player,
      assignment: player.assignmentKey
        ? this.document.assignments[player.assignmentKey] || null
        : null,
    }));

    return {
      status: 'resolved',
      playKey,
      formation,
      set,
      play: entry.play,
      players,
      provenance: entry.provenance || null,
      resolution: entry.resolution || null,
    };
  }
}

module.exports = {
  EaPlayKnowledgeStore,
  normalizeStructuralValue,
  presentationAlias,
  tripleKey,
  setPlayKey,
  presentationPlayKey,
};
