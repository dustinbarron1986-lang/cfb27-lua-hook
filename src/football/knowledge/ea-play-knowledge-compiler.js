'use strict';

function normalizeGuid(value) {
  return value == null ? null : String(value).trim().toLowerCase();
}

function normalizeAssetPath(value) {
  return value == null
    ? null
    : String(value).trim().replace(/\\/g, '/').replace(/\.xml$/i, '').toLowerCase();
}

function flattenAssignmentRecords(data) {
  const out = [];
  for (const value of Object.values(data?.assignments || {})) {
    if (Array.isArray(value)) out.push(...value.filter(Boolean));
    else if (value) out.push(value);
  }
  return out;
}

function pushIndex(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function createAssetIndex(records = []) {
  const byPath = new Map();
  const byPartitionGuid = new Map();
  const byPrimaryGuid = new Map();
  const byPair = new Map();

  for (const record of records) {
    const assetPath = normalizeAssetPath(record.assetPath || record.name);
    const partitionGuid = normalizeGuid(record.partitionGuid);
    const primaryGuid = normalizeGuid(record.primaryGuid);
    pushIndex(byPath, assetPath, record);
    pushIndex(byPartitionGuid, partitionGuid, record);
    pushIndex(byPrimaryGuid, primaryGuid, record);
    if (partitionGuid && primaryGuid) pushIndex(byPair, `${partitionGuid}|${primaryGuid}`, record);
  }

  return { byPath, byPartitionGuid, byPrimaryGuid, byPair };
}

function unique(list) {
  return Array.isArray(list) && list.length === 1 ? list[0] : null;
}

function resolveReference(ref, index) {
  if (!ref || !index) return { record: null, status: 'missing_reference' };
  const assetPath = normalizeAssetPath(ref.assetPath);
  const partitionGuid = normalizeGuid(ref.partitionGuid);
  const instanceGuid = normalizeGuid(ref.ref);

  if (assetPath) {
    const exact = unique(index.byPath.get(assetPath));
    if (exact) return { record: exact, status: 'resolved_asset_path', exact: true };
    const matches = index.byPath.get(assetPath) || [];
    if (matches.length > 1) return { record: null, status: 'ambiguous_asset_path', candidates: matches };
  }

  if (partitionGuid && instanceGuid) {
    const exact = unique(index.byPair.get(`${partitionGuid}|${instanceGuid}`));
    if (exact) return { record: exact, status: 'resolved_partition_instance', exact: true };
    const matches = index.byPair.get(`${partitionGuid}|${instanceGuid}`) || [];
    if (matches.length > 1) return { record: null, status: 'ambiguous_partition_instance', candidates: matches };
  }

  if (instanceGuid) {
    const exact = unique(index.byPrimaryGuid.get(instanceGuid));
    if (exact) return { record: exact, status: 'resolved_primary_guid', exact: true };
    const matches = index.byPrimaryGuid.get(instanceGuid) || [];
    if (matches.length > 1) return { record: null, status: 'ambiguous_primary_guid', candidates: matches };
  }

  if (partitionGuid) {
    const exact = unique(index.byPartitionGuid.get(partitionGuid));
    if (exact) return { record: exact, status: 'resolved_partition_guid', exact: true };
    const matches = index.byPartitionGuid.get(partitionGuid) || [];
    if (matches.length > 1) return { record: null, status: 'ambiguous_partition_guid', candidates: matches };
  }

  return { record: null, status: 'unresolved_reference', ref };
}

function startingAlignment(setRecord, index) {
  const positions = setRecord?.positions || [];
  return positions.find(row => Number(row.index) === Number(index)) || positions[index] || null;
}

function normalizedAssignment(record) {
  if (!record) return null;
  return {
    assignmentAssetPath: record.assetPath || record.name || null,
    assignmentGuid: record.primaryGuid || null,
    assignmentPartitionGuid: record.partitionGuid || null,
    positionAssignId: record.positionAssignId ?? null,
    routeType: record.routeType || null,
    assignmentSemantics: record.semantics || null,
    assignmentName: record.shortName || null,
    assignmentCategory: record.category || null,
    source: 'ea',
  };
}

function compileResolvedPlay(play, context) {
  const setResolution = resolveReference(play.setRef, context.sets);
  const setRecord = setResolution.record;
  const formationResolution = setRecord
    ? resolveReference(setRecord.formationRef, context.formations)
    : { record: null, status: 'set_unresolved' };
  const formationRecord = formationResolution.record;

  const players = (play.positionAssignmentDefines || []).map((assignmentRef, index) => {
    const resolution = resolveReference(assignmentRef, context.assignments);
    const assignment = normalizedAssignment(resolution.record);
    return {
      index,
      startingAlignment: startingAlignment(setRecord, index),
      assignmentRef: {
        assetPath: assignmentRef.assetPath || null,
        partitionGuid: assignmentRef.partitionGuid || null,
        ref: assignmentRef.ref || null,
      },
      ...(assignment || {
        assignmentAssetPath: assignmentRef.assetPath || null,
        assignmentGuid: assignmentRef.ref || null,
        assignmentPartitionGuid: assignmentRef.partitionGuid || null,
        positionAssignId: null,
        routeType: null,
        assignmentSemantics: null,
        assignmentName: null,
        assignmentCategory: null,
        source: 'ea',
      }),
      resolutionStatus: resolution.status,
      source: 'ea',
    };
  });

  const unresolvedAssignments = players.filter(player =>
    /^unresolved|^ambiguous|^missing/.test(player.resolutionStatus || '') ||
    (player.positionAssignId == null && !player.assignmentAssetPath)
  ).length;

  return {
    schemaVersion: 1,
    formation: formationRecord ? {
      name: formationRecord.name,
      formId: formationRecord.formId,
      formationType: formationRecord.formationType || null,
      assetPath: formationRecord.assetPath,
      partitionGuid: formationRecord.partitionGuid || null,
      primaryGuid: formationRecord.primaryGuid || null,
      source: 'ea',
    } : null,
    set: setRecord ? {
      name: setRecord.name,
      setId: setRecord.setId,
      assetPath: setRecord.assetPath,
      formationAssetPath: formationRecord?.assetPath || setRecord.formationAssetPath || null,
      positions: setRecord.positions || [],
      defaultPresnapMovement: setRecord.defaultPresnapMovement || null,
      presnapMovements: setRecord.presnapMovements || [],
      packages: setRecord.packages || [],
      partitionGuid: setRecord.partitionGuid || null,
      primaryGuid: setRecord.primaryGuid || null,
      source: 'ea',
    } : null,
    play: {
      name: play.name || play.playName,
      playId: play.playId,
      assetPath: play.assetPath,
      setAssetPath: setRecord?.assetPath || play.setAssetPath || null,
      offensePlayType: play.offensePlayType || null,
      defensePlayType: play.defensePlayType || null,
      runHole: play.runHole ?? null,
      blockingSchemeAssetPath: play.blockingSchemeRef?.assetPath || null,
      blockingSchemeRef: play.blockingSchemeRef || null,
      coverageSchemeRef: play.coverageSchemeRef || null,
      passData: play.passData || [],
      concepts: play.concepts || [],
      flowType: play.flowType || null,
      allowHotRoutes: play.allowHotRoutes ?? null,
      enableMotion: play.enableMotion ?? null,
      disableMotion: play.disableMotion ?? null,
      additionalPresnapMovements: play.additionalPresnapMovements || [],
      passShort: play.passShort ?? null,
      passMedium: play.passMedium ?? null,
      passLong: play.passLong ?? null,
      rawMetadata: play.rawMetadata || null,
      source: 'ea',
    },
    players,
    provenance: {
      formation: formationRecord ? 'ea_asset' : 'unresolved',
      set: setRecord ? 'ea_asset' : 'unresolved',
      play: 'ea_asset',
      assignments: 'ea_asset',
      progression: 'not_authored_here',
    },
    resolution: {
      formation: formationResolution.status,
      set: setResolution.status,
      expectedPlayerAssignments: 11,
      actualPlayerAssignmentRefs: players.length,
      resolvedPlayerAssignments: players.filter(player => !/^unresolved|^ambiguous|^missing/.test(player.resolutionStatus || '')).length,
      unresolvedPlayerAssignments: unresolvedAssignments,
    },
  };
}

function compileEaPlayKnowledge({ formations = [], sets = [], plays = [], assignmentIndex = null } = {}) {
  const assignmentRecords = flattenAssignmentRecords(assignmentIndex);
  const context = {
    formations: createAssetIndex(formations),
    sets: createAssetIndex(sets),
    assignments: createAssetIndex(assignmentRecords),
  };
  const compiled = plays.map(play => compileResolvedPlay(play, context));
  const unresolved = [];
  for (const entry of compiled) {
    if (!entry.formation || !entry.set || entry.resolution.actualPlayerAssignmentRefs !== 11 || entry.resolution.unresolvedPlayerAssignments) {
      unresolved.push({
        play: entry.play.assetPath || entry.play.name,
        formationStatus: entry.resolution.formation,
        setStatus: entry.resolution.set,
        assignmentRefs: entry.resolution.actualPlayerAssignmentRefs,
        resolvedAssignments: entry.resolution.resolvedPlayerAssignments,
        unresolvedAssignments: entry.resolution.unresolvedPlayerAssignments,
      });
    }
  }

  return {
    metadata: {
      schemaVersion: 1,
      source: 'EA Frostbite Formation/Set/Play + PositionAssignment assets',
      formationCount: formations.length,
      setCount: sets.length,
      playCount: plays.length,
      assignmentRecordCount: assignmentRecords.length,
      compiledPlayCount: compiled.length,
      fullyResolvedPlayCount: compiled.length - unresolved.length,
      unresolvedPlayCount: unresolved.length,
      provenanceHierarchy: [
        'ea_extracted_asset_data',
        'verified_runtime_telemetry',
        'verified_manual_knowledge',
        'structurally_derived_coordinator_inference',
        'generic_football_heuristics',
      ],
      notes: [
        'Legacy flattened playbook assignment numbers are never used to resolve PositionAssignmentDefine.positionAssignId.',
        'PlayPassData percentage is preserved as EA-authored metadata and is not treated as an exact QB read progression.',
      ],
    },
    plays: compiled,
    unresolved,
  };
}

module.exports = {
  normalizeAssetPath,
  flattenAssignmentRecords,
  createAssetIndex,
  resolveReference,
  compileResolvedPlay,
  compileEaPlayKnowledge,
};
