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

function pointerFromNode(node) {
  if (!node) return null;
  const attrs = node.attrs || {};
  const ref = attrs.ref || attrs.instanceGuid || attrs.guid || null;
  const partitionGuid = attrs.partitionGuid || attrs.fileGuid || null;
  const assetPath = attrs.assetPath || attrs.path || ((node.name === 'import' || node.name === 'external') ? attrs.name : null);
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
  if (typeof value === 'string') return { ref: value, partitionGuid: null, assetPath: null };
  if (typeof value !== 'object') return null;
  return {
    ref: value.ref || value.instanceGuid || value.guid || null,
    partitionGuid: value.partitionGuid || value.fileGuid || null,
    assetPath: value.assetPath || value.path || value.name || stringValue(value) || null,
  };
}

function normalizePosition(row, index) {
  const raw = row && typeof row === 'object' ? row : { value: row };
  const explicit = first(raw, ['index', 'positionIndex', 'playerIndex', 'slotIndex']);
  return {
    index: explicit != null && Number.isFinite(Number(explicit)) ? Number(explicit) : index,
    positionType: first(raw, ['positionType', 'position', 'playPosition', 'playerPosition']) || null,
    depthPosition: first(raw, ['depthPosition', 'depthPos', 'depth']) || null,
    x: first(raw, ['x', 'X', 'posX', 'positionX']) ?? null,
    y: first(raw, ['y', 'Y', 'posY', 'positionY']) ?? null,
    packagePosition: first(raw, ['packagePosition', 'setPackagePosition', 'packagePos']) || null,
    flipIndex: first(raw, ['flipIndex', 'flipPositionIndex', 'flippedIndex']) ?? null,
    presnapMovement: first(raw, ['presnapMovement', 'preSnapMovement', 'movement', 'autoMotion']) || null,
    raw,
  };
}

function findArray(arrays, preferredNames, predicate = null) {
  for (const name of preferredNames) {
    if (Array.isArray(arrays?.[name])) return arrays[name];
  }
  if (predicate) {
    for (const [name, value] of Object.entries(arrays || {})) {
      if (Array.isArray(value) && predicate(name, value)) return value;
    }
  }
  return [];
}

function parseFormationXml(xmlText, options = {}) {
  const partition = parsePartition(xmlText, options);
  const f = partition.primary.fields;
  return {
    kind: 'formation',
    name: stringValue(first(f, ['Name', 'formationName', 'name'])),
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
  const arrays = partition.primary.arrays;
  const positionRows = findArray(
    arrays,
    ['SetPosition', 'setPositions', 'positions', 'positionDefines'],
    name => /set.*position|positions?/i.test(name) && !/package/i.test(name),
  );
  const packageRows = findArray(
    arrays,
    ['SetPackagePosition', 'setPackagePositions', 'packagePositions'],
    name => /package.*position/i.test(name),
  );
  const formationRef = refValue(first(f, ['Formation', 'formation', 'FormationDefine', 'formationDefine', 'formationAsset']));
  return {
    kind: 'set',
    name: stringValue(first(f, ['setName', 'Name', 'name'])),
    setId: first(f, ['setId', 'SetId']) ?? null,
    assetPath: stringValue(first(f, ['Name', 'assetPath', 'path'])),
    formationRef,
    formationAssetPath: formationRef?.assetPath || null,
    positions: positionRows.map(normalizePosition),
    packagePositions: packageRows.map((row, index) => ({ index, raw: row })),
    partitionGuid: partition.partitionGuid,
    primaryGuid: partition.primary.guid,
    sourceFile: partition.sourceFile,
    raw: partition.primary.raw,
    source: 'ea',
  };
}

function normalizePassData(row) {
  const raw = row && typeof row === 'object' ? row : { value: row };
  return {
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
  const assignmentRows = findArray(
    arrays,
    ['positionAssignmentDefines'],
    name => /positionAssignmentDefines/i.test(name),
  );
  const passRows = findArray(
    arrays,
    ['passData', 'PlayPassData', 'playPassData'],
    name => /pass.*data/i.test(name),
  );
  const setRef = refValue(first(f, ['Set', 'set', 'SetDefine', 'setDefine', 'setAsset']));
  const blockingSchemeRef = refValue(first(f, ['BlockingSchemeDefine', 'blockingSchemeDefine', 'blockingScheme']));
  const coverageSchemeRef = refValue(first(f, ['CoverageSchemeDefine', 'coverageSchemeDefine', 'coverageScheme']));
  const positionAssignmentDefines = assignmentRows.map((value, index) => ({ index, ...refValue(value), raw: value }));
  const passData = passRows.map(normalizePassData);
  const concepts = [...new Set(passData.map(row => row.concept).filter(Boolean).map(String))];
  return {
    kind: 'play',
    name: stringValue(first(f, ['playName', 'Name', 'name'])),
    playName: stringValue(first(f, ['playName', 'Name', 'name'])),
    playId: first(f, ['playId', 'PlayId']) ?? null,
    assetPath: stringValue(first(f, ['Name', 'assetPath', 'path'])),
    setRef,
    setAssetPath: setRef?.assetPath || null,
    positionAssignmentDefines,
    blockingSchemeRef,
    coverageSchemeRef,
    passData,
    concepts,
    offensePlayType: first(f, ['offensePlayType', 'OffensePlayType']) || null,
    defensePlayType: first(f, ['defensePlayType', 'DefensePlayType']) || null,
    runHole: first(f, ['runHole', 'RunHole']) ?? null,
    flowType: first(f, ['FlowType', 'flowType']) || null,
    allowHotRoutes: first(f, ['allowHotRoutes', 'AllowHotRoutes']) ?? null,
    enableMotion: first(f, ['enableMotion', 'EnableMotion']) ?? null,
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
  const names = new Set([...Object.keys(partition.primary.fields), ...Object.keys(partition.primary.arrays)]);
  if (names.has('positionAssignmentDefines') || type === 'play' || /playdefine/.test(type)) return 'play';
  if (names.has('setId') || names.has('setName') || [...names].some(name => /set.*position/i.test(name))) return 'set';
  if (names.has('formId') || names.has('formationType') || /formation/.test(type)) return 'formation';
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
  refValue,
  normalizePosition,
};
