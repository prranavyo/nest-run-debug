import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Form, MethodForm, RouteForm, SavedCase, Target, keyOf } from './types';
import { kindOf } from './parse';
import { isSecretKey, redact, redactText } from './redact';

// ---------------------------------------------------------------- files
const safe = (s: string) => s.replace(/[^\w.\-]+/g, '_');

export function caseFilePath(root: string, key: string): string {
  return path.join(root, '.nest-run', 'cases', safe(key) + '.json');
}

export function loadCases(root: string, key: string): SavedCase[] {
  return loadCasesDetailed(root, key).cases;
}

export interface CaseLoadResult {
  cases: SavedCase[];
  errors: string[];
}

function validCase(value: unknown, index: number, key: string): SavedCase | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Partial<SavedCase>;
  if (typeof c.name !== 'string' || !c.name.trim() || !c.inputs || typeof c.inputs !== 'object' || Array.isArray(c.inputs)) return undefined;
  return {
    id: typeof c.id === 'string' && c.id ? c.id : `legacy-${safe(key)}-${index}`,
    name: c.name.trim(),
    inputs: redact(c.inputs),
    ...(c.kinds && typeof c.kinds === 'object' && !Array.isArray(c.kinds) ? { kinds: redact(c.kinds) as Record<string, string> } : {}),
    ...(c.expected !== undefined ? { expected: redact(c.expected) } : {}),
  };
}

export function loadCasesDetailed(root: string, key: string): CaseLoadResult {
  try {
    const file = caseFilePath(root, key);
    if (!fs.existsSync(file)) return { cases: [], errors: [] };
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return { cases: [], errors: ['The saved-case file is empty.'] };
    const json: unknown = JSON.parse(raw);
    if (!json || typeof json !== 'object' || !Array.isArray((json as { cases?: unknown }).cases)) {
      return { cases: [], errors: ['The saved-case file does not contain a cases array.'] };
    }
    const errors: string[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    const cases: SavedCase[] = [];
    for (const [index, value] of (json as { cases: unknown[] }).cases.entries()) {
      const c = validCase(value, index, key);
      if (!c) {
        errors.push(`Ignored malformed case #${index + 1}.`);
        continue;
      }
      if (ids.has(c.id!) || names.has(c.name)) {
        errors.push(`Ignored duplicate saved case "${c.name}".`);
        continue;
      }
      ids.add(c.id!);
      names.add(c.name);
      cases.push(c);
    }
    return { cases, errors };
  } catch (error) {
    return { cases: [], errors: [`Could not read saved cases: ${redactText(error instanceof Error ? error.message : error)}`] };
  }
}

function writeCases(root: string, key: string, cases: SavedCase[]) {
  const file = caseFilePath(root, key);
  if (!cases.length) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* nothing to delete */
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const safeCases = cases.map((c) => ({ ...c, inputs: redact(c.inputs), ...(c.kinds ? { kinds: redact(c.kinds) } : {}), ...(c.expected !== undefined ? { expected: redact(c.expected) } : {}) }));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 2, target: key, cases: safeCases }, null, 2) + '\n', { encoding: 'utf8', flag: 'w' });
    fs.renameSync(tmp, file);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
  }
}

export function upsertCase(root: string, key: string, c: SavedCase) {
  const all = loadCases(root, key).filter((x) => x.name !== c.name && x.id !== c.id);
  all.push({ ...c, id: c.id || randomUUID(), inputs: redact(c.inputs), ...(c.expected !== undefined ? { expected: redact(c.expected) } : {}) });
  writeCases(root, key, all);
}

export function removeCase(root: string, key: string, name: string) {
  writeCases(root, key, loadCases(root, key).filter((x) => x.name !== name));
}

// ---------------------------------------------------------------- form <-> saved case
const isRouteForm = (f: Form): f is RouteForm => 'path' in f;

/** Headers that must never be written into a shared file. */
const dropHeader = (line: string) => {
  const match = /^\s*([^:]+)\s*:/.exec(line);
  return !!match && isSecretKey(match[1].trim());
};

