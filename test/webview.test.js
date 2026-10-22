const assert = require('node:assert/strict');
const { test } = require('node:test');
const { esc, pretty, statusPage, runningPage, formPage, resultPage, runAllPage } = require('../out/views.js');

test('esc sanitizes HTML special characters including quotes and brackets', () => {
  const unsafe = `<script>alert("xss & 'hack'")</script>`;
  const safe = esc(unsafe);
  assert.equal(safe.includes('<script>'), false);
  assert.equal(safe.includes('&lt;script&gt;'), true);
  assert.equal(safe.includes('&quot;'), true);
  assert.equal(safe.includes('&#39;'), true);
  assert.equal(safe.includes('&amp;'), true);
});

test('views render strict Content-Security-Policy with nonces', () => {
  const base = { className: 'TestService', method: 'run', root: 'D:/app' };
  const html = statusPage(base, 'Operation completed', false, true);

  assert.match(html, /<meta http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  assert.match(html, /TestService\.run/);
});

test('resultPage includes toggle for inspection and safely renders report without leaking raw credentials', () => {
  const base = { className: 'AuthService', method: 'login', root: 'D:/app' };
  const target = { kind: 'method', className: 'AuthService', method: 'login', params: [], uri: { fsPath: 'auth.service.ts' }, bodyLine: 1 };
  const report = {
    ms: 10,
    output: { token: 'jwt-secret-value', publicId: 123 },
    calls: [],
    logs: ['Logged in ada with token=jwt-secret-value'],
  };

  const html = resultPage(base, target, {}, report);
  assert.match(html, /<button id="tg"/);
  // Default masked view should mask secrets
  assert.match(html, /id="masked"/);
  assert.match(html, /id="plain"/);
  assert.equal(html.includes('&lt;script&gt;'), false);
});


test('interactive views use CSP-compatible delegated click handlers instead of inline onclick attributes', () => {
  const base = { className: 'UserService', method: 'findUser', root: 'D:/app' };
  const methodTarget = {
    kind: 'method', className: 'UserService', method: 'findUser',
    params: [{ name: 'id', type: 'number' }], uri: { fsPath: 'D:/app/src/user.service.ts' }, bodyLine: 2,
  };
  const form = formPage(base, methodTarget, { values: ['1'], kinds: ['number'] }, ['saved case'], false);
  const result = resultPage(base, methodTarget, { id: 1 }, { output: { id: 1 }, calls: [], logs: [], ms: 1 });
  const running = runningPage(base, 'Running');
  const cases = runAllPage(base, [{ name: 'case "one"', status: 'pass', note: 'ok', ms: 1 }]);
  const pages = [form, result, running, cases, statusPage(base, 'Done', false, true)];

  for (const html of pages) {
    assert.doesNotMatch(html, /\sonclick\s*=/i, 'inline click handler violates script-src nonce CSP');
    assert.match(html, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
    assert.match(html, /document\.addEventListener\('click'/);
  }
  assert.match(form, /data-action="submit-run"/);
  assert.match(form, /data-action="submit-debug"/);
  assert.match(result, /data-action="toggle-secrets"/);
  assert.match(running, /data-action="cancel-run"/);
  assert.match(cases, /data-action="case-open"/);
});
