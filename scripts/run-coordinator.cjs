#!/usr/bin/env node
'use strict';

const path = require('path');
const { runLiveCoordinator } = require('../src/coordinator/live-coordinator.cjs');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') result.configPath = argv[++i];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => controller.abort());
}

runLiveCoordinator({
  repoRoot: path.resolve(__dirname, '..'),
  configPath: args.configPath,
  signal: controller.signal,
}).catch(error => {
  console.error(`[COORD] FAILED: ${error?.stack || error}`);
  process.exitCode = 1;
});
