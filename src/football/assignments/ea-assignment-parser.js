'use strict';

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttributes(text) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = re.exec(text))) attrs[match[1]] = decodeXml(match[2]);
  return attrs;
}

function parseXmlTree(xmlText) {
  const xml = String(xmlText || '').replace(/^\uFEFF/, '');
  const doc = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [doc];
  const tokenRe = /<!--[\s\S]*?-->|<\?[^>]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g;
  let match;
  while ((match = tokenRe.exec(xml))) {
    const token = match[0];
    if (!token) continue;
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) {
      stack[stack.length - 1].text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (token.startsWith('<!')) continue;
    if (token.startsWith('<')) {
      const selfClosing = /\/\s*>$/.test(token);
      const inner = token.slice(1, selfClosing ? token.lastIndexOf('/') : token.lastIndexOf('>')).trim();
      const nameMatch = inner.match(/^([^\s/>]+)/);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      const attrs = parseAttributes(inner.slice(name.length));
      const node = { name, attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
      continue;
    }
    if (token.trim()) stack[stack.length - 1].text += decodeXml(token);
  }
  return doc.children.find(node => node.name !== '#text') || null;
}

function directChildren(node, name) {
  return (node?.children || []).filter(child => !name || child.name === name);
}

function directChild(node, name) {
  return directChildren(node, name)[0] || null;
}

function scalar(text) {
  const value = String(text ?? '').trim();
  if (value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

function nodeValue(node) {
  if (!node) return null;
  const attrs = node.attrs || {};
  const childElements = directChildren(node);
  if (!childElements.length) {
    if (attrs.ref != null || attrs.partitionGuid != null) {
      const ref = {};
      if (attrs.ref != null) ref.ref = attrs.ref;
      if (attrs.partitionGuid != null) ref.partitionGuid = attrs.partitionGuid;
      const text = scalar(node.text);
      if (text != null) ref.value = text;
      return ref;
    }
    return scalar(node.text);
  }
  return objectValue(node);
}

function arrayValue(arrayNode) {
  return directChildren(arrayNode, 'item').map(item => {
    if (item.attrs?.ref != null) return { ref: item.attrs.ref };
    const complex = directChild(item, 'complex');
    if (complex) return objectValue(complex);
    const children = directChildren(item);
    if (children.length === 1) return nodeValue(children[0]);
    if (children.length > 1) return objectValue(item);
    return scalar(item.text);
  });
}

function objectValue(node) {
  const out = {};
  for (const child of directChildren(node)) {
    let value;
    let key;
    if (child.name === 'field') {
      key = child.attrs?.name || 'field';
      value = nodeValue(child);
    } else if (child.name === 'array') {
      key = child.attrs?.name || 'array';
      value = arrayValue(child);
    } else {
      key = child.attrs?.name || child.name;
      value = nodeValue(child);
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      if (!Array.isArray(out[key])) out[key] = [out[key]];
      out[key].push(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function parseInstance(node) {
  const fields = {};
  const arrays = {};
  for (const child of directChildren(node)) {
    if (child.name === 'field') fields[child.attrs?.name || 'field'] = nodeValue(child);
    if (child.name === 'array') arrays[child.attrs?.name || 'array'] = arrayValue(child);
  }
  return {
    guid: node.attrs?.guid || null,
    type: node.attrs?.type || null,
    exported: node.attrs?.exported === 'true',
    fields,
    arrays,
  };
}

function assignmentCategory(name) {
  const match = String(name || '').match(/\/Assignments\/([^/]+)\//i);
  return match ? match[1] : null;
}

function parseAssignmentXml(xmlText, options = {}) {
  const root = parseXmlTree(xmlText);
  if (!root || root.name !== 'partition') throw new Error('Expected Frostbite <partition> root');

  const instances = directChildren(root, 'instance').map(parseInstance);
  const byGuid = new Map(instances.map(instance => [instance.guid, instance]));
  const primaryGuid = root.attrs?.primaryInstance || null;
  const primary = byGuid.get(primaryGuid) || instances.find(instance => instance.type === 'PositionAssignmentDefine');
  if (!primary) throw new Error('PositionAssignmentDefine primary instance not found');

  const refs = (primary.arrays.positionAssignment || [])
    .map(item => item && typeof item === 'object' ? item.ref : null)
    .filter(Boolean);
  const actions = refs.map((guid, index) => {
    const instance = byGuid.get(guid);
    if (!instance) return { order: index, guid, type: 'MissingReference', opcode: null, fields: {}, arrays: {} };
    return {
      order: index,
      guid,
      type: instance.type,
      opcode: instance.fields.opCodeEX || null,
      fields: instance.fields,
      arrays: instance.arrays,
    };
  });

  const name = primary.fields.Name || null;
  const rawId = primary.fields.positionAssignId;
  return {
    schemaVersion: 1,
    sourceFile: options.sourceFile || null,
    partitionGuid: root.attrs?.guid || null,
    primaryGuid: primary.guid,
    positionAssignId: rawId == null ? null : rawId,
    name,
    shortName: name ? String(name).split('/').pop() : null,
    category: assignmentCategory(name),
    routeType: primary.fields.routeType || null,
    positionIndex: primary.fields.positionIndex ?? null,
    actions,
  };
}

module.exports = {
  parseAssignmentXml,
  parseXmlTree,
  parseAttributes,
  assignmentCategory,
};
