const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveEnvironment, inspectDatabaseTarget } = require('../out/environment.js');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-run-env-'));
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

test('environment resolution respects file precedence and does not leak secrets', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, '.env'), 'VAR_BASE=from-env\nVAR_SHARED=from-env\nVAR_SECRET=supersecret123\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'VAR_SHARED=from-local\n');

  const resolved = resolveEnvironment(root, { VAR_OVERRIDE: 'from-override' }, { VAR_SHARED: 'from-process' });
  assert.equal(resolved.env.VAR_BASE, 'from-env');
  assert.equal(resolved.env.VAR_SHARED, 'from-process'); // process.env overrides .env/.env.local
  assert.equal(resolved.env.VAR_OVERRIDE, 'from-override'); // extension overrides everything
  assert.deepEqual(resolved.loadedFiles, ['.env', '.env.local']);
});

test('environment resolution loads .env.test when in test environment', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, '.env'), 'DATABASE_URL=postgres://u:p@localhost:5432/app\n');
  fs.writeFileSync(path.join(root, '.env.test'), 'DATABASE_URL=postgres://u:p@localhost:5432/app_test\n');

  const resolved = resolveEnvironment(root, {}, { NODE_ENV: 'test' });
  assert.equal(resolved.database.safety, 'test');
  assert.equal(resolved.database.label, 'localhost:5432/app_test');
  assert.ok(resolved.loadedFiles.includes('.env.test'));
});

test('inspectDatabaseTarget classifies local, test, remote, and SQLite targets safely', () => {
  // 1. Local Postgres
  const localPg = inspectDatabaseTarget({ DATABASE_URL: 'postgres://admin:secret123@localhost:5432/dev_db' });
  assert.equal(localPg.safety, 'local');
  assert.equal(localPg.label, 'localhost:5432/dev_db');
  assert.equal(localPg.label.includes('secret123'), false);

  // 2. Explicit test database
  const testDb = inspectDatabaseTarget({ DATABASE_URL: 'postgres://admin:secret123@db.example.com:5432/my_app_test' });
  assert.equal(testDb.safety, 'test');
  assert.equal(testDb.label, 'db.example.com:5432/my_app_test');
  assert.equal(testDb.label.includes('secret123'), false);

  // 3. Remote database
  const remoteDb = inspectDatabaseTarget({ DATABASE_URL: 'postgres://admin:secret123@aws-rds.cluster.amazonaws.com:5432/prod_db' });
  assert.equal(remoteDb.safety, 'remote');
  assert.equal(remoteDb.label, 'aws-rds.cluster.amazonaws.com:5432/prod_db');
  assert.equal(remoteDb.label.includes('secret123'), false);

  // 4. SQLite local file database (without throwing Invalid URL)
  const sqliteDev = inspectDatabaseTarget({ DATABASE_URL: 'file:./prisma/dev.db' });
  assert.equal(sqliteDev.safety, 'local');
  assert.equal(sqliteDev.label, 'sqlite:./prisma/dev.db');

  // 5. SQLite test database
  const sqliteTest = inspectDatabaseTarget({ DATABASE_URL: 'file:./test.sqlite' });
  assert.equal(sqliteTest.safety, 'test');
  assert.equal(sqliteTest.label, 'sqlite:./test.sqlite');

  // 6. Missing database
  const missing = inspectDatabaseTarget({});
  assert.equal(missing.safety, 'unknown');
  assert.match(missing.reason, /No supported database URL/);

  // 7. Malformed database URL with embedded password
  const malformed = inspectDatabaseTarget({ DATABASE_URL: 'not-a-valid-url?password=super-secret-password' });
  assert.equal(malformed.safety, 'unknown');
  assert.equal(malformed.reason.includes('super-secret-password'), false);
});
