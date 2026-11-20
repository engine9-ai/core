/**
 * Transform chain runner: a batch of rows through an ordered list of row
 * transforms, in memory.
 *
 * Portable on purpose. It imports nothing, so the same code runs on a server
 * worker (which resolves transforms from its plugin registry and bindings from
 * its database) and in a browser (which resolves them from plugin files the
 * person is editing). What differs between the two is passed in:
 *
 *   resolveTransform(step)  -> { transform, bindings, options, path }
 *   resolveBindings({ bindings, pipeline, tablesToUpsert, path, batch }) -> { boundItems }
 *
 * A transform is `({ batch, options, pluginId, inputId, ...boundItems })`
 * returning `{ batch }` (a new array) or nothing (it changed `batch` in place).
 * Returning fewer rows filters them out.
 *
 * With `trace: true` each step also reports what it did (rows in and out, the
 * fields it changed, rows it queued for a write, console output, time), and a
 * step that throws stops the chain instead of throwing: the report says which
 * step failed and the output is the batch as it stood before it.
 */

export const TRANSFORM_PATH_KIND = 'transforms';
export const UPSERT_BINDING_PATH = 'sql.tables.upsert';
const DEFAULT_ROW_LIMIT = 20;
const MAX_TEXT = 1000;
const MAX_CONSOLE = 200;
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** `<plugin path>:transforms:<name>` -> { pluginPath, name }, or null when it is not that shape. */
export function parseTransformPath(path) {
  const text = String(path ?? '');
  const marker = `:${TRANSFORM_PATH_KIND}:`;
  const at = text.lastIndexOf(marker);
  if (at <= 0) return null;
  const pluginPath = text.slice(0, at);
  const name = text.slice(at + marker.length);
  if (!pluginPath || !name || name.includes(':')) return null;
  return { pluginPath, name };
}

/** A step is a transform path, or `{ path, options, transform?, bindings? }`. */
export function normalizeTransformStep(step) {
  if (typeof step === 'string' && step.trim()) return { path: step.trim(), options: {} };
  if (isObject(step) && (typeof step.path === 'string' || typeof step.transform === 'function')) {
    return { ...step, options: isObject(step.options) ? step.options : {} };
  }
  throw new Error('Each transform must be a path string or { path, options }');
}

function stepLabel(step) {
  return step.path || step.transform?.name || 'transform';
}

/**
 * resolveTransform over plugin modules already in memory, keyed by plugin
 * path: `{ 'accounts/x/thing.plugin.js': { transforms: { name: { transform, options, bindings } } } }`.
 * A module may be the plugin itself or a namespace with a `default` export.
 * A transform may also be a bare function. `fallback` resolves anything that
 * is not one of these plugins (a server's own resolveTransform).
 */
export function createPluginTransformResolver(plugins = {}, { fallback } = {}) {
  return async function resolveTransform(step) {
    const config = normalizeTransformStep(step);
    if (typeof config.transform === 'function') {
      return { transform: config.transform, bindings: config.bindings || {}, options: config.options, path: config.path };
    }
    const parsed = parseTransformPath(config.path);
    const mod = parsed ? plugins[parsed.pluginPath] : undefined;
    if (!parsed || mod === undefined) {
      if (fallback) return fallback(config);
      if (!parsed) throw new Error(`Invalid transform path ${config.path}: expected <plugin path>:transforms:<name>`);
      throw new Error(`Plugin ${parsed.pluginPath} is not loaded (from ${config.path})`);
    }
    const plugin = isObject(mod?.default) ? mod.default : mod;
    const entry = plugin?.transforms?.[parsed.name];
    const definition = typeof entry === 'function' ? { transform: entry } : entry;
    if (!definition || typeof definition.transform !== 'function') {
      const known = Object.keys(plugin?.transforms || {});
      throw new Error(
        `Plugin ${parsed.pluginPath} has no transform ${parsed.name}${known.length ? ` (it has: ${known.join(', ')})` : ''}`
      );
    }
    const options = { ...(isObject(definition.options) ? definition.options : {}), ...config.options };
    let bindings = definition.bindings;
    if (typeof bindings === 'function') bindings = bindings(options);
    return { ...definition, bindings: bindings || {}, options, path: config.path };
  };
}

// ---- trace helpers ---------------------------------------------------------

function clip(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  const text = stable(value);
  if (text === undefined) return null;
  if (text.length > MAX_TEXT) return `${text.slice(0, MAX_TEXT)}…`;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function clipRow(row) {
  if (!isObject(row)) return { value: clip(row) };
  const out = {};
  for (const [key, value] of Object.entries(row)) if (value !== undefined) out[key] = clip(value);
  return out;
}

function stable(value) {
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));
  } catch {
    return String(value);
  }
}

function copy(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* functions, symbols: fall through */
    }
  }
  try {
    return JSON.parse(stable(value));
  } catch {
    return isObject(value) ? { ...value } : value;
  }
}

