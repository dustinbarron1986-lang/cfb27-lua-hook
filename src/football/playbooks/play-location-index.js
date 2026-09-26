const fs = require('fs');
const path = require('path');

const DEFAULT_PLAY_LOCATIONS_PATH = path.join(__dirname, '../../../data/playbooks/cfb27-play-locations.json');

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// PlayLocationIndex is a distinct provenance/semantics from VerifiedMembershipStore:
//   - VerifiedMembershipStore: a curated, current-membership confidence layer
//     (hand-verified against an external source), used by the verified path.
//   - PlayLocationIndex: automatically derived from raw Frosty playbook XML
//     exports (formation_set_list), used only by the unverified path to enrich
//     otherwise-nameless numeric formationId/setId references.
// Kept in a separate module/file for exactly that reason.
class PlayLocationIndex {
  constructor(options = {}) {
    this.path = options.path || DEFAULT_PLAY_LOCATIONS_PATH;
    const parsed = options.data || loadJson(this.path, { playbooks: {} });
    this.playbooks = parsed.playbooks || {};
  }

  // Exact lookup only: no fuzzy matching, no global (cross-playbook) fallback,
  // no play-name guessing. Real cross-playbook naming conflicts for identical
  // (formationId, setId) pairs were found in the raw export data, so lookups
  // are always scoped to the specific playbook they're being resolved for.
  lookup(playbookId, formationId, setId) {
    if (formationId == null || setId == null) return null;
    const book = this.playbooks[String(playbookId)];
    if (!book) return null;
    const entry = book[`${formationId}:${setId}`];
    if (!entry) return null;
    return {
      formationId: entry.formationId,
      formationName: entry.formationName ?? null,
      setId: entry.setId,
      setName: entry.setName ?? null,
    };
  }
}

function displayFormation(formationName, setName) {
  if (formationName && setName) return `${formationName} ${setName}`;
  if (formationName) return formationName;
  if (setName) return setName;
  return null;
}

module.exports = { PlayLocationIndex, displayFormation, DEFAULT_PLAY_LOCATIONS_PATH };
