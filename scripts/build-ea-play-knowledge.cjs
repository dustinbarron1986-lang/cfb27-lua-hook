#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseEaAssetXml } = require('../src/football/knowledge/ea-play-asset-parser');
const { compileEaPlayKnowledge } = require('../src/football/knowledge/ea-play-knowledge-compiler');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-ea-play-assets-'));
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

function sourceDirectory(sourcePath) {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) throw new Error(`Formation/Set/Play source not found: ${resolved}`);
  if (fs.statSync(resolved).isDirectory()) return { root: resolved, cleanup: null };
  if (/\.zip$/i.test(resolved)) {
    const root = extractZip(resolved);
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }
  throw new Error('Formation/Set/Play source must be a directory or .zip file');
}

function compactAlignment(position) {
  if (!position) return null;
  return {
    index: position.index,
    positionType: position.positionType,
    depthPosition: position.depthPosition,
    x: position.x,
    y: position.y,
    depth: position.depth,
    flippedX: position.flippedX,
    flippedY: position.flippedY,
    facing: position.facing,
    flippedFacing: position.flippedFacing,
    packagePosition: position.packagePosition,
    flipIndex: position.flipIndex,
    groupType: position.groupType,
    primaryMotionMan: position.primaryMotionMan,
  };
}

function compactRuntimeIndex(compiled) {
  return {
    metadata: compiled.metadata,
    plays: compiled.plays.map(entry => ({
      formation: entry.formation,
      set: entry.set ? {
        ...entry.set,
        positions: (entry.set.positions || []).map(compactAlignment),
        defaultPresnapMovement: entry.set.defaultPresnapMovement ? {
          guid: entry.set.defaultPresnapMovement.guid,
          name: entry.set.defaultPresnapMovement.name,
          type: entry.set.defaultPresnapMovement.type,
          isDefault: entry.set.defaultPresnapMovement.isDefault,
        } : null,
        presnapMovements: (entry.set.presnapMovements || []).map(movement => ({
          guid: movement.guid,
          name: movement.name,
          type: movement.type,
          isDefault: movement.isDefault,
          positions: (movement.positions || []).map(compactAlignment),
        })),
        packages: entry.set.packages || [],
      } : null,
      play: { ...entry.play, rawMetadata: undefined },
      players: entry.players.map(player => ({
        ...player,
        startingAlignment: compactAlignment(player.startingAlignment),
      })),
      provenance: entry.provenance,
      resolution: entry.resolution,
    })),
    unresolved: compiled.unresolved,
  };
}

function buildEaPlayKnowledge(sourcePath, assignmentIndexPath, options = {}) {
  const source = sourceDirectory(sourcePath);
  try {
    const xmlFiles = walkXmlFiles(source.root);
    const formations = [];
    const sets = [];
    const plays = [];
    const failures = [];

    for (const file of xmlFiles) {
      const relative = path.relative(source.root, file).replaceAll(path.sep, '/');
      try {
        const parsed = parseEaAssetXml(fs.readFileSync(file, 'utf8'), { sourceFile: relative });
        if (parsed.kind === 'formation') formations.push(parsed);
        else if (parsed.kind === 'set') sets.push(parsed);
        else if (parsed.kind === 'play') plays.push(parsed);
      } catch (error) {
        failures.push({ file: relative, error: error.message });
      }
    }

    const assignmentIndex = JSON.parse(fs.readFileSync(path.resolve(assignmentIndexPath), 'utf8'));
    const compiled = compileEaPlayKnowledge({ formations, sets, plays, assignmentIndex });
    compiled.metadata.sourceXmlCount = xmlFiles.length;
    compiled.metadata.parseFailureCount = failures.length;
    compiled.metadata.parseFailures = failures;
    compiled.metadata.generatedAt = new Date().toISOString();

    return options.compact === false ? compiled : compactRuntimeIndex(compiled);
  } finally {
    source.cleanup?.();
  }
}

function main(argv = process.argv.slice(2)) {
  const sourcePath = argv[0];
  const assignmentIndexPath = argv[1] || path.resolve(__dirname, '..', 'data', 'knowledge', 'ea-assignment-index.json');
  const outputPath = argv[2] || path.resolve(__dirname, '..', 'data', 'knowledge', 'pro-style-ea-play-knowledge.json');
  if (!sourcePath) {
    console.error('Usage: node scripts/build-ea-play-knowledge.cjs <Formations.zip|asset-dir> [ea-assignment-index.json] [output-json]');
    process.exitCode = 1;
    return null;
  }

  const result = buildEaPlayKnowledge(sourcePath, assignmentIndexPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result) + '\n', 'utf8');
  const bytes = fs.statSync(outputPath).size;

  console.log('=== EA AUTHORITATIVE PLAY KNOWLEDGE ===');
  console.log('Source XML files:', result.metadata.sourceXmlCount);
  console.log('Formations:', result.metadata.formationCount);
  console.log('Sets:', result.metadata.setCount);
  console.log('Plays:', result.metadata.playCount);
  console.log('Compiled plays:', result.metadata.compiledPlayCount);
  console.log('Fully resolved plays:', result.metadata.fullyResolvedPlayCount);
  console.log('Unresolved plays:', result.metadata.unresolvedPlayCount);
  console.log('Parse failures:', result.metadata.parseFailureCount);
  console.log('Output bytes:', bytes);
  if (result.unresolved.length) console.log('Unresolved sample:', JSON.stringify(result.unresolved.slice(0, 20), null, 2));
  if (result.metadata.parseFailures?.length) console.log('Parse failure sample:', JSON.stringify(result.metadata.parseFailures.slice(0, 20), null, 2));
  return result;
}

if (require.main === module) main();

module.exports = {
  walkXmlFiles,
  sourceDirectory,
  compactRuntimeIndex,
  buildEaPlayKnowledge,
  main,
};
