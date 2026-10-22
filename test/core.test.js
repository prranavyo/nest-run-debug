const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const { redact, redactText, maskReport, REDACTED, matches, ANY } = require('../out/redact.js');
const { formToCase, loadCasesDetailed, upsertCase, caseFilePath } = require('../out/cases.js');
const { resolveEnvironment, inspectDatabaseTarget } = require('../out/environment.js');
const { findMethods, findRoutes } = require('../out/parse.js');
const { classifyDiagnostic } = require('../out/diagnostics.js');
const { generateJest } = require('../out/jest.js');
const { Daemon } = require('../out/daemon.js');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-run-test-'));
  tempRoots.push(root);
  return root;
}
afterEach(async () => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (attempt === 9) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
});

test('redacts nested values, headers, URLs, errors, circular values and raw SQL report values', () => {
  const circular = { password: 'password-123', nested: [{ Authorization: 'Bearer abcdefghijklmnop' }] };
  circular.self = circular;
  circular.url = 'https://example.test/items?token=jwt-token-value&keep=1';
  circular.missing = undefined;
  const safe = redact(circular);
  assert.equal(safe.password, '••••••');
  assert.equal(safe.nested[0].Authorization, '••••••');
  assert.equal(safe.self, '[Circular]');
  assert.equal(safe.missing, undefined);
  assert.match(safe.url, /token=%E2%80%A2/);
  assert.equal(redact(new Error('failed with Bearer abcdefghijklmnop')).message.includes('abcdefghijklmnop'), false);
  assert.equal(redactText('eyJabcdefgh.abcdefgh.abcdefgh').includes('eyJ'), false);
  const report = maskReport({ calls: [{ kind: 'raw', params: ['db-password'], result: { value: { clientSecret: 'x' } } }] });
  assert.equal(report.calls[0].params[0], 'db-password'); // runner replaces SQL params before they enter a report
  assert.equal(report.calls[0].result.value.clientSecret, '••••••');
});

test('saved cases are schema-tolerant, stable, atomically persisted, and redact inputs', () => {
  const root = tempRoot();
  const target = { kind: 'route', routePath: 'login', className: 'AuthController', method: 'login' };
  const form = { path: 'login', pathParams: {}, query: 'token=never-save', headers: 'Authorization: Bearer never-save\nX-Trace: ok', token: 'never-save', body: '{"password":"never-save","name":"Ada"}' };
  const saved = formToCase(target, form, 'login');
  assert.equal(saved.inputs.headers.includes('Authorization'), false);
  assert.equal(saved.inputs.body.includes('never-save'), false);
  upsertCase(root, 'AuthController.login', saved);
  const loaded = loadCasesDetailed(root, 'AuthController.login');
  assert.equal(loaded.errors.length, 0);
  assert.equal(loaded.cases.length, 1);
  assert.ok(loaded.cases[0].id);
  const persisted = fs.readFileSync(caseFilePath(root, 'AuthController.login'), 'utf8');
  assert.equal(persisted.includes('never-save'), false);
  fs.writeFileSync(caseFilePath(root, 'AuthController.login'), '{ not json');
  assert.equal(loadCasesDetailed(root, 'AuthController.login').errors.length, 1);
});

test('environment resolution has explicit precedence and classifies targets without exposing passwords', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, '.env'), 'DATABASE_URL=postgres://user:from-file@localhost:5432/app_test\nFROM_FILE=one\n');
  const resolved = resolveEnvironment(root, { FROM_OVERRIDE: 'three' }, { FROM_FILE: 'two', NODE_ENV: 'test' });
  assert.equal(resolved.env.FROM_FILE, 'two');
  assert.equal(resolved.env.FROM_OVERRIDE, 'three');
  assert.equal(resolved.database.safety, 'test');
  assert.equal(resolved.database.label, 'localhost:5432/app_test');
  assert.equal(inspectDatabaseTarget({ DATABASE_URL: 'postgres://u:password@db.example.com:5432/prod' }).safety, 'remote');
  assert.equal(inspectDatabaseTarget({ DATABASE_URL: 'not a url' }).reason.includes('password'), false);
});

