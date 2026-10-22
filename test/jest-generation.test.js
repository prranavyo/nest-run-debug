const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
const { generateJest } = require('../out/jest.js');

function verifyValidTypeScript(code) {
  const transpiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `Generated TypeScript had compilation errors:\n${errors.map((e) => e.messageText).join('\n')}\n\nGenerated Code:\n${code}`);
}

test('generateJest creates valid Jest test for a synchronous or async service method with mocked database', () => {
  const result = generateJest({
    kind: 'method',
    className: 'ProductService',
    method: 'findById',
    testName: 'returns product by id',
    specDir: 'D:/app/src/product',
    targetFile: 'D:/app/src/product/product.service.ts',
    paramNames: ['id', 'userToken'],
    args: ['prod-1', 'secret-user-token'],
    report: {
      output: { id: 'prod-1', name: 'Keyboard', price: 99.99 },
      calls: [
        {
          kind: 'model',
          model: 'product',
          action: 'findUnique',
          args: { where: { id: 'prod-1' } },
          result: { value: { id: 'prod-1', name: 'Keyboard', price: 99.99 } },
        },
      ],
      meta: {
        prisma: { className: 'PrismaService', file: 'D:/app/src/prisma/prisma.service.ts' },
        deps: [],
      },
    },
  });

  assert.equal(result.content.includes('secret-user-token'), false);
  assert.match(result.content, /describe\('ProductService\.findById'/);
  assert.match(result.content, /ProductService/);
  assert.match(result.content, /PrismaService/);
  verifyValidTypeScript(result.content);
});

test('generateJest creates valid Jest test for service method throwing an error', () => {
  const result = generateJest({
    kind: 'method',
    className: 'AuthService',
    method: 'validateUser',
    testName: 'throws unauthorized when password is wrong',
    specDir: 'D:/app/src/auth',
    targetFile: 'D:/app/src/auth/auth.service.ts',
    paramNames: ['username', 'password'],
    args: ['ada', 'plain-secret-pass'],
    report: {
      error: { message: 'Invalid credentials with password=plain-secret-pass' },
      calls: [],
      meta: { deps: [] },
    },
  });

  assert.equal(result.content.includes('plain-secret-pass'), false);
  assert.match(result.content, /rejects\.toThrow/);
  verifyValidTypeScript(result.content);
});

test('generateJest creates valid Jest e2e test for controller route using supertest', () => {
  const result = generateJest({
    kind: 'route',
    className: 'UserController',
    method: 'createUser',
    testName: 'creates a new user',
    specDir: 'D:/app/src/user',
    targetFile: 'D:/app/src/user/user.controller.ts',
    appModuleFile: 'D:/app/src/app.module.ts',
    http: {
      method: 'POST',
      headers: { 'Authorization': 'Bearer super-secret-token', 'X-Custom-Header': 'test-val' },
      body: { name: 'Ada', password: 'my-plaintext-password' },
    },
    report: {
      http: {
        method: 'POST',
        url: '/users?token=secret-token-in-url',
        status: 201,
        body: { id: 'u1', name: 'Ada', token: 'jwt-token-xyz' },
      },
      sentHeaders: { 'Authorization': 'Bearer super-secret-token', 'X-Custom-Header': 'test-val' },
      sentBody: { name: 'Ada', password: 'my-plaintext-password' },
      calls: [
        {
          kind: 'raw',
          fn: '$queryRawUnsafe',
          sql: 'INSERT INTO users (name) VALUES ($1)',
          params: ['my-plaintext-password'],
          result: { value: [] },
        },
      ],
      meta: {
        globalPrefix: 'api',
        prisma: { className: 'PrismaService', file: 'D:/app/src/prisma/prisma.service.ts' },
      },
    },
  });

  assert.equal(result.content.includes('super-secret-token'), false);
  assert.equal(result.content.includes('my-plaintext-password'), false);
  assert.equal(result.content.includes('secret-token-in-url'), false);
  assert.match(result.content, /supertest/);
  assert.match(result.content, /app\.setGlobalPrefix\('api'\)/);
  verifyValidTypeScript(result.content);
});
