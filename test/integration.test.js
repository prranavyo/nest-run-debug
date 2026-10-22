const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { generateJest } = require('../out/jest.js');
const { maskReport, redact } = require('../out/redact.js');
const { formToCase, upsertCase, loadCasesDetailed } = require('../out/cases.js');
const { classifyDiagnostic } = require('../out/diagnostics.js');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-run-fixture-'));
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

test('end-to-end integration: service run report, redaction, saved case, and Jest generation', () => {
  const root = tempRoot();
  const serviceFile = path.join(root, 'src', 'payment.service.ts');
  const specDir = path.dirname(serviceFile);
  fs.mkdirSync(specDir, { recursive: true });

  // 1. Simulate an observed execution report from payment service
  const runReport = {
    runId: 'run-payment-101',
    ms: 45,
    bootMs: 0,
    calls: [
      {
        kind: 'model',
        model: 'user',
        action: 'findUnique',
        args: { where: { id: 'u1' } },
        ms: 12,
        result: {
          value: { id: 'u1', email: 'ada@example.test', password: 'hash-$2b$10$abcdefghijklmnopqrstuv' },
        },
      },
      {
        kind: 'raw',
        fn: '$executeRawUnsafe',
        sql: 'UPDATE accounts SET balance = balance - $1 WHERE user_id = $2',
        params: [100, 'u1'],
        ms: 8,
        result: { value: 1 },
      },
    ],
    logs: [
      'Processing payment for user ada@example.test with token=my-secret-jwt-value',
      'Transaction authorization=secret-auth-key approved',
    ],
    output: {
      success: true,
      transactionId: 'tx-999',
      clientSecret: 'live_secret_key_123',
    },
    meta: {
      prisma: { className: 'PrismaService', file: path.join(root, 'src', 'prisma.service.ts') },
      deps: [],
    },
  };

  // 2. Verify maskReport sanitizes all sensitive logs and fields
  const masked = maskReport(runReport);
  assert.equal(masked.output.clientSecret, '••••••');
  assert.equal(masked.output.transactionId, 'tx-999');
  assert.equal(masked.calls[0].result.value.password, '••••••');
  assert.equal(masked.logs[0].includes('my-secret-jwt-value'), false);
  assert.equal(masked.logs[1].includes('secret-auth-key'), false);

  // 3. Save case from this execution and verify persistence is clean
  const target = { kind: 'method', className: 'PaymentService', method: 'processPayment', params: [{ name: 'amount', type: 'number' }] };
  const form = { values: ['100'], kinds: ['number'] };
  const savedCase = formToCase(target, form, 'Normal Payment Case', { output: masked.output });

  upsertCase(root, 'PaymentService.processPayment', savedCase);
  const loaded = loadCasesDetailed(root, 'PaymentService.processPayment');
  assert.equal(loaded.cases.length, 1);
  assert.equal(loaded.cases[0].name, 'Normal Payment Case');
  assert.equal(loaded.cases[0].expected.output.clientSecret, '••••••');

  // 4. Generate Jest test file from the unmasked report
  const generated = generateJest({
    kind: 'method',
    className: 'PaymentService',
    method: 'processPayment',
    testName: 'processes user payment and updates balance',
    specDir,
    targetFile: serviceFile,
    paramNames: ['amount'],
    args: [100],
    report: runReport,
  });

  // Verify no secrets in generated test code
  assert.equal(generated.content.includes('live_secret_key_123'), false);
  assert.equal(generated.content.includes('hash-$2b$10$abcdefghijklmnopqrstuv'), false);
  assert.match(generated.content, /PaymentService/);
  assert.match(generated.content, /describe\('PaymentService\.processPayment'/);

  // 5. Transpile generated Jest test to ensure valid TypeScript
  const transpiled = ts.transpileModule(generated.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0);

  // 6. Test diagnostic classification on simulated failure
  const diag = classifyDiagnostic(new Error('Connection to database timed out after 30000 ms.'));
  assert.equal(diag.category, 'timeout');
});
