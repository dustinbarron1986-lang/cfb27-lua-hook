const { normalize } = require('./playbook-repository');
const {
  VerifiedMembershipStore,
  normalizeMembershipName,
  inferFallbackMetadata
} = require('./verified-membership');
const { PlayLocationIndex, displayFormationForPlaybook } = require('./play-location-index');

function verifiedId(bookId, formation, name) {
  const slug = value => normalizeMembershipName(value).replace(/\s+/g, '-');
  return `${bookId}:verified:${slug(formation)}:${slug(name)}`;
}

class DatabasePlaybookRepository {
  constructor(database, options = {}) {
    if (!database) throw new Error('DatabasePlaybookRepository requires a CoordinatorDatabase.');
    this.database = database;
    this.verifiedMemberships = options.verifiedMembershipStore || new VerifiedMembershipStore(options.verifiedMemberships || {});
    // Raw-Frosty-export-derived formation/set names -- enriches the unverified
    // path only. The verified path (_normalizeVerifiedPlay) never consults
    // this; it remains the higher-confidence, currently-curated layer.
    this.playLocations = options.playLocationIndex || new PlayLocationIndex(options.playLocations || {});
    this.strictMembership = options.strictMembership !== false;
  }

  list(options = {}) {
    return this.database.listPlaybooks(options).map(book => {
      const verifiedStats = this.verifiedMemberships.stats(book.id);
      return {
        id: book.id,
        name: book.name,
        side: book.side,
        order: book.sortOrder,
        sourceFile: book.sourceFile,
        playCount: verifiedStats.verified ? verifiedStats.playPaths : Number(book.playCount || 0),
        rawCatalogPlayCount: Number(book.playCount || 0),
        membershipVerified: verifiedStats.verified,
        verifiedFormationCount: verifiedStats.formations,
        available: Boolean(book.available)
      };
    });
  }

  resolve(selector, options = {}) {
    const book = this.database.resolvePlaybook(selector, options);
    if (!book) return null;
    const verifiedStats = this.verifiedMemberships.stats(book.id);
    return {
      id: Number(book.id),
      name: book.name,
      side: book.side,
      order: Number(book.sort_order || 0),
      visible: Boolean(book.visible),
      sourceFile: book.source_file,
      playCount: verifiedStats.verified ? verifiedStats.playPaths : Number(book.play_count || 0),
      rawCatalogPlayCount: Number(book.play_count || 0),
      membershipVerified: verifiedStats.verified,
      verifiedFormationCount: verifiedStats.formations,
      exactRecommendationsAllowed: verifiedStats.verified || !this.strictMembership
    };
  }

  get(selector, options = {}) {
    const book = this.resolve(selector, options);
    if (!book) return null;

    if (book.membershipVerified) {
      const plays = this._verifiedPlays(book);
      return {
        ...book,
        plays,
        playCount: plays.length,
        membershipSource: 'verified_current_overlay'
      };
    }

    const plays = this.database.playbookPlays(book.id).map(def => this._normalizePlay(def, book));
    return {
      ...book,
      plays,
      playCount: plays.length,
      membershipSource: 'legacy_editor_catalog',
      exactRecommendationsAllowed: !this.strictMembership
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
    const paths = this.verifiedMemberships.paths(book.id);
    const legacyDefs = this.database.playbookPlays(book.id);
    const legacyByName = new Map();
    for (const def of legacyDefs) {
      const key = normalizeMembershipName(def.name);
      if (!legacyByName.has(key)) legacyByName.set(key, []);
      legacyByName.get(key).push(def);
    }

    return paths.map(path => {
      const key = normalizeMembershipName(path.name);
      const legacyMatch = legacyByName.get(key)?.[0] || null;
      const globalMatch = legacyMatch || this.database.catalogPlaysByName(path.name, { side: 'offense' })[0] || null;
      return this._normalizeVerifiedPlay(globalMatch, book, path);
    });
  }

  _normalizeVerifiedPlay(def, book, path) {
    const fallback = inferFallbackMetadata(path.name);
    const playKind = def?.playKind || fallback.playKind || null;
    const normalizedType = playKind === 'RPO' ? 'PASS' : (def?.playKind ? def.playKind : fallback.type);
    const concepts = def?.concepts?.length ? def.concepts : fallback.concepts;
    const primaryConcept = def?.primaryConcept || fallback.primaryConcept || null;
    const modifiers = [...new Set([...(def?.modifiers || []), ...(fallback.modifiers || [])])];

    return {
      id: verifiedId(book.id, path.formation, path.name),
      catalogId: def?.catalogId || null,
      name: path.name,
      type: normalizedType,
      playKind,
      playType: def?.playType ?? null,
      classification: def?.classification ?? null,
      formationId: def?.formationId ?? null,
      setId: def?.setId ?? null,
      formation: path.formation,
      runHole: def?.runHole ?? null,
      concepts: concepts || [],
      primaryConcept,
      modifiers,
      assignmentFamilies: def?.assignmentFamilies || [],
      presentationFamily: path.formation,
      sourcePlaybookId: book.id,
      sourcePlaybookName: book.name,
      sourceFile: book.sourceFile,
      membershipVerified: true,
      membershipSource: 'verified_current_overlay'
    };
  }

  _normalizePlay(def, book) {
    const playKind = def.playKind || null;
    const normalizedType = playKind === 'RPO' ? 'PASS' : playKind;
    // Enrich from the raw-Frosty-export-derived location index, scoped to
    // this exact playbook (real cross-playbook naming conflicts for identical
    // (formationId, setId) pairs were found in the source data, so this must
    // never fall back to a global/cross-playbook lookup). Unknown stays null
    // on every field -- never fabricated, never a raw numeric fallback.
    const location = this.playLocations.lookup(book.id, def.formationId, def.setId);
    return {
      id: `${book.id}:${def.catalogId}`,
      catalogId: def.catalogId,
      name: def.name,
      type: normalizedType,
      playKind,
      playType: def.playType,
      classification: def.classification,
      formationId: def.formationId,
      formationName: location?.formationName ?? null,
      setId: def.setId,
      setName: location?.setName ?? null,
      formation: location
        ? displayFormationForPlaybook(book.id, def.formationId, def.setId, location.formationName, location.setName)
        : null,
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

module.exports = { DatabasePlaybookRepository };
