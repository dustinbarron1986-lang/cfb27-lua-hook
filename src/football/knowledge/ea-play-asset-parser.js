'use strict';

const { parseXmlTree } = require('../assignments/ea-assignment-parser');

function scalar(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return text;
}

function children(node, name = null) {
  return (node?.children || []).filter(child => !name || child.name === name);
}

function child(node, name) {
  return children(node, name)[0] || null;
}

function splitFrostbiteRef(value) {
  if (value == null) return { ref: null, assetPath: null };
  const text = String(value).trim();
  if (!text || text.toLowerCase() === 'null') return { ref: null, assetPath: null };

  // MMC/Frostbite external PointerRef values use one or more literal
  // backslashes between the asset path and instance GUID. Split the entire
  // delimiter run so the normalized asset path never retains a trailing slash.
  const match = text.match(/^(.*?)[\\\\]+([^\\\\]+)$/);
  if (!match) return { ref: text, assetPath: null };
  return {
    assetPath: match[1] || null,
    ref: match[2] || null,
  };
}

function pointerFromNode(node) {
  if (!node) return null;
  const attrs = node.attrs || {};
  const split = splitFrostbiteRef(attrs.ref || attrs.instanceGuid || attrs.guid || null);
  const partitionGuid = attrs.partitionGuid || attrs.fileGuid || null;
  const assetPath = split.assetPath || attrs.assetPath || attrs.path ||
    ((node.name === 'import' || node.name === 'external') ? attrs.name : null);
  const ref = split.ref;
  if (!ref && !partitionGuid && !assetPath) return null;
  return { ref, partitionGuid, assetPath };
}

