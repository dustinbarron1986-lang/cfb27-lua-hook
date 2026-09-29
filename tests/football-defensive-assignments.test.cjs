'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildAuthoritativeDefensiveStructure}=require('../src/football/analysis/authoritative-defense');
const {evaluateAssignmentMatchup}=require('../src/football/analysis/assignment-matchup');
function expanded(assignments){return {status:'resolved',playKey:'def:test',play:{name:'Cover 3'},players:assignments.map((defense,index)=>({index,startingAlignment:{positionType:'DB'},assignment:{positionAssignId:index,assignmentName:'A'+index,assignmentSemantics:{defense}}}))};}
test('authoritative defensive responsibilities preserve EA provenance and unknown stays unknown',()=>{
 const def=buildAuthoritativeDefensiveStructure({status:'resolved',playKey:'d',play:{name:'x'},players:[{index:0,assignment:{assignmentSemantics:{defense:{zones:[{family:'deep'}],man:[],rush:[],alignments:[],disguise:[]}}}},{index:1,assignment:null}]});
 assert.equal(def.available,true); assert.equal(def.assignments[0].provenance,'EA_AUTHORED'); assert.equal(def.assignments[1].known,false); assert.deepEqual(def.unknownAssignments,[1]);
});
test('corner-flat structure can stress resolved curl-flat responsibility',()=>{
 const def=buildAuthoritativeDefensiveStructure(expanded([{zones:[{family:'curl_flat'}],man:[],rush:[],alignments:[],disguise:[]},{zones:[{family:'deep'}],man:[],rush:[],alignments:[],disguise:[]}]));
 const result=evaluateAssignmentMatchup({offensiveAuthority:{routeTargets:[{routeFamily:'corner'},{routeFamily:'flat'}],blockingPlayers:[]},offensiveProfile:{decisionClass:'pass',playMechanism:'dropback',passConcept:'flood_sail',routes:['corner','flat']},defensiveAuthority:def});
 assert.equal(result.classification,'GREEN'); assert.match(result.reasons.join(' '),/curl-flat/i);
});
test('screen vs multiple authoritative rush responsibilities is a structural positive',()=>{
 const rush={zones:[],man:[],rush:[{gap:'A'}],alignments:[],disguise:[]};
 const def=buildAuthoritativeDefensiveStructure(expanded([rush,rush,rush,rush,rush]));
 const result=evaluateAssignmentMatchup({offensiveAuthority:{routeTargets:[],blockingPlayers:[]},offensiveProfile:{decisionClass:'pass',playMechanism:'screen',routes:['screen']},defensiveAuthority:def});
 assert.ok(result.score>0);
});
test('assignment evaluator never claims live receiver openness',()=>{
 const def=buildAuthoritativeDefensiveStructure(expanded([{zones:[{family:'deep'}],man:[],rush:[],alignments:[],disguise:[]}]));
 const result=evaluateAssignmentMatchup({offensiveAuthority:{routeTargets:[{routeFamily:'go'}],blockingPlayers:[]},offensiveProfile:{decisionClass:'pass',playMechanism:'dropback',routes:['go']},defensiveAuthority:def});
 assert.doesNotMatch(JSON.stringify(result),/will be open|receiver is open|guaranteed open/i); assert.match(result.limitation,/no live leverage/i);
});
