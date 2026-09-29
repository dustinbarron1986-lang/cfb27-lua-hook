'use strict';

const { buildOffensiveProfile } = require('./offensive-profile');

function countZone(defense,family){return (defense?.zones||[]).filter(row=>row.family===family).length;}

function evaluateAssignmentMatchup({offensiveAuthority=null,offensiveProfile=null,defensiveAuthority=null}={}) {
  if (!defensiveAuthority?.available) {
    return {available:false,score:0,classification:'YELLOW',reasons:['Individual defensive assignments are not authoritatively resolved; broad structure remains the fallback.'],provenance:null};
  }
  const profile=offensiveProfile || buildOffensiveProfile({},offensiveAuthority);
  const routes=new Set(profile.routes||[]);
  const routeTargets=offensiveAuthority?.routeTargets||[];
  const rushCount=(defensiveAuthority.rush||[]).length;
  const blockerCount=(offensiveAuthority?.blockingPlayers||[]).filter(player=>(player.eaAssignment?.semantics?.blocking?.passBlocks||[]).length>0).length;
  let score=0; const reasons=[];
  if (routes.has('corner') && (routes.has('flat')||routes.has('quick_out')) && countZone(defensiveAuthority,'curl_flat')>0) {
    score+=0.8; reasons.push('EA-authored corner/flat distribution places a curl-flat responsibility in a high-low conflict.');
  }
  const floodLike=profile.passConcept==='flood_sail'||(routes.has('corner')&&(routes.has('flat')||routes.has('deep_out')));
  if (floodLike && countZone(defensiveAuthority,'flat')+countZone(defensiveAuthority,'curl_flat')>0) {
    score+=0.45; reasons.push('EA-authored outside route distribution stresses the flat/curl-flat layer structurally.');
  }
  const verticalTargets=routeTargets.filter(target=>['go','post','corner','wheel'].includes(String(target.routeFamily||'').toLowerCase())).length;
  const deepZones=countZone(defensiveAuthority,'deep');
  if (verticalTargets>=3 && deepZones>0 && verticalTargets>deepZones) {
    score+=0.4; reasons.push('Vertical route distribution creates more deep threats than the resolved deep-zone responsibility count.');
  }
  if (profile.playMechanism==='screen' && rushCount>=5) {
    score+=0.55; reasons.push('Screen structure attacks a defense with multiple EA-authored pass-rush responsibilities.');
  }
  if (blockerCount>0 && rushCount>blockerCount) {
    score-=Math.min(1.2,0.35+(rushCount-blockerCount)*0.2);
    reasons.push('Resolved rush assignments outnumber identified EA pass-block assignments; this is a static overload risk, not a live free-rusher claim.');
  }
  return {
    available:true,score:Number(score.toFixed(3)),classification:score>=0.55?'GREEN':score<=-0.55?'RED':'YELLOW',reasons,
    evidence:{rushCount,passBlockAssignmentCount:blockerCount,deepZoneCount:deepZones,verticalTargetCount:verticalTargets,responsibilityFamilies:defensiveAuthority.responsibilityFamilies||[]},
    provenance:'EA_AUTHORED_ASSIGNMENTS+DERIVED_MATCHUP',
    limitation:'Static assignment structure only; no live leverage, spacing, receiver openness, pursuit angle, or pressure distance is claimed.',
  };
}
module.exports={evaluateAssignmentMatchup};
