function norm(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(text, terms) {
  return terms.some(term => text.includes(term));
}

function coveragePlain(coverageKey, defensiveName) {
  const name = String(defensiveName || '');
  const blitz = /\b(blitz|pressure|zero)\b/i.test(name);
  if (blitz) return 'They are sending extra rushers. Get the ball out quickly if your first read is open.';
  switch (coverageKey) {
    case 'cover_0': return 'Everyone is mostly matched one-on-one. Crossing routes can shake defenders loose, but pressure may arrive fast.';
    case 'cover_1': return 'Most receivers are one-on-one with one deep safety helping. Favor the receiver who has created the clearest space from his defender.';
    case 'cover_2': return 'Two defenders are protecting deep. The middle of the field can open if the underneath defenders step forward.';
    case 'cover_2_man': return 'Receivers are mostly one-on-one with two deep safeties. Short crossing routes are usually safer than forcing a deep throw.';
    case 'cover_3': return 'Three defenders are protecting deep. Short throws near the sideline and routes up the middle can open; avoid throwing late to a receiver deep near the sideline.';
    case 'cover_4': return 'Four defenders are protecting deep. Take the shorter route if the defense keeps everything in front of it.';
    case 'cover_6': return 'The defense is protecting deep with a split look. Work underneath first and avoid forcing a throw into the deep safeties.';
    default: return name ? 'Use the numbered reads below. If the first option is covered, move on immediately.' : null;
  }
}

function passTemplate(play, concept) {
  const n = norm(play?.name);
  const key = norm(concept);

  if (key.includes('mesh') || n.includes('mesh')) {
    return {
      family: 'mesh',
      reads: [
        ['1', 'Receiver crossing close to the line', 'Look for the receiver running across the field with space in front of him.'],
        ['2', 'Second receiver across the middle', 'If the first route is covered, look for the receiver crossing the other way or stopping in open space.'],
        ['3', 'Short outlet', 'If both are covered, take the running back or shortest safe throw.']
      ],
      paths: ['crossLeftToRight', 'crossRightToLeft', 'flatRight']
    };
  }

  if (key.includes('flood') || includesAny(n, ['flood', 'sail'])) {
    return {
      family: 'flood',
      reads: [
        ['1', 'Deep sideline route', 'Check the deepest receiver on the play side first.'],
        ['2', 'Middle sideline route', 'If the deep route is covered, come down to the receiver breaking toward the sideline.'],
        ['3', 'Short receiver near the sideline', 'If the defense stays deep, take the easy short throw near the sideline.']
      ],
      paths: ['deepOutRight', 'midOutRight', 'flatRight']
    };
  }

  if (key.includes('four vertical') || includesAny(n, ['vertical', 'all go', 'seam'])) {
    return {
      family: 'verticals',
      reads: [
        ['1', 'Inside deep route', 'Look between the deep defenders for the inside receiver.'],
        ['2', 'Outside deep receiver', 'If an outside receiver has created clear space from his defender, take that throw.'],
        ['3', 'Short outlet', 'If the deep routes are covered, take the easy throw underneath.']
      ],
      paths: ['seamLeft', 'goRight', 'flatLeft']
    };
  }

  if (key.includes('slant') || n.includes('slant')) {
    return {
      family: 'slants',
      reads: [
        ['1', 'First receiver cutting inside', 'Throw as the receiver turns toward the middle if the throwing lane is clear.'],
        ['2', 'Second receiver cutting inside', 'If the first lane is crowded, move to the other receiver cutting toward the middle.'],
        ['3', 'Short outlet', 'Do not hold the ball if both slants are covered.']
      ],
      paths: ['slantLeft', 'slantRight', 'flatRight']
    };
  }

  if (key.includes('corner') || n.includes('corner')) {
    return {
      family: 'corner',
      reads: [
        ['1', 'Receiver breaking toward the sideline', 'Look for the deeper receiver breaking away from the middle.'],
        ['2', 'Short receiver underneath', 'If the deep route is covered, throw underneath on the same side.'],
        ['3', 'Short outlet', 'If both are covered, take the safest short throw.']
      ],
      paths: ['cornerRight', 'flatRight', 'flatLeft']
    };
  }

  if (key.includes('stick') || includesAny(n, ['stick', 'spacing'])) {
    return {
      family: 'stick',
      reads: [
        ['1', 'Short receiver settling in space', 'Throw when he turns and there is no defender directly in the throwing lane.'],
        ['2', 'Short receiver near the sideline', 'If the first option is covered inside, look outside immediately.'],
        ['3', 'Backside short route', 'If the defense jumps the first two, come back to the other side.']
      ],
      paths: ['stickRight', 'flatRight', 'hitchLeft']
    };
  }

  if (key.includes('screen') || n.includes('screen')) {
    return {
      family: 'screen',
      reads: [
        ['1', 'Screen target', 'Let the rush come toward you, then throw to the receiver behind the blockers.'],
        ['2', 'Do not force it', 'If the screen is covered immediately, throw the ball away if you can.']
      ],
      paths: ['screenRight']
    };
  }

  if (includesAny(n, ['dagger', 'levels', 'deep in', 'dig'])) {
    return {
      family: 'inBreak',
      reads: [
        ['1', 'Receiver breaking across the middle', 'Look for the deeper receiver crossing into open space.'],
        ['2', 'Shorter inside route', 'If the deep route is covered, come down to the shorter receiver underneath.'],
        ['3', 'Short outlet', 'Take the easy throw if the middle is crowded.']
      ],
      paths: ['deepInRight', 'shallowInLeft', 'flatRight']
    };
  }

  if (includesAny(n, ['post', 'skinny post'])) {
    return {
      family: 'post',
      reads: [
        ['1', 'Deep receiver breaking toward the middle', 'Take it only if he gets behind the defender and the deep middle is open.'],
        ['2', 'Intermediate route', 'If a deep defender is waiting on the deep throw, look for the receiver crossing underneath.'],
        ['3', 'Short outlet', 'Take the safe throw if the first two are covered.']
      ],
      paths: ['postRight', 'crossLeftToRight', 'flatLeft']
    };
  }

  if (includesAny(n, ['curl', 'comeback', 'hitch'])) {
    return {
      family: 'curl',
      reads: [
        ['1', 'Receiver stopping in open space', 'Throw as he turns back if the defender is giving him room.'],
        ['2', 'Other short outside route', 'Move to the other side if the first receiver is tightly covered.'],
        ['3', 'Short outlet', 'Take the easy throw underneath rather than waiting.']
      ],
      paths: ['curlRight', 'curlLeft', 'flatRight']
    };
  }

  if (includesAny(n, ['cross', 'drive', 'shallow', 'drag'])) {
    return {
      family: 'cross',
      reads: [
        ['1', 'Receiver crossing the field', 'Lead him into open space as he clears traffic.'],
        ['2', 'Deeper crossing route', 'If the first receiver is covered, look behind him for the deeper route.'],
        ['3', 'Short outlet', 'Take the running back or shortest route if the middle is crowded.']
      ],
      paths: ['crossLeftToRight', 'deepInRight', 'flatLeft']
    };
  }

  return {
    family: 'genericPass',
    reads: [
      ['1', 'Primary route', 'Look at the receiver the play is designed to feature first.'],
      ['2', 'Second route', 'If the first receiver is covered, move to the next route across the field.'],
      ['3', 'Short outlet', 'If nothing opens quickly, take the shortest safe throw.']
    ],
    paths: ['deepInRight', 'shortOutLeft', 'flatRight']
  };
}

function runTemplate(play, concept) {
  const n = norm(play?.name);
  const key = norm(concept);

  if (key.includes('outside zone') || includesAny(n, ['stretch', 'outside zone', 'wide zone'])) {
    return {
      family: 'outside',
      headline: 'Start toward the outside edge.',
      watch: 'Watch the last blocker on the edge.',
      steps: [
        'If he seals the defender inside, keep running outside.',
        'If the defender stays outside, cut upfield just inside that block.',
        'If both lanes close, cut back behind the flow instead of forcing the edge.'
      ],
      lane: 'outside'
    };
  }

  if (key.includes('counter') || n.includes('counter')) {
    return {
      family: 'counter',
      headline: 'Take the first step away, then follow the blocker moving across in front of you.',
      watch: 'Watch the blocker who crosses in front of you.',
      steps: [
        'Stay behind him long enough for the block to happen.',
        'Run through the opening he creates.',
        'Do not bounce outside early unless the lane is completely closed.'
      ],
      lane: 'offGuard'
    };
  }

  if (includesAny(n, ['power o', 'power g', 'power'])) {
    return {
      family: 'power',
      headline: 'Follow the blocker moving across in front of you into the first opening just outside the middle.',
      watch: 'Watch the blocker moving across in front of you.',
      steps: [
        'Stay on his back until he chooses a defender to block.',
        'Cut through the space immediately beside that block.',
        'If the lane disappears, get north/south instead of drifting sideways.'
      ],
      lane: 'offGuard'
    };
  }

  if (includesAny(n, ['toss', 'sweep', 'end around', 'jet sweep'])) {
    return {
      family: 'sweep',
      headline: 'Get to the outside, then turn upfield.',
      watch: 'Watch the defender closest to the sideline.',
      steps: [
        'If your blocker gets outside of him, keep going around the edge.',
        'If he stays wide, cut underneath the block and go straight upfield.',
        'Do not keep running sideways once an inside lane opens.'
      ],
      lane: 'edge'
    };
  }

  if (includesAny(n, ['duo', 'dive', 'slam', 'iso', 'blast', 'gut', 'inside zone', 'mid zone', 'zone split']) || key.includes('inside zone')) {
    return {
      family: 'inside',
      headline: 'Press the middle and choose the first clean opening.',
      watch: 'Watch the two blockers beside the center.',
      steps: [
        'Start straight toward the middle so the defense has to commit.',
        'If one side gets pushed backward, cut to the other side of the center.',
        'Once you pick a lane, get upfield quickly instead of sliding sideways.'
      ],
      lane: 'inside'
    };
  }

  if (includesAny(n, ['trap', 'wham'])) {
    return {
      family: 'trap',
      headline: 'Attack the quick opening in the middle.',
      watch: 'Watch for a defender being allowed through and then blocked from the side.',
      steps: [
        'Do not hesitate behind the line.',
        'Hit the opening as soon as the side block lands.',
        'If the lane is gone, cut to the nearest open space and get upfield.'
      ],
      lane: 'inside'
    };
  }

  if (key.includes('read option') || includesAny(n, ['read option', 'zone read', 'veer'])) {
    return {
      family: 'readOption',
      headline: 'Watch the unblocked defender on the edge before deciding who keeps the ball.',
      watch: 'Watch the edge defender the play leaves unblocked.',
      steps: [
        'If he crashes toward the running back, keep the ball with the quarterback.',
        'If he waits outside for the quarterback, hand it off.',
        'Make the decision quickly; do not try to read everyone.'
      ],
      lane: 'option'
    };
  }

  return {
    family: 'genericRun',
    headline: 'Follow the play-side blockers and take the first clean lane.',
    watch: 'Watch the blocker directly in front of the intended lane.',
    steps: [
      'If he wins his block, run beside him.',
      'If the lane closes, cut behind the next blocker instead of running into contact.',
      'Once you see daylight, turn upfield.'
    ],
    lane: 'inside'
  };
}

function rpoTemplate(play) {
  const n = norm(play?.name);
  if (n.includes('bubble') || n.includes('screen')) {
    return {
      family: 'rpoBubble',
      reads: [
        ['1', 'Count defenders outside', 'If the defense has fewer defenders outside than you have blockers/receivers, throw the quick screen immediately.'],
        ['2', 'If the outside is covered', 'Hand the ball off and let the run play happen.'],
        ['3', 'If unsure', 'Hand it off. The run is the safer answer.']
      ],
      paths: ['screenRight', 'runInside']
    };
  }
  if (n.includes('slant') || n.includes('glance') || n.includes('post')) {
    return {
      family: 'rpoSlant',
      reads: [
        ['1', 'Watch the defender between the run and the receiver', 'Focus on the linebacker or safety sitting in the throwing lane.'],
        ['2', 'If he steps toward the run', 'Throw to the receiver cutting inside behind him.'],
        ['3', 'If he stays back', 'Hand the ball off.']
      ],
      paths: ['slantRight', 'runInside']
    };
  }
  return {
    family: 'rpoGeneric',
    reads: [
      ['1', 'Watch the conflict defender', 'Focus on the defender responsible for both the run area and the quick pass area.'],
      ['2', 'If he attacks the run', 'Throw the quick pass behind him.'],
      ['3', 'If he stays in coverage', 'Hand the ball off.']
    ],
    paths: ['shortOutRight', 'runInside']
  };
}

function assignmentPlain(meaning) {
  switch (meaning) {
    case 'slant_route_family': return { label: 'Cuts toward the middle', family: 'slant' };
    case 'vertical_or_seam_route_family': return { label: 'Runs deep up the field', family: 'vertical' };
    case 'mesh_cross_route_family': return { label: 'Crosses the field underneath', family: 'cross' };
    case 'screen_bubble_receiver_action': return { label: 'Quick screen target', family: 'screen' };
    case 'glance_or_post_receiver_action': return { label: 'Breaks toward the deep middle', family: 'post' };
    default: return null;
  }
}

function friendlyEaRoute(routeType, routeFamily) {
  const raw = routeFamily || String(routeType || '')
    .replace(/^AssignRouteType_/i, '')
    .replace(/^RR_/i, '');
  if (!raw) return null;
  return String(raw).replaceAll('_', ' ').trim();
}

function receiverKnowledge(playKnowledge) {
  const receivers = Array.isArray(playKnowledge?.receiverButtons) ? playKnowledge.receiverButtons : [];
  return receivers.map(receiver => {
    const fallback = assignmentPlain(receiver.assignment_meaning);
    const ea = receiver.eaAssignment || null;
    const geometry = ea?.semantics?.route || null;
    const routeFamily = geometry?.routeFamily || fallback?.family || null;
    const routeLabel = geometry
      ? friendlyEaRoute(ea?.routeType, geometry.routeFamily)
      : fallback?.label || null;
    return {
      button: receiver.button,
      x: receiver.x,
      y: receiver.y,
      assignment: receiver.assignment,
      assignmentMeaning: receiver.assignment_meaning || null,
      assignmentConfidence: receiver.assignment_confidence || 'unknown',
      eaAssignmentStatus: receiver.eaAssignmentStatus || null,
      assignmentName: ea?.shortName || null,
      assignmentRouteType: ea?.routeType || null,
      assignmentGeometry: geometry,
      routeFamily,
      routeLabel
    };
  });
}

function verifiedProgression(playKnowledge) {
  if (!playKnowledge?.progressionVerified || !Array.isArray(playKnowledge.progression)) return null;
  return playKnowledge.progression.map((read, index) => ({
    number: read.button || String(index + 1),
    button: read.button || null,
    label: read.label || read.route || `Read ${index + 1}`,
    detail: read.detail || read.coaching || '',
    path: read.path || null
  }));
}

function derivedProgression(playKnowledge) {
  const derived = playKnowledge?.derivedProgression;
  if (!derived?.available || derived.status !== 'derived_structural' || !Array.isArray(derived.reads)) return null;
  return {
    ...derived,
    reads: derived.reads.map((read, index) => ({
      number: read.number || String(index + 1),
      button: read.button || null,
      label: read.label || `Read ${index + 1}`,
      detail: read.detail || '',
      timing: read.timing || null,
      assignmentId: read.assignmentId ?? null,
      assignmentName: read.assignmentName || null
    }))
  };
}

function buildNoviceGuide({ selectedPlay, advice, defensiveCall, playKnowledge } = {}) {
  if (!selectedPlay) return null;
  const concept = advice?.concept || selectedPlay.primaryConcept || selectedPlay.concepts?.[0] || null;
  const playName = norm(selectedPlay.name);
  const isRpo = selectedPlay.playKind === 'RPO' || selectedPlay.modifiers?.includes('rpo') || /\brpo\b/.test(playName);
  const type = isRpo ? 'rpo' : (selectedPlay.type === 'RUN' ? 'run' : 'pass');
  const coverageNote = coveragePlain(advice?.coverage || null, defensiveCall?.name);

  if (type === 'run') {
    const t = runTemplate(selectedPlay, concept);
    return {
      mode: 'run',
      concept: concept || null,
      family: t.family,
      headline: t.headline,
      watch: t.watch,
      steps: t.steps,
      lane: t.lane,
      coverageNote: /\b(blitz|pressure|zero)\b/i.test(String(defensiveCall?.name || ''))
        ? 'They are sending extra rushers. The lane may appear quickly, so make one cut and get upfield.'
        : null,
      terminology: null
    };
  }

  const receivers = receiverKnowledge(playKnowledge);
  const verifiedReads = verifiedProgression(playKnowledge);
  const derivedReads = derivedProgression(playKnowledge);
  const routeTargets = receivers
    .filter(receiver => receiver.routeLabel)
    .map(receiver => ({
      button: receiver.button,
      label: receiver.routeLabel,
      detail: receiver.assignmentConfidence === 'high'
        ? 'This route family is strongly supported by the assignment data.'
        : 'This route family is partially supported by the assignment data.'
    }));

  const t = type === 'rpo' ? rpoTemplate(selectedPlay) : passTemplate(selectedPlay, concept);
  const note = type === 'rpo'
    ? (/\b(blitz|pressure|zero)\b/i.test(String(defensiveCall?.name || ''))
        ? 'Extra rushers are coming. Make the run-or-throw decision immediately.'
        : null)
    : coverageNote;

  if (verifiedReads) {
    return {
      mode: type,
      concept: concept || null,
      family: t.family,
      diagramMode: 'verified',
      diagramLabel: 'PLAY VIEW — VERIFIED',
      reads: verifiedReads,
      paths: playKnowledge.routes || verifiedReads.map(r => r.path).filter(Boolean),
      receivers,
      coverageNote: note,
      progressionStatus: 'verified',
      routeStatus: playKnowledge.routeArtVerified ? 'verified' : 'partial',
      terminology: null
    };
  }

  if (derivedReads) {
    return {
      mode: type,
      concept: concept || null,
      family: t.family,
      diagramMode: 'assignment_geometry',
      diagramLabel: 'EA ASSIGNMENT VIEW — DERIVED READS',
      reads: derivedReads.reads,
      paths: [],
      receivers,
      coverageNote: note,
      progressionStatus: 'derived',
      routeStatus: 'ea_assignment_geometry',
      timingCalibrated: Boolean(derivedReads.timingCalibrated),
      warning: derivedReads.warning,
      terminology: null
    };
  }

  const exactGeometryCount = receivers.filter(receiver => receiver.assignmentGeometry?.points?.length).length;
  const partial = receivers.length > 0;
  return {
    mode: type,
    concept: concept || null,
    family: t.family,
    diagramMode: exactGeometryCount ? 'assignment_geometry' : (partial ? 'assignment_partial' : 'concept_estimated'),
    diagramLabel: exactGeometryCount ? 'EA ASSIGNMENT VIEW — PARTIAL' : (partial ? 'ASSIGNMENT VIEW — PARTIAL' : 'CONCEPT VIEW — ESTIMATED'),
    reads: [],
    targets: routeTargets,
    receivers,
    // Keep the concept paths only as a visual fallback. The UI renders them dashed and labels them estimated.
    paths: partial ? [] : t.paths,
    coverageNote: note,
    progressionStatus: 'unverified',
    routeStatus: exactGeometryCount ? 'ea_assignment_geometry_partial' : (playKnowledge?.routeKnowledge || 'unknown'),
    warning: exactGeometryCount
      ? `${exactGeometryCount} receiver route${exactGeometryCount === 1 ? '' : 's'} use decoded EA assignment geometry. The designed EA read order is still unknown, so no progression is claimed.`
      : (partial
        ? 'The receiver buttons come from the pre-snap alignment. Only routes supported by decoded assignment data are drawn. The designed read order is not known yet.'
        : 'The exact routes and designed read order are not verified yet. This screen will not invent a progression.'),
    terminology: null
  };
}
module.exports = { buildNoviceGuide, passTemplate, runTemplate, rpoTemplate, coveragePlain, assignmentPlain, receiverKnowledge };
