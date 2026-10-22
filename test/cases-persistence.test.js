const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCasesDetailed, upsertCase, removeCase, caseFilePath, formToCase, caseToForm } = require('../out/cases.js');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-run-cases-'));
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

test('handles missing, empty, and malformed case files gracefully', () => {
  const root = tempRoot();
  const key = 'UserService.find';

  // 1. Missing file
  const missing = loadCasesDetailed(root, key);
  assert.equal(missing.cases.length, 0);
  assert.equal(missing.errors.length, 0);

  // 2. Empty file
  const file = caseFilePath(root, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '   \n');
  const empty = loadCasesDetailed(root, key);
  assert.equal(empty.cases.length, 0);
  assert.equal(empty.errors.length, 1);
  assert.match(empty.errors[0], /empty/);

  // 3. Corrupt non-JSON file
  fs.writeFileSync(file, '{"cases": [ invalid json }');
  const corrupt = loadCasesDetailed(root, key);
  assert.equal(corrupt.cases.length, 0);
  assert.equal(corrupt.errors.length, 1);
  assert.match(corrupt.errors[0], /Could not read saved cases/);

  // 4. Missing cases array
  fs.writeFileSync(file, '{"schemaVersion": 2}');
  const noArray = loadCasesDetailed(root, key);
  assert.equal(noArray.cases.length, 0);
  assert.equal(noArray.errors.length, 1);
});

test('supports schema migration from v1 to v2 with stable unique IDs', () => {
  const root = tempRoot();
  const key = 'UserService.find';
  const file = caseFilePath(root, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Legacy schema without IDs
  const legacyData = {
    target: key,
    cases: [
      { name: 'Admin user', inputs: { id: '1' } },
      { name: 'Guest user', inputs: { id: '2' } },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(legacyData));

  const loaded = loadCasesDetailed(root, key);
  assert.equal(loaded.errors.length, 0);
  assert.equal(loaded.cases.length, 2);
  assert.ok(loaded.cases[0].id.includes('legacy'));
  assert.ok(loaded.cases[1].id.includes('legacy'));
  assert.notEqual(loaded.cases[0].id, loaded.cases[1].id);

  // Upserting assigns standard UUID and writes schemaVersion 2
  upsertCase(root, key, { name: 'New user', inputs: { id: '3' } });
  const reloaded = loadCasesDetailed(root, key);
  assert.equal(reloaded.cases.length, 3);
  const rawSaved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rawSaved.schemaVersion, 2);
});

test('handles duplicate case names and duplicate IDs safely', () => {
  const root = tempRoot();
  const key = 'ProductService.create';
  const file = caseFilePath(root, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const dupData = {
    schemaVersion: 2,
    cases: [
      { id: 'c1', name: 'Duplicate Name', inputs: { sku: 'A' } },
      { id: 'c2', name: 'Duplicate Name', inputs: { sku: 'B' } },
      { id: 'c1', name: 'Another Case', inputs: { sku: 'C' } },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(dupData));

  const loaded = loadCasesDetailed(root, key);
  assert.equal(loaded.cases.length, 1);
  assert.equal(loaded.errors.length, 2);
});

test('upsert and remove case maintain file state cleanly', () => {
  const root = tempRoot();
  const key = 'OrderService.checkout';
  const file = caseFilePath(root, key);

  upsertCase(root, key, { name: 'Cart with 1 item', inputs: { items: 1 } });
  upsertCase(root, key, { name: 'Cart with 2 items', inputs: { items: 2 } });
  assert.equal(loadCasesDetailed(root, key).cases.length, 2);

  removeCase(root, key, 'Cart with 1 item');
  const remaining = loadCasesDetailed(root, key).cases;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].name, 'Cart with 2 items');

  removeCase(root, key, 'Cart with 2 items');
  assert.equal(fs.existsSync(file), false);
});
