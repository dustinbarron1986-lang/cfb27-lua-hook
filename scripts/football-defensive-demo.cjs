'use strict';

// Offline demonstration of the Stage 3 defensive recommendation engine.
// Shows a cold-start recommendation (theory only, zero empirical evidence),
// then seeds synthetic historical results (offline demo only -- never written
// to the production DB) and shows how empirical matchup evidence takes over.
//
// Usage: node scripts/football-defensive-demo.cjs

const path = require('path');
const { FootballEngine } = require('../src/football/engine');
const { loadPlaybooks } = require('../src/coordinator/playbook-loader.cjs');
const { formatRecommendationDiagnostic } = require('../src/football/recommendation/diagnostic');

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  // Stage 3A finding: no verified/persisted defensive playbook selection exists
  // yet (unlike offense's Pro Style/405), so the documented sample fallback is
  // the candidate source for this stage. { useDatabase: false } makes that explicit.
  const playbooks = loadPlaybooks(repoRoot, { useDatabase: false });
  const defense = playbooks.defense;

  const engine = new FootballEngine();
  const cpuPlayName = 'Shock H Option';
  const resolvedConcept = engine.knowledge.resolveConcept(cpuPlayName);
  const offensePlay = {
    id: 'shock-h-option',
    name: cpuPlayName,
    concepts: resolvedConcept ? [resolvedConcept] : [],
    primaryConcept: resolvedConcept,
  };
  const situation = { down: 2, distance: 7, yardLine: 40 };

  console.log('=== SCENARIO A: COLD START ===');
  console.log(`CPU play: ${cpuPlayName}`);
  console.log(`Resolved offensive concept (CatalogResolver/KnowledgeEngine): ${resolvedConcept || 'unresolved'}`);
  console.log(`Defensive candidate source: ${defense.name} (${defense.status}) — ${defense.plays.length} available calls`);

  const coldRanked = engine.recommendDefenses({ playbook: defense, offensePlay, situation, limit: 3 });
  const coldTop = coldRanked.recommendations[0];
  console.log(`\nRecommended: ${coldTop.play.name}  score=${coldTop.score}`);
  console.log(`Theory contribution: ${coldTop.components.bootstrapTheory.toFixed(3)}`);
  console.log(`Empirical attempts (exact matchup): ${coldTop.diagnostic.exactMatchup.attempts}`);
  console.log('\n--- diagnostic ---');
  console.log(formatRecommendationDiagnostic(coldTop));

  console.log('\n\n=== SCENARIO B: LEARNED MATCHUP (synthetic history, offline demo only) ===');
  const coverThreeMatch = defense.plays.find(p => p.name === 'Cover 3 Match');
  const midBlitz = defense.plays.find(p => p.name === 'Mid Blitz');

  // Synthetic evidence: this exact CPU play has gashed Cover 3 Match, but Mid
  // Blitz has consistently stopped it. Recorded only into this in-memory demo
  // engine -- never written to the production coordinator.db.
  for (const yards of [11, 9, 14, 8]) {
    engine.recordPlay({ play: offensePlay, opponentPlay: coverThreeMatch, situation, result: { yards, turnover: false } });
  }
  for (const yards of [1, 0, -1, 2]) {
    engine.recordPlay({ play: offensePlay, opponentPlay: midBlitz, situation, result: { yards, turnover: false } });
  }

  const learnedRanked = engine.recommendDefenses({ playbook: defense, offensePlay, situation, limit: 3 });
  const learnedTop = learnedRanked.recommendations[0];
  const learnedCoverThree = learnedRanked.recommendations.find(r => r.play.name === 'Cover 3 Match');
  const learnedMidBlitz = learnedRanked.recommendations.find(r => r.play.name === 'Mid Blitz');

  console.log(`Recommended after evidence: ${learnedTop.play.name}  score=${learnedTop.score}`);
  console.log(`Cover 3 Match: attempts=${learnedCoverThree.diagnostic.exactMatchup.attempts}, defensiveSuccessRate=${learnedCoverThree.diagnostic.exactMatchup.defensiveSuccessRate}, avgYards=${learnedCoverThree.diagnostic.exactMatchup.avgYards}`);
  console.log(`Mid Blitz: attempts=${learnedMidBlitz.diagnostic.exactMatchup.attempts}, defensiveSuccessRate=${learnedMidBlitz.diagnostic.exactMatchup.defensiveSuccessRate}, avgYards=${learnedMidBlitz.diagnostic.exactMatchup.avgYards}`);
  console.log(`\nCold-start #1 was: ${coldTop.play.name} (theory-driven)`);
  console.log(`Learned #1 is: ${learnedTop.play.name} (empirical evidence now dominant)`);
  console.log('\n--- diagnostic ---');
  console.log(formatRecommendationDiagnostic(learnedTop));
}

if (require.main === module) main();

module.exports = { main };