function valueOf(node) {
  if (!node) return null;
  const pointer = pointerFromNode(node);
  const kids = children(node);
  if (!kids.length) {
    const text = scalar(node.text);
    if (!pointer) return text;
    return text == null ? pointer : { ...pointer, value: text };
  }

  if (node.name === 'array') return kids.filter(k => k.name === 'item').map(itemValue);

  const out = {};
  if (pointer) Object.assign(out, pointer);
  for (const kid of kids) {
    const key = kid.attrs?.name || kid.name;
    const val = kid.name === 'array'
      ? children(kid, 'item').map(itemValue)
      : valueOf(kid);
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      if (!Array.isArray(out[key])) out[key] = [out[key]];
      out[key].push(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function itemValue(item) {
  const pointer = pointerFromNode(item);
  const complex = child(item, 'complex');
  if (complex) {
    const value = valueOf(complex);
    return pointer ? { ...pointer, ...(value && typeof value === 'object' ? value : { value }) } : value;
  }
  const kids = children(item);
  if (kids.length === 1) {
    const value = valueOf(kids[0]);
    return pointer ? { ...pointer, ...(value && typeof value === 'object' ? value : { value }) } : value;
  }
  if (kids.length > 1) {
    const value = valueOf(item);
    return pointer ? { ...pointer, ...value } : value;
  }
  const text = scalar(item.text);
  if (!pointer) return text;
  return text == null ? pointer : { ...pointer, value: text };
}

function parseInstance(node) {
  const fields = {};
  const arrays = {};
  const raw = {};
  for (const kid of children(node)) {
    const key = kid.attrs?.name || kid.name;
    const value = kid.name === 'array'
      ? children(kid, 'item').map(itemValue)
      : valueOf(kid);
    raw[key] = value;
    if (kid.name === 'array') arrays[key] = value;
    else fields[key] = value;
  }
  return {
    guid: node.attrs?.guid || null,
    type: node.attrs?.type || null,
    exported: node.attrs?.exported === 'true',
    fields,
    arrays,
    raw,
  };
}

function parsePartition(xmlText, options = {}) {
  const root = parseXmlTree(xmlText);
  if (!root || root.name !== 'partition') throw new Error('Expected Frostbite <partition> root');
  const instances = children(root, 'instance').map(parseInstance);
  const primaryGuid = root.attrs?.primaryInstance || null;
  const primary = instances.find(instance => instance.guid === primaryGuid) || instances[0] || null;
  if (!primary) throw new Error('No primary Frostbite instance found');
  return {
    sourceFile: options.sourceFile || null,
    partitionGuid: root.attrs?.guid || null,
    primaryGuid,
    primary,
    instances,
    byGuid: new Map(instances.map(instance => [instance.guid, instance])),
  };
}

function first(obj, names) {
  for (const name of names) {
    if (obj && obj[name] != null) return obj[name];
  }
  return null;
}

function stringValue(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') return value.value == null ? null : String(value.value);
  return null;
}

function refValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const split = splitFrostbiteRef(value);
    if (!split.ref && !split.assetPath) return null;
    return { ref: split.ref, partitionGuid: null, assetPath: split.assetPath };
  }
  if (typeof value !== 'object') return null;
  const split = splitFrostbiteRef(value.ref || value.instanceGuid || value.guid || null);
  const ref = split.ref;
  const partitionGuid = value.partitionGuid || value.fileGuid || null;
  const assetPath = value.assetPath || value.path || split.assetPath || null;
  if (!ref && !partitionGuid && !assetPath) return null;
  return { ref, partitionGuid, assetPath };
}

function dereference(partition, value, expectedType = null) {
  const ref = refValue(value);
  if (!ref?.ref || ref.partitionGuid || ref.assetPath) return null;
  const instance = partition.byGuid.get(ref.ref) || null;
  if (!instance) return null;
  if (expectedType && instance.type !== expectedType) return null;
  return instance;
}

function normalizePosition(row, index = null) {
  const raw = row?.fields || (row && typeof row === 'object' ? row : { value: row });
  const explicit = first(raw, ['posOrder', 'index', 'positionIndex', 'playerIndex', 'slotIndex']);
  const resolvedIndex = explicit != null && Number.isFinite(Number(explicit))
    ? Number(explicit)
    : index;
  return {
    index: resolvedIndex,
    positionType: first(raw, ['positionType', 'position', 'playPosition', 'playerPosition', 'depthPosition']) || null,
    depthPosition: first(raw, ['depthPosition', 'depthPos']) || null,
    depth: first(raw, ['depth', 'Depth']) ?? null,
    x: first(raw, ['XPos', 'x', 'X', 'posX', 'positionX']) ?? null,
    y: first(raw, ['YPos', 'y', 'Y', 'posY', 'positionY']) ?? null,
    flippedX: first(raw, ['flippedXPos', 'flippedX']) ?? null,
    flippedY: first(raw, ['flippedYPos', 'flippedY']) ?? null,
    facing: first(raw, ['facing']) ?? null,
    flippedFacing: first(raw, ['flippedFacing']) ?? null,
    packagePosition: first(raw, ['packagePosition', 'setPackagePosition', 'packagePos']) || null,
    flipIndex: first(raw, ['flipAssign', 'flipIndex', 'flipPositionIndex', 'flippedIndex']) ?? null,
    groupType: first(raw, ['groupType']) || null,
    primaryMotionMan: first(raw, ['primaryMotionMan']) ?? null,
    guid: row?.guid || null,
    raw,
  };
}

function normalizeMovement(partition, instance) {
  if (!instance) return null;
  const positionRefs = instance.arrays.PlayerPosition || [];
  const positions = positionRefs.map((ref, index) => {
    const resolved = dereference(partition, ref, 'SetPosition');
    return resolved
      ? normalizePosition(resolved, index)
      : { index, guid: refValue(ref)?.ref || null, unresolved: true, raw: ref };
  });
  return {
    guid: instance.guid,
    name: first(instance.fields, ['name', 'Name']) || null,
    type: first(instance.fields, ['type', 'Type']) || null,
    isDefault: Boolean(first(instance.fields, ['isDefault', 'IsDefault'])),
    positions,
    raw: instance.raw,
  };
}

function normalizePackage(partition, instance) {
  if (!instance) return null;
  const rows = (instance.arrays.packagePositions || []).map((ref, index) => {
    const resolved = dereference(partition, ref, 'SetPackagePosition');
    const raw = resolved?.fields || {};
    return {
      index,
      order: first(raw, ['order', 'Order']) ?? index,
      position: first(raw, ['position', 'Position']) || null,
      depth: first(raw, ['Depth', 'depth']) ?? null,
      guid: resolved?.guid || refValue(ref)?.ref || null,
      raw,
      unresolved: !resolved,
    };
  });
  return {
    guid: instance.guid,
    name: first(instance.fields, ['name', 'Name']) || null,
    positions: rows,
    raw: instance.raw,
  };
}

function parseFormationXml(xmlText, options = {}) {
  const partition = parsePartition(xmlText, options);
  const f = partition.primary.fields;
  return {
    kind: 'formation',
    name: stringValue(first(f, ['formationName', 'name', 'Name'])),
    formationType: first(f, ['formationType', 'FormationType']) || null,
    formId: first(f, ['formId', 'formationId', 'FormId']) ?? null,
    assetPath: stringValue(first(f, ['Name', 'assetPath', 'path'])),
    partitionGuid: partition.partitionGuid,
    primaryGuid: partition.primary.guid,
    sourceFile: partition.sourceFile,
    raw: partition.primary.raw,
    source: 'ea',
  };
}

function parseSetXml(xmlText, options = {}) {
  const partition = parsePartition(xmlText, options);
  const f = partition.primary.fields;
  const formationRef = refValue(first(f, ['form', 'Formation', 'formation', 'FormationDefine', 'formationDefine', 'formationAsset']));

  const movementRefs = partition.primary.arrays.preSnapMovements || [];
  const presnapMovements = movementRefs
    .map(ref => normalizeMovement(partition, dereference(partition, ref, 'PreSnapMovement')))
    .filter(Boolean);
  const defaultMovement = presnapMovements.find(movement => movement.isDefault) || null;

  const packageRefs = partition.primary.arrays.packages || [];
  const packages = packageRefs
    .map(ref => normalizePackage(partition, dereference(partition, ref, 'SetPackage')))
    .filter(Boolean);

  return {
    kind: 'set',
    name: stringValue(first(f, ['setName', 'name', 'Name'])),
    setId: first(f, ['setId', 'SetId']) ?? null,
    assetPath: stringValue(first(f, ['Name', 'assetPath', 'path'])),
    formationRef,
    formationAssetPath: formationRef?.assetPath || null,
    positions: defaultMovement?.positions || [],
    defaultPresnapMovement: defaultMovement,
    presnapMovements,
    packages,
    partitionGuid: partition.partitionGuid,
    primaryGuid: partition.primary.guid,
    sourceFile: partition.sourceFile,
    raw: partition.primary.raw,
    source: 'ea',
  };
}

function normalizePassData(row) {
  const raw = row?.fields || (row && typeof row === 'object' ? row : { value: row });
  return {
    guid: row?.guid || null,
    position: first(raw, ['position', 'Position']) ?? null,
    combo: first(raw, ['combo', 'Combo']) ?? null,
    percentage: first(raw, ['percentage', 'Percentage']) ?? null,
    concept: first(raw, ['concept', 'Concept']) ?? null,
    raw,
  };
}

function parsePlayXml(xmlText, options = {}) {
  const partition = parsePartition(xmlText, options);
  const f = partition.primary.fields;
  const arrays = partition.primary.arrays;
  const assignmentRows = arrays.positionAssignmentDefines || [];
  const passRows = arrays.passData || [];
  const setRef = refValue(first(f, ['Set', 'set', 'SetDefine', 'setDefine', 'setAsset']));
  const blockingSchemeRef = refValue(first(f, ['BlockingSchemeDefine', 'blockingSchemeDefine', 'blockingScheme']));
  const coverageSchemeRef = refValue(first(f, ['CoverageSchemeDefine', 'coverageSchemeDefine', 'coverageScheme']));
  const positionAssignmentDefines = assignmentRows.map((value, index) => ({
    index,
    ...refValue(value),
    raw: value,
  }));
  const passData = passRows.map(value => {
    const resolved = dereference(partition, value, 'PlayPassData');
    return resolved
      ? normalizePassData(resolved)
      : { ...normalizePassData(value), unresolved: true, ref: refValue(value) };
  });
  const concepts = [...new Set(passData.map(row => row.concept).filter(Boolean).map(String))];

  const additionalPresnapMovements = (arrays.AdditionalPreSnapMovements || [])
    .map(ref => normalizeMovement(partition, dereference(partition, ref, 'PreSnapMovement')))
    .filter(Boolean);

  return {
    kind: 'play',
    name: stringValue(first(f, ['playName', 'name', 'Name'])),
    playName: stringValue(first(f, ['playName', 'name', 'Name'])),
    playId: first(f, ['playId', 'PlayId']) ?? null,
    assetPath: stringValue(first(f, ['Name', 'assetPath', 'path'])),
    setRef,
    setAssetPath: setRef?.assetPath || null,
    positionAssignmentDefines,
    blockingSchemeRef,
    coverageSchemeRef,
    passData,
    concepts,
    additionalPresnapMovements,
    offensePlayType: first(f, ['offensePlayType', 'OffensePlayType']) || null,
    defensePlayType: first(f, ['defensePlayType', 'DefensePlayType']) || null,
    runHole: first(f, ['runHole', 'RunHole']) ?? null,
    flowType: first(f, ['FlowType', 'flowType']) || null,
    allowHotRoutes: first(f, ['allowHotRoutes', 'AllowHotRoutes']) ?? null,
    enableMotion: first(f, ['enableMotion', 'EnableMotion']) ?? null,
    disableMotion: first(f, ['disableMotion', 'DisableMotion']) ?? null,
    passShort: first(f, ['passShort', 'PassShort']) ?? null,
    passMedium: first(f, ['passMedium', 'PassMedium']) ?? null,
    passLong: first(f, ['passLong', 'PassLong']) ?? null,
    partitionGuid: partition.partitionGuid,
    primaryGuid: partition.primary.guid,
    sourceFile: partition.sourceFile,
    rawMetadata: partition.primary.raw,
    source: 'ea',
  };
}

function detectEaAssetKind(xmlText) {
  const partition = parsePartition(xmlText);
  const type = String(partition.primary.type || '').toLowerCase();
  if (type === 'play' || /playdefine/.test(type)) return 'play';
  if (type === 'set' || type.endsWith('set')) return 'set';
  if (type === 'formation' || /formation/.test(type)) return 'formation';
  return null;
}

function parseEaAssetXml(xmlText, options = {}) {
  const kind = options.kind || detectEaAssetKind(xmlText);
  if (kind === 'formation') return parseFormationXml(xmlText, options);
  if (kind === 'set') return parseSetXml(xmlText, options);
  if (kind === 'play') return parsePlayXml(xmlText, options);
  throw new Error(`Unsupported EA play asset type${options.sourceFile ? `: ${options.sourceFile}` : ''}`);
}

module.exports = {
  parsePartition,
  parseFormationXml,
  parseSetXml,
  parsePlayXml,
  parseEaAssetXml,
  detectEaAssetKind,
  splitFrostbiteRef,
  refValue,
  normalizePosition,
};
