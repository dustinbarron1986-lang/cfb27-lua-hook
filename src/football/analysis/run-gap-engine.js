'use strict';

function cleanEnum(value, prefixes = []) {
  let text = String(value || '');
  for (const prefix of prefixes) text = text.replace(new RegExp(`^${prefix}`, 'i'), '');
  return text.replaceAll('_', ' ').trim().toLowerCase() || null;
}

function gapInfo(gap) {
  const raw = String(gap || '');
  if (!raw) return { gap: null, side: null, family: null };
  const lower = raw.toLowerCase();
  const side = lower.includes('left') ? 'left' : lower.includes('right') ? 'right' : null;
  let family = null;
  if (/a_gap/.test(lower)) family = 'A';
  else if (/b_gap/.test(lower)) family = 'B';
  else if (/c_gap/.test(lower)) family = 'C';
  else if (/d_gap/.test(lower)) family = 'D';
  else if (/outside/.test(lower)) family = 'outside';
  return { gap: raw, side, family };
}

function analyzeRunAssignments(assignments = [], options = {}) {
  const blockers = [];
  const gapVotes = [];
  for (const item of assignments || []) {
    const record = item?.eaAssignment || item?.record || item;
    const blocking = record?.semantics?.blocking;
    if (!blocking) continue;
    for (const lead of blocking.leadBlocks || []) {
      const info = gapInfo(lead.gap);
      if (info.gap) gapVotes.push(info);
      blockers.push({
        player: item.player || item.position || item.button || null,
        assignmentId: record.positionAssignId ?? item.assignmentId ?? null,
        assignmentName: record.shortName || null,
        role: 'lead_block',
        technique: cleanEnum(lead.technique, ['BLOCKINGTECHNIQUE_']),
        ...info,
      });
    }
    for (const run of blocking.runBlocks || []) {
      blockers.push({
        player: item.player || item.position || item.button || null,
        assignmentId: record.positionAssignId ?? item.assignmentId ?? null,
        assignmentName: record.shortName || null,
        role: 'run_block',
        technique: cleanEnum(run.receiverBlockType, ['RECEIVERBLOCKTYPE_']),
        gap: null,
        side: null,
        family: null,
      });
    }
  }

  const counts = new Map();
  for (const vote of gapVotes) counts.set(vote.gap, (counts.get(vote.gap) || 0) + 1);
  const primary = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const primaryInfo = gapInfo(primary);
  const catalogRunHole = options.runHole == null ? null : String(options.runHole);

  return {
    available: blockers.length > 0 || catalogRunHole != null,
    source: blockers.length ? 'ea_blocking_assignments' : (catalogRunHole != null ? 'catalog_run_hole' : 'unavailable'),
    primaryGap: primaryInfo.gap,
    primaryGapFamily: primaryInfo.family,
    primarySide: primaryInfo.side,
    catalogRunHole,
    blockers,
    techniques: [...new Set(blockers.map(block => block.technique).filter(Boolean))],
    designedGaps: [...new Set(gapVotes.map(vote => vote.gap))],
  };
}

module.exports = { analyzeRunAssignments, gapInfo };
