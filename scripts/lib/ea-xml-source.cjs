'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function walkXmlFiles(root) {
  const out = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.xml$/i.test(entry.name)) out.push(full);
    }
  }
  visit(root);
  return out.sort((a, b) => a.localeCompare(b));
}

function extractZip(zipPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-ea-xml-'));
  if (process.platform === 'win32') {
    const escapedZip = String(path.resolve(zipPath)).replaceAll("'", "''");
    const escapedDir = String(dir).replaceAll("'", "''");
    const command = `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDir}' -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'pipe' });
  } else {
    execFileSync('unzip', ['-q', path.resolve(zipPath), '-d', dir], { stdio: 'pipe' });
  }
  return dir;
}

function openXmlSource(sourcePath) {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) throw new Error(`EA XML source not found: ${resolved}`);

  if (fs.statSync(resolved).isDirectory()) {
    return {
      root: resolved,
      files: walkXmlFiles(resolved),
      cleanup: null,
    };
  }

  if (/\.zip$/i.test(resolved)) {
    const root = extractZip(resolved);
    return {
      root,
      files: walkXmlFiles(root),
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  }

  throw new Error('EA XML source must be a directory or .zip file');
}

function relativeSourcePath(source, file) {
  return path.relative(source.root, file).replaceAll(path.sep, '/');
}

module.exports = {
  walkXmlFiles,
  extractZip,
  openXmlSource,
  relativeSourcePath,
};