export function formToCase(target: Target, form: Form, name: string, expected?: any): SavedCase {
  if (target.kind === 'method') {
    const f = form as MethodForm;
    const inputs: Record<string, string> = {};
    const kinds: Record<string, string> = {};
    target.params.forEach((p, i) => {
      inputs[p.name] = f.values[i] ?? '';
      if (kindOf(p.type) === 'any' && f.kinds[i]) kinds[p.name] = f.kinds[i];
    });
    const c: SavedCase = { name, inputs: redact(inputs) };
    if (Object.keys(kinds).length) c.kinds = kinds;
    if (expected !== undefined) c.expected = expected;
    return c;
  }
  const f = form as RouteForm;
  const safePathParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(f.pathParams || {})) {
    safePathParams[k] = isSecretKey(k) ? '<REDACTED>' : v;
  }
  const c: SavedCase = {
    name,
    inputs: {
      path: f.path,
      pathParams: safePathParams,
      query: redactText(f.query, '<REDACTED>'),
      headers: f.headers.split(/\r?\n/).filter((l) => !dropHeader(l)).join('\n'), // the login token is never saved
      body: safeBody(f.body),
    },
  };
  if (expected !== undefined) c.expected = expected;
  return c;
}

function safeBody(body: string): string {
  if (!body) return body;
  try {
    return JSON.stringify(redact(JSON.parse(body), '<REDACTED>'), null, 2);
  } catch {
    return redactText(body, '<REDACTED>');
  }
}

export function caseToForm(target: Target, c: SavedCase, token = '', fallback?: Form): Form {
  if (target.kind === 'method') {
    return {
      values: target.params.map((p) => String(c.inputs?.[p.name] ?? '')),
      kinds: target.params.map((p) => (kindOf(p.type) === 'any' ? c.kinds?.[p.name] || 'text' : '')),
    };
  }
  const base = fallback && isRouteForm(fallback) ? fallback : undefined;
  return {
    path: c.inputs?.path ?? base?.path ?? target.routePath,
    pathParams: c.inputs?.pathParams ?? {},
    query: c.inputs?.query ?? '',
    headers: c.inputs?.headers ?? '',
    token,
    body: c.inputs?.body ?? '',
  };
}

// ---------------------------------------------------------------- secrets
/** Names of fields in this form that look like secrets and have a value. */
export function secretFields(target: Target, form: Form): string[] {
  const found: string[] = [];
  if (target.kind === 'method') {
    const f = form as MethodForm;
    target.params.forEach((p, i) => {
      if (isSecretKey(p.name) && (f.values[i] ?? '') !== '') found.push(p.name);
    });
    return found;
  }
  const f = form as RouteForm;
  const scan = (v: any) => {
    if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (isSecretKey(k) && x !== '' && x !== null && x !== undefined) found.push(k);
        else scan(x);
      }
    }
  };
  try {
    scan(JSON.parse(f.body || 'null'));
  } catch {
    /* body is not JSON */
  }
  return found;
}

/** Same form, with the values of secret-looking fields emptied. */
export function stripSecrets(target: Target, form: Form): Form {
  if (target.kind === 'method') {
    const f = form as MethodForm;
    return { ...f, values: f.values.map((v, i) => (isSecretKey(target.params[i]?.name ?? '') ? '' : v)) };
  }
  const f = form as RouteForm;
  const wipe = (v: any): any => {
    if (Array.isArray(v)) return v.map(wipe);
    if (v && typeof v === 'object') {
      const o: any = {};
      for (const [k, x] of Object.entries(v)) o[k] = isSecretKey(k) && typeof x !== 'object' ? '' : wipe(x);
      return o;
    }
    return v;
  };
  try {
    return { ...f, body: JSON.stringify(wipe(JSON.parse(f.body)), null, 2) };
  } catch {
    return f;
  }
}

export { keyOf };
