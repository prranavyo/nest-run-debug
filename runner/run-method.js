// Runs ONE thing inside your Nest project and records what happens:
//   - a service method        {type:'call', file, className, method, params:[...]}
//   - an API request          {type:'http', httpMethod, path, query, headers, body}
//
// Two ways to start it (the extension picks):
//   one-shot : node -r ts-node/register -r tsconfig-paths/register run-method.js <requestFile> <outFile>
//   --serve  : node ... run-method.js --serve      (stays alive; one JSON request per line on stdin)
// The working folder is your Nest project, so your own tsconfig and node_modules are used.

const fs = require('fs');
const path = require('path');
const util = require('util');

const cwd = process.cwd();
const SERVE = process.argv[2] === '--serve';
const MARK = '@@NESTRUN@@';

// Load packages from the USER'S project, not from the extension folder.
const load = (name) => require(require.resolve(name, { paths: [cwd] }));

// The serve loop below serializes requests. The instrumentation is necessarily process-global
// for a live Nest app, so only this single active context may receive logs and Prisma events.
let current = { calls: [], logs: [], depth: 0, runId: undefined };

const SECRET_KEY = /(?:pass(?:word|phrase|code)?|pwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth(?:orization)?|api[-_]?key|x[-_]api[-_]key|private[-_]?key|hash|cookie|credential|database(?:[-_]?(?:url|password|user(?:name)?|pwd))?|db[-_]?(?:pass(?:word)?|user|pwd)|connection[-_]?string|client[-_]?secret|session(?:[-_]?id)?)/i;
const SECRET_QUERY = /^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|key|pass(?:word|phrase|code)?|pwd|secret|token)$/i;
const MASK = '<REDACTED>';
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\b/g;
const BCRYPT = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}\b/gi;
const CONNECTION_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^@\s/]+)(@)/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const KEY_VALUE_SECRET = /\b(pass(?:word|phrase|code)?|pwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|client[-_]?secret|authorization)\s*([:=])\s*((?!••••••|%E2%80%A2|<REDACTED>)[^\s,;'"\]}]+)/gi;
const JSON_SECRET = /(["'])(pass(?:word|phrase|code)?|pwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|client[-_]?secret|authorization)\1\s*:\s*(["'])(.*?)\3/gi;
const QUERY_PARAM_SECRET = /(?:([?&]|\b))(access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|pass(?:word|code)?|pwd|secret|token|key)=((?!••••••|%E2%80%A2|<REDACTED>)[^\s&"'`]+)/gi;

function redactText(value) {
  let text;
  try { text = typeof value === 'string' ? value : String(value); } catch { return MASK; }
  text = text.replace(CONNECTION_CREDENTIAL, `$1${MASK}$3`)
    .replace(PRIVATE_KEY, `[${MASK}]`)
    .replace(JWT, MASK)
    .replace(BCRYPT, MASK)
    .replace(BEARER, `$1${MASK}`)
    .replace(QUERY_PARAM_SECRET, `$1$2=${MASK}`)
    .replace(KEY_VALUE_SECRET, `$1$2${MASK}`)
    .replace(JSON_SECRET, `$1$2$1: $3${MASK}$3`);
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"')]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      let changed = false;
      for (const key of [...url.searchParams.keys()]) if (SECRET_QUERY.test(key)) { url.searchParams.set(key, MASK); changed = true; }
      if (url.password) { url.password = MASK; changed = true; }
      return changed ? url.toString() : candidate;
    } catch { return candidate; }
  });
}

function redactValue(value, seen = new WeakSet()) {
  if (value === undefined || value === null || ['boolean', 'number'].includes(typeof value)) return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return String(value);
  if (value instanceof Error) return { name: value.name, message: redactText(value.message), stack: value.stack && redactText(value.stack) };
  if (typeof value !== 'object') return redactText(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  const out = {};
  for (const key of Object.keys(value)) out[key] = SECRET_KEY.test(key) && value[key] !== null && value[key] !== undefined && value[key] !== '' ? MASK : redactValue(value[key], seen);
  return out;
}

process.on('unhandledRejection', (e) => {
  if (current && Array.isArray(current.logs)) {
    current.logs.push('unhandled error: ' + redactText((e && e.stack) || e));
  }
});

// ---------------------------------------------------------------- helpers
function safeValue(v) {
  return redactValue(v === undefined ? null : v);
}

function summarize(r) {
  if (Array.isArray(r)) return { rowCount: r.length, rows: safeValue(r.slice(0, 50)) };
  return { value: safeValue(r) };
}

function describeRaw(args) {
  const first = args[0];
  if (typeof first === 'string') return { sql: first, params: args.slice(1) };
  if (first && typeof first.sql === 'string') return { sql: first.sql, params: first.values || [] };
  if (Array.isArray(first)) return { sql: first.join('?'), params: args.slice(1) };
  return { sql: String(first), params: args.slice(1) };
}

function safeSqlParams(params) {
  // Query shape is useful; raw bind values are not shown or persisted by default.
  return (params || []).map(() => MASK);
}

function trackEager(rec, pp) {
  const t0 = Date.now();
  return Promise.resolve(pp).then(
    (r) => {
      rec.ms = Date.now() - t0;
      try {
        rec.result = summarize(r);
      } catch {
        rec.result = { value: '[Unserializable result]' };
      }
      return r;
    },
    (e) => {
      rec.ms = Date.now() - t0;
      try {
        rec.error = redactText(e && e.message ? e.message : e);
      } catch {
        rec.error = 'Database query failed';
      }
      throw e;
    },
  );
}

// Prisma queries are "lazy": they only run when awaited. We keep that behaviour (so $transaction([...])
// still works) and record the result at the moment Prisma actually runs the query.
function trackLazy(rec, pp) {
  if (!pp || typeof pp.then !== 'function') return pp;
  // A normal JavaScript promise is already running (and "await" ignores a replaced .then), so record it directly.
  if (pp instanceof Promise) return trackEager(rec, pp);
  const origThen = pp.then.bind(pp);
  let tracked;
  try {
    pp.then = (onFulfilled, onRejected) => {
      if (!tracked) {
        const t0 = Date.now();
        tracked = origThen(
          (r) => {
            rec.ms = Date.now() - t0;
            try {
              rec.result = summarize(r);
            } catch {
              rec.result = { value: '[Unserializable result]' };
            }
            return r;
          },
          (e) => {
            rec.ms = Date.now() - t0;
            try {
              rec.error = redactText(e && e.message ? e.message : e);
            } catch {
              rec.error = 'Database query failed';
            }
            throw e;
          },
        );
      }
      return tracked.then(onFulfilled, onRejected);
    };
    return pp;
  } catch {
    return trackEager(rec, pp);
  }
}

// ---------------------------------------------------------------- find services / Prisma inside the app
function allInstances(app) {
  const list = [];
  try {
    for (const mod of app.container.getModules().values()) {
      for (const group of [mod.providers, mod.controllers, mod.injectables]) {
        for (const w of group.values()) {
          if (w && w.instance && typeof w.instance === 'object') list.push(w);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return list;
}

function findProviderByName(app, name) {
  // By class name: more reliable than comparing class objects
  // (on Windows "d:\x" and "D:\x" load as two separate copies of the same file).
  for (const w of allInstances(app)) {
    if (w.metatype && w.metatype.name === name) return w.instance;
  }
  return undefined;
}

const isClient = (v) => v && typeof v === 'object' && typeof v.$queryRawUnsafe === 'function';

function findClients(app) {
  const found = new Set();
  for (const w of allInstances(app)) {
    const inst = w.instance;
    if (isClient(inst)) found.add(inst);
    else {
      for (const key of Object.getOwnPropertyNames(inst)) {
        try {
          if (isClient(inst[key])) found.add(inst[key]);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return [...found];
}

// Which file does a class live in? (used by the "create Jest test" feature to write import lines)
function fileOfClass(cls) {
  if (!cls) return undefined;
  for (const [file, m] of Object.entries(require.cache)) {
    const ex = m && m.exports;
    if (!ex || (typeof ex !== 'object' && typeof ex !== 'function')) continue;
    try {
      for (const k of Object.keys(ex)) if (ex[k] === cls) return file;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- record DB calls
// Works on every Prisma version: services hold the Prisma client in a property (this.Database ...).
// We give them a thin wrapper around the client that notes down each call, then passes it on.
const RAW = new Set(['$queryRawUnsafe', '$executeRawUnsafe', '$queryRaw', '$executeRaw']);
const ACTIONS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn',
  'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy', 'findRaw', 'aggregateRaw',
]);
const isDelegate = (v) => v && typeof v === 'object' && typeof v.findMany === 'function';

const wrappedClients = new WeakMap(); // wrapper -> real client
let lastClients = [];

function wrapDelegate(modelName, delegate) {
  return new Proxy(delegate, {
    get(t, key) {
      const v = Reflect.get(t, key, t);
      if (typeof key === 'string' && ACTIONS.has(key) && typeof v === 'function') {
        return (...args) => {
          const rec = { kind: 'model', model: modelName, action: key, args: safeValue(args[0]), depth: current.depth };
          current.calls.push(rec);
          return trackLazy(rec, v.apply(t, args));
        };
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

function wrapClient(target) {
  const wrapper = new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t);
      if (typeof prop === 'string') {
        if (RAW.has(prop) && typeof v === 'function') {
          return (...args) => {
            const { sql, params } = describeRaw(args);
            const rec = { kind: 'raw', fn: prop, sql: redactText(sql), params: safeSqlParams(params), depth: current.depth };
            current.calls.push(rec);
            return trackLazy(rec, v.apply(t, args));
          };
        }
        if (prop === '$transaction' && typeof v === 'function') {
          return (arg, ...rest) =>
            typeof arg === 'function'
              ? v.call(t, (tx) => arg(wrapClient(tx)), ...rest) // calls inside the transaction are recorded too
              : v.call(t, arg, ...rest);
        }
        if (isDelegate(v)) return wrapDelegate(prop, v);
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  wrappedClients.set(wrapper, target);
  return wrapper;
}

// Replace "this.Database" (and similar) in every service with the recording wrapper.
function replaceReferences(app, client) {
  const wrapped = wrapClient(client);
  let count = 0;
  for (const w of allInstances(app)) {
    const inst = w.instance;
    if (inst === client) continue;
    for (const key of Object.getOwnPropertyNames(inst)) {
      let val;
      try {
        val = inst[key];
      } catch {
        continue;
      }
      if (val === client) {
        try {
          inst[key] = wrapped;
          count++;
        } catch {
          /* read-only property: skip */
        }
      }
    }
  }
  return count;
}

// Fallback when no service holds the client in a normal property.
function patchClientItself(client) {
  for (const name of RAW) {
    const original = client[name];
    if (typeof original !== 'function') continue;
    client[name] = function (...args) {
      const { sql, params } = describeRaw(args);
      const rec = { kind: 'raw', fn: name, sql: redactText(sql), params: safeSqlParams(params), depth: current.depth };
      current.calls.push(rec);
      return trackLazy(rec, original.apply(client, args));
    };
  }
  if (typeof client.$use === 'function') {
    client.$use(async (p, next) => {
      if (!p.model) return next(p);
      const rec = { kind: 'model', model: p.model, action: p.action, args: safeValue(p.args), depth: current.depth };
      current.calls.push(rec);
      const t0 = Date.now();
      try {
        const r = await next(p);
        rec.ms = Date.now() - t0;
        rec.result = summarize(r);
        return r;
      } catch (e) {
        rec.ms = Date.now() - t0;
        rec.error = redactText(e && e.message ? e.message : e);
        throw e;
      }
    });
  }
}

function instrumentApp(app) {
  lastClients = findClients(app);
  for (const client of lastClients) {
    if (replaceReferences(app, client) === 0) patchClientItself(client);
  }
}

// ---------------------------------------------------------------- record calls to OTHER services
// (the services your method uses, like a response helper or a token service)
function wrapService(className, target) {
  return new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t);
      if (typeof v !== 'function' || typeof prop !== 'string' || prop === 'constructor') return v;
      return function (...args) {
        const rec = { kind: 'service', service: className, method: prop, args: safeValue(args), depth: current.depth };
        current.calls.push(rec);
        const t0 = Date.now();
        current.depth++;
        let r;
        try {
          r = v.apply(t, args);
        } catch (e) {
          current.depth--;
          rec.ms = Date.now() - t0;
          rec.sync = true;
          rec.error = redactText(e && e.message ? e.message : e);
          throw e;
        }
        if (r && typeof r.then === 'function') {
          rec.sync = false;
          return Promise.resolve(r).then(
            (x) => {
              current.depth--;
              rec.ms = Date.now() - t0;
              rec.result = summarize(x);
              return x;
            },
            (e) => {
              current.depth--;
              rec.ms = Date.now() - t0;
              rec.error = redactText(e && e.message ? e.message : e);
              throw e;
            },
          );
        }
        current.depth--;
        rec.sync = true;
        rec.ms = Date.now() - t0;
        rec.result = summarize(r);
        return r;
      };
    },
  });
}

// ---------------------------------------------------------------- start the Nest app (once per kind)
let contextApp; // for service methods: no web server
let contextPromise;
function boot() {
  if (!contextPromise) {
    contextPromise = (async () => {
      const { NestFactory } = load('@nestjs/core');
      const AppModule = loadAppModule();
      const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
      instrumentApp(app);
      contextApp = app;
      return app;
    })().catch((e) => {
      contextPromise = null; // try again next time
      throw e;
    });
  }
  return contextPromise;
}

function loadAppModule() {
  const appModulePath = path.resolve(cwd, process.env.NEST_RUN_APP_MODULE || 'src/app.module');
  const appMod = require(appModulePath);
  return appMod.AppModule || Object.values(appMod)[0];
}

// For API requests we start the app the way YOUR main.ts does (global prefix, pipes, filters...),
// but on a free port, so it never clashes with your dev server.
let httpApp;
let httpPromise;
function bootHttp() {
  if (!httpPromise) {
    httpPromise = (async () => {
      const { NestFactory } = load('@nestjs/core');
      const mainPath = path.resolve(cwd, process.env.NEST_RUN_MAIN || 'src/main');
      let hasMain = true;
      try {
        require.resolve(mainPath);
      } catch {
        hasMain = false;
      }

      let app;
      if (hasMain) {
        // Patch listen() on Nest's application class: whatever your main.ts does, the app starts on a free port.
        const { NestApplication } = load('@nestjs/core/nest-application');
        const originalListen = NestApplication.prototype.listen;
        let onListening;
        const listening = new Promise((r) => (onListening = r));
        NestApplication.prototype.listen = async function (_port, ...rest) {
          app = this;
          NestApplication.prototype.listen = originalListen;
          const server = await originalListen.call(this, 0, ...rest.filter((x) => typeof x === 'string'));
          onListening();
          return server;
        };
        require(mainPath); // runs your bootstrap()
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Your main file did not start an HTTP app in time (it must call NestFactory.create and app.listen).')),
            Number(process.env.NEST_RUN_STARTUP_TIMEOUT_MS || 60000),
          );
        });
        try {
          await Promise.race([listening, timeout]);
        } finally {
          clearTimeout(timer);
          NestApplication.prototype.listen = originalListen;
        }
      } else {
        const AppModule = loadAppModule();
        app = await NestFactory.create(AppModule, { logger: false });
        if (process.env.NEST_RUN_GLOBAL_PREFIX) app.setGlobalPrefix(process.env.NEST_RUN_GLOBAL_PREFIX);
        await app.listen(0);
      }
      instrumentApp(app);
      httpApp = app;
      const addr = app.getHttpServer().address();
      return { app, addr };
    })().catch((e) => {
      httpPromise = null;
      throw e;
    });
  }
  return httpPromise;
}

function globalPrefixOf(app) {
  let prefix = '';
  try {
    prefix = app.config && app.config.getGlobalPrefix ? app.config.getGlobalPrefix() : '';
  } catch {
    /* ignore */
  }
  if (!prefix) prefix = process.env.NEST_RUN_GLOBAL_PREFIX || '';
  return String(prefix || '').replace(/^\/+|\/+$/g, '');
}

function prismaMeta() {
  const c = lastClients[0];
  if (!c) return undefined;
  return { className: c.constructor && c.constructor.name, file: fileOfClass(c.constructor) };
}

// ---------------------------------------------------------------- run a service method
async function execCall(req, report) {
  const b0 = Date.now();
  const app = await boot();
  report.bootMs = Date.now() - b0;
  report.meta.prisma = prismaMeta();

  let instance = findProviderByName(app, req.className);
  if (!instance) {
    const real = fs.realpathSync.native ? fs.realpathSync.native(req.file) : req.file;
    const Target = require(real)[req.className];
    if (!Target) throw new Error(`Class "${req.className}" is not exported from ${req.file}`);
    try {
      instance = app.get(Target, { strict: false });
    } catch {
      throw new Error(
        `${req.className} is not registered in any module of your app. Add it to the "providers" list of a module that AppModule imports.`,
      );
    }
  }
  if (typeof instance[req.method] !== 'function') throw new Error(`"${req.method}" is not a method of ${req.className}`);

  // wrap the OTHER services this one uses, so their calls are recorded (and put back afterwards)
  const byInstance = new Map(allInstances(app).map((w) => [w.instance, w]));
  const restore = [];
  for (const key of Object.getOwnPropertyNames(instance)) {
    let val;
    try {
      val = instance[key];
    } catch {
      continue;
    }
    if (!val || typeof val !== 'object' || wrappedClients.has(val) || isClient(val)) continue;
    const w = byInstance.get(val);
    if (!w) continue;
    const cls = (w.metatype && w.metatype.name) || (val.constructor && val.constructor.name);
    report.meta.deps.push({ prop: key, className: cls, file: fileOfClass(w.metatype || val.constructor) });
    try {
      instance[key] = wrapService(cls, val);
      restore.push([key, val]);
    } catch {
      /* read-only: skip */
    }
  }

  try {
    const t0 = Date.now();
    const output = await instance[req.method](...req.params);
    report.ms = Date.now() - t0;
    report.output = safeValue(output);
  } finally {
    for (const [key, original] of restore) {
      try {
        instance[key] = original;
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------- send an API request
async function execHttp(req, report) {
  if (typeof fetch !== 'function') throw new Error('Sending requests needs Node.js 18 or newer.');
  const b0 = Date.now();
  const { app, addr } = await bootHttp();
  report.bootMs = Date.now() - b0;
  const prefix = globalPrefixOf(app);
  report.meta.globalPrefix = prefix;
  report.meta.prisma = prismaMeta();

  let host = addr && addr.address ? addr.address : '127.0.0.1';
  if (host === '::' || host === '0.0.0.0') host = '127.0.0.1';
  if (host.includes(':')) host = `[${host}]`;

  // a path without a leading "/" gets the global prefix (like /api) added; with "/" it is used exactly
  let p = String(req.path || '');
  if (!p.startsWith('/')) p = '/' + (prefix ? prefix + '/' : '') + p;
  let url = `http://${host}:${addr.port}${p}`;
  if (req.query) url += (url.includes('?') ? '&' : '?') + String(req.query).replace(/^\?/, '');

  const method = String(req.httpMethod || 'GET').toUpperCase();
  const headers = { ...(req.headers || {}) };
  let body;
  if (req.body !== undefined && req.body !== null && method !== 'GET' && method !== 'HEAD') {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }

  const t0 = Date.now();
  const controller = new AbortController();
  const timeoutMs = Number(process.env.NEST_RUN_HTTP_TIMEOUT_MS || 30000);
  const timeout = setTimeout(() => controller.abort(new Error(`HTTP request timed out after ${timeoutMs} ms.`)), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text === '' ? '' : JSON.parse(text);
  } catch {
    /* not JSON: keep text */
  }
  report.ms = Date.now() - t0;
  report.http = {
    method,
    url: url.replace(/^http:\/\/[^/]+/, ''),
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers),
    body: safeValue(parsed),
  };
  report.sentHeaders = headers;
  report.sentBody = req.body === undefined ? undefined : safeValue(req.body);
}

// ---------------------------------------------------------------- one request, one report
async function execute(req) {
  const report = { runId: req.runId, calls: [], logs: [], depth: 0, output: undefined, error: undefined, ms: 0, bootMs: 0, meta: { deps: [] } };
  current = report;
  try {
    if (req.type === 'http') await execHttp(req, report);
    else await execCall(req, report);
  } catch (e) {
    report.error = { message: redactText((e && e.message) || e), stack: e && e.stack ? redactText(e.stack) : undefined };
  } finally {
    delete report.depth;
    current = { calls: [], logs: [], depth: 0, runId: undefined };
  }
  return report;
}

// ---------------------------------------------------------------- entry points
async function closeApps() {
  for (const app of [contextApp, httpApp]) {
    try {
      if (app) await app.close();
    } catch {
      /* ignore */
    }
  }
}

if (SERVE) {
  // keep console output out of the way: show it inside the result panel instead
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    console[level] = (...a) => current.logs.push(redactText((level === 'log' ? '' : level + ': ') + util.format(...a)));
  }
  const rl = require('readline').createInterface({ input: process.stdin });
  let requestTail = Promise.resolve();
  rl.on('line', (line) => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    requestTail = requestTail
      .then(async () => {
        const report = await execute(req);
        process.stdout.write(MARK + JSON.stringify({ id: req.id, report }) + '\n');
      })
      .catch((error) => {
        const report = { runId: req.runId, calls: [], logs: [], ms: 0, bootMs: 0, meta: { deps: [] }, error: { message: redactText(error), stack: '' } };
        process.stdout.write(MARK + JSON.stringify({ id: req.id, report }) + '\n');
      });
  });
  rl.on('close', () => process.exit(0));
} else {
  (async () => {
    const [, , requestFile, outFile] = process.argv;
    const req = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    const report = await execute(req);
    fs.writeFileSync(outFile, JSON.stringify(report));
    await closeApps();
    process.exit(0);
  })();
}
