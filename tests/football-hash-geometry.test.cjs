'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashGeometryScore, flipRecommendation, mirrorability } = require('../src/football/analysis/hash-geometry');

function stretch(extra={}) {
  return {
    id:'stretch',
    name:'HB Stretch',
    type:'RUN',
    runDirection:'LEFT',
    normalizedProfile:{ decisionClass:'run', playMechanism:'dropback', runFamily:'perimeter', fieldStress:[] },
    ...extra,
  };
}

test('unknown live hash produces no football geometry claim', () => {
  const result = hashGeometryScore(stretch(), { hash:'unknown', offenseDirection:1 });
  assert.equal(result.score, 0);
  assert.equal(result.available, false);
});

test('field-side value requires known play orientation', () => {
  const play={...stretch()}; delete play.runDirection;
  const result=hashGeometryScore(play,{hash:'right',offenseDirection:1});
  assert.equal(result.score,0);
  assert.equal(result.available,false);
});

test('wide-side is not universally rewarded', () => {
  const play={
    name:'Inside Zone',type:'RUN',runDirection:'LEFT',
    normalizedProfile:{decisionClass:'run',playMechanism:'dropback',runFamily:'zone',fieldStress:[]}
  };
  const result=hashGeometryScore(play,{hash:'right',offenseDirection:1});
  assert.equal(result.score,0);
});

test('mirror recommendation fails closed without play-level mirror evidence', () => {
  const authority={set:{positions:[{flippedX:2,flipIndex:1}]},play:{}};
  const result=flipRecommendation(stretch(),{hash:'left',offenseDirection:1},authority);
  assert.equal(result.recommend,false);
  assert.equal(result.mirror.mirrorable,false);
  assert.equal(result.mirror.provenance,'DERIVED');
});

test('explicit EA mirror metadata can preserve a good call by flipping it', () => {
  const authority={play:{allowFlip:true},set:{positions:[]}};
  const result=flipRecommendation(stretch(),{hash:'left',offenseDirection:1},authority);
  assert.equal(result.recommend,true);
  assert.equal(result.targetSide,'RIGHT');
  assert.equal(result.provenance,'EA_AUTHORED');
});

test('derived catalog mirror evidence is distinguished from EA-authored mirror evidence', () => {
  assert.equal(mirrorability({mirrorable:true},null).provenance,'DERIVED');
  assert.equal(mirrorability({}, {play:{allowFlip:true}}).provenance,'EA_AUTHORED');
});
