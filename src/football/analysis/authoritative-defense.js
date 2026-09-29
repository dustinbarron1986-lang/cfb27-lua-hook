'use strict';

function assignmentDefense(player = {}) {
  return player.assignment?.assignmentSemantics?.defense ||
    player.assignment?.semantics?.defense ||
    player.eaAssignment?.semantics?.defense || null;
}
function buildAuthoritativeDefensiveStructure(expanded) {
  if (!expanded || expanded.status !== 'resolved') return {available:false,status:expanded?.status||'unavailable',reason:expanded?.reason||'authoritative_defensive_play_not_expanded',assignments:[],provenance:null};
  const assignments=(expanded.players||[]).map(player=>{const defense=assignmentDefense(player);return {
    playerIndex:player.index,position:player.startingAlignment?.positionType||player.startingAlignment?.depthPosition||null,
    assignmentName:player.assignment?.assignmentName||null,assignmentId:player.assignment?.positionAssignId??null,
    zones:defense?.zones||[],man:defense?.man||[],rush:defense?.rush||[],alignments:defense?.alignments||[],disguise:defense?.disguise||[],
    known:Boolean(defense),provenance:defense?'EA_AUTHORED':null};});
  const known=assignments.filter(row=>row.known);
  const zones=known.flatMap(row=>row.zones.map(zone=>({...zone,playerIndex:row.playerIndex})));
  const man=known.flatMap(row=>row.man.map(value=>({...value,playerIndex:row.playerIndex})));
  const rush=known.flatMap(row=>row.rush.map(value=>({...value,playerIndex:row.playerIndex})));
  return {available:known.length>0,status:known.length?'resolved':'no_defensive_assignment_semantics',playKey:expanded.playKey||null,play:expanded.play||null,
    assignments,zones,man,rush,responsibilityFamilies:[...new Set([...zones.map(row=>row.family),...(man.length?['man']:[]),...(rush.length?['rush']:[])].filter(Boolean))],
    provenance:known.length?'EA_AUTHORED':null,unknownAssignments:assignments.filter(row=>!row.known).map(row=>row.playerIndex)};
}
function resolveAuthoritativeDefense({store,liveCall}={}) {
  if (!store || typeof store.resolvePlay!=='function' || !liveCall?.available || !liveCall?.name || !liveCall?.set)
    return {available:false,status:'unavailable',reason:'store_or_live_defensive_identity_unavailable'};
  const resolved=store.resolvePlay({playName:liveCall.name,setName:liveCall.set,evidence:{authorityEligible:true,playName:{value:liveCall.name,source:'live_telemetry.defensivePlay'},setName:{value:liveCall.set,source:'live_telemetry.defensiveSet'}}});
  if (resolved?.status!=='resolved') return {available:false,status:resolved?.status||'unresolved',reason:resolved?.reason||'authoritative_defensive_structural_miss',resolution:resolved};
  return {...buildAuthoritativeDefensiveStructure(store.expandPlay(resolved.playKey)),resolution:resolved};
}
module.exports={assignmentDefense,buildAuthoritativeDefensiveStructure,resolveAuthoritativeDefense};
