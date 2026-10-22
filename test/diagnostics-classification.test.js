const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classifyDiagnostic, attachDiagnostic } = require('../out/diagnostics.js');

test('classifyDiagnostic categorizes runner and system errors accurately', () => {
  // 1. missing-dependency
  const depErr = classifyDiagnostic(new Error('Cannot find module ts-node in D:\\app'));
  assert.equal(depErr.category, 'missing-dependency');

  // 2. timeout
  const timeErr = classifyDiagnostic(new Error('Run timed out after 30000 ms.'));
  assert.equal(timeErr.category, 'timeout');

  // 3. cancelled
  const cancelErr = classifyDiagnostic(new Error('Run cancelled by the user.'));
  assert.equal(cancelErr.category, 'cancelled');

  // 4. compilation
  const compErr = classifyDiagnostic(new Error('TS2304: Cannot find name "Foo".'));
  assert.equal(compErr.category, 'compilation');

  // 5. bootstrap
  const bootErr = classifyDiagnostic(new Error('NestFactory failed to createApplicationContext'));
  assert.equal(bootErr.category, 'bootstrap');

  // 6. resolution
  const resErr = classifyDiagnostic(new Error('UserService is not registered in any module of your app'));
  assert.equal(resErr.category, 'resolution');

  // 7. invalid-input
  const inputErr = classifyDiagnostic(new Error('The body is not valid JSON'));
  assert.equal(inputErr.category, 'invalid-input');

  // 8. http
  const httpErr = classifyDiagnostic(new Error('fetch failed: ECONNREFUSED 127.0.0.1:3000'));
  assert.equal(httpErr.category, 'http');

  // 9. database
  const dbErr = classifyDiagnostic(new Error('PrismaClientKnownRequestError: Unique constraint failed'));
  assert.equal(dbErr.category, 'database');

  // 10. configuration
  const cfgErr = classifyDiagnostic(new Error('nest_run_app_module is not configured properly'));
  assert.equal(cfgErr.category, 'configuration');
});

test('classifyDiagnostic does not misclassify genuine application exceptions', () => {
  // Application error mentioning "request" should NOT be classified as http failure
  const app1 = classifyDiagnostic(new Error('Invalid user request: account is currently locked'));
  assert.equal(app1.category, 'application');

  // Application error mentioning "database" in domain logic should NOT be classified as Prisma driver error
  const app2 = classifyDiagnostic(new Error('User domain logic: cannot migrate user to another database without consent'));
  assert.equal(app2.category, 'application');

  // Application error mentioning "provider" in business domain (e.g., payment provider)
  const app3 = classifyDiagnostic(new Error('Payment provider declined credit card transaction'));
  assert.equal(app3.category, 'application');
});

test('attachDiagnostic safely redacts secrets and decorates report', () => {
  const rawReport = {
    runId: 'run-123',
    error: { message: 'Failed with token=secret-token-abc and password=confidential' },
  };
  const decorated = attachDiagnostic(rawReport, 'run-123');
  assert.ok(decorated.diagnostic);
  assert.equal(decorated.diagnostic.category, 'application');
  assert.equal(decorated.diagnostic.cause.message.includes('secret-token-abc'), false);
  assert.equal(decorated.diagnostic.cause.message.includes('confidential'), false);
  assert.equal(decorated.diagnostic.runId, 'run-123');
});
