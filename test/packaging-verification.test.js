const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

test('package.json specifies runtime dependencies and correct entry point', () => {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.main, './out/extension.js', 'main must point to ./out/extension.js');
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', pkg.main)), true, 'compiled main file must exist');

  assert.ok(pkg.dependencies, 'package.json must declare dependencies');
  assert.ok(pkg.dependencies.typescript, 'typescript must be in dependencies (not only devDependencies)');

  const cmdIds = (pkg.contributes?.commands || []).map((c) => c.command);
  assert.ok(cmdIds.includes('nestRun.run'), 'contributes.commands must include nestRun.run');
  assert.ok(cmdIds.includes('nestRun.debug'), 'contributes.commands must include nestRun.debug');

  assert.ok(pkg.activationEvents?.includes('onLanguage:typescript'), 'activationEvents must include onLanguage:typescript');
});

test('runtime dependency audit: all external modules loaded at runtime are declared in dependencies', () => {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const prodDependencies = new Set(Object.keys(pkg.dependencies || {}));
  const builtins = new Set(Module.builtinModules);

  // Install mock into require.cache
  require.cache['vscode-mock'] = {
    id: 'vscode-mock',
    filename: 'vscode-mock',
    loaded: true,
    exports: {
      Position: class {},
      Range: class {},
      CodeLens: class {},
      Uri: { file: (f) => ({ fsPath: f }) },
      commands: { registerCommand: () => ({ dispose: () => {} }) },
      languages: { registerCodeLensProvider: () => ({ dispose: () => {} }) },
      workspace: {
        onDidSaveTextDocument: () => ({ dispose: () => {} }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
      },
      window: {},
    },
  };

  // Hook module resolution to track every external module requested by out/
  const requiredModules = new Set();
  const origResolve = Module._resolveFilename;

  Module._resolveFilename = function (request, parent, isMain) {
    if (parent && parent.filename && parent.filename.includes(path.join('nest-run-debug', 'out'))) {
      if (!request.startsWith('.') && request !== 'vscode' && !builtins.has(request) && !builtins.has(request.replace(/^node:/, ''))) {
        requiredModules.add(request);
      }
    }
    if (request === 'vscode') return 'vscode-mock';
    return origResolve.apply(this, arguments);
  };

  try {
    // Clear out cache and require all compiled modules
    const outDir = path.resolve(__dirname, '..', 'out');
    const jsFiles = fs.readdirSync(outDir).filter((f) => f.endsWith('.js'));
    for (const jsFile of jsFiles) {
      const fullPath = path.join(outDir, jsFile);
      delete require.cache[fullPath];
      require(fullPath);
    }
  } finally {
    Module._resolveFilename = origResolve;
  }

  // Verify all intercepted runtime modules are declared in dependencies
  assert.ok(requiredModules.size > 0, 'Must have recorded runtime modules');
  assert.ok(requiredModules.has('typescript'), 'typescript must be intercepted as required by out/');

  for (const mod of requiredModules) {
    assert.ok(
      prodDependencies.has(mod),
      `Module "${mod}" is loaded by out/ but not declared in package.json dependencies!`,
    );
  }
});

test('.vscodeignore preserves out/, runner/, and node_modules while excluding dev/test/git files', () => {
  const ignorePath = path.resolve(__dirname, '..', '.vscodeignore');
  const lines = fs.readFileSync(ignorePath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  // Ensure runtime essentials are NOT ignored
  for (const line of lines) {
    assert.notEqual(line, 'node_modules/**', '.vscodeignore must not ignore node_modules/**');
    assert.notEqual(line, 'node_modules', '.vscodeignore must not ignore node_modules');
    assert.notEqual(line, 'out/**', '.vscodeignore must not ignore out/**');
    assert.notEqual(line, 'runner/**', '.vscodeignore must not ignore runner/**');
  }

  // Ensure dev/test files ARE ignored
  assert.ok(lines.includes('src/**'), '.vscodeignore should exclude src/**');
  assert.ok(lines.includes('test/**'), '.vscodeignore should exclude test/**');
});