/** Fields that differ between two rows: { field: { from, to } }. */
export function changedFields(before, after) {
  const a = isObject(before) ? before : { value: before };
  const b = isObject(after) ? after : { value: after };
  const fields = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (stable(a[key]) !== stable(b[key])) fields[key] = { from: clip(a[key]), to: clip(b[key]) };
  }
  return fields;
}

/**
 * What one step did to the batch. `snapshot` holds copies of the rows before
 * the step and `refs` the row objects themselves. A row that is still the
 * same object afterwards (changed in place, or kept by a filter) is compared
 * with its own snapshot. When the step returned all-new objects, rows are
 * compared by position and any difference in length shows as added / removed.
 */
export function describeBatchChange(snapshot, refs, after) {
  const rows = Array.isArray(after) ? after : [];
  const position = new Map();
  refs.forEach((ref, i) => {
    if (ref != null && typeof ref === 'object' && !position.has(ref)) position.set(ref, i);
  });
  const usedBefore = new Set();
  const usedAfter = new Set();
  const changes = [];
  const compare = (i, j) => {
    usedBefore.add(i);
    usedAfter.add(j);
    const fields = changedFields(snapshot[i], rows[j]);
    if (Object.keys(fields).length) changes.push({ index: j, type: 'changed', fields });
  };
  rows.forEach((row, j) => {
    const i = row != null && typeof row === 'object' ? position.get(row) : undefined;
    if (i !== undefined && !usedBefore.has(i)) compare(i, j);
  });
  if (usedAfter.size === 0) {
    for (let k = 0; k < Math.min(snapshot.length, rows.length); k += 1) compare(k, k);
  }
  rows.forEach((row, j) => {
    if (!usedAfter.has(j)) changes.push({ index: j, type: 'added', record: clipRow(row) });
  });
  snapshot.forEach((row, i) => {
    if (!usedBefore.has(i)) changes.push({ index: i, type: 'removed', record: clipRow(row) });
  });
  const rank = { changed: 0, added: 1, removed: 2 };
  return changes.sort((x, y) => x.index - y.index || rank[x.type] - rank[y.type]);
}

function consoleText(args) {
  const text = args
    .map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? arg.stack || arg.message : stable(arg)))
    .join(' ');
  return text.length > MAX_TEXT * 2 ? `${text.slice(0, MAX_TEXT * 2)}…` : text;
}

/** Collect console output while a step runs. Returns the function that puts console back. */
function captureConsole(entries) {
  const target = typeof console === 'undefined' ? null : console;
  if (!target) return () => {};
  const saved = {};
  for (const level of CONSOLE_LEVELS) {
    saved[level] = target[level];
    target[level] = (...args) => {
      if (entries.length < MAX_CONSOLE) entries.push({ level, message: consoleText(args) });
    };
  }
  return () => {
    for (const level of CONSOLE_LEVELS) target[level] = saved[level];
  };
}

