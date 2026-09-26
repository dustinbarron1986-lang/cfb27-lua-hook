function gradeOffensivePlay(event) {
  const s = event.situation || {};
  const r = event.result || {};
  const yards = Number(r.yards || 0);
  const distance = Math.max(0, Number(s.distance || 0));

  const catastrophic = Boolean(r.turnover || r.safetyAllowed);
  let objectiveSuccess = false;

  if (!catastrophic) {
    if (r.touchdown || r.firstDown || r.conversion) objectiveSuccess = true;
    else if ((s.down === 3 || s.down === 4) && distance > 0) objectiveSuccess = yards >= distance;
  }

  let situationalSuccess = objectiveSuccess;

  if (!catastrophic && !situationalSuccess && (s.down === 1 || s.down === 2) && distance > 0) {
    const threshold = s.down === 1 ? 0.40 : 0.50;
    situationalSuccess = yards >= distance * threshold;
  }

  const explosiveThreshold = event.play?.type === "RUN" ? 10 : 15;
  const explosive = Boolean(r.explosive) || yards >= explosiveThreshold;
  const negativePlay = yards < 0 || Boolean(r.sack);

  let resultGrade = 0;
  if (catastrophic) resultGrade = -1;
  else if (r.touchdown || r.firstDown || r.conversion) resultGrade = 1;
  else if (situationalSuccess) resultGrade = 0.65;
  else if (negativePlay) resultGrade = -0.5;

  return { objectiveSuccess, situationalSuccess, explosive, catastrophic, negativePlay, resultGrade };
}

function gradeDefensivePlay(event) {
  const s = event.situation || {};
  const r = event.result || {};
  const yards = Number(r.yards || 0);
  const distance = Math.max(0, Number(s.distance || 0));

  let objectiveSuccess;
  if (r.turnover) objectiveSuccess = true;
  else if (r.touchdown || r.firstDown || r.conversion) objectiveSuccess = false;
  else if ((s.down === 3 || s.down === 4) && distance > 0) objectiveSuccess = yards < distance;
  else {
    const threshold = s.down === 1 ? 0.40 : s.down === 2 ? 0.50 : 1.00;
    objectiveSuccess = distance > 0 ? yards < distance * threshold : !r.touchdown;
  }

  return {
    objectiveSuccess,
    takeaway: Boolean(r.turnover),
    explosiveAllowed: Boolean(r.explosive) || yards >= (event.play?.type === "RUN" ? 10 : 15)
  };
}

module.exports = { gradeOffensivePlay, gradeDefensivePlay };
