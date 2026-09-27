'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseAssignmentXml } = require('../src/football/assignments/ea-assignment-parser');
const { deriveAssignmentSemantics } = require('../src/football/assignments/assignment-semantics');
const { EaAssignmentStore } = require('../src/football/assignments/ea-assignment-store');
const { buildAssignmentIndex } = require('../scripts/build-ea-assignment-index.cjs');
const { buildPassingPlayArt } = require('../src/football/analysis/play-art-engine');
const { deriveStructuralProgression } = require('../src/football/analysis/passing-progression-engine');
const { analyzeRunAssignments } = require('../src/football/analysis/run-gap-engine');
const { PlayKnowledgeStore } = require('../src/football/knowledge/play-knowledge-store');
const { ExecutionAdvisor } = require('../src/football/recommendation/execution-advisor');

const DRAG_XML = `<?xml version="1.0" encoding="utf-8"?>
<partition guid="p1" primaryInstance="main">
  <instance guid="main" type="PositionAssignmentDefine" exported="true">
    <field name="Name">football/Gameplay/playbooks/PlayLibrary/Assignments/RunRoute/Test_DragLt</field>
    <array name="positionAssignment" type="ref(PointerRef)">
      <item ref="run1"/><item ref="cut1"/><item ref="run2"/><item ref="open1"/>
    </array>
    <field name="positionAssignId">2044271394</field>
    <field name="routeType">AssignRouteType_RR_Drag</field>
  </instance>
  <instance guid="run1" type="RunRouteAssignment" exported="true">
    <field name="opCodeEX">ID_RUNROUTE</field><field name="distance">4.75</field><field name="direction">145</field><field name="speed">50</field>
  </instance>
  <instance guid="cut1" type="ReceiverCutAssignment" exported="true">
    <field name="opCodeEX">ID_RECCUT</field><field name="direction">LEFT</field><field name="cutType">REC_CUT_NORMAL</field>
  </instance>
  <instance guid="run2" type="RunRouteAssignment" exported="true">
    <field name="opCodeEX">ID_RUNROUTE</field><field name="distance">15</field><field name="direction">170</field><field name="speed">100</field>
  </instance>
  <instance guid="open1" type="GetOpenAssignment" exported="true"><field name="opCodeEX">ID_RECGETOPEN</field></instance>
</partition>`;

const POWER_XML = `<?xml version="1.0" encoding="utf-8"?>
<partition guid="p2" primaryInstance="main">
  <instance guid="main" type="PositionAssignmentDefine" exported="true">
    <field name="Name">football/Gameplay/playbooks/PlayLibrary/Assignments/Blocking/FB_IForm_H6_Kickout_PowerO_Rt</field>
    <array name="positionAssignment" type="ref(PointerRef)"><item ref="lead"/><item ref="run"/></array>
    <field name="positionAssignId">5137</field><field name="routeType">AssignRouteType_Block_Run</field>
  </instance>
  <instance guid="lead" type="LeadBlockAssignment" exported="true">
    <field name="opCodeEX">ID_LEADBLOCK</field><field name="blockingTechnique">BLOCKINGTECHNIQUE_KICKOUT</field><field name="blockingGap">D_GAP_RIGHT</field>
  </instance>
  <instance guid="run" type="RunBlockAssignment" exported="true"><field name="opCodeEX">ID_RUNBLOCK</field></instance>
</partition>`;

function record(xml) {
  const parsed = parseAssignmentXml(xml);
  return { ...parsed, semantics: deriveAssignmentSemantics(parsed) };
}

test('EA assignment parser preserves ordered route geometry and exact assignment id', () => {
  const parsed = parseAssignmentXml(DRAG_XML);
  assert.equal(parsed.positionAssignId, 2044271394);
  assert.equal(parsed.category, 'RunRoute');
  assert.equal(parsed.routeType, 'AssignRouteType_RR_Drag');
  assert.deepEqual(parsed.actions.map(action => action.opcode), ['ID_RUNROUTE', 'ID_RECCUT', 'ID_RUNROUTE', 'ID_RECGETOPEN']);

  const route = deriveAssignmentSemantics(parsed).route;
  assert.equal(route.segments.length, 2);
  assert.equal(route.totalDistance, 19.75);
  assert.equal(route.routeFamily, 'drag');
  assert.equal(route.events[0].type, 'cut');
});

test('run gap analysis preserves EA kickout technique and designed gap', () => {
  const power = record(POWER_XML);
  const result = analyzeRunAssignments([{ player: 'FB', eaAssignment: power }]);
  assert.equal(result.source, 'ea_blocking_assignments');
  assert.equal(result.primaryGap, 'D_GAP_RIGHT');
  assert.equal(result.primaryGapFamily, 'D');
  assert.equal(result.primarySide, 'right');
  assert.equal(result.blockers[0].technique, 'kickout');
});

