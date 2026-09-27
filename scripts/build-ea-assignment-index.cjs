#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseAssignmentXml } = require('../src/football/assignments/ea-assignment-parser');
const { deriveAssignmentSemantics } = require('../src/football/assignments/assignment-semantics');
const { openXmlSource, relativeSourcePath } = require('./lib/ea-xml-source.cjs');

function compactAction(action) {
  return {
    order: action.order,
    guid: action.guid || null,
    type: action.type || null,
    opcode: action.opcode || null,
    fields: action.fields || {},
    arrays: action.arrays || {},
  };
}

function compactRecord(parsed, sourceRoot) {
  return {
    positionAssignId: parsed.positionAssignId,
    name: parsed.name,
    assetPath: parsed.name,
    shortName: parsed.shortName,
    category: parsed.category,
    routeType: parsed.routeType,
    positionIndex: parsed.positionIndex,
    sourceFile: parsed.sourceFile
      ? path.relative(sourceRoot, parsed.sourceFile).replaceAll(path.sep, '/')
      : null,
    partitionGuid: parsed.partitionGuid,
    primaryGuid: parsed.primaryGuid,
    actions: parsed.actions.map(compactAction),
    opcodes: parsed.actions.map(action => action.opcode || action.type).filter(Boolean),
    semantics: deriveAssignmentSemantics(parsed),
    source: 'EA_AUTHORED',
  };
}

function buildAssignmentIndex(sourcePath) {
  const source = openXmlSource(sourcePath);
  try {
    const assignments = {};
    const stats = {
      sourceFiles: source.files.length,
      parsedFiles: 0,
      failedFiles: [],
      uniqueIds: 0,
      duplicateIds: [],
      categories: {},
      semanticCounts: { route: 0, blocking: 0, defense: 0 },
    };

    for (const file of source.files) {
      try {
        const parsed = parseAssignmentXml(fs.readFileSync(file, 'utf8'), { sourceFile: file });
        const record = compactRecord(parsed, source.root);
        const key = parsed.positionAssignId == null ? `guid:${parsed.primaryGuid}` : String(parsed.positionAssignId);
        if (!assignments[key]) assignments[key] = [];
        assignments[key].push(record);
        stats.parsedFiles += 1;
        stats.categories[parsed.category || 'unknown'] = (stats.categories[parsed.category || 'unknown'] || 0) + 1;
        if (record.semantics.route) stats.semanticCounts.route += 1;
        if (record.semantics.blocking) stats.semanticCounts.blocking += 1;
        if (record.semantics.defense) stats.semanticCounts.defense += 1;
      } catch (error) {
        stats.failedFiles.push({
          file: relativeSourcePath(source, file),
          error: error.message,
        });
      }
    }

    stats.uniqueIds = Object.keys(assignments).length;
    stats.duplicateIds = Object.entries(assignments)
      .filter(([, records]) => records.length > 1)
      .map(([positionAssignId, records]) => ({
        positionAssignId,
        count: records.length,
        sourceFiles: records.map(record => record.sourceFile),
      }));

    const compactAssignments = {};
    for (const [key, records] of Object.entries(assignments)) {
      compactAssignments[key] = records.length === 1 ? records[0] : records;
    }

    return {
      metadata: {
        schemaVersion: 2,
        source: 'EA Frostbite PositionAssignmentDefine XML export',
        generatedAt: new Date().toISOString(),
        sourceFileCount: stats.sourceFiles,
        parsedFileCount: stats.parsedFiles,
        uniqueAssignmentIds: stats.uniqueIds,
        duplicateAssignmentIds: stats.duplicateIds.length,
        timingCalibrated: false,
        notes: [
          'Ordered EA-authored assignment actions are preserved.',
          'Route distance/direction/speed are preserved from EA assignment data.',
          'movementCost and delayUnits are relative values, not seconds.',
          'Duplicate positionAssignId values are preserved as arrays instead of silently overwritten.'
        ],
      },
      assignments: compactAssignments,
      stats,
    };
  } finally {
    source.cleanup?.();
  }
}

function main(argv = process.argv.slice(2)) {
  const sourcePath = argv[0];
  const outputArg = argv[1];
  if (!sourcePath) {
    console.error('Usage: node scripts/build-ea-assignment-index.cjs <Assignments.zip|assignment-xml-root> [output-json]');
    process.exitCode = 1;
    return null;
  }

  const outPath = outputArg
    ? path.resolve(outputArg)
    : path.resolve(__dirname, '..', 'data', 'knowledge', 'ea-assignment-index.json');
  const index = buildAssignmentIndex(sourcePath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(index) + '\n', 'utf8');

  console.log('=== EA ASSIGNMENT INDEX ===');
  console.log('Source:', path.resolve(sourcePath));
  console.log('Output:', outPath);
  console.log('XML files:', index.metadata.sourceFileCount);
  console.log('Parsed:', index.metadata.parsedFileCount);
  console.log('Unique assignment IDs:', index.metadata.uniqueAssignmentIds);
  console.log('Duplicate IDs preserved:', index.metadata.duplicateAssignmentIds);
  console.log('Semantics:', JSON.stringify(index.stats.semanticCounts));
  if (index.stats.failedFiles.length) {
    console.log('Parse failures:', index.stats.failedFiles.length);
    console.log(JSON.stringify(index.stats.failedFiles.slice(0, 20), null, 2));
  }
  return index;
}

if (require.main === module) main();

module.exports = { buildAssignmentIndex, compactAction, compactRecord, main };
