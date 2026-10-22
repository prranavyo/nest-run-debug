const assert = require('node:assert/strict');
const { test } = require('node:test');
const { redact, redactText, sanitizeError, maskReport, isSecretKey, MASK, REDACTED } = require('../out/redact.js');

test('isSecretKey identifies sensitive property names case-insensitively', () => {
  const secrets = [
    'password', 'Password', 'PASSWORD', 'passphrase', 'pwd',
    'token', 'Token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token',
    'idToken', 'id_token', 'authorization', 'Authorization',
    'apiKey', 'api_key', 'x-api-key', 'clientSecret', 'client_secret',
    'secret', 'Secret', 'privateKey', 'private_key',
    'database_url', 'dbPassword', 'db_pass', 'db_user', 'connectionString',
    'cookie', 'Cookie', 'session', 'sessionId'
  ];
  for (const key of secrets) {
    assert.equal(isSecretKey(key), true, `Expected ${key} to be recognized as secret`);
  }

  const nonSecrets = ['username', 'email', 'name', 'title', 'id', 'status', 'description', 'createdAt'];
  for (const key of nonSecrets) {
    assert.equal(isSecretKey(key), false, `Expected ${key} to not be recognized as secret`);
  }
});

test('redactText masks key-value credentials and URLs with sensitive parameters', () => {
  // Query parameters in full URL
  const url = 'https://api.example.com/v1/auth?token=super-secret-jwt&api_key=12345&user=ada';
  const safeUrl = redactText(url);
  assert.equal(safeUrl.includes('super-secret-jwt'), false);
  assert.equal(safeUrl.includes('12345'), false);
  assert.equal(safeUrl.includes('ada'), true);

  // Standalone query strings
  const qs = 'token=my-secret-token&page=2&apiKey=secret-key-xyz';
  const safeQs = redactText(qs);
  assert.equal(safeQs.includes('my-secret-token'), false);
  assert.equal(safeQs.includes('secret-key-xyz'), false);
  assert.equal(safeQs.includes('page=2'), true);

  // Free text key-value patterns
  const log1 = 'User login failed with password=plain-text-pass and status=401';
  assert.equal(redactText(log1).includes('plain-text-pass'), false);
  assert.equal(redactText(log1).includes('status=401'), true);

  // JSON in text
  const jsonText = 'Error body: {"password": "confidential123", "username": "ada"}';
  const safeJson = redactText(jsonText);
  assert.equal(safeJson.includes('confidential123'), false);
  assert.equal(safeJson.includes('ada'), true);
});

test('redactText masks Bearer tokens, JWTs, connection credentials, bcrypt and private keys', () => {
  const bearer = 'Authorization: Bearer mySecretTokenValue123';
  assert.equal(redactText(bearer).includes('mySecretTokenValue123'), false);
  assert.match(redactText(bearer), /Bearer/);

  const jwt = 'Found token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeak';
  assert.equal(redactText(jwt).includes('eyJ'), false);

  const conn = 'Connected to postgres://app_user:db_password_123@db.internal:5432/main';
  const safeConn = redactText(conn);
  assert.equal(safeConn.includes('db_password_123'), false);
  assert.equal(safeConn.includes('db.internal'), true);

  const pkey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactText(pkey).includes('MIIEowIBAAKCAQEA0'), false);
});

test('redact handles nested structures, Sets, Maps, and non-JSON values', () => {
  const map = new Map();
  map.set('password', 'map-secret');
  map.set('normal', 'public-data');

  const set = new Set([{ token: 'set-secret' }, 'plain']);

  const input = {
    auth: {
      tokens: ['token-in-array', { refreshToken: 'refresh-value' }],
      credentials: {
        apiKey: 'key-123',
        clientSecret: 'secret-456'
      }
    },
    count: 42n,
    symbol: Symbol('debug'),
    date: new Date('2026-01-01T00:00:00.000Z'),
    regex: /test/i,
    map,
    set,
    fn: function doSomething() {}
  };

  const safe = redact(input);
  assert.equal(safe.auth.credentials.apiKey, MASK);
  assert.equal(safe.auth.credentials.clientSecret, MASK);
  assert.equal(safe.auth.tokens[1].refreshToken, MASK);
  assert.equal(safe.count, '42n');
  assert.equal(safe.date, '2026-01-01T00:00:00.000Z');
  assert.equal(safe.regex, '/test/i');
  assert.equal(safe.map.password, MASK);
  assert.equal(safe.map.normal, 'public-data');
  assert.equal(safe.set[0].token, MASK);
  assert.equal(safe.fn, '[Function doSomething]');
});

test('sanitizeError masks secrets in custom error properties and stack', () => {
  const err = new Error('Database connection failed with password=super-secret');
  err.apiKey = 'err-api-key';
  err.stack = 'Error: at authenticate (db.ts:10)\n    token=leak-in-stack';

  const sanitized = sanitizeError(err);
  assert.equal(sanitized.message.includes('super-secret'), false);
  assert.equal(sanitized.apiKey, MASK);
  assert.equal(sanitized.stack.includes('leak-in-stack'), false);
});
