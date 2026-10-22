import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Param } from './types';

// ---------------------------------------------------------------- service method parameters
export function parseParams(src: string): Param[] {
  return src
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(?:(?:private|public|protected|readonly)\s+)*(\w+)\??\s*(?::\s*([^=]+?))?\s*(?:=.*)?$/s.exec(s);
      return { name: m ? m[1] : s, type: m && m[2] ? m[2].trim() : 'any' };
    });
}

export type Kind = 'text' | 'number' | 'boolean' | 'json' | 'any';

// What kind of box does this TypeScript type need?
export function kindOf(type: string): Kind {
  const parts = type.split('|').map((x) => x.trim()).filter((x) => x && x !== 'undefined' && x !== 'null');
  const t = (parts.length === 1 ? parts[0] : type).trim().toLowerCase();
  if (t === '' || t === 'any' || t === 'unknown') return 'any'; // untyped: user chooses, default text
  if (t === 'string') return 'text';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'json'; // DTOs, objects, arrays...
}

export function convert(raw: string, kind: string): unknown {
  switch (kind) {
    case 'number':
      return raw.trim() === '' ? undefined : Number(raw);
    case 'boolean':
      return raw.trim().toLowerCase() === 'true';
    case 'json':
      if (raw.trim() === '') return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw; // text: exactly what you typed
  }
}

// ---------------------------------------------------------------- controller routes
export interface RouteDecl {
  className: string;
  method: string;
  httpMethod: string;
  routePath: string;
  pathParams: string[];
  hasBody: boolean;
  bodyType?: string;
  decoratorOffset: number;
  bodyOffset: number; // first statement inside the method
}

export interface MethodDecl {
  className: string;
  method: string;
  params: Param[];
  methodOffset: number;
  bodyOffset: number;
}

/** Index of the bracket that closes the one at openIdx (skips quoted text). */
function matchClose(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const joinPath = (...parts: string[]) =>
  parts
    .map((s) => s.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

function decorators(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}

interface DecoratorMatch {
  name: string;
  arguments: readonly ts.Expression[];
  decorator: ts.Decorator;
}

function matchDecorator(decorator: ts.Decorator): DecoratorMatch | undefined {
  const expr = decorator.expression;
  if (ts.isIdentifier(expr)) {
    return { name: expr.text, arguments: [], decorator };
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return { name: expr.expression.text, arguments: expr.arguments, decorator };
  }
  return undefined;
}

function findDecorator(node: ts.Node, name: string): DecoratorMatch | undefined {
  for (const decorator of decorators(node)) {
    const match = matchDecorator(decorator);
    if (match && match.name === name) return match;
  }
  return undefined;
}

function literalPath(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return '';
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isArrayLiteralExpression(expression) && expression.elements.length > 0) {
    return literalPath(expression.elements[0] as ts.Expression);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const property = expression.properties.find(
      (item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === 'path',
    );
    return property ? literalPath(property.initializer) : '';
  }
  return undefined; // dynamic decorators are deliberately not guessed
}

function nodeName(node: ts.PropertyName | ts.BindingName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) ? node.text : undefined;
}

function methodParams(method: ts.MethodDeclaration, source: ts.SourceFile): Param[] {
  return method.parameters.map((parameter) => ({
    name: nodeName(parameter.name) ?? parameter.name.getText(source),
    type: parameter.type?.getText(source) ?? 'any',
  }));
}

/** Finds class methods through TypeScript's syntax tree instead of a signature regex. */
export function findMethods(text: string): MethodDecl[] {
  const source = ts.createSourceFile('target.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: MethodDecl[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name && findDecorator(node, 'Injectable')) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name || !member.body) continue;
        const method = nodeName(member.name);
        if (!method || member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) continue;
        out.push({
          className: node.name.text,
          method,
          params: methodParams(member, source),
          methodOffset: member.name.getStart(source),
          bodyOffset: member.body.getStart(source) + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Finds statically resolvable Nest controller routes. Dynamic decorator paths are intentionally omitted. */
export function findRoutes(text: string): RouteDecl[] {
  const source = ts.createSourceFile('target.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: RouteDecl[] = [];
  const routeDecorators = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'];
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      const controller = findDecorator(node, 'Controller');
      if (controller) {
        const prefix = literalPath(controller.arguments[0]);
        if (prefix === undefined) return; // no invented URL for a computed prefix
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member) || !member.name || !member.body) continue;
          for (const decorator of decorators(member)) {
            const match = matchDecorator(decorator);
            if (!match || !routeDecorators.includes(match.name)) continue;
            const decoratorName = match.name;
            const childPath = literalPath(match.arguments[0]);
            if (childPath === undefined) continue;
            const routePath = joinPath(prefix, childPath);
            const body = member.parameters.find((parameter) => !!findDecorator(parameter, 'Body'));
            const method = nodeName(member.name);
            if (!method) continue;
            out.push({
              className: node.name.text,
              method,
              httpMethod: decoratorName.toUpperCase(),
              routePath,
              pathParams: [...routePath.matchAll(/:(\w+)/g)].map((m) => m[1]),
              hasBody: !!body,
              bodyType: body?.type?.getText(source),
              decoratorOffset: decorator.getStart(source),
              bodyOffset: member.body.getStart(source) + 1,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

// ---------------------------------------------------------------- a starter JSON body from the DTO class
const SAMPLE: Record<string, unknown> = {
  string: '',
  number: 0,
  boolean: false,
  date: '2024-01-01T00:00:00.000Z',
};

export function bodyTemplate(controllerFile: string, controllerText: string, typeName: string, root: string): string | undefined {
  try {
    // which file is the DTO imported from?
    let spec: string | undefined;
    for (const m of controllerText.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop());
      if (names.includes(typeName)) {
        spec = m[2];
        break;
      }
    }
    let src: string | undefined;
    const candidates: string[] = [];
    if (spec) {
      const base = spec.startsWith('.') ? path.resolve(path.dirname(controllerFile), spec) : path.join(root, spec);
      candidates.push(base + '.ts', path.join(base, 'index.ts'));
    }
    candidates.push(controllerFile); // DTO declared in the same file
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const text = fs.readFileSync(c, 'utf8');
        if (new RegExp(`class\\s+${typeName}\\b`).test(text)) {
          src = text;
          break;
        }
      }
    }
    if (!src) return undefined;

    const at = src.search(new RegExp(`class\\s+${typeName}\\b`));
    const open = src.indexOf('{', at);
    const close = matchClose(src, open, '{', '}');
    const block = src.slice(open + 1, close < 0 ? undefined : close);

    const obj: Record<string, unknown> = {};
    for (const m of block.matchAll(/^[ \t]*(?:(?:public|private|protected|readonly)\s+)*(\w+)(\??)!?\s*:\s*([^;=\n]+)/gm)) {
      if (m[1] === 'constructor') continue;
      const type = m[3].trim();
      const lower = type.toLowerCase();
      obj[m[1]] = lower in SAMPLE ? SAMPLE[lower] : /\[\]$|^array</i.test(type) ? [] : null;
    }
    return Object.keys(obj).length ? JSON.stringify(obj, null, 2) : undefined;
  } catch {
    return undefined;
  }
}
