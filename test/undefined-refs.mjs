// Static check: no module references a name it never receives.
//
// Domain modules take their dependencies out of `ctx`. If one uses a helper that server.js has but
// never destructures — or a Node builtin it forgot to import — nothing complains until that exact
// route runs, and then it throws ReferenceError and returns a 500. Three live features were broken
// this way at once (Stripe webhooks, customer portal login, and the device credential reveal), and
// each had been broken since the module was split out, because no test exercised those paths.
//
// A running server cannot catch this; only reading the code can. So this walks every module's AST
// and reports identifiers that are read but never bound anywhere in the file.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let acorn, walk;
try { acorn = require('acorn'); walk = require('acorn-walk'); }
catch {
  // acorn is a dev-only convenience; on a machine without it, skip rather than fail the suite.
  console.log('SKIP acorn not installed — run: npm install --no-save acorn acorn-walk');
  console.log('RESULT: 0 passed, 0 failed');
  process.exit(0);
}

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// Names that exist at runtime without being declared in the file.
const GLOBALS = new Set([
  'console', 'process', 'Buffer', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'AggregateError', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'fetch', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
  'Infinity', 'NaN', 'undefined', 'globalThis', 'structuredClone', 'Symbol', 'BigInt', 'Intl',
  'Reflect', 'Proxy', 'arguments', 'eval', 'require', 'module', 'exports', '__dirname', '__filename',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'crypto', 'performance', 'Function', 'Response', 'Request', 'Headers', 'Blob', 'FormData', 'Event'
]);

const files = [
  ...readdirSync('domains').filter(f => f.endsWith('.js')).map(f => 'domains/' + f),
  ...readdirSync('lib').filter(f => f.endsWith('.js')).map(f => 'lib/' + f),
  'server.js', 'db.js', 'auth.js', 'hash.js', 'wg.js'
];

for (const file of files) {
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { continue; }

  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); }
  catch (e) { ok(false, `${file}: parses (${e.message})`); continue; }

  // Every binding introduced anywhere in the file. Deliberately not scope-aware: a name bound in
  // one function and used in another is legal at module level often enough that tracking scopes
  // would cost more in false positives than it buys.
  const bound = new Set();
  const addPattern = (p) => {
    if (!p) return;
    switch (p.type) {
      case 'Identifier': bound.add(p.name); break;
      case 'ObjectPattern': p.properties.forEach(pr => addPattern(pr.type === 'RestElement' ? pr.argument : pr.value)); break;
      case 'ArrayPattern': p.elements.forEach(addPattern); break;
      case 'AssignmentPattern': addPattern(p.left); break;
      case 'RestElement': addPattern(p.argument); break;
    }
  };
  walk.full(ast, n => {
    if (n.type === 'VariableDeclarator') addPattern(n.id);
    else if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
      if (n.id) bound.add(n.id.name);
      n.params.forEach(addPattern);
    } else if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') { if (n.id) bound.add(n.id.name); }
    else if (n.type === 'ImportDefaultSpecifier' || n.type === 'ImportSpecifier' || n.type === 'ImportNamespaceSpecifier') bound.add(n.local.name);
    else if (n.type === 'CatchClause') addPattern(n.param);
  });

  const missing = new Map();
  walk.ancestor(ast, {
    Identifier(node, _state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      // Skip positions where an Identifier is a label rather than a value read.
      if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
      if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
      if (parent.type === 'MethodDefinition' && parent.key === node) return;
      if (parent.type === 'PropertyDefinition' && parent.key === node) return;
      if (['VariableDeclarator', 'FunctionDeclaration', 'ClassDeclaration'].includes(parent.type) && parent.id === node) return;
      if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ExportSpecifier') return;
      if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type)) return;
      if (bound.has(node.name) || GLOBALS.has(node.name)) return;
      if (!missing.has(node.name)) missing.set(node.name, node.loc.start.line);
    }
  });

  const list = [...missing].map(([n, l]) => `${n} (line ${l})`).join(', ');
  ok(missing.size === 0, `${file}: every name it uses is defined${missing.size ? ' — ' + list : ''}`);
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
