'use strict';

// Offline demonstration of the Stage 4 novice execution guide pipeline:
// selected play + actual defense + PlayKnowledgeStore + KnowledgeEngine ->
// ExecutionAdvisor -> guide -> (what CoordinatorWindow.showSelection() renders).
//
// Usage: node scripts/football-novice-guide-demo.cjs

const { FootballEngine } = require('../src/football/engine');

function printCase(label, result) {
  console.log(`\n=== ${label} ===`);
  console.log(`known: ${result.available}  concept: ${result.advice?.concept || 'unresolved'}`);
  console.log(`guide.mode: ${result.guide.mode}  guide.diagramMode: ${result.guide.diagramMode || '(run mode has no diagramMode)'}`);
}

function main() {
  const engine = new FootballEngine();

  // CASE A -- KNOWN PARTIAL PASS: Pro Style 405, Singleback Ace, PA JET SWEEP.
  // Fields match the real DatabasePlaybookRepository.get(405) output exactly
  // (verified via a direct DB query) -- primaryConcept "slants" lines up with
  // button B's decoded slant_route_family assignment below.
  const caseA = engine.adviseExecution({
    selectedPlay: {
      id: '405:verified:singleback-ace:pa-jet-sweep', name: 'PA JET SWEEP', formation: 'Singleback Ace',
      type: 'PASS', concepts: ['play_action', 'slants', 'slant', 'quick_game'], primaryConcept: 'slants', sourcePlaybookId: 405,
    },
    defensiveCall: { id: 'd1', name: 'Cover 1 Robber Press', set: '3-3 Wide Jack' },
  });
  printCase('CASE A: KNOWN PARTIAL PASS (Pro Style / Singleback Ace / PA JET SWEEP)', caseA);
  console.log(`Knowledge level: ${caseA.guide.diagramMode} (expected PARTIAL, not VERIFIED)`);
  console.log('Receiver/controller buttons:', caseA.guide.receivers.map(r => `${r.button}${r.routeFamily ? `=${r.routeFamily}` : ' (undecoded)'}`).join(', '));
  console.log(`Exact progression known? ${caseA.guide.progressionStatus === 'verified' ? 'YES' : 'NO'}`);
  console.log('Structured guide output:', JSON.stringify({
    diagramMode: caseA.guide.diagramMode,
    diagramLabel: caseA.guide.diagramLabel,
    warning: caseA.guide.warning,
    targets: caseA.guide.targets,
  }, null, 2));

  // CASE B -- ESTIMATED PASS: catalog concept knowledge, no play-specific
  // knowledge (Southern Miss has no play-knowledge book at all).
  const caseB = engine.adviseExecution({
    selectedPlay: {
      id: '295:seam-divide', name: 'Seam Divide', formation: 'Gun Bunch Spread Nasty',
      type: 'PASS', concepts: ['four_verticals'], primaryConcept: 'four_verticals', sourcePlaybookId: 295,
    },
    defensiveCall: { id: 'd2', name: 'Overload 3 Sky Press' },
  });
  printCase('CASE B: ESTIMATED PASS (Seam Divide, no play-specific knowledge)', caseB);
  console.log(`Estimated diagram paths (dashed, concept-level): ${caseB.guide.paths.join(', ')}`);
  console.log(`Label: ${caseB.guide.diagramLabel}`);
  console.log(`Warning: ${caseB.guide.warning}`);

  // CASE C -- RUN PLAY: HB Stretch.
  const caseC = engine.adviseExecution({
    selectedPlay: {
      id: '405:hb-stretch', name: 'HB Stretch', formation: 'Singleback Ace Overload',
      type: 'RUN', concepts: ['outside_zone'], primaryConcept: 'outside_zone', sourcePlaybookId: 405,
    },
    defensiveCall: { id: 'd3', name: 'Cover 3 Sky' },
  });
  printCase('CASE C: RUN PLAY (HB Stretch)', caseC);
  console.log(`Resolved concept: ${caseC.guide.concept}`);
  console.log(`Run lane: ${caseC.guide.lane}`);
  console.log(`WATCH: ${caseC.guide.watch}`);
  console.log('Steps:');
  caseC.guide.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

  // CASE D -- RPO: RPO Glance Post.
  const caseD = engine.adviseExecution({
    selectedPlay: {
      id: '405:rpo-glance-post', name: 'RPO Glance Post', formation: 'Singleback Ace',
      type: 'PASS', concepts: ['rpo_glance_post'], primaryConcept: 'rpo_glance_post', sourcePlaybookId: 405,
    },
    defensiveCall: { id: 'd4', name: 'Cover 3 Sky' },
  });
  printCase('CASE D: RPO (RPO Glance Post)', caseD);
  console.log(`Resolved RPO family: ${caseD.guide.family} (glance/slant conflict-defender family)`);
  console.log(`Knowledge confidence: ${caseD.guide.diagramMode} (${caseD.guide.diagramMode === 'concept_estimated' ? 'no Pro Style play-specific entry for this exact play -- concept-level only' : 'play-specific knowledge found'})`);
  console.log('Note: by the recovered module\'s own conservative design, concept-level');
  console.log('conflict-defender COACHING TEXT (e.g. "watch the defender between the run');
  console.log('and the receiver") is only surfaced once at least PARTIAL receiver-button');
  console.log('knowledge exists for this exact play (see Case A). Pure ESTIMATED RPOs/passes');
  console.log('show the resolved family + a dashed concept diagram, but withhold read text --');
  console.log('this is intentional: showing text that reads like a designed read order for a');
  console.log('play we have zero button/route data on would misrepresent confidence.');
}

if (require.main === module) main();

module.exports = { main };
