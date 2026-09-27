'use strict';

const PROVENANCE = Object.freeze({
  EA_AUTHORED: 'EA_AUTHORED',
  RUNTIME_OBSERVED: 'RUNTIME_OBSERVED',
  VERIFIED_MANUAL: 'VERIFIED_MANUAL',
  DERIVED_STRUCTURAL: 'DERIVED_STRUCTURAL',
  HEURISTIC: 'HEURISTIC',
});

function normalizeGuid(value) {
  return value == null ? null : String(value).trim().toLowerCase();
}

function normalizeAssetPath(value) {
  return value == null
    ? null
    : String(value).trim().replace(/\\/g, '/').replace(/\.xml$/i, '').replace(/\/+$/g, '').toLowerCase();
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

  return { records, byPath, byPartitionGuid, byPrimaryGuid, byPair };
}

function unique(list) {
  return Array.isArray(list) && list.length === 1 ? list[0] : null;
}

function identityFor(record) {
  return {
    assetPath: normalizeAssetPath(record?.assetPath || record?.name),
    partitionGuid: normalizeGuid(record?.partitionGuid),
    ref: normalizeGuid(record?.primaryGuid),
  };
}

function refIdentity(ref) {
  return {
    assetPath: normalizeAssetPath(ref?.assetPath),
    partitionGuid: normalizeGuid(ref?.partitionGuid),
    ref: normalizeGuid(ref?.ref),
  };
}

function matchesIdentity(record, identity) {
  const actual = identityFor(record);
  if (identity.assetPath && actual.assetPath !== identity.assetPath) return false;
  if (identity.partitionGuid && actual.partitionGuid !== identity.partitionGuid) return false;
  if (identity.ref && actual.ref !== identity.ref) return false;
  return true;
}

function resolveReference(ref, index) {
  if (!ref || !index) return { record: null, status: 'missing_reference', exact: false };

  const identity = refIdentity(ref);
  const provided = Object.values(identity).filter(Boolean).length;
  if (!provided) return { record: null, status: 'missing_reference_identity', exact: false, ref };

  const candidates = (index.records || []).filter(record => matchesIdentity(record, identity));
  if (candidates.length === 1) {
    const status = provided === 3
      ? 'resolved_exact_identity'
      : provided === 2
        ? 'resolved_partial_identity'
        : 'resolved_single_identity';
    return { record: candidates[0], status, exact: provided === 3, identity };
  }
  if (candidates.length > 1) {
    return { record: null, status: 'ambiguous_identity', exact: false, identity, candidates };
  }

  const componentMatches = {
    assetPath: identity.assetPath ? (index.byPath.get(identity.assetPath) || []).length : 0,
    partitionGuid: identity.partitionGuid ? (index.byPartitionGuid.get(identity.partitionGuid) || []).length : 0,
    ref: identity.ref ? (index.byPrimaryGuid.get(identity.ref) || []).length : 0,
  };
  const anyComponentMatch = Object.values(componentMatches).some(count => count > 0);

  return {
    record: null,
    status: anyComponentMatch ? 'identity_mismatch' : 'unresolved_reference',
    exact: false,
    identity,
    componentMatches,
    ref,
  };
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
    assignmentActions: record.actions || [],
    assignmentSemantics: record.semantics || null,
    assignmentName: record.shortName || null,
    assignmentCategory: record.category || null,
    assignmentSourceFile: record.sourceFile || null,
    source: PROVENANCE.EA_AUTHORED,
  };
}

function isResolvedStatus(status) {
  return /^resolved_/.test(String(status || ''));
}

function isSpecialTeamsRef(ref) {
  return /\/assignments\/specialteams\//i.test(String(ref?.assetPath || ''));
}