test('assignment store does not silently choose conflicting duplicate IDs', () => {
  const a = record(DRAG_XML);
  const b = {
    ...a,
    routeType: 'AssignRouteType_RR_Post',
    semantics: { ...a.semantics, route: { ...a.semantics.route, routeFamily: 'post' } }
  };
  const store = new EaAssignmentStore({ data: { assignments: { '2044271394': [a, b] } } });
  const resolved = store.resolve(2044271394);
  assert.equal(resolved.ambiguous, true);
  assert.equal(resolved.record, null);
});

test('play art translates EA-relative route geometry from receiver alignment', () => {
  const drag = record(DRAG_XML);
  const art = buildPassingPlayArt([
    { button: 'X', x: -12, y: 0, assignment: 2044271394, eaAssignment: drag }
  ]);
  assert.equal(art.source, 'ea_assignment_geometry');
  assert.equal(art.targets.length, 1);
  assert.equal(art.targets[0].geometry.points[0].x, -12);
  assert.equal(art.timingCalibrated, false);
});

test('passing progression is labeled coordinator-derived, never EA-authored', () => {
  const drag = record(DRAG_XML);
  const post = {
    ...drag,
    positionAssignId: 99,
    shortName: 'WR_Post',
    routeType: 'AssignRouteType_RR_Post',
    semantics: {
      ...drag.semantics,
      route: { ...drag.semantics.route, routeFamily: 'post', maxDepth: 18, movementCost: 19 }
    }
  };
  const art = buildPassingPlayArt([
    { button: 'X', x: -12, y: 0, assignment: 2044271394, eaAssignment: drag },
    { button: 'Y', x: 5, y: 0, assignment: 99, eaAssignment: post },
  ]);
  const progression = deriveStructuralProgression({ playArt: art, coverage: 'cover_1', pressure: true });
  assert.equal(progression.status, 'derived_structural');
  assert.equal(progression.provenance, 'coordinator_derived_from_ea_assignments');
  assert.equal(progression.timingCalibrated, false);
  assert.match(progression.warning, /not an EA-authored progression/i);
  assert.equal(progression.reads[0].button, 'X');
});

test('index builder preserves collisions instead of overwriting them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb27-ea-assignments-'));
  fs.mkdirSync(path.join(dir, 'RunRoute'));
  fs.writeFileSync(path.join(dir, 'RunRoute', 'a.xml'), DRAG_XML);
  fs.writeFileSync(path.join(dir, 'RunRoute', 'b.xml'), DRAG_XML.replace('Test_DragLt', 'Test_DragLt_Copy'));
  const index = buildAssignmentIndex(dir);
  assert.equal(index.metadata.sourceFileCount, 2);
  assert.equal(index.metadata.uniqueAssignmentIds, 1);
  assert.equal(index.metadata.duplicateAssignmentIds, 1);
  assert.equal(Array.isArray(index.assignments['2044271394']), true);
});


test('PlayKnowledgeStore enriches receiver assignment IDs and ExecutionAdvisor derives a coverage-aware read order', () => {
  const drag = record(DRAG_XML);
  const slant = {
    ...drag,
    positionAssignId: 88,
    shortName: 'WR_Slant',
    routeType: 'AssignRouteType_RR_Slant',
    semantics: {
      ...drag.semantics,
      route: { ...drag.semantics.route, routeFamily: 'slant', maxDepth: 8, movementCost: 6 }
    }
  };
  const eaStore = new EaAssignmentStore({
    data: { assignments: { '2044271394': drag, '88': slant } }
  });
  const playStore = new PlayKnowledgeStore({
    autoData: {
      playbooks: {
        '405': {
          entries: {
            'singleback ace|test pass': {
              play: 'Test Pass',
              formation: 'Singleback Ace',
              receiverButtons: [
                { button: 'X', x: -12, y: 0, assignment: 2044271394 },
                { button: 'Y', x: 8, y: 0, assignment: 88 }
              ]
            }
          }
        }
      }
    },
    overrideData: { plays: {} },
    eaAssignmentStore: eaStore
  });

  const resolved = playStore.resolve(405, 'Singleback Ace', 'Test Pass');
  assert.equal(resolved.eaAssignmentResolvedCount, 2);
  assert.equal(resolved.receiverButtons[0].eaAssignmentStatus, 'resolved');

  const advisor = new ExecutionAdvisor({
    playKnowledgeStore: playStore,
    knowledgeEngine: {
      advise() {
        return {
          known: true,
          concept: 'slants',
          coverage: 'cover_1',
          pressureDetected: false,
          coaching: { preSnap: [], postSnap: [] },
          reasons: []
        };
      }
    }
  });
  const result = advisor.advise({
    selectedPlay: {
      id: 'test-pass',
      name: 'Test Pass',
      formation: 'Singleback Ace',
      type: 'PASS',
      primaryConcept: 'slants',
      concepts: ['slants'],
      sourcePlaybookId: 405
    },
    defensiveCall: { name: 'Cover 1 Robber' }
  });
  assert.equal(result.guide.progressionStatus, 'derived');
  assert.equal(result.guide.diagramMode, 'assignment_geometry');
  assert.equal(result.guide.receivers.filter(receiver => receiver.assignmentGeometry).length, 2);
  assert.match(result.guide.warning, /not an EA-authored progression/i);
});
