const fs = require('fs');
const path = require('path');

const DEFAULT_VERIFIED_MEMBERSHIP_PATH = path.join(
  __dirname,
  '../../../data/playbooks/verified-memberships.json'
);

function normalizeMembershipName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadVerifiedMemberships(filePath = DEFAULT_VERIFIED_MEMBERSHIP_PATH) {
  if (!fs.existsSync(filePath)) return { metadata: {}, playbooks: {} };
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    metadata: parsed.metadata || {},
    playbooks: parsed.playbooks || {}
  };
}

function inferFallbackMetadata(playName) {
  const n = normalizeMembershipName(playName);
  const concepts = [];
  const modifiers = [];

  const isRpo = /\brpo\b|\balert\b|\blookie\b/.test(n) &&
    /\b(zone|duo|power|stretch|counter|read|base)\b/.test(n);
  const isPlayAction = /^pa\b|\bpa\b|\bplay action\b/.test(n);

  if (isRpo) modifiers.push('rpo');
  if (isPlayAction) {
    modifiers.push('play_action');
    concepts.push('play_action');
  }

  if (/\binside zone\b|\bsplit zone\b|\bmid zone\b/.test(n)) concepts.push('inside_zone');
  if (/\boutside zone\b|\bwide zone\b|\bstretch\b/.test(n)) concepts.push('outside_zone');
  if (/\bcounter\b/.test(n)) concepts.push('counter');
  if (/\bread option\b|\boption\b/.test(n)) concepts.push('read_option');
  if (/\bmesh\b/.test(n)) concepts.push('mesh');
  if (/\bflood\b|\bsail\b/.test(n)) concepts.push('flood');
  if (/\bslant/.test(n)) concepts.push('slants');
  if (/\bvertical|\ball go\b|\bseam/.test(n)) concepts.push('four_verticals');
  if (/\bscreen\b|\bbubble\b/.test(n)) concepts.push('screen_bubble');
  if (/\bcorner\b/.test(n)) concepts.push('corner');

  const passSignals = /\b(pa|screen|cross|curl|dig|hook|seam|vertical|mesh|flood|slant|spot|post|corner|comeback|drag|wheel|bench|stick|drive|dagger|smash|return|levels|spacing|texas|fade|hitch|choice|scissors|unders|fork|whip)\b/.test(n);
  const runSignals = /\b(hb|fb|qb|duo|zone|power|counter|toss|iso|lead|blast|stretch|sweep|dive|slam|wham|option|trap|gut|off tackle)\b/.test(n);

  const playKind = isRpo ? 'RPO' : (passSignals && !(/^hb\b/.test(n) && !isPlayAction) ? 'PASS' : (runSignals ? 'RUN' : 'PASS'));
  const type = playKind === 'RPO' ? 'PASS' : playKind;

  return {
    type,
    playKind,
    concepts: [...new Set(concepts)],
    primaryConcept: concepts[0] || (type === 'RUN' ? 'run' : 'dropback_pass'),
    modifiers: [...new Set(modifiers)]
  };
}

class VerifiedMembershipStore {
  constructor(options = {}) {
    this.path = options.path || DEFAULT_VERIFIED_MEMBERSHIP_PATH;
    this.data = options.data || loadVerifiedMemberships(this.path);
    this.metadata = this.data.metadata || {};
    this.playbooks = this.data.playbooks || {};
  }

  get(playbookId) {
    if (playbookId == null) return null;
    return this.playbooks[String(playbookId)] || null;
  }

  isVerified(playbookId) {
    return this.get(playbookId)?.membershipVerified === true;
  }

  paths(playbookId) {
    const record = this.get(playbookId);
    if (!record?.membershipVerified) return [];
    const out = [];
    for (const formation of record.formations || []) {
      for (const play of formation.plays || []) {
        out.push({ formation: formation.name, name: play });
      }
    }
    return out;
  }

  stats(playbookId) {
    const record = this.get(playbookId);
    if (!record) return { verified: false, formations: 0, playPaths: 0 };
    const formations = (record.formations || []).length;
    const playPaths = (record.formations || []).reduce((sum, f) => sum + (f.plays || []).length, 0);
    return { verified: Boolean(record.membershipVerified), formations, playPaths };
  }
}

module.exports = {
  DEFAULT_VERIFIED_MEMBERSHIP_PATH,
  VerifiedMembershipStore,
  normalizeMembershipName,
  inferFallbackMetadata,
  loadVerifiedMemberships
};
