const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectDatabaseTarget, resolveEnvironment } = require('../out/environment.js');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-run-space test-'));
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

test('handles file paths with spaces and Windows drive letters', () => {
  const root = tempRoot(); // Contains a space in path
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'DATABASE_URL=file:./nested folder/dev.db\nPORT=3000\n');

  const resolved = resolveEnvironment(root);
  assert.equal(resolved.env.PORT, '3000');
  assert.equal(resolved.database.safety, 'local');
  assert.match(resolved.database.label, /sqlite:\.\/nested folder\/dev\.db/);
});

test('inspectDatabaseTarget handles spaces in SQLite database paths', () => {
  const target = inspectDatabaseTarget({ DATABASE_URL: 'file:C:/Users/Ada Lovelace/Project Name/dev.db' });
  assert.equal(target.safety, 'local');
  assert.equal(target.label, 'sqlite:C:/Users/Ada Lovelace/Project Name/dev.db');
});