function errorOf(error) {
  if (error instanceof Error) return { message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  return { message: String(error) };
}

function queueSizes(tables) {
  const sizes = {};
  for (const [table, rows] of Object.entries(tables)) sizes[table] = Array.isArray(rows) ? rows.length : 0;
  return sizes;
}

// ---- the runner ------------------------------------------------------------

/**
 * Resolve every step once, so a file can be streamed through the chain batch
 * by batch without resolving again. Returns `runBatch(batch)` -> the next
 * batch (throws when a step throws).
 */
export async function prepareTransformChain({ steps = [], resolveTransform, resolveBindings, pluginId, inputId } = {}) {
  if (typeof resolveTransform !== 'function') throw new Error('prepareTransformChain needs resolveTransform');
  const resolved = [];
  for (const step of steps) {
    const config = normalizeTransformStep(step);
    const r = await resolveTransform(config);
    if (!r || typeof r.transform !== 'function') throw new Error(`Could not resolve transform ${stepLabel(config)}`);
    resolved.push({ ...r, path: r.path || config.path });
  }
  const pipeline = { bindings: {} };
  const tablesToUpsert = {};
  async function runBatch(batch) {
    let current = batch;
    for (const step of resolved) {
      const boundItems = await bind({ step, resolveBindings, pipeline, tablesToUpsert, batch: current });
      const output = (await step.transform({ ...boundItems, batch: current, options: step.options, pluginId, inputId })) || {};
      if (Array.isArray(output.batch)) current = output.batch;
    }
    return current;
  }
  return { steps: resolved, runBatch, tablesToUpsert };
}

async function bind({ step, resolveBindings, pipeline, tablesToUpsert, batch }) {
  const bindings = isObject(step.bindings) ? step.bindings : {};
  const names = Object.keys(bindings);
  if (!names.length) return {};
  if (typeof resolveBindings === 'function') {
    const { boundItems } = await resolveBindings({ bindings, pipeline, tablesToUpsert, path: step.path, batch });
    return boundItems || {};
  }
  // No resolver (a browser): only the in-memory upsert queue can be bound.
  const boundItems = {};
  const missing = [];
  for (const name of names) {
    if (bindings[name]?.path === UPSERT_BINDING_PATH) boundItems[name] = tablesToUpsert;
    else missing.push(`${name} (${bindings[name]?.path ?? 'no path'})`);
  }
  if (missing.length) {
    throw new Error(
      `${stepLabel(step)} needs ${missing.join(', ')}, which reads or writes account data and cannot be bound here`
    );
  }
  return boundItems;
}

/**
 * Run `rows` through `steps`.
 *
 * @param {object} args
 * @param {Array<string|object>} args.steps transform paths or { path, options }
 * @param {object[]} args.rows input rows (copied first when tracing, so the caller's rows are untouched)
 * @param {Function} args.resolveTransform see the file header
 * @param {Function} [args.resolveBindings] omitted: transforms with data bindings fail with a clear message
 * @param {boolean} [args.trace] report each step; a failing step stops the chain instead of throwing
 * @param {number} [args.limit] rows echoed in the report's output and writes (default 20)
 * @returns {Promise<{ rows: object[], steps: object[], output: object, warnings: string[] }>}
 */
export async function runTransformChain({
  steps = [],
  rows = [],
  resolveTransform,
  resolveBindings,
  pluginId,
  inputId,
  trace = false,
  limit = DEFAULT_ROW_LIMIT
} = {}) {
  if (typeof resolveTransform !== 'function') throw new Error('runTransformChain needs resolveTransform');
  if (!Array.isArray(rows)) throw new Error('runTransformChain rows must be an array');

  if (!trace) {
    const chain = await prepareTransformChain({ steps, resolveTransform, resolveBindings, pluginId, inputId });
    const out = await chain.runBatch(rows);
    return { rows: out, steps: [], output: { row_count: out.length, rows: out.slice(0, limit).map(clipRow), truncated: out.length > limit }, warnings: [] };
  }

  const pipeline = { bindings: {} };
  const tablesToUpsert = {};
  const report = [];
  const warnings = [];
  let batch = rows.map(copy);
  let failed = false;

  for (let index = 0; index < steps.length; index += 1) {
    let config = null;
    let problem = null;
    try {
      config = normalizeTransformStep(steps[index]);
    } catch (e) {
      problem = e;
    }
    const name = config ? stepLabel(config) : String(steps[index]);
    const entry = {
      id: `${index}:${name}`,
      name,
      ...(config?.slot ? { slot: config.slot } : {}),
      status: 'ok',
      ms: 0,
      rows_in: batch.length,
      rows_out: batch.length,
      changes: [],
      writes: [],
      lookups: [],
      console: []
    };
    if (failed) {
      report.push({ ...entry, status: 'skipped', rows_in: 0, rows_out: 0 });
      continue;
    }

    const refs = batch.slice();
    const snapshot = batch.map(copy);
    const queued = queueSizes(tablesToUpsert);
    const restoreConsole = captureConsole(entry.console);
    const started = now();
    let after = batch;
    try {
      if (problem) throw problem;
      const resolved = await resolveTransform(config);
      if (!resolved || typeof resolved.transform !== 'function') throw new Error(`Could not resolve transform ${name}`);
      const step = { ...resolved, path: resolved.path || config.path };
      const boundItems = await bind({ step, resolveBindings, pipeline, tablesToUpsert, batch });
      const output = (await step.transform({ ...boundItems, batch, options: step.options, pluginId, inputId })) || {};
      if (Array.isArray(output.batch)) after = output.batch;
    } catch (e) {
      problem = e;
    } finally {
      restoreConsole();
    }
    entry.ms = Math.round((now() - started) * 1000) / 1000;

    for (const [table, queue] of Object.entries(tablesToUpsert)) {
      const before = queued[table] ?? 0;
      if (Array.isArray(queue) && queue.length > before) {
        const added = queue.slice(before);
        entry.writes.push({ binding: UPSERT_BINDING_PATH, table, row_count: added.length, rows: added.slice(0, limit).map(clipRow) });
      }
    }

    if (problem) {
      failed = true;
      entry.status = 'error';
      entry.error = errorOf(problem);
      // The output is the batch as it stood before the failing step.
      batch = snapshot;
    } else {
      entry.rows_out = after.length;
      entry.changes = describeBatchChange(snapshot, refs, after);
      batch = after;
    }
    report.push(entry);
  }

  const leftover = Object.entries(tablesToUpsert).filter(([, queue]) => Array.isArray(queue) && queue.length);
  if (leftover.length) {
    warnings.push(
      `Rows were queued for ${UPSERT_BINDING_PATH} and not written: ${leftover.map(([t, q]) => `${t}=${q.length}`).join(', ')}`
    );
  }

  return {
    rows: batch,
    steps: report,
    output: { row_count: batch.length, rows: batch.slice(0, limit).map(clipRow), truncated: batch.length > limit },
    warnings
  };
}