test('TypeScript parser finds realistic service methods and static Nest routes without guessing dynamic routes', () => {
  const source = `
    @Injectable() export class UserService {
      async find<T extends string>(id: string, options: { active: boolean }): Promise<T> { return id as T; }
    }
    @Controller({ path: 'users' }) export class UserController {
      @Get(':id') async get(@Param('id') id: string): Promise<void> { return; }
      @Post(\`create\`) create(@Body() dto: CreateUserDto) { return dto; }
      @Delete(dynamicPath) remove() { return; }
    }`;
  const methods = findMethods(source);
  assert.deepEqual(methods.map((item) => item.method), ['find']);
  assert.equal(methods[0].params[1].type, '{ active: boolean }');
  const routes = findRoutes(source);
  assert.deepEqual(routes.map((item) => [item.httpMethod, item.routePath]), [['GET', 'users/:id'], ['POST', 'users/create']]);
  assert.equal(routes[1].bodyType, 'CreateUserDto');
});

test('diagnostics preserve application errors and classify common runner failures safely', () => {
  assert.equal(classifyDiagnostic(new Error('Cannot find module ts-node'), 'r1').category, 'missing-dependency');
  assert.equal(classifyDiagnostic(new Error('Run timed out after 10 ms')).category, 'timeout');
  assert.equal(classifyDiagnostic(new Error('Prisma connection error')).category, 'database');
  const app = classifyDiagnostic(new Error('password=never-save application failed'));
  assert.equal(app.category, 'application');
  assert.equal(app.cause.message.includes('never-save'), false);
});

test('Jest generation produces parseable TypeScript and replaces sensitive values', () => {
  const generated = generateJest({
    kind: 'method', className: 'AuthService', method: 'login', testName: 'logs in', specDir: '/tmp/spec', targetFile: '/tmp/auth.service.ts',
    paramNames: ['email', 'password'], args: ['a@example.test', 'never-save'],
    report: { output: { token: 'never-save', profile: { id: 1 } }, calls: [{ kind: 'raw', fn: '$queryRawUnsafe', sql: 'select 1', params: ['never-save'], result: { value: [] } }], meta: { deps: [] } },
  });
  assert.equal(generated.content.includes('never-save'), false);
  assert.match(generated.content, /<REDACTED>/);
  const compiled = ts.transpileModule(generated.content, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.equal((compiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length, 0);
});

test('daemon serializes per-project requests and can cancel queued work without contaminating later reports', async () => {
  const root = tempRoot();
  const runner = path.join(root, 'fake-runner.js');
  fs.writeFileSync(runner, `
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', line => { const req = JSON.parse(line); setTimeout(() => {
      process.stdout.write('@@NESTRUN@@' + JSON.stringify({ id: req.id, report: { runId: req.runId, calls: [{ marker: req.marker }], logs: [req.marker], meta: { deps: [] }, ms: 1 } }) + '\\n');
    }, req.delay || 0); });`);
  const daemon = new Daemon(root, [runner, '--serve'], process.env);
  const first = daemon.run({ marker: 'first', delay: 30 }, 500);
  const second = daemon.run({ marker: 'second', delay: 0 }, 500);
  const cancelled = daemon.run({ marker: 'never', delay: 0 }, 500);
  cancelled.cancel();
  const [a, b, c] = await Promise.all([first.promise, second.promise, cancelled.promise]);
  assert.equal(a.logs[0], 'first');
  assert.equal(b.logs[0], 'second');
  assert.match(c.error.message, /cancelled before it started/);
  daemon.dispose();
});

test('comparison wildcard remains precise for redacted expected values', () => {
  assert.equal(matches({ token: 'anything', id: 1 }, { token: ANY, id: 1 }), true);
  assert.equal(matches({ token: undefined }, { token: ANY }), false);
});
