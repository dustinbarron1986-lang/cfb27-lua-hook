'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_INDEX_PATH = path.join(__dirname, '../../../data/knowledge/ea-assignment-index.json');

function comparableRecord(record) {
  if (!record) return null;
  return JSON.stringify({
    routeType: record.routeType || null,
    category: record.category || null,
    semantics: record.semantics || null,
  });
}

function normalizeEntries(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

class EaAssignmentStore {
  constructor(options = {}) {
    this.path = options.path || DEFAULT_INDEX_PATH;
    this.data = options.data || null;
    if (!this.data && fs.existsSync(this.path)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      } catch (_) {
        this.data = null;
      }
    }
    this.data ||= { metadata: { schemaVersion: 1 }, assignments: {} };
    this.assignments = this.data.assignments || {};
  }

  available() {
    return Object.keys(this.assignments).length > 0;
  }

  lookupAll(positionAssignId, options = {}) {
    if (positionAssignId == null || positionAssignId === '') return [];
    let entries = normalizeEntries(this.assignments[String(positionAssignId)]);
    if (options.category) {
      const wanted = String(options.category).toLowerCase();
      entries = entries.filter(entry => String(entry.category || '').toLowerCase() === wanted);
    }
    return entries;
  }

  resolve(positionAssignId, options = {}) {
    const entries = this.lookupAll(positionAssignId, options);
    if (!entries.length) return null;
    if (entries.length === 1) {
      return { record: entries[0], exact: true, ambiguous: false, equivalentDuplicates: 0 };
    }
    const signatures = new Set(entries.map(comparableRecord));
    if (signatures.size === 1) {
      return {
        record: entries[0],
        exact: true,
        ambiguous: false,
        equivalentDuplicates: entries.length - 1,
      };
    }
    return {
      record: null,
      exact: false,
      ambiguous: true,
      candidates: entries,
      equivalentDuplicates: 0,
    };
  }

  lookup(positionAssignId, options = {}) {
    return this.resolve(positionAssignId, options)?.record || null;
  }

  listByCategory(category) {
    const wanted = String(category || '').toLowerCase();
    const out = [];
    for (const entries of Object.values(this.assignments)) {
      for (const entry of normalizeEntries(entries)) {
        if (String(entry.category || '').toLowerCase() === wanted) out.push(entry);
      }
    }
    return out;
  }

  hotRoutes() {
    return this.listByCategory('HotRoute');
  }
}

module.exports = { EaAssignmentStore, DEFAULT_INDEX_PATH };
