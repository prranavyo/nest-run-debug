// One conservative sanitisation boundary for reports, files, generated code and diagnostics.
// It deliberately favours hiding a value over trying to infer that a credential is harmless.
// NOTE: Automatic detection cannot identify every arbitrary secret embedded in free text.

const SECRET_KEY = /(?:pass(?:word|phrase|code)?|pwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth(?:orization)?|api[-_]?key|x[-_]api[-_]key|private[-_]?key|hash|cookie|credential|database(?:[-_]?(?:url|password|user(?:name)?|pwd))?|db[-_]?(?:pass(?:word)?|user|pwd)|connection[-_]?string|client[-_]?secret|session(?:[-_]?id)?)/i;
const SECRET_QUERY_KEY = /^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|key|pass(?:word|phrase|code)?|pwd|secret|token)$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\b/g;
const BCRYPT = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}\b/gi;
const CONNECTION_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^@\s/]+)(@)/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const KEY_VALUE_SECRET = /\b(pass(?:word|phrase|code)?|pwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|client[-_]?secret)\s*([:=])\s*((?!••••••|%E2%80%A2|<REDACTED>)[^\s,;'"\]}]+)/gi;
const AUTH_HEADER_SECRET = /\b(authorization)\s*:\s*(?!Bearer|••••••|%E2%80%A2|<REDACTED>)([^\s,;'"\]}]+)/gi;
const JSON_SECRET = /(["'])(pass(?:word|phrase|code)?|pwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|client[-_]?secret|authorization)\1\s*:\s*(["'])(.*?)\3/gi;
const QUERY_PARAM_SECRET = /(?:([?&]|\b))(access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|pass(?:word|code)?|pwd|secret|token|key)=((?!••••••|%E2%80%A2|<REDACTED>)[^\s&"'`]+)/gi;

export const MASK = '••••••';
export const REDACTED = '<REDACTED>';
export const ANY = '<any>'; // in a saved expected value: matches anything

export const isSecretKey = (key: string) => SECRET_KEY.test(key);

function sanitizeUrl(text: string, mask: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"')]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      let changed = false;
      for (const key of [...url.searchParams.keys()]) {
        if (SECRET_QUERY_KEY.test(key)) {
          url.searchParams.set(key, mask);
          changed = true;
        }
      }
      if (url.password) {
        url.password = mask;
        changed = true;
      }
      return changed ? url.toString() : candidate;
    } catch {
      return candidate;
    }
  });
}

/** Redacts recognizable credentials in arbitrary text. This cannot detect every arbitrary secret in free text. */
export function redactText(value: unknown, mask: string = MASK): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : String(value);
  } catch {
    return mask;
  }
  return sanitizeUrl(text, mask)
    .replace(CONNECTION_CREDENTIAL, `$1${mask}$3`)
    .replace(PRIVATE_KEY, `[${mask}]`)
    .replace(JWT, mask)
    .replace(BCRYPT, mask)
    .replace(BEARER, `$1${mask}`)
    .replace(QUERY_PARAM_SECRET, `$1$2=${mask}`)
    .replace(KEY_VALUE_SECRET, `$1$2${mask}`)
    .replace(AUTH_HEADER_SECRET, `$1: ${mask}`)
    .replace(JSON_SECRET, `$1$2$1: $3${mask}$3`);
}

function errorShape(error: Error, seen: WeakSet<object>, mask: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: redactText(error.name || 'Error', mask),
    message: redactText(error.message || String(error), mask),
  };
  if (error.stack) out.stack = redactText(error.stack, mask);
  const keys = new Set([...Object.getOwnPropertyNames(error), ...Object.keys(error as unknown as Record<string, unknown>)]);
  for (const key of keys) {
    if (key === 'name' || key === 'message' || key === 'stack') continue;
    const val = (error as unknown as Record<string, unknown>)[key];
    out[key] = isSecretKey(key) && val !== null && val !== undefined && val !== '' ? mask : clone(val, seen, mask);
  }
  return out;
}

function clone(value: unknown, seen: WeakSet<object>, mask: string): unknown {
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return redactText(value, mask);
  if (typeof value === 'function') return `[Function ${(value as Function).name || 'anonymous'}]`;
  if (typeof value === 'symbol') return String(value);
  if (value instanceof Error) return errorShape(value, seen, mask);
  if (typeof value !== 'object') return redactText(value, mask);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Set) return [...value].map((item) => clone(item, seen, mask));
  if (value instanceof Map) {
    const outMap: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      const keyStr = String(k);
      outMap[keyStr] = isSecretKey(keyStr) && v !== null && v !== undefined && v !== '' ? mask : clone(v, seen, mask);
    }
    return outMap;
  }
  if (Array.isArray(value)) return value.map((item) => clone(item, seen, mask));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (isSecretKey(key)) {
      if (child === null || child === undefined || child === '') {
        out[key] = child;
      } else if (typeof child === 'object' && !(child instanceof Error)) {
        out[key] = clone(child, seen, mask);
      } else {
        out[key] = mask;
      }
    } else {
      out[key] = clone(child, seen, mask);
    }
  }
  return out;
}

/** Returns a JSON-safe, circular-safe, redacted copy without mutating the source. */
export function redact<T = unknown>(value: T, mask: string = MASK): T {
  return clone(value, new WeakSet<object>(), mask) as T;
}

export function sanitizeError(error: unknown, mask: string = MASK): { name?: string; message: string; stack?: string; [key: string]: unknown } {
  const safe = redact(error instanceof Error ? error : { message: error }, mask) as Record<string, unknown>;
  return {
    ...safe,
    message: typeof safe.message === 'string' ? safe.message : redactText(error, mask),
    ...(typeof safe.name === 'string' ? { name: safe.name } : {}),
    ...(typeof safe.stack === 'string' ? { stack: safe.stack } : {}),
  };
}

/** A copy of a run report safe for rendering or persistence. */
export function maskReport(report: unknown, mask: string = MASK): any {
  return redact(report, mask);
}

/** Does actual match expected? (<any> matches a present, non-undefined value.) */
export function matches(actual: any, expected: any): boolean {
  if (expected === ANY) return actual !== undefined;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e));
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    return expectedKeys.length === actualKeys.length && expectedKeys.every((key) => key in actual && matches(actual[key], expected[key]));
  }
  return actual === expected;
}
