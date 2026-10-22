import * as path from 'path';
import { REDACTED, redact, redactText, isSecretKey } from './redact';

export interface JestInput {
  kind: 'method' | 'route';
  className: string;
  method: string;
  testName: string;
  specDir: string; // folder the test file will be written to
  targetFile: string; // the service / controller file
  report: any; // the real (unmasked) run report
  paramNames?: string[]; // method: parameter names
  args?: unknown[]; // method: the values that were passed
  http?: { method: string; headers: Record<string, string>; body: unknown }; // route
  appModuleFile?: string; // route: file of AppModule
}

// ---------------------------------------------------------------- small helpers
const q = (s: string) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const isIdent = (s: string) => /^[A-Za-z_$][\w$]*$/.test(s);
const dot = (name: string) => (isIdent(name) ? `.${name}` : `[${q(name)}]`);

/** Import path from the test file to a class file (or the package name for node_modules). */
function importPath(specDir: string, file: string): string {
  const f = file.replace(/\\/g, '/');
  const nm = f.lastIndexOf('/node_modules/');
  if (nm >= 0) {
    const rest = f.slice(nm + '/node_modules/'.length).split('/');
    return rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
  }
  let rel = path.relative(specDir, file).replace(/\\/g, '/').replace(/\.(ts|js)$/, '');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

/** A value as code. Secrets become '<REDACTED>' (or expect.anything() inside assertions). */
function lit(v: unknown, asMatcher = false, pad = 0): string {
  const safe = redact(v === undefined ? null : v, REDACTED);
  let s = JSON.stringify(safe, null, 2) ?? 'undefined';
  if (asMatcher) s = s.split(JSON.stringify(REDACTED)).join('expect.anything()');
  return s
    .split('\n')
    .map((l, i) => (i === 0 ? l : ' '.repeat(pad) + l))
    .join('\n');
}

const resultOf = (c: any): unknown => (c.result ? (c.result.rows !== undefined ? c.result.rows : c.result.value) : undefined);

// ---------------------------------------------------------------- database mock (shared by both kinds of test)
function dbBlock(calls: any[]): string {
  const models = new Map<string, Set<string>>();
  const raws = new Set<string>();
  for (const c of calls) {
    if (c.kind === 'model') {
      if (!models.has(c.model)) models.set(c.model, new Set());
      models.get(c.model)!.add(c.action);
    } else if (c.kind === 'raw') raws.add(c.fn || '$queryRawUnsafe');
  }
  const lines = ['const db: any = {', '  $connect: jest.fn(),', '  $disconnect: jest.fn(),', '  $transaction: jest.fn(),'];
  for (const raw of raws) lines.push(`  ${isIdent(raw) ? raw : q(raw)}: jest.fn(),`);
  for (const [model, actions] of models) {
    lines.push(`  ${isIdent(model) ? model : q(model)}: { ${[...actions].map((a) => `${a}: jest.fn()`).join(', ')} },`);
  }
  lines.push('};');
  return lines.join('\n');
}

const dbExpr = (c: any) => (c.kind === 'model' ? `db${dot(c.model)}${dot(c.action)}` : `db${dot(c.fn || '$queryRawUnsafe')}`);

/** "what the database answered" lines, in the order the calls happened */
function dbMocks(calls: any[], pad: string): string[] {
  const out: string[] = [];
  for (const c of calls) {
    if (c.error) out.push(`${pad}${dbExpr(c)}.mockRejectedValueOnce(new Error(${q(redactText(c.error, REDACTED))}));`);
    else out.push(`${pad}${dbExpr(c)}.mockResolvedValueOnce(${lit(resultOf(c), false, pad.length)});`);
  }
  return out;
}

/** "the database was asked this" lines */
function dbAsserts(calls: any[], pad: string): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (const c of calls) {
    const expr = dbExpr(c);
    const n = (seen.get(expr) || 0) + 1;
    seen.set(expr, n);
    if (c.kind === 'model') {
      if (c.args === null || c.args === undefined) continue;
      out.push(`${pad}expect(${expr}).toHaveBeenNthCalledWith(${n}, ${lit(c.args, true, pad.length)});`);
    } else {
      // Raw SQL parameter values are masked by default to protect credentials in test files
      const params = (c.params || []).map((p: unknown) => (p === undefined ? 'undefined' : 'expect.anything()'));
      out.push(`${pad}expect(${expr}).toHaveBeenNthCalledWith(${[n, JSON.stringify(c.sql), ...params].join(', ')});`);
    }
  }
  return out;
}

const transactionSetup = '    db.$transaction.mockImplementation((arg: any) => (typeof arg === \'function\' ? arg(db) : Promise.all(arg)));';

