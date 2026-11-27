import { MobileError } from './store.mjs';

const sensitive = /secret|credential|token|password|api[_.-]?key|cookie|auth|pin|private/i;
const shortText = value => typeof value === 'string' ? value.slice(0, 160) : undefined;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeName = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const packageName = /^(?:@[a-z0-9][a-z0-9_.-]{0,62}\/)?[a-z0-9][a-z0-9_.-]{0,127}$/;

function publicProperty(key, value) {
  if (!record(value) || !safeName.test(key) || sensitive.test(key) || value.writeOnly || value['x-sensitive'] ||
      value['x-secret'] || value.format === 'password') return null;
  const { type, enum: choices } = value;
  if (!['boolean', 'integer', 'number'].includes(type) &&
      !(type === 'string' && Array.isArray(choices) && choices.length && choices.length <= 32 &&
        choices.every(choice => typeof choice === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(choice)))) return null;
  return {
    type, title: shortText(value.title),
    ...(Array.isArray(choices) ? { enum: choices.filter(choice => allowedValue({ type }, choice)) } : {}),
    ...Object.fromEntries(['minimum', 'maximum'].flatMap(bound =>
      Number.isFinite(value[bound]) ? [[bound, value[bound]]] : [])),
  };
}

function allowedValue(schema, value) {
  const validType = schema.type === 'boolean' ? typeof value === 'boolean'
    : schema.type === 'integer' ? Number.isSafeInteger(value)
    : schema.type === 'number' ? Number.isFinite(value)
    : typeof value === 'string';
  return validType && (!schema.enum || schema.enum.includes(value))
    && (schema.minimum === undefined || value >= schema.minimum)
    && (schema.maximum === undefined || value <= schema.maximum);
}

export function boundedGroups(document) {
  return (Array.isArray(document?.groups) ? document.groups : []).flatMap(row => {
    const group = row?.group;
    if (!group || typeof group.id !== 'string' || !group.id.startsWith('world:') || !safeName.test(group.id)) return [];
    const world = group.id.slice('world:'.length);
    const properties = Object.fromEntries(Object.entries(group.schema?.properties ?? {}).flatMap(([key, value]) => {
      const projected = key.startsWith('worlds.' + world + '.') && publicProperty(key, value);
      return projected ? [[key, projected]] : [];
    }));
    const values = Object.fromEntries(Object.entries(row.values ?? {}).filter(([key, value]) =>
      Object.hasOwn(properties, key) && allowedValue(properties[key], value)));
    return Object.keys(properties).length ? [{
      group: { id: group.id, owner: shortText(group.owner), schema: { title: shortText(group.schema.title), properties } }, values,
    }] : [];
  });
}

export function boundedWorlds(document) {
  return (Array.isArray(document?.worlds) ? document.worlds : [])
    .filter(row => typeof row?.id === 'string' && safeName.test(row.id))
    .map(row => ({
      id: row.id, label: shortText(row.label) ?? row.id, status: shortText(row.status),
      enabled: typeof row.enabled === 'boolean' ? row.enabled : row.status === 'active',
      available: row.status !== 'missing' && row.available !== false,
      ...(typeof row.visible === 'boolean' ? { visible: row.visible } : {}),
      order: Number.isSafeInteger(row.order) ? row.order : undefined,
      packageName: shortText(row.packageName),
    }));
}

export async function boundWorkbenchSettings(desktop, provider) {
  if (!desktop) throw new MobileError('WORKBENCH_NOT_AVAILABLE', 503);
  const [config, worlds, model] = await Promise.all([
    desktop.request('/api/config'), desktop.request('/api/worlds'), provider().catch(() => null),
  ]);
  return {
    format: 'tina-computer-settings/1',
    groups: boundedGroups(config), worlds: boundedWorlds(worlds), providers: model?.instances ?? [],
  };
}

export async function boundWorldMarket(desktop) {
  const [registry, search] = await Promise.all([
    desktop.request('/api/extensions'), desktop.request('/api/extensions/search?kind=world').catch(() => null),
  ]);
  const project = (rows, installed) => (Array.isArray(rows) ? rows : []).filter(item =>
    typeof item?.name === 'string' && packageName.test(item.name) && (installed ? item.kind === 'world' && item.state !== 'removed' : true))
    .slice(0, 150).map(item => ({
      name: item.name, label: shortText(item.label ?? item.title) ?? item.name,
      description: shortText(item.description ?? item.metadata?.description),
      version: shortText(item.installedVersion ?? item.version),
      ...(installed ? { worldId: shortText(item.worldId), state: shortText(item.state) } : {}),
    }));
  return {
    installed: project(registry.extensions, true), available: project(search?.hits, false),
    partial: !search || search.partial === true,
  };
}

export async function saveBoundWorldSettings(desktop, input, provider) {
  if (!desktop) throw new MobileError('WORKBENCH_NOT_AVAILABLE', 503);
  if (!record(input) || !record(input.values) || !record(input.expected) ||
      Object.keys(input).some(key => !['group', 'values', 'expected'].includes(key)))
    throw new MobileError('WORKBENCH_SETTINGS_INVALID', 400);
  const config = await desktop.request('/api/config');
  const selected = boundedGroups(config).find(row => row.group.id === input.group);
  if (!selected) throw new MobileError('WORKBENCH_GROUP_NOT_AVAILABLE', 404);
  const properties = selected.group.schema.properties;
  const changes = Object.entries(input.values);
  if (!changes.length || changes.some(([key, value]) =>
      !Object.hasOwn(properties, key) || !allowedValue(properties[key], value))
      || Object.keys(input.expected).some(key => !Object.hasOwn(properties, key)))
    throw new MobileError('WORKBENCH_SETTINGS_INVALID', 400);
  if (changes.some(([key]) => !Object.hasOwn(input.expected, key) || !Object.is(input.expected[key], selected.values[key])))
    throw new MobileError('WORKBENCH_SETTINGS_CHANGED', 409);
  const original = config.groups.find(row => row.group.id === input.group);
  await desktop.save({ group: input.group, values: input.values, expected: original.values });
  return { ok: true, readback: true, ...await boundWorkbenchSettings(desktop, provider) };
}
