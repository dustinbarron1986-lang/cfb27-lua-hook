'use strict';

// Runtime store for compiled defensive playbook authority
// (data/knowledge/ea-defensive-play-knowledge.json).
//
// Live telemetry reports the defensive SET name and PLAY name (the numeric
// live play id is a runtime identifier that does not appear in the playbook
// XML, so it is never used as a key). Resolution hierarchy:
//
//   1. EXACT_BOOK       exact set + play name inside a known playbook id
//   2. NARROWED_BOOKS   exact names inside the books still consistent with
//                       this game's earlier exact observations (CPU opponent)
//   3. CORPUS           exact names anywhere in the exported corpus
//   (each tier first tries case/whitespace-normalized names, then a
//    punctuation-insensitive structural form)
//
// When several candidates share one 11-player structure the call is fully
// resolved. When they differ (e.g. set "Over" exists under both 4-3 and
// Nickel), only the defender slots on which every candidate agrees are
// reported as known. Nothing is guessed.

const fs = require('fs');
const path = require('path');
const {
  loadRouteTypeTable,
  routeTypeForOrdinal,
  defensiveResponsibility,
  offenseSideForX,
} = require('../assignments/assign-route-type');

const DEFAULT_PATH = path.resolve(__dirname, '..', '..', '..', 'data', 'knowledge', 'ea-defensive-play-knowledge.json');

// Madden/EA position_type codes 0..18 (offense 0..9 verified against the
// offensive XML slot order; defense 10..18 against alignment). Higher codes
// are left numeric rather than guessed.
const POSITION_LABEL = Object.freeze({
  10: 'LE', 11: 'RE', 12: 'DT', 13: 'LOLB', 14: 'MLB', 15: 'ROLB', 16: 'CB', 17: 'FS', 18: 'SS',
});

function normalizedName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function structuralName(value) {
  return normalizedName(value).replace(/[^a-z0-9]+/g, '');
}

function unknownSlot(index, base, conflicting) {
  return Object.freeze({
    index,
    positionType: base?.positionType ?? null,
    position: base?.position ?? null,
    alignment: null,
    assignmentRef: null,
    routeType: null,
    responsibility: null,
    known: false,
    provenance: null,
    conflictingRouteTypes: conflicting,
  });
}

// Defender slots on which every candidate structure agrees exactly.
function slotConsensus(variants) {
  const size = Math.max(...variants.map(v => v.length));
  const players = [];
  for (let i = 0; i < size; i += 1) {
    const slot = variants.map(v => v.find(p => p.index === i) || null);
    const base = slot[0];
    const agree = base && slot.every(p => p && p.assignmentRef === base.assignmentRef && p.positionType === base.positionType);
    players.push(agree ? base : unknownSlot(i, base, [...new Set(slot.map(p => p?.routeType || null))]));
  }
  return players;
}

// Responsibilities present in every candidate (multiset intersection). Slot
// index and alignment are dropped because they differ between candidates; a
// zone keeps its authored EA side, which is part of the routeType itself.
function responsibilityConsensus(variants) {
  const counts = variants.map(v => {
    const m = new Map();
    for (const p of v) if (p.known) m.set(p.routeType, (m.get(p.routeType) || 0) + 1);
    return m;
  });
  const size = Math.max(...variants.map(v => v.length));
  const players = [];
  for (const [routeType, n] of counts[0]) {
    const common = Math.min(...counts.map(m => m.get(routeType) || 0));
    const representative = variants[0].find(p => p.routeType === routeType);
    for (let i = 0; i < common; i += 1) {
      players.push(Object.freeze({ ...representative, index: null, positionType: null, position: null, alignment: null }));
    }
  }
  const conflicting = [...new Set(variants.flatMap(v => v.map(p => p.routeType)))]
    .filter(rt => !players.some(p => p.routeType === rt) || counts.some(m => (m.get(rt) || 0) !== counts[0].get(rt)));
  while (players.length < size) players.push(unknownSlot(null, null, conflicting));
  return players;
}

