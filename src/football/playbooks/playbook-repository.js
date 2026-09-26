const fs = require('fs');
const path = require('path');
const {
  VerifiedMembershipStore,
  normalizeMembershipName,
  inferFallbackMetadata
} = require('./verified-membership');

const DEFAULT_INDEX_PATH = path.join(__dirname, '../../../data/playbooks/cfb27-playbook-index.json');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function verifiedId(bookId, formation, name) {
  const slug = value => normalizeMembershipName(value).replace(/\s+/g, '-');
  return `${bookId}:verified:${slug(formation)}:${slug(name)}`;
}

class PlaybookRepository {
  constructor(options = {}) {
    this.indexPath = options.indexPath || DEFAULT_INDEX_PATH;
    this.data = options.data || loadJson(this.indexPath);
    this.playbooks = this.data.playbooks || [];
    this.plays = this.data.plays || {};
    this.verifiedMemberships = options.verifiedMembershipStore || new VerifiedMembershipStore(options.verifiedMemberships || {});
    this.strictMembership = options.strictMembership !== false;

    this.byId = new Map();
    this.byName = new Map();
    this.globalPlayNameIndex = new Map();
    for (const book of this.playbooks) {
      this.byId.set(String(book.id), book);
      this.byName.set(normalize(book.name), book);
    }
    for (const def of Object.values(this.plays)) {
      const key = normalizeMembershipName(def.name);
      if (!this.globalPlayNameIndex.has(key)) this.globalPlayNameIndex.set(key, []);
      this.globalPlayNameIndex.get(key).push(def);
    }
  }

  list({ side = 'offense', visibleOnly = true } = {}) {
    return this.playbooks
      .filter(book => !side || book.side === side)
      .filter(book => !visibleOnly || book.visible)
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
      .map(book => {
        const verifiedStats = this.verifiedMemberships.stats(book.id);
        return {
          id: book.id,
          name: book.name,
          side: book.side,
          order: book.order,
          sourceFile: book.sourceFile,
          playCount: verifiedStats.verified ? verifiedStats.playPaths : (book.playIds || []).length,
          rawCatalogPlayCount: (book.playIds || []).length,
          membershipVerified: verifiedStats.verified,
          verifiedFormationCount: verifiedStats.formations,
          available: (book.playIds || []).length > 0
        };
      });
  }

  resolve(selector, { side = null, visibleOnly = false } = {}) {
    if (selector == null || selector === '') return null;
    const raw = String(selector).trim();
    const book = this.byId.get(raw) || this.byName.get(normalize(raw)) || null;
    if (!book) return null;
    if (side && book.side !== side) return null;
    if (visibleOnly && !book.visible) return null;
    return book;
  }

  get(selector, options = {}) {
    const book = this.resolve(selector, options);
    if (!book) return null;
    const verifiedStats = this.verifiedMemberships.stats(book.id);

    if (verifiedStats.verified) {
      const plays = this._verifiedPlays(book);
      return {
        id: book.id,
        name: book.name,
        side: book.side,
        sourceFile: book.sourceFile,
        playCount: plays.length,
        rawCatalogPlayCount: (book.playIds || []).length,
        membershipVerified: true,
        verifiedFormationCount: verifiedStats.formations,
        exactRecommendationsAllowed: true,
        membershipSource: 'verified_current_overlay',
        plays
      };
    }

    const plays = (book.playIds || [])
      .map(id => this.plays[id])
      .filter(Boolean)
      .map(def => this._normalizePlay(def, book));

    return {
      id: book.id,
      name: book.name,
      side: book.side,
      sourceFile: book.sourceFile,
      playCount: plays.length,
      rawCatalogPlayCount: plays.length,
      membershipVerified: false,
      verifiedFormationCount: 0,
      exactRecommendationsAllowed: !this.strictMembership,
      membershipSource: 'legacy_editor_catalog',
      plays
    };
  }

  findPlays(selector, query, options = {}) {
    const book = this.get(selector, options);
    if (!book) return [];
    const q = normalize(query);
    if (!q) return book.plays;
    return book.plays.filter(play =>
      normalize(play.name).includes(q) ||
      normalize(play.formation).includes(q) ||
      (play.concepts || []).some(c => normalize(c).includes(q))
    );
  }

  _verifiedPlays(book) {
    const bookDefs = (book.playIds || []).map(id => this.plays[id]).filter(Boolean);
    const bookByName = new Map();
    for (const def of bookDefs) {
      const key = normalizeMembershipName(def.name);
      if (!bookByName.has(key)) bookByName.set(key, []);
      bookByName.get(key).push(def);
    }

    return this.verifiedMemberships.paths(book.id).map(pathInfo => {
      const key = normalizeMembershipName(pathInfo.name);
      const def = bookByName.get(key)?.[0] || this.globalPlayNameIndex.get(key)?.[0] || null;
      return this._normalizeVerifiedPlay(def, book, pathInfo);
    });
  }

  _normalizeVerifiedPlay(def, book, pathInfo) {
    const fallback = inferFallbackMetadata(pathInfo.name);
    const playKind = def?.type || fallback.playKind || null;
    const normalizedType = playKind === 'RPO' ? 'PASS' : (def?.type || fallback.type);
    const concepts = def?.concepts?.length ? def.concepts : fallback.concepts;
    const primaryConcept = def?.primaryConcept || fallback.primaryConcept || null;
    const modifiers = [...new Set([...(def?.modifiers || []), ...(fallback.modifiers || [])])];

    return {
      id: verifiedId(book.id, pathInfo.formation, pathInfo.name),
      catalogId: def?.id || null,
      name: pathInfo.name,
      type: normalizedType,
      playKind,
      playType: def?.playType ?? null,
      classification: def?.classification ?? null,
      formationId: def?.formationId ?? null,
      setId: def?.setId ?? null,
      formation: pathInfo.formation,
      runHole: def?.runHole ?? null,
      concepts: concepts || [],
      primaryConcept,
      modifiers,
      assignmentFamilies: def?.assignmentFamilies || [],
      presentationFamily: pathInfo.formation,
      sourcePlaybookId: book.id,
      sourcePlaybookName: book.name,
      sourceFile: book.sourceFile,
      membershipVerified: true,
      membershipSource: 'verified_current_overlay'
    };
  }

  _normalizePlay(def, book) {
    const playKind = def.type || null;
    const normalizedType = playKind === 'RPO' ? 'PASS' : playKind;
    return {
      id: `${book.id}:${def.id}`,
      catalogId: def.id,
      name: def.name,
      type: normalizedType,
      playKind,
      playType: def.playType,
      classification: def.classification,
      formationId: def.formationId,
      setId: def.setId,
      formation: def.setId == null ? null : `set:${def.setId}`,
      runHole: def.runHole,
      concepts: def.concepts || [],
      primaryConcept: def.primaryConcept || null,
      modifiers: def.modifiers || [],
      assignmentFamilies: def.assignmentFamilies || [],
      presentationFamily: `${def.formationId ?? '?'}:${def.setId ?? '?'}`,
      sourcePlaybookId: book.id,
      sourcePlaybookName: book.name,
      sourceFile: book.sourceFile,
      membershipVerified: false,
      membershipSource: 'legacy_editor_catalog'
    };
  }
}

module.exports = { PlaybookRepository, normalize };
