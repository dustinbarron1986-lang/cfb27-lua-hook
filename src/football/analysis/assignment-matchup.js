'use strict';

// Static assignment matchup: EA-authored offensive route/blocking structure vs
// the EA-authored defensive responsibilities of the exact live defensive call.
//
// Both structures share one field frame (+x = offense right, +y = downfield),
// proved from the playbook XML and Frostbite set positions. Route END points
// are compared with the region each authored responsibility covers.
//
// This is structural evidence only. It says "this structure stresses the
// right-side curl-flat defender", never "the receiver is open": no live
// leverage, spacing, pursuit or pressure timing is tracked.

const { buildOffensiveProfile } = require('./offensive-profile');

const GREEN = 0.55;
const RED = -0.55;
const MAX_SCORE = 1.5;

function sideOfX(x, band = 3) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  if (n > band) return 'RIGHT';
  if (n < -band) return 'LEFT';
  return 'MIDDLE';
}

function depthOfY(y) {
  const n = Number(y);
  if (!Number.isFinite(n)) return null;
  if (n < 5) return 'SHORT';
  if (n < 14) return 'MID';
  return 'DEEP';
}

function routeEnd(target) {
  const points = target?.geometry?.points || [];
  const last = points[points.length - 1];
  if (!last) return null;
  const startX = Number(target.startX ?? target.geometry?.start?.x);
  return {
    playerIndex: target.playerIndex,
    label: target.playerLabel || target.button || null,
    routeFamily: String(target.routeFamily || '').toLowerCase(),
    x: Number(last.x),
    y: Number(last.y),
    side: sideOfX(last.x),
    depth: depthOfY(last.y),
    wide: Math.abs(Number(last.x)) >= 9,
    lateralTravel: Number.isFinite(startX) ? Math.abs(Number(last.x) - startX) : 0,
  };
}

function lower(side) {
  return String(side || '').toLowerCase();
}

function zonesOf(defense, predicate) {
  return (defense?.zones || []).filter(predicate);
}

function underOnSide(defense, side) {
  return zonesOf(defense, z => z.layer === 'UNDER' && z.offenseSide === side);
}

function passBlockers(offensiveAuthority) {
  return (offensiveAuthority?.blockingPlayers || []).filter(player =>
    (player.eaAssignment?.semantics?.blocking?.passBlocks || []).length > 0);
}

