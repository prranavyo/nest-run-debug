const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Create a robust mock for the vscode API to verify extension activation and command registration
const registeredCommands = new Map();
let registeredCodeLensProvider = null;
let registeredCodeLensSelector = null;
const subscriptions = [];

class MockPosition {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class MockRange {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class MockCodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
}

class MockUri {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }
  static file(f) {
    return new MockUri(f);
  }
}

class MockSourceBreakpoint {
  constructor(location) {
    this.location = location;
  }
}

class MockLocation {
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    this.rangeOrPosition = rangeOrPosition;
  }
}

const mockVscode = {
  Position: MockPosition,
  Range: MockRange,
  CodeLens: MockCodeLens,
  Uri: MockUri,
  SourceBreakpoint: MockSourceBreakpoint,
  Location: MockLocation,
  ViewColumn: { One: 1, Beside: 2 },
  commands: {
    registerCommand(id, handler) {
      registeredCommands.set(id, handler);
      return { dispose: () => registeredCommands.delete(id) };
    },
    executeCommand: async () => {},
  },
  languages: {
    registerCodeLensProvider(selector, provider) {
      registeredCodeLensSelector = selector;
      registeredCodeLensProvider = provider;
      return { dispose: () => { registeredCodeLensProvider = null; } };
    },
  },
  window: {
    activeTextEditor: undefined,
    showInformationMessage: () => Promise.resolve(),
    showWarningMessage: () => Promise.resolve(),
    showErrorMessage: () => Promise.resolve(),
    createWebviewPanel: () => ({
      webview: { html: '', onDidReceiveMessage: () => ({ dispose: () => {} }) },
      dispose: () => {},
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => fallback,
    }),
    getWorkspaceFolder: () => undefined,
    onDidSaveTextDocument: () => ({ dispose: () => {} }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
  debug: {
    addBreakpoints: () => {},
    removeBreakpoints: () => {},
    startDebugging: async () => true,
    stopDebugging: async () => {},
    onDidTerminateDebugSession: () => ({ dispose: () => {} }),
  },
};

// Install mock into require cache before loading extension
const Module = require('module');
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain) {
  if (request === 'vscode') return 'vscode-mock';
  return origResolveFilename.apply(this, arguments);
};
require.cache['vscode-mock'] = {
  id: 'vscode-mock',
  filename: 'vscode-mock',
  loaded: true,
  exports: mockVscode,
};

const extension = require('../out/extension.js');

test('extension entry point loads and exports activate and deactivate', () => {
  assert.equal(typeof extension.activate, 'function');
  assert.equal(typeof extension.deactivate, 'function');
});

test('extension activate registers nestRun.run and nestRun.debug commands', () => {
  registeredCommands.clear();
  subscriptions.length = 0;
  const mockContext = {
    subscriptions,
    extensionPath: path.resolve(__dirname, '..'),
    extensionUri: MockUri.file(path.resolve(__dirname, '..')),
    workspaceState: { get: () => undefined, update: async () => {} },
    secrets: { get: async () => undefined, store: async () => {} },
  };

  extension.activate(mockContext);

  assert.equal(registeredCommands.has('nestRun.run'), true, 'nestRun.run command must be registered');
  assert.equal(registeredCommands.has('nestRun.debug'), true, 'nestRun.debug command must be registered');
  assert.notEqual(registeredCodeLensProvider, null, 'CodeLens provider must be registered');
  assert.deepEqual(registeredCodeLensSelector, { language: 'typescript' });
});

test('CodeLens provider returns run and debug commands for realistic NestJS service', () => {
  assert.notEqual(registeredCodeLensProvider, null);

  const sampleServiceCode = `
import { Injectable } from '@nestjs/common';

@Injectable()
export class OrderService {
  async getOrder(orderId: string) {
    return { orderId, status: 'active' };
  }

  cancelOrder(orderId: string, reason?: string) {
    return { cancelled: true };
  }
}
`;

  const lines = sampleServiceCode.split('\n');
  const mockDoc = {
    fileName: 'order.service.ts',
    languageId: 'typescript',
    lineCount: lines.length,
    getText: () => sampleServiceCode,
    positionAt(offset) {
      const textBefore = sampleServiceCode.slice(0, offset);
      const line = textBefore.split('\n').length - 1;
      const lastNewline = textBefore.lastIndexOf('\n');
      const character = lastNewline === -1 ? offset : offset - lastNewline - 1;
      return new MockPosition(line, character);
    },
    lineAt(lineIdx) {
      return { text: lines[lineIdx] ?? '' };
    },
    uri: MockUri.file('/path/to/order.service.ts'),
  };

  const lenses = registeredCodeLensProvider.provideCodeLenses(mockDoc);
  assert.equal(lenses.length, 4, 'Should have 2 lenses (Run + Debug) for each of the 2 methods');

  const runLenses = lenses.filter((l) => l.command.command === 'nestRun.run');
  const debugLenses = lenses.filter((l) => l.command.command === 'nestRun.debug');

  assert.equal(runLenses.length, 2);
  assert.equal(debugLenses.length, 2);

  // Check first method
  assert.equal(runLenses[0].command.title, '▶ Run');
  assert.equal(runLenses[0].command.arguments[0].method, 'getOrder');
  assert.equal(runLenses[0].command.arguments[0].className, 'OrderService');
  assert.equal(runLenses[0].command.arguments[0].kind, 'method');

  assert.equal(debugLenses[0].command.title, '🐞 Debug');
  assert.equal(debugLenses[0].command.arguments[0].method, 'getOrder');
  assert.equal(debugLenses[0].command.arguments[0].className, 'OrderService');
  assert.equal(debugLenses[0].command.arguments[0].kind, 'method');
});

test('CodeLens provider returns Send Request and Debug commands for NestJS controller', () => {
  assert.notEqual(registeredCodeLensProvider, null);

  const sampleControllerCode = `
import { Controller, Get, Post, Param, Body } from '@nestjs/common';

@Controller('orders')
export class OrderController {
  @Get(':id')
  async getOrder(@Param('id') id: string) {
    return { id };
  }

  @Post()
  async createOrder(@Body() body: any) {
    return body;
  }
}
`;

  const lines = sampleControllerCode.split('\n');
  const mockDoc = {
    fileName: 'order.controller.ts',
    languageId: 'typescript',
    lineCount: lines.length,
    getText: () => sampleControllerCode,
    positionAt(offset) {
      const textBefore = sampleControllerCode.slice(0, offset);
      const line = textBefore.split('\n').length - 1;
      const lastNewline = textBefore.lastIndexOf('\n');
      const character = lastNewline === -1 ? offset : offset - lastNewline - 1;
      return new MockPosition(line, character);
    },
    lineAt(lineIdx) {
      return { text: lines[lineIdx] ?? '' };
    },
    uri: MockUri.file('/path/to/order.controller.ts'),
  };

  const lenses = registeredCodeLensProvider.provideCodeLenses(mockDoc);
  assert.equal(lenses.length, 4, 'Should have 2 lenses (Send request + Debug) for each route');

  const runLenses = lenses.filter((l) => l.command.command === 'nestRun.run');
  const debugLenses = lenses.filter((l) => l.command.command === 'nestRun.debug');

  assert.equal(runLenses[0].command.title, '▶ Send request');
  assert.equal(runLenses[0].command.arguments[0].routePath, 'orders/:id');
  assert.equal(runLenses[0].command.arguments[0].kind, 'route');

  assert.equal(debugLenses[0].command.title, '🐞 Debug');
  assert.equal(debugLenses[0].command.arguments[0].routePath, 'orders/:id');
  assert.equal(debugLenses[0].command.arguments[0].kind, 'route');
});
