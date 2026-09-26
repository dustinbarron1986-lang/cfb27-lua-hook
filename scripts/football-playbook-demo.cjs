'use strict';

// Offline demonstration of the Stage 2 DB-backed playbook recovery. Loads a
// real playbook from the SQLite coordinator DB (no live CFB27 process
// required), builds a sample situation, and prints the engine's ranked
// recommendations exactly the way the live coordinator would.
//
// Usage:
//   node scripts/football-playbook-demo.cjs [--playbook <id-or-name>] [--down N] [--distance N] [--yard-line N]

const path = require('path');
const { FootballEngine } = require('../src/football/engine');
const { loadOffensePlaybookFromDatabase } = require('../src/coordinator/playbook-loader.cjs');

function parseArgs(argv) {
  const args = { playbook: 405, down: 2, distance: 5, yardLine: 45 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--playbook') args.playbook = argv[++i];
    else if (a === '--down') args.down = Number(argv[++i]);
    else if (a === '--distance') args.distance = Number(argv[++i]);
    else if (a === '--yard-line') args.yardLine = Number(argv[++i]);
  }
  return args;
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const args = parseArgs(process.argv.slice(2));

  const offense = loadOffensePlaybookFromDatabase(repoRoot, { offensePlaybookId: args.playbook });
  if (!offense) {
    console.error(`Could not load playbook "${args.playbook}" from the coordinator DB.`);
    process.exitCode = 1;
    return;
  }

  console.log('=== SELECTED PLAYBOOK ===');
  console.log(`name: ${offense.name} (id ${offense.id})`);
  console.log(`membership: ${offense.membershipSource} (verified=${offense.membershipVerified})`);
  console.log(`eligible plays loaded: ${offense.plays.length} (raw catalog: ${offense.rawCatalogPlayCount})`);

  const situation = {
    down: args.down,
    distance: args.distance,
    yardLine: args.yardLine,
    quarter: 2,
    clockSeconds: 420,
    playClockSeconds: 25,
    possession: 0,
    offenseScore: 10,
    defenseScore: 7,
    scoreDifferential: 3,
    flags: {},
  };

  console.log('\n=== SAMPLE SITUATION ===');
  console.log(`Down ${situation.down} & ${situation.distance}, ball on the ${situation.yardLine}, Q${situation.quarter}`);

  const engine = new FootballEngine();
  const ranked = engine.recommendPlays({ playbook: offense, situation, limit: 5 });

  console.log(`\n=== TOP RECOMMENDATIONS (${ranked.evaluated} evaluated) ===`);
  ranked.recommendations.forEach((rec, index) => {
    console.log(`${index + 1}. ${rec.play.name}  [${rec.play.formation || 'formation unknown'}]  score=${rec.score}`);
    if (rec.reasons?.length) console.log(`   WHY: ${rec.reasons.slice(0, 3).join(' | ')}`);
  });

  if (!ranked.recommendations.length) {
    console.log('(no recommendations — playbook may be empty or all plays filtered)');
  }
}

if (require.main === module) main();

module.exports = { main };