function compileResolvedPlay(play, context) {
  const setResolution = resolveReference(play.setRef, context.sets);
  const setRecord = setResolution.record;
  const formationResolution = setRecord
    ? resolveReference(setRecord.formationRef, context.formations)
    : { record: null, status: 'set_unresolved', exact: false };
  const formationRecord = formationResolution.record;

  const players = (play.positionAssignmentDefines || []).map((assignmentRef, index) => {
    const resolution = resolveReference(assignmentRef, context.assignments);
    const assignment = normalizedAssignment(resolution.record);
    const specialTeams = !assignment && isSpecialTeamsRef(assignmentRef);
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
        assignmentActions: [],
        assignmentSemantics: null,
        assignmentName: null,
        assignmentCategory: specialTeams ? 'SpecialTeams' : null,
        assignmentSourceFile: null,
        source: PROVENANCE.EA_AUTHORED,
      }),
      resolutionStatus: specialTeams ? 'unresolved_special_teams' : resolution.status,
      specialTeamsUnresolved: specialTeams,
      source: PROVENANCE.EA_AUTHORED,
    };
  });

  const unresolvedPlayers = players.filter(player => !isResolvedStatus(player.resolutionStatus));
  const specialTeamsUnresolved = unresolvedPlayers.filter(player => player.specialTeamsUnresolved).length;
  const normalOffenseUnresolved = unresolvedPlayers.length - specialTeamsUnresolved;
  const resolutionStatus = normalOffenseUnresolved > 0
    ? 'unresolved_normal_offense'
    : specialTeamsUnresolved > 0
      ? 'partial_special_teams'
      : 'fully_resolved';

  return {
    schemaVersion: 2,
    formation: formationRecord ? {
      name: formationRecord.name,
      formId: formationRecord.formId,
      formationType: formationRecord.formationType || null,
      assetPath: formationRecord.assetPath,
      partitionGuid: formationRecord.partitionGuid || null,
      primaryGuid: formationRecord.primaryGuid || null,
      source: PROVENANCE.EA_AUTHORED,
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
      source: PROVENANCE.EA_AUTHORED,
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
      source: PROVENANCE.EA_AUTHORED,
    },
    players,
    provenance: {
      formation: formationRecord ? PROVENANCE.EA_AUTHORED : 'UNRESOLVED',
      set: setRecord ? PROVENANCE.EA_AUTHORED : 'UNRESOLVED',
      play: PROVENANCE.EA_AUTHORED,
      assignments: PROVENANCE.EA_AUTHORED,
      progression: PROVENANCE.DERIVED_STRUCTURAL,
    },
    resolution: {
      status: resolutionStatus,
      formation: formationResolution.status,
      set: setResolution.status,
      expectedPlayerAssignments: 11,
      actualPlayerAssignmentRefs: players.length,
      resolvedPlayerAssignments: players.filter(player => isResolvedStatus(player.resolutionStatus)).length,
      unresolvedPlayerAssignments: unresolvedPlayers.length,
      unresolvedNormalOffenseAssignments: normalOffenseUnresolved,
      unresolvedSpecialTeamsAssignments: specialTeamsUnresolved,
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
  let assignmentRefCount = 0;
  let resolvedAssignmentRefCount = 0;
  let unresolvedNormalOffenseRefCount = 0;
  let unresolvedSpecialTeamsRefCount = 0;

  for (const entry of compiled) {
    assignmentRefCount += entry.resolution.actualPlayerAssignmentRefs;
    resolvedAssignmentRefCount += entry.resolution.resolvedPlayerAssignments;
    unresolvedNormalOffenseRefCount += entry.resolution.unresolvedNormalOffenseAssignments;
    unresolvedSpecialTeamsRefCount += entry.resolution.unresolvedSpecialTeamsAssignments;

    if (
      !entry.formation ||
      !entry.set ||
      entry.resolution.actualPlayerAssignmentRefs !== 11 ||
      entry.resolution.unresolvedPlayerAssignments
    ) {
      unresolved.push({
        play: entry.play.assetPath || entry.play.name,
        resolutionStatus: entry.resolution.status,
        formationStatus: entry.resolution.formation,
        setStatus: entry.resolution.set,
        assignmentRefs: entry.resolution.actualPlayerAssignmentRefs,
        resolvedAssignments: entry.resolution.resolvedPlayerAssignments,
        unresolvedAssignments: entry.resolution.unresolvedPlayerAssignments,
        unresolvedNormalOffenseAssignments: entry.resolution.unresolvedNormalOffenseAssignments,
        unresolvedSpecialTeamsAssignments: entry.resolution.unresolvedSpecialTeamsAssignments,
        unresolvedRefs: entry.players
          .filter(player => !isResolvedStatus(player.resolutionStatus))
          .map(player => ({
            index: player.index,
            status: player.resolutionStatus,
            assetPath: player.assignmentRef.assetPath,
            partitionGuid: player.assignmentRef.partitionGuid,
            ref: player.assignmentRef.ref,
          })),
      });
    }
  }

  const fullyResolvedPlayCount = compiled.filter(entry => entry.resolution.status === 'fully_resolved').length;
  const partiallyResolvedPlayCount = compiled.filter(entry => entry.resolution.status === 'partial_special_teams').length;
  const unresolvedNormalOffensePlayCount = compiled.filter(entry => entry.resolution.status === 'unresolved_normal_offense').length;

  return {
    metadata: {
      schemaVersion: 2,
      source: 'EA Frostbite Formation/Set/Play + PositionAssignment assets',
      formationCount: formations.length,
      setCount: sets.length,
      playCount: plays.length,
      assignmentRecordCount: assignmentRecords.length,
      compiledPlayCount: compiled.length,
      assignmentRefCount,
      resolvedAssignmentRefCount,
      unresolvedAssignmentRefCount: assignmentRefCount - resolvedAssignmentRefCount,
      assignmentResolutionPercentage: assignmentRefCount
        ? Number(((resolvedAssignmentRefCount / assignmentRefCount) * 100).toFixed(4))
        : 0,
      fullyResolvedPlayCount,
      partiallyResolvedPlayCount,
      unresolvedNormalOffensePlayCount,
      unresolvedPlayCount: unresolved.length,
      unresolvedNormalOffenseRefCount,
      unresolvedSpecialTeamsRefCount,
      provenanceHierarchy: Object.values(PROVENANCE),
      notes: [
        'Legacy flattened playbook assignment numbers are never used to resolve PositionAssignmentDefine.positionAssignId.',
        'External assignment references are resolved by all available authoritative identity fields; conflicting path/GUID values are rejected.',
        'PlayPassData percentage is preserved as EA-authored metadata and is not treated as an exact QB read progression.',
        'SpecialTeams corpus gaps are classified separately and do not reduce normal-offense authority.',
      ],
    },
    plays: compiled,
    unresolved,
  };
}

module.exports = {
  PROVENANCE,
  normalizeAssetPath,
  flattenAssignmentRecords,
  createAssetIndex,
  resolveReference,
  isResolvedStatus,
  isSpecialTeamsRef,
  compileResolvedPlay,
  compileEaPlayKnowledge,
};