let cached = null;

class EaDefensivePlayStore {
  constructor(doc, { routeTypeTable = null } = {}) {
    this.doc = doc;
    this.metadata = doc.metadata || {};
    this.structures = doc.structures || [];
    this.routeTypeTable = routeTypeTable || loadRouteTypeTable();
    this.expandedStructures = new Map();
    // name index: tier -> key -> [{ bookId, row }]
    this.index = { normalized: new Map(), structural: new Map() };
    for (const [bookId, book] of Object.entries(doc.books || {})) {
      for (const row of book.plays || []) {
        const setName = book.formations?.[row[1]]?.sets?.[row[2]] ?? null;
        if (setName == null) continue;
        const entry = { bookId: String(bookId), row, setName };
        this._add('normalized', `${normalizedName(setName)}|${normalizedName(row[3])}`, entry);
        this._add('structural', `${structuralName(setName)}|${structuralName(row[3])}`, entry);
      }
    }
  }

  static load(filePath = DEFAULT_PATH) {
    if (cached && cached.filePath === filePath) return cached.store;
    if (!fs.existsSync(filePath)) return null;
    const store = new EaDefensivePlayStore(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    cached = { filePath, store };
    return store;
  }

  _add(tier, key, entry) {
    const list = this.index[tier].get(key);
    if (list) list.push(entry);
    else this.index[tier].set(key, [entry]);
  }

  bookName(bookId) {
    return this.doc.books?.[String(bookId)]?.name || null;
  }

  hasBook(bookId) {
    return bookId != null && Boolean(this.doc.books?.[String(bookId)]);
  }

  // Books that contain an exact (normalized) set+play match; used to narrow the
  // CPU opponent's book across a game.
  booksContaining({ setName, playName }) {
    const list = this.index.normalized.get(`${normalizedName(setName)}|${normalizedName(playName)}`) || [];
    return [...new Set(list.map(entry => entry.bookId))];
  }

  _candidates({ setName, playName, bookIds }) {
    const allowed = bookIds ? new Set(bookIds.map(String)) : null;
    const tiers = [
      ['normalized', `${normalizedName(setName)}|${normalizedName(playName)}`],
      ['structural', `${structuralName(setName)}|${structuralName(playName)}`],
    ];
    for (const [tier, key] of tiers) {
      const hits = (this.index[tier].get(key) || []).filter(entry => !allowed || allowed.has(entry.bookId));
      if (hits.length) return { tier, hits };
    }
    return { tier: null, hits: [] };
  }

  expandStructure(structureIdx) {
    if (this.expandedStructures.has(structureIdx)) return this.expandedStructures.get(structureIdx);
    const rows = this.structures[structureIdx] || [];
    const players = rows.map(([index, positionType, x, y, depth, assignmentRef]) => {
      const routeType = routeTypeForOrdinal(assignmentRef, this.routeTypeTable);
      const responsibility = routeType ? defensiveResponsibility(routeType.name) : null;
      const known = Boolean(responsibility && responsibility.category !== 'UNKNOWN');
      return Object.freeze({
        index,
        positionType,
        position: POSITION_LABEL[positionType] || `PT${positionType}`,
        alignment: Object.freeze({ x, y, depth, offenseSide: offenseSideForX(x) }),
        assignmentRef,
        routeType: routeType?.name || null,
        routeTypeEvidence: routeType?.evidence || null,
        responsibility: known ? responsibility : null,
        known,
        provenance: known ? 'EA_AUTHORED' : null,
      });
    });
    const frozen = Object.freeze(players);
    this.expandedStructures.set(structureIdx, frozen);
    return frozen;
  }

  // Exact catalog identity (book + formation_id + set_id + play name), as
  // carried by DB-loaded playbook plays. No name-only fallback.
  resolvePlaybookPlay({ bookId, formationId, setId, playName } = {}) {
    const book = this.doc.books?.[String(bookId)];
    if (!book) return { resolved: false, status: 'unavailable', reason: 'defensive_book_not_in_authority_artifact' };
    const name = normalizedName(playName);
    const hits = (book.plays || [])
      .filter(row => String(row[1]) === String(formationId) && String(row[2]) === String(setId) && normalizedName(row[3]) === name)
      .map(row => ({ bookId: String(bookId), row, setName: book.formations?.[row[1]]?.sets?.[row[2]] ?? null }));
    if (!hits.length) return { resolved: false, status: 'unresolved', reason: 'no_exact_catalog_identity_match', playName };
    return this._resolveCandidates({ evidence: 'EXACT_CATALOG_IDENTITY', tier: 'ids', hits, setName: hits[0].setName, playName });
  }

  resolveLiveCall({ setName, playName, bookId = null, candidateBookIds = null } = {}) {
    if (!normalizedName(playName)) {
      return { resolved: false, status: 'unavailable', reason: 'live_defensive_play_name_unavailable' };
    }
    const attempts = [];
    if (this.hasBook(bookId)) attempts.push(['EXACT_BOOK', [String(bookId)]]);
    if (Array.isArray(candidateBookIds) && candidateBookIds.length) attempts.push(['NARROWED_BOOKS', candidateBookIds]);
    attempts.push(['CORPUS', null]);

    for (const [evidence, bookIds] of attempts) {
      const { tier, hits } = this._candidates({ setName, playName, bookIds });
      if (!hits.length) continue;
      return this._resolveCandidates({ evidence, tier, hits, setName, playName });
    }
    return {
      resolved: false,
      status: 'unresolved',
      reason: 'no_exact_set_and_play_match_in_exported_defensive_books',
      setName: setName ?? null,
      playName,
    };
  }

  _resolveCandidates({ evidence, tier, hits, setName, playName }) {
    const structureIds = [...new Set(hits.map(hit => hit.row[6]))];
    const variants = structureIds.map(id => this.expandStructure(id));
    const formations = [...new Set(hits.map(hit => this.doc.books[hit.bookId].formations?.[hit.row[1]]?.name).filter(Boolean))];
    const books = [...new Set(hits.map(hit => hit.bookId))];
    const first = hits[0];

    let players;
    let status;
    let slotMapping = true;
    if (variants.length === 1) {
      players = variants[0];
      status = 'resolved';
    } else {
      players = slotConsensus(variants);
      const byResponsibility = responsibilityConsensus(variants);
      // Candidates often share the same authored responsibilities in a
      // different slot order (e.g. "Over" under 4-3 vs Nickel). Prefer the
      // responsibility-multiset consensus when it knows more, and say that the
      // per-defender slot mapping is not established.
      if (byResponsibility.filter(p => p.known).length > players.filter(p => p.known).length) {
        players = byResponsibility;
        slotMapping = false;
      }
      status = 'partial_consensus';
    }
    const knownCount = players.filter(p => p.known).length;
    return {
      resolved: knownCount > 0,
      status: knownCount === players.length && status === 'resolved' ? 'resolved' : (knownCount ? 'partial' : 'unresolved'),
      evidence,
      matchTier: tier,
      book: books.length === 1 ? books[0] : null,
      bookName: books.length === 1 ? this.bookName(books[0]) : null,
      candidateBooks: books,
      formation: formations.length === 1 ? formations[0] : null,
      candidateFormations: formations,
      set: first.setName,
      play: first.row[3],
      playId: first.row[0],
      playKey: `def:${first.bookId}:${first.row[0]}`,
      structureVariants: variants.length,
      slotMapping,
      players,
      knownAssignments: knownCount,
      totalAssignments: players.length,
      provenance: knownCount ? 'EA_AUTHORED' : null,
      resolutionLevel: this.metadata.resolutionLevel || 'ROUTE_TYPE',
      liveSetName: setName ?? null,
      livePlayName: playName,
    };
  }
}

module.exports = {
  DEFAULT_PATH,
  POSITION_LABEL,
  EaDefensivePlayStore,
  normalizedName,
  structuralName,
};