function evaluateAssignmentMatchup({ offensiveAuthority = null, offensiveProfile = null, defensiveAuthority = null, runGap = null } = {}) {
  if (!defensiveAuthority?.available) {
    return {
      available: false,
      score: 0,
      classification: 'YELLOW',
      reasons: ['Individual defensive assignments are not authoritatively resolved; broad structure remains the fallback.'],
      stresses: [],
      provenance: null,
    };
  }

  const profile = offensiveProfile || buildOffensiveProfile({}, offensiveAuthority);
  const defense = defensiveAuthority;
  const summary = defense.summary || {
    rushers: (defense.rush || []).length,
    deepCount: (defense.zones || []).filter(z => z.family === 'deep').length,
    manDefenders: (defense.man || []).length,
  };
  const complete = (defense.knownAssignments ?? 0) >= (defense.totalAssignments ?? 11);
  const routes = (offensiveAuthority?.routeTargets || []).map(routeEnd).filter(Boolean);
  const rushers = defense.rush || [];
  const blockers = passBlockers(offensiveAuthority);
  const mechanism = profile.playMechanism || null;
  const isRun = profile.decisionClass === 'run' || mechanism === 'run';
  const stresses = [];
  let score = 0;

  const add = (key, value, reason, detail = {}) => {
    score += value;
    stresses.push({ key, value: Number(value.toFixed(3)), reason, ...detail });
  };

  // ---------------- PASS GAME ----------------
  if (!isRun && routes.length) {
    const deepZones = zonesOf(defense, z => z.layer === 'DEEP');
    const deepRoutes = routes.filter(r => r.depth === 'DEEP');

    for (const side of ['LEFT', 'RIGHT']) {
      const sideRoutes = routes.filter(r => r.side === side);
      const under = underOnSide(defense, side);
      const outsideUnder = under.filter(z => z.responsibility === 'FLAT' || z.responsibility === 'CURL_FLAT');
      const wideShort = sideRoutes.filter(r => r.depth === 'SHORT' && r.wide);
      const outsideHigh = sideRoutes.filter(r => (r.depth === 'MID' || r.depth === 'DEEP') && Math.abs(r.x) >= 7);

      // High-low on one outside underneath defender.
      if (outsideUnder.length === 1 && wideShort.length && outsideHigh.length) {
        const defender = outsideUnder[0];
        add('high_low', 0.6,
          `This assignment structure puts a high-low on the ${lower(side)}-side ${defender.responsibility === 'CURL_FLAT' ? 'curl-flat' : 'flat'} defender (short outside route under an outside route above it).`,
          { side, defender: defender.responsibility });
      }

      // Flood: three layers to one side against zone.
      const layers = new Set(sideRoutes.map(r => r.depth));
      if (layers.size === 3 && sideRoutes.length >= 3 && under.length <= 2) {
        add('flood', 0.5,
          `Three route levels to the ${lower(side)} side stress the ${lower(side)} flat/curl-flat and deep responsibilities together (flood/sail structure).`,
          { side });
      }

      // Horizontal stretch: inside and wide underneath routes vs one under defender.
      const insideUnderRoutes = sideRoutes.filter(r => r.depth !== 'DEEP' && !r.wide);
      if (under.length === 1 && wideShort.length && insideUnderRoutes.length) {
        add('horizontal_stretch', 0.3,
          `Inside and outside underneath routes to the ${lower(side)} stretch the single ${lower(side)}-side underneath defender horizontally.`,
          { side });
      }
    }

    if (deepZones.length && deepRoutes.length > deepZones.length) {
      add('vertical_stretch', 0.4,
        `${deepRoutes.length} deep route ends against ${deepZones.length} authored deep responsibilities creates a numbers stretch over the top.`);
    }
    if (summary.shell === 'THREE_DEEP') {
      const seams = deepRoutes.filter(r => Math.abs(r.x) >= 3 && Math.abs(r.x) <= 11);
      if (seams.length >= 2) {
        add('seam_stress', 0.3, 'Two seam-depth routes stress the deep-middle-third defender between the outside thirds.');
      }
    }
    if (summary.shell === 'ZERO_DEEP' && deepRoutes.length) {
      add('no_deep_help', 0.5, 'The authored structure has no deep-zone defender; any vertical route is uncapped structurally.');
    }
    if ((summary.coverageMode === 'MAN' || summary.coverageMode === 'MIXED') && summary.manDefenders >= 3) {
      const crossers = routes.filter(r => r.lateralTravel >= 8 && r.depth !== 'DEEP');
      if (crossers.length) {
        add('man_crossers', 0.35,
          'Crossing routes work against the authored man responsibilities (defenders must trail across the formation); leverage itself is not tracked.');
      }
    }
  }

  // Route families without decoded geometry (legacy/partial offensive
  // authority): only the side-independent family checks are possible.
  if (!isRun && !routes.length) {
    const families = new Set(profile.routes || []);
    const outsideUnder = zonesOf(defense, z => z.family === 'curl_flat' || z.family === 'flat');
    if (families.has('corner') && (families.has('flat') || families.has('quick_out')) && outsideUnder.some(z => z.family === 'curl_flat')) {
      add('high_low', 0.8, 'Corner/flat route families put a high-low on an authored curl-flat responsibility (side not established without route geometry).');
    }
  }

  if (!isRun) {
    if (mechanism === 'screen' && summary.rushers >= 5) {
      add('screen_vs_rush', 0.55, `Screen structure attacks an authored ${summary.rushers}-man rush.`);
    } else if (mechanism === 'screen' && complete && summary.rushers <= 3 && summary.underCount >= 6) {
      add('screen_vs_drop', -0.3, `Screen runs into ${summary.underCount} authored underneath droppers with only ${summary.rushers} rushers.`);
    }
  }

  // ---------------- PROTECTION ----------------
  if (!isRun && blockers.length) {
    if (rushers.length > blockers.length) {
      add('rush_overload', -Math.min(1.2, 0.35 + (rushers.length - blockers.length) * 0.2),
        `${rushers.length} authored rushers vs ${blockers.length} authored pass blockers: a static numbers problem in protection, not a live free-rusher claim.`);
    }
    if (summary.overloadSide) {
      const side = summary.overloadSide;
      const sideRush = rushers.filter(r => r.offenseSide === side).length;
      const sideBlock = blockers.filter(p => sideOfX(p.alignment?.x, 1.5) === side).length;
      if (sideRush > sideBlock) {
        add('overload_side', -0.3, `Authored pressure overloads the ${lower(side)} side (${sideRush} rushers vs ${sideBlock} blockers aligned there).`, { side });
      }
    }
  }

  // ---------------- RUN GAME ----------------
  if (isRun) {
    const poa = runGap?.primarySide ? String(runGap.primarySide).toUpperCase() : null;
    // Box: authored rushers plus inside underneath droppers. Only claimed when
    // every defender is resolved.
    if (complete && defense.resolution?.slotMapping !== false) {
      // Box = known defenders whose authored alignment is inside the tackle
      // box (|x| <= 7, depth <= 8) and who are not deep-zone players.
      // Compared with the play's own run blockers aligned in the same box
      // (perimeter stalk blocks do not count); otherwise fixed 6/8 bounds.
      const inBox = alignment => {
        const x = Number(alignment?.x);
        const y = Number(alignment?.y);
        return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 7 && Math.abs(y) <= 8;
      };
      const box = (defense.assignments || []).filter(a =>
        a.known && inBox(a.alignment) && !(a.zones || []).some(z => z.layer === 'DEEP')).length;
      const runBlockers = (offensiveAuthority?.blockingPlayers || []).filter(p => {
        const b = p.eaAssignment?.semantics?.blocking || {};
        return ((b.runBlocks || []).length || (b.leadBlocks || []).length) && inBox(p.alignment);
      }).length;
      const margin = runBlockers >= 5 ? runBlockers - box : null;
      if (margin != null ? margin >= 0 : box <= 6) {
        add('light_box', 0.35, `The authored structure commits ${box} defenders to the box${margin != null ? ` against ${runBlockers} authored run blockers` : ''}.`);
      } else if (margin != null ? margin <= -2 : box >= 8) {
        add('loaded_box', -0.35, `The authored structure commits ${box} defenders to the box${margin != null ? ` against ${runBlockers} authored run blockers` : ''}.`);
      }
    }
    if (poa === 'LEFT' || poa === 'RIGHT') {
      const sideRush = rushers.filter(r => r.offenseSide === poa).length;
      const awayRush = rushers.filter(r => r.offenseSide && r.offenseSide !== poa && r.offenseSide !== 'MIDDLE').length;
      if (sideRush - awayRush >= 2) {
        add('rush_to_poa', -0.3, `Authored rushers are weighted to the ${lower(poa)} point of attack.`, { side: poa });
      }
      const perimeter = /outside|stretch|sweep|toss|perimeter/.test(String(profile.runConcept || profile.runFamily || ''));
      if (perimeter && complete) {
        const force = underOnSide(defense, poa).filter(z => z.responsibility === 'FLAT' || z.responsibility === 'CURL_FLAT').length +
          rushers.filter(r => r.offenseSide === poa && r.interior === false).length;
        if (force === 0) add('no_force', 0.3, `No authored flat/curl-flat or edge rusher is assigned to the ${lower(poa)} perimeter.`, { side: poa });
      }
    }
  }

  score = Math.max(-MAX_SCORE, Math.min(MAX_SCORE, score));
  return {
    available: true,
    score: Number(score.toFixed(3)),
    classification: score >= GREEN ? 'GREEN' : score <= RED ? 'RED' : 'YELLOW',
    reasons: stresses.map(row => row.reason),
    stresses,
    evidence: {
      rushCount: rushers.length,
      blitzCount: summary.blitzers ?? 0,
      passBlockAssignmentCount: blockers.length,
      deepZoneCount: summary.deepCount ?? 0,
      shell: summary.shell || null,
      coverageMode: summary.coverageMode || null,
      routeEnds: routes.length,
      knownAssignments: defense.knownAssignments ?? null,
      completeDefense: complete,
      responsibilityFamilies: defense.responsibilityFamilies || [],
    },
    provenance: 'EA_AUTHORED_ASSIGNMENTS+DERIVED_MATCHUP',
    limitation: 'Static assignment structure only; no live leverage, spacing, receiver openness, pursuit angle, or pressure distance is claimed.',
  };
}

module.exports = { evaluateAssignmentMatchup, routeEnd, sideOfX, depthOfY };