// ---------------------------------------------------------------- test for a service method
function methodTest(i: JestInput): string {
  const r = i.report;
  const top: any[] = (r.calls || []).filter((c: any) => !c.depth);
  const dbCalls = top.filter((c) => c.kind === 'raw' || c.kind === 'model');
  const svcCalls = top.filter((c) => c.kind === 'service');
  const prisma = r.meta?.prisma;
  const deps: any[] = r.meta?.deps || [];

  const imports = new Map<string, string>();
  imports.set(i.className, importPath(i.specDir, i.targetFile));
  if (prisma?.file) imports.set(prisma.className, importPath(i.specDir, prisma.file));
  for (const d of deps) if (d.file) imports.set(d.className, importPath(i.specDir, d.file));

  const varOf = (d: any) => `${d.prop}Mock`;
  const depLines: string[] = [];
  for (const d of deps) {
    const methods = [...new Set(svcCalls.filter((c) => c.service === d.className).map((c) => c.method))];
    depLines.push(`  const ${varOf(d)}: any = { ${methods.map((m) => `${m}: jest.fn()`).join(', ')} };`);
  }

  const providers = [`        ${i.className},`];
  if (prisma?.file) providers.push(`        { provide: ${prisma.className}, useValue: db },`);
  else providers.push(`        // TODO: provide your database service here: { provide: <PrismaService>, useValue: db },`);
  for (const d of deps) {
    if (d.file) providers.push(`        { provide: ${d.className}, useValue: ${varOf(d)} },`);
    else providers.push(`        // TODO: ${d.className} (${d.prop}) could not be found: provide a mock for it`);
  }

  // what the other services returned
  const svcMocks: string[] = [];
  for (const c of svcCalls) {
    const d = deps.find((x) => x.className === c.service);
    if (!d) continue;
    const target = `${varOf(d)}${dot(c.method)}`;
    if (c.error) {
      svcMocks.push(c.sync ? `    ${target}.mockImplementationOnce(() => { throw new Error(${q(redactText(c.error, REDACTED))}); });` : `    ${target}.mockRejectedValueOnce(new Error(${q(redactText(c.error, REDACTED))}));`);
    } else {
      svcMocks.push(`    ${target}.${c.sync ? 'mockReturnValueOnce' : 'mockResolvedValueOnce'}(${lit(resultOf(c), false, 4)});`);
    }
  }

  // the call itself
  const argList = (i.args || [])
    .map((a, idx) => {
      const name = i.paramNames?.[idx] ?? '';
      if (isSecretKey(name) && a !== undefined && a !== '') return q(REDACTED);
      return a === undefined ? 'undefined' : lit(a);
    })
    .join(', ');
  const call = `service${dot(i.method)}(${argList})`;

  const body: string[] = [];
  if (dbCalls.length) body.push('    // what the database answered during the recorded run', ...dbMocks(dbCalls, '    '), '');
  if (svcMocks.length) body.push('    // what the other services returned during the recorded run', ...svcMocks, '');
  if (r.error) {
    body.push(`    await expect(${call}).rejects.toThrow(${q(redactText(r.error.message, REDACTED))});`);
  } else {
    body.push(`    const result = await ${call};`, '');
    if (r.output === null || r.output === undefined) body.push('    expect(result == null).toBe(true);');
    else body.push(`    expect(result).toEqual(${lit(r.output, true, 4)});`);
  }
  const asserts = [
    ...dbAsserts(dbCalls, '    '),
    ...svcCalls.flatMap((c) => {
      const d = deps.find((x) => x.className === c.service);
      if (!d) return [];
      const n = svcCalls.filter((x) => x.service === c.service && x.method === c.method).indexOf(c) + 1;
      return [`    expect(${varOf(d)}${dot(c.method)}).toHaveBeenNthCalledWith(${[n, ...(c.args || []).map((a: unknown) => lit(a, true, 4))].join(', ')});`];
    }),
  ];
  if (asserts.length) body.push('', '    // what the service asked the database and the other services', ...asserts);

  return [
    `import { Test } from '@nestjs/testing';`,
    ...[...imports].map(([name, from]) => `import { ${name} } from '${from}';`),
    '',
    `describe('${i.className}.${i.method}', () => {`,
    `  let service: ${i.className};`,
    '',
    dbBlock(dbCalls)
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
    ...depLines,
    '',
    '  beforeEach(async () => {',
    '    jest.resetAllMocks();',
    transactionSetup,
    '    const moduleRef = await Test.createTestingModule({',
    '      providers: [',
    ...providers,
    '      ],',
    '    }).compile();',
    `    service = moduleRef.get(${i.className});`,
    '  });',
    '',
    `  it(${q(i.testName)}, async () => {`,
    ...body,
    '  });',
    '});',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- test for an API route
function routeTest(i: JestInput): string {
  const r = i.report;
  const dbCalls: any[] = (r.calls || []).filter((c: any) => c.kind === 'raw' || c.kind === 'model');
  const prisma = r.meta?.prisma;
  const resp = r.http;
  const h = i.http!;
  const prefix: string = r.meta?.globalPrefix || '';

  const imports: string[] = [`import { Test } from '@nestjs/testing';`, `import { INestApplication } from '@nestjs/common';`];
  if (i.appModuleFile) imports.push(`import { AppModule } from '${importPath(i.specDir, i.appModuleFile)}';`);
  else imports.push(`// TODO: import { AppModule } from '<path to your app module>';`);
  if (prisma?.file) imports.push(`import { ${prisma.className} } from '${importPath(i.specDir, prisma.file)}';`);
  else imports.push(`// TODO: import your database service (PrismaService)`);

  const verb = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(h.method.toLowerCase()) ? h.method.toLowerCase() : 'get';
  const chain: string[] = [`request(app.getHttpServer()).${verb}(${q(redactText(resp.url, REDACTED))})`];
  for (const [name, value] of Object.entries(h.headers || {})) {
    if (/^(content-type|content-length|host|accept-encoding|connection|user-agent)$/i.test(name)) continue;
    chain.push(`.set(${q(name)}, ${q(isSecretKey(name) ? REDACTED : redactText(value, REDACTED))})`);
  }
  if (h.body !== undefined && h.body !== null && !['GET', 'HEAD'].includes(h.method.toUpperCase())) {
    chain.push(`.send(${lit(h.body, false, 6)})`);
  }

  const body: string[] = [];
  if (dbCalls.length) body.push('    // what the database answered during the recorded run', ...dbMocks(dbCalls, '    '), '');
  body.push(`    const res = await ${chain.join('\n      ')};`, '');
  body.push(`    expect(res.status).toBe(${resp.status});`);
  if (typeof resp.body === 'string') body.push(`    expect(res.text).toBe(${q(resp.body)});`);
  else body.push(`    expect(res.body).toEqual(${lit(resp.body, true, 4)});`);
  const asserts = dbAsserts(dbCalls, '    ');
  if (asserts.length) body.push('', '    // what the app asked the database', ...asserts);

  return [
    ...imports,
    '',
    `// eslint-disable-next-line @typescript-eslint/no-require-imports`,
    `const request = require('supertest');`,
    '',
    `describe('${h.method.toUpperCase()} ${resp.url.split('?')[0]}', () => {`,
    '  let app: INestApplication;',
    '',
    dbBlock(dbCalls)
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
    '',
    '  beforeAll(async () => {',
    '    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })',
    prisma?.file ? `      .overrideProvider(${prisma.className})` : '      // TODO: .overrideProvider(<PrismaService>)',
    '      .useValue(db)',
    '      .compile();',
    '    app = moduleRef.createNestApplication();',
    prefix ? `    app.setGlobalPrefix(${q(prefix)});` : '',
    '    // TODO: apply the same pipes, filters and settings your main.ts uses (for example ValidationPipe)',
    '    await app.init();',
    '  });',
    '',
    '  beforeEach(() => {',
    '    jest.resetAllMocks();',
    transactionSetup.replace(/^ {4}/, '    '),
    '  });',
    '',
    '  afterAll(async () => {',
    '    await app.close();',
    '  });',
    '',
    `  it(${q(i.testName)}, async () => {`,
    ...body,
    '  });',
    '});',
    '',
  ]
    .filter((l) => l !== undefined)
    .join('\n')
    .replace(/\n\n\n+/g, '\n\n');
}

// ---------------------------------------------------------------- public
export function generateJest(i: JestInput): { content: string; notes: string[] } {
  if (!i.className || !i.method || !i.targetFile || !i.specDir || !i.report || typeof i.report !== 'object') {
    throw new Error('Cannot generate a Jest test: the recorded target or report is incomplete.');
  }
  if (i.kind === 'route' && (!i.http || !i.report.http)) {
    throw new Error('Cannot generate an API test without a recorded HTTP request and response.');
  }
  const code = i.kind === 'method' ? methodTest(i) : routeTest(i);
  const notes: string[] = [];
  if (code.includes(REDACTED)) {
    notes.push('Values of fields that look like secrets (password, token, hash...) were replaced with "<REDACTED>". Put test values there.');
  }
  notes.push('The database answers come from a real run. Dates and big numbers were saved as plain text.');
  notes.push('If Jest cannot find imports that start with "src/", add  moduleNameMapper: { "^src/(.*)$": "<rootDir>/$1" }  to your Jest config.');
  if (i.kind === 'route') notes.push('Install supertest if you do not have it:  npm i -D supertest @types/supertest');
  const header = ['// Generated from a recorded run.', ...notes.map((n) => `// - ${n}`), ''].join('\n');
  return { content: header + code, notes };
}
