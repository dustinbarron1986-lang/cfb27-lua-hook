'use strict';

const { classifyOffensiveStructure, normalize } = require('../analysis/structural-threat-model');

function playType(play = {}) {
  return String(play.type || play.playKind || '').trim().toUpperCase();
}

function verifiedHotRouteSupport(play = {}) {
  return play.hotRouteEligible === true ||
    play.authoritativeCapabilities?.hotRoute === true ||
    play.eaAuthority?.capabilities?.hotRoute === true;
}

function adjustmentCapabilities(play = {}, authoritativeKnowledge = null) {
  const type = playType(play);
  const structure = play.structural || classifyOffensiveStructure(
    play,
    authoritativeKnowledge?.authoritative || play.authoritativeStructure || null
  );
  const modifiers = new Set(structure?.modifierKeys || []);
  const text = normalize([play.name, ...(play.concepts || [])].join(' '));

  const runLikeType = type === 'RUN';
  const rpo = type === 'RPO' || modifiers.has('RPO_CONFLICT') || /(^| )rpo( |$)/.test(text);
  const option = type === 'OPTION' || modifiers.has('OPTION') ||
    /read option|zone read|speed option|veer|power read/.test(text);
  const positivePass = type === 'PASS' || type === 'SCREEN';

  const canHotRoute = verifiedHotRouteSupport(play) || (positivePass && !rpo && !option && !runLikeType);
  const hotRouteReason = canHotRoute
    ? 'Normal passing hot-route capability is positively established.'
    : (rpo ? 'RPO adjustment rules do not establish normal hot routes.'
      : option ? 'Option/read-option adjustment rules do not establish normal hot routes.'
        : runLikeType ? 'Run plays do not establish normal passing hot routes.'
          : 'Hot-route legality is not positively established for this play type.');

  // Protection is fail-closed for run/RPO/option. The existing assignment map
  // still decides whether a specific eligible receiver can actually stay in.
  const canAdjustProtection = positivePass && !rpo && !option && !runLikeType;

  return {
    type: type || null,
    runLikeType,
    rpo,
    option,
    canHotRoute,
    canAdjustProtection,
    canAudible: true,
    hotRouteReason,
    provenance: verifiedHotRouteSupport(play)
      ? 'AUTHORITATIVE_CAPABILITY'
      : (type ? 'CANONICAL_PLAY_TYPE' : 'FAIL_CLOSED_UNKNOWN_TYPE'),
  };
}

module.exports = { adjustmentCapabilities, playType };
