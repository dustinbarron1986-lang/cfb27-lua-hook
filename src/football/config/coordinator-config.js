const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '../../../data/coordinator-config.json');

function loadCoordinatorConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Merge-based: a field left `undefined` in `config` preserves whatever is
// already on disk for that field; a field explicitly passed as `null` clears
// it. This lets callers update just the offense selection, just the defense
// selection, or both, without ever clobbering the other side -- e.g. saving
// a defense selection must never disturb the existing Pro Style/405 offense
// selection, and vice versa.
function saveCoordinatorConfig(config, configPath = DEFAULT_CONFIG_PATH) {
  const existing = loadCoordinatorConfig(configPath) || {};

  const pick = key => (config[key] === undefined ? existing[key] : config[key]);

  const offensePlaybookId = Number(pick('offensePlaybookId'));
  const offensePlaybookName = String(pick('offensePlaybookName') || '');

  const rawDefenseId = pick('defensePlaybookId');
  const defensePlaybookId = rawDefenseId == null ? null : Number(rawDefenseId);
  const defensePlaybookName = defensePlaybookId == null ? null : String(pick('defensePlaybookName') || '');

  const normalized = {
    version: 1,
    offensePlaybookId,
    offensePlaybookName,
    defensePlaybookId,
    defensePlaybookName,
    updatedAt: new Date().toISOString()
  };

  if (!Number.isFinite(normalized.offensePlaybookId) || !normalized.offensePlaybookName) {
    throw new Error('A valid offensive playbook id and name are required.');
  }
  if (normalized.defensePlaybookId != null && (!Number.isFinite(normalized.defensePlaybookId) || !normalized.defensePlaybookName)) {
    throw new Error('A valid defensive playbook id and name are required when setting a defensive selection.');
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, configPath);
  return normalized;
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  loadCoordinatorConfig,
  saveCoordinatorConfig
};
