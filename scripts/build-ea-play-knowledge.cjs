#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseEaAssetXml } = require('../src/football/knowledge/ea-play-asset-parser');
const { compileEaPlayKnowledge } = require('../src/football/knowledge/ea-play-knowledge-compiler');
const { buildAssignmentIndex } = require('./build-ea-assignment-index.cjs');
const { openXmlSource, relativeSourcePath } = require('./lib/ea-xml-source.cjs');

function readAssignmentSource(sourcePath) {
  const resolved = path.resolve(sourcePath);
  if (/\.json$/i.test(resolved)) return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return buildAssignmentIndex(resolved);
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

function stableKey(prefix, value, fallback) {
  const raw = value == null ? String(fallback ?? '') : String(value);
  return `${prefix}:${raw}`;
}

function compactRuntimeIndex(compiled) {
  const formations = {};
  const sets = {};
  const assignments = {};
  const plays = {};

  for (const entry of compiled.plays) {
    const formationKey = entry.formation
      ? stableKey('formation', entry.formation.assetPath || entry.formation.primaryGuid, entry.formation.formId)
      : null;
    const setKey = entry.set
      ? stableKey('set', entry.set.assetPath || entry.set.primaryGuid, entry.set.setId)
      : null;
    const playKey = stableKey('play', entry.play.assetPath, entry.play.playId);

    if (entry.formation && !formations[formationKey]) {
      formations[formationKey] = entry.formation;
    }

    if (entry.set && !sets[setKey]) {
      sets[setKey] = {
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
      };
    }

    const players = entry.players.map(player => {
      const assignmentIdentity = player.assignmentAssetPath
        ? [
            player.assignmentAssetPath,
            player.assignmentPartitionGuid || '',
            player.assignmentGuid || '',
          ].join('|')
        : null;
      const assignmentKey = assignmentIdentity && player.positionAssignId != null
        ? stableKey('assignment', assignmentIdentity)
        : null;

      if (
        assignmentKey &&
        player.positionAssignId != null &&
        !assignments[assignmentKey]
      ) {
        assignments[assignmentKey] = {
          assignmentAssetPath: player.assignmentAssetPath,
          assignmentGuid: player.assignmentGuid,
          assignmentPartitionGuid: player.assignmentPartitionGuid,
          positionAssignId: player.positionAssignId,
          routeType: player.routeType,
          assignmentActions: player.assignmentActions,
          assignmentSemantics: player.assignmentSemantics,
          assignmentName: player.assignmentName,
          assignmentCategory: player.assignmentCategory,
          assignmentSourceFile: player.assignmentSourceFile,
          source: player.source,
        };
      }

      const runtimePlayer = {
        index: player.index,
        assignmentKey,
        resolutionStatus: player.resolutionStatus,
        source: player.source,
      };
      if (!assignmentKey) {
        runtimePlayer.assignmentRef = player.assignmentRef;
        runtimePlayer.specialTeamsUnresolved = player.specialTeamsUnresolved;
      }
      return runtimePlayer;
    });

    plays[playKey] = {
      formationKey,
      setKey,
      play: { ...entry.play, rawMetadata: undefined },
      players,
      provenance: entry.provenance,
      resolution: entry.resolution,
    };
  }

  return {
    metadata: {
      ...compiled.metadata,
      runtimeFormat: 'deduplicated-json-v1',
      formationRecordCount: Object.keys(formations).length,
      setRecordCount: Object.keys(sets).length,
      assignmentRecordCount: Object.keys(assignments).length,
      assignmentReferenceReuseCount: Math.max(
        0,
        Number(compiled.metadata.resolvedAssignmentRefCount || 0) - Object.keys(assignments).length
      ),
      playRecordCount: Object.keys(plays).length,
    },
    formations,
    sets,
    assignments,
    plays,
    unresolved: compiled.unresolved,
  };
}

function buildEaPlayKnowledge(formationSourcePath, assignmentSourcePath, options = {}) {
  const source = openXmlSource(formationSourcePath);
  try {
    const formations = [];
    const sets = [];
    const plays = [];
    const failures = [];

    for (const file of source.files) {
      const relative = relativeSourcePath(source, file);
      try {
        const parsed = parseEaAssetXml(fs.readFileSync(file, 'utf8'), { sourceFile: relative });
        if (parsed.kind === 'formation') formations.push(parsed);
        else if (parsed.kind === 'set') sets.push(parsed);
        else if (parsed.kind === 'play') plays.push(parsed);
      } catch (error) {
        failures.push({ file: relative, error: error.message });
      }
    }

    const assignmentIndex = readAssignmentSource(assignmentSourcePath);
    const compiled = compileEaPlayKnowledge({ formations, sets, plays, assignmentIndex });
    compiled.metadata.sourceXmlCount = source.files.length;
    compiled.metadata.parseFailureCount = failures.length;
    compiled.metadata.parseFailures = failures;
    compiled.metadata.assignmentSourceFileCount = assignmentIndex.metadata?.sourceFileCount ?? null;
    compiled.metadata.assignmentParseFailureCount = assignmentIndex.stats?.failedFiles?.length ?? 0;
    compiled.metadata.generatedAt = new Date().toISOString();

    return options.compact === false ? compiled : compactRuntimeIndex(compiled);
  } finally {
    source.cleanup?.();
  }
}

function serializedSizes(result) {
  const minified = Buffer.byteLength(JSON.stringify(result), 'utf8');
  const pretty = Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8');
  return {
    minifiedBytes: minified,
    prettyBytes: pretty,
    minificationSavingsBytes: pretty - minified,
    minificationSavingsPercentage: pretty
      ? Number((((pretty - minified) / pretty) * 100).toFixed(2))
      : 0,
  };
}

function main(argv = process.argv.slice(2)) {
  const formationSourcePath = argv[0];
  const assignmentSourcePath = argv[1];
  const outputPath = argv[2] || path.resolve(__dirname, '..', 'data', 'knowledge', 'pro-style-ea-play-knowledge.json');

  if (!formationSourcePath || !assignmentSourcePath) {
    console.error('Usage: node scripts/build-ea-play-knowledge.cjs <Formations.zip|asset-dir> <Assignments.zip|assignment-dir|assignment-index.json> [output-json]');
    process.exitCode = 1;
    return null;
  }

  const result = buildEaPlayKnowledge(formationSourcePath, assignmentSourcePath);
  const sizes = serializedSizes(result);
  result.metadata.generatedArtifact = sizes;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result) + '\n', 'utf8');
  const bytes = fs.statSync(outputPath).size;

  console.log('=== EA AUTHORITATIVE PLAY KNOWLEDGE ===');
  console.log('Formation/Set/Play XML files:', result.metadata.sourceXmlCount);
  console.log('Formations:', result.metadata.formationCount);
  console.log('Sets:', result.metadata.setCount);
  console.log('Plays:', result.metadata.playCount);
  console.log('Assignment source XML files:', result.metadata.assignmentSourceFileCount);
  console.log('Assignment refs:', result.metadata.assignmentRefCount);
  console.log('Resolved assignment refs:', result.metadata.resolvedAssignmentRefCount);
  console.log('Unresolved assignment refs:', result.metadata.unresolvedAssignmentRefCount);
  console.log('Resolution %:', result.metadata.assignmentResolutionPercentage);
  console.log('Fully resolved plays:', result.metadata.fullyResolvedPlayCount);
  console.log('Partially resolved plays:', result.metadata.partiallyResolvedPlayCount);
  console.log('Normal-offense unresolved refs:', result.metadata.unresolvedNormalOffenseRefCount);
  console.log('SpecialTeams unresolved refs:', result.metadata.unresolvedSpecialTeamsRefCount);
  console.log('Formation/Set/Play parse failures:', result.metadata.parseFailureCount);
  console.log('Assignment parse failures:', result.metadata.assignmentParseFailureCount);
  console.log('Deduplicated formation records:', result.metadata.formationRecordCount);
  console.log('Deduplicated set records:', result.metadata.setRecordCount);
  console.log('Deduplicated assignment records:', result.metadata.assignmentRecordCount);
  console.log('Assignment reference reuse:', result.metadata.assignmentReferenceReuseCount);
  console.log('Output bytes:', bytes);
  console.log('Pretty JSON bytes:', sizes.prettyBytes);
  console.log('Minification savings %:', sizes.minificationSavingsPercentage);

  if (result.unresolved.length) {
    console.log('Unresolved sample:', JSON.stringify(result.unresolved.slice(0, 20), null, 2));
  }
  if (result.metadata.parseFailures?.length) {
    console.log('Parse failure sample:', JSON.stringify(result.metadata.parseFailures.slice(0, 20), null, 2));
  }
  return result;
}

if (require.main === module) main();

module.exports = {
  readAssignmentSource,
  compactAlignment,
  compactRuntimeIndex,
  buildEaPlayKnowledge,
  serializedSizes,
  main,
};
