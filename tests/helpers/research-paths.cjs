'use strict';

// Locates the local EA Research corpus (Playbooks/, Assignments/) without
// hardcoding one machine layout. Order: CFB27_RESEARCH_ROOT, the sibling
// ../Research next to the repository, then the historical C:/CFB27Tools path.
// Tests that need the corpus skip when it is absent.

const fs = require('node:fs');
const path = require('node:path');

function researchRoot() {
  const candidates = [
    process.env.CFB27_RESEARCH_ROOT,
    path.resolve(__dirname, '..', '..', '..', 'Research'),
    'C:/CFB27Tools/Research',
  ].filter(Boolean);
  return candidates.find(dir => fs.existsSync(path.join(dir, 'Playbooks'))) || null;
}

function researchPath(...parts) {
  const root = researchRoot();
  return root ? path.join(root, ...parts) : null;
}

module.exports = { researchRoot, researchPath };
