const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');

test('debug launch lets VS Code resolve Node instead of launching the extension-host executable', () => {
  assert.doesNotMatch(source, /runtimeExecutable:\s*process\.execPath/);
  assert.match(source, /type:\s*'node'/);
  assert.match(source, /runtimeArgs:\s*setup\.preload/);
  assert.match(source, /sourceMaps:\s*true/);
});

test('debug-launch failures have an explicit error path and clean up breakpoints', () => {
  assert.match(source, /Could not start the Node\.js debugger:/);
  assert.match(source, /vscode\.debug\.removeBreakpoints\(\[bp\]\)/);
});
