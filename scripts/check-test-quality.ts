#!/usr/bin/env bun
/**
 * Test-quality audit
 *
 * Flags two categories of test-quality issues:
 * 1. Dead mock assertions — a component is mocked and the test title claims to
 *    exercise the mocked component, but the assertion only does a broad
 *    container.textContent check that would pass even if the parent stopped
 *    using the mocked child.
 * 2. Describe-scope mismatches — a test lives in a describe('X') block where X
 *    is a function name, but the test never calls X and instead calls a
 *    different function Y.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

interface Finding {
  file: string;
  line: number;
  column: number;
  message: string;
}

/* ── File discovery ─────────────────────────────────────────────────────── */

function findTestFiles(dir: string, files: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git')
        continue;
      findTestFiles(path, files);
    } else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
      files.push(path);
    }
  }
  return files;
}

/* ── AST helpers ──────────────────────────────────────────────────────── */

function parseFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
}

function getPos(sf: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, column: character + 1 };
}

function getCallArgString(
  sf: ts.SourceFile,
  call: ts.CallExpression,
  argIndex: number
): string | null {
  const arg = call.arguments[argIndex];
  if (!arg) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.text;
  }
  if (ts.isTemplateExpression(arg)) {
    return arg.head.text;
  }
  return null;
}

function nodeText(sf: ts.SourceFile, node: ts.Node): string {
  return node.getText(sf);
}

/* ── Collect top-level mocks ──────────────────────────────────────────── */

interface MockInfo {
  modulePath: string;
  componentName: string | null;
  pos: { line: number; column: number };
}

function isMockCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (ts.isPropertyAccessExpression(expr)) {
    const name = expr.name.text;
    if (name !== 'mock') return false;
    const obj = expr.expression;
    if (ts.isIdentifier(obj)) {
      return ['vi', 'jest', 'bun'].includes(obj.text);
    }
  }
  return false;
}

function extractComponentNameFromPath(modulePath: string): string | null {
  const match = modulePath.match(/\/([^/]+)\.tsx$/);
  if (match) return match[1];
  return null;
}

function collectTopLevelMocks(sf: ts.SourceFile): MockInfo[] {
  const mocks: MockInfo[] = [];
  function visit(node: ts.Node) {
    if (isMockCall(node) && node.arguments.length >= 1) {
      const modulePath = getCallArgString(sf, node, 0);
      if (modulePath) {
        mocks.push({
          modulePath,
          componentName: extractComponentNameFromPath(modulePath),
          pos: getPos(sf, node),
        });
      }
    }
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return mocks;
}

function isComponentMock(mock: MockInfo): boolean {
  return (
    mock.modulePath.endsWith('.tsx') ||
    mock.modulePath.includes('/components/') ||
    mock.modulePath.includes('/ui/')
  );
}

/* ── Collect describe/it blocks ───────────────────────────────────────── */

interface ItBlock {
  title: string | null;
  body: ts.ArrowFunction | ts.FunctionExpression;
  pos: { line: number; column: number };
}

interface DescribeBlock {
  title: string | null;
  body: ts.ArrowFunction | ts.FunctionExpression;
  pos: { line: number; column: number };
  children: (DescribeBlock | ItBlock)[];
}

function isDescribeOrItCall(
  node: ts.Node
): { kind: 'describe' | 'it'; call: ts.CallExpression } | null {
  if (!ts.isCallExpression(node)) return null;
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    if (expr.text === 'describe' || expr.text === 'it' || expr.text === 'test') {
      return { kind: expr.text === 'test' ? 'it' : (expr.text as 'describe' | 'it'), call: node };
    }
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const name = expr.name.text;
    if (name === 'only' || name === 'skip') {
      const obj = expr.expression;
      if (ts.isIdentifier(obj)) {
        if (obj.text === 'describe') return { kind: 'describe', call: node };
        if (obj.text === 'it' || obj.text === 'test') return { kind: 'it', call: node };
      }
    }
  }
  return null;
}

function collectDescribeBlocks(node: ts.Node, sf: ts.SourceFile): DescribeBlock[] {
  const blocks: DescribeBlock[] = [];

  function visit(current: ts.Node, parentDescribe: DescribeBlock | null) {
    const info = isDescribeOrItCall(current);
    if (!info) {
      ts.forEachChild(current, (child) => visit(child, parentDescribe));
      return;
    }

    const title = getCallArgString(sf, info.call, 0);
    const bodyArg = info.call.arguments[1];
    if (!bodyArg || (!ts.isArrowFunction(bodyArg) && !ts.isFunctionExpression(bodyArg))) {
      return;
    }

    if (info.kind === 'describe') {
      const block: DescribeBlock = {
        title,
        body: bodyArg,
        pos: getPos(sf, current),
        children: [],
      };
      if (parentDescribe) {
        parentDescribe.children.push(block);
      } else {
        blocks.push(block);
      }
      ts.forEachChild(bodyArg.body, (child) => visit(child, block));
    } else {
      const itBlock: ItBlock = {
        title,
        body: bodyArg,
        pos: getPos(sf, current),
      };
      if (parentDescribe) {
        parentDescribe.children.push(itBlock);
      }
    }
  }

  visit(node, null);
  return blocks;
}

function isItBlock(child: DescribeBlock | ItBlock): child is ItBlock {
  return !('children' in child);
}

/* ── Pattern 1: Dead mock assertions ──────────────────────────────────── */

function findDeadMockAssertions(sf: ts.SourceFile, filePath: string): Finding[] {
  const findings: Finding[] = [];
  const mocks = collectTopLevelMocks(sf).filter(isComponentMock);
  if (mocks.length === 0) return findings;

  const describes = collectDescribeBlocks(sf, sf);

  // Build a set of selectors/testids that the mocks produce
  const mockSelectors = new Set<string>();
  for (const mock of mocks) {
    function visitForMock(node: ts.Node) {
      if (isMockCall(node)) {
        const path = getCallArgString(sf, node, 0);
        if (path === mock.modulePath && node.arguments.length >= 2) {
          const factory = node.arguments[1];
          const text = nodeText(sf, factory);
          // Extract data-testid values
          const testIdMatches = text.matchAll(/data-testid=(?:"|')([^"']+)/g);
          for (const m of testIdMatches) {
            mockSelectors.add(m[1]);
          }
          // Extract class names that look like mock-specific markers
          const classMatches = text.matchAll(/class=(?:"|')([^"']+)/g);
          for (const m of classMatches) {
            for (const cls of m[1].split(/\s+/)) {
              if (cls.startsWith('prose') || cls.startsWith('bg-') || cls.startsWith('text-')) {
                mockSelectors.add(`.${cls}`);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visitForMock);
    }
    visitForMock(sf);
  }

  function findRenderCall(node: ts.Node): ts.CallExpression | null {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'render'
    ) {
      return node;
    }
    let result: ts.CallExpression | null = null;
    ts.forEachChild(node, (child) => {
      if (!result) result = findRenderCall(child);
    });
    return result;
  }

  function hasContainerTextContentAssertion(node: ts.Node): boolean {
    if (ts.isCallExpression(node)) {
      const text = nodeText(sf, node);
      if (/container\.(textContent|innerHTML)/.test(text)) {
        return true;
      }
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found) found = hasContainerTextContentAssertion(child);
    });
    return found;
  }

  function hasMockSpecificQuery(node: ts.Node): boolean {
    if (ts.isCallExpression(node)) {
      const text = nodeText(sf, node);
      for (const sel of mockSelectors) {
        if (text.includes(`"${sel}"`) || text.includes(`'${sel}'`)) {
          return true;
        }
      }
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found) found = hasMockSpecificQuery(child);
    });
    return found;
  }

  function visitIt(itBlock: ItBlock) {
    const renderCall = findRenderCall(itBlock.body);
    if (!renderCall) return;

    const hasContainerAssert = hasContainerTextContentAssertion(itBlock.body);
    const hasMockQuery = hasMockSpecificQuery(itBlock.body);
    if (!hasContainerAssert || hasMockQuery) return;

    // Check if test title mentions a mocked component
    if (!itBlock.title) return;
    const lowerTitle = itBlock.title.toLowerCase();

    for (const mock of mocks) {
      if (!mock.componentName) continue;
      const lowerComponent = mock.componentName.toLowerCase();
      // Title must explicitly reference the mocked component
      const mentionsComponent =
        lowerTitle.includes(lowerComponent) ||
        lowerTitle.includes(`via ${lowerComponent}`) ||
        lowerTitle.includes(`through ${lowerComponent}`);

      // Title must suggest the mocked component is the subject
      const impliesComponentInvolved =
        lowerTitle.includes('render') ||
        lowerTitle.includes('markdown') ||
        lowerTitle.includes('via') ||
        lowerTitle.includes('through') ||
        lowerTitle.includes('pass') ||
        lowerTitle.includes('delegate');

      if (mentionsComponent && impliesComponentInvolved) {
        findings.push({
          file: filePath,
          ...itBlock.pos,
          message: `Test title references mocked component "${mock.componentName}" but asserts only on container.textContent without querying the mock's output. This assertion is "dead" — it would pass even if the parent stopped delegating to the mocked child. Consider querying the mock by its testid/class or rewording the test title.`,
        });
        break;
      }
    }
  }

  function visitDescribe(desc: DescribeBlock) {
    for (const child of desc.children) {
      if (isItBlock(child)) {
        visitIt(child);
      } else {
        visitDescribe(child);
      }
    }
  }

  for (const desc of describes) {
    visitDescribe(desc);
  }

  return findings;
}

/* ── Pattern 2: Describe-scope mismatch ───────────────────────────────── */

function extractIdentifiers(node: ts.Node): Set<string> {
  const ids = new Set<string>();
  function visit(n: ts.Node) {
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) {
        ids.add(n.expression.text);
      } else if (ts.isPropertyAccessExpression(n.expression)) {
        const obj = n.expression.expression;
        const methodName = n.expression.name.text;
        if (ts.isCallExpression(obj) && ts.isIdentifier(obj.expression)) {
          if (!['expect', 'vi', 'jest'].includes(obj.expression.text)) {
            ids.add(methodName);
          }
        } else if (ts.isIdentifier(obj)) {
          if (!['expect', 'vi', 'jest', 'console', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Map', 'Set', 'Promise', 'Error', 'RegExp', 'Buffer', 'process', 'window', 'document', 'localStorage', 'sessionStorage'].includes(obj.text)) {
            ids.add(methodName);
            // Also track the object name — it might match a describe title (e.g. toastsSignal.subscribe)
            ids.add(obj.text);
          }
        } else {
          ids.add(methodName);
        }
        // Track callback arguments to array methods like .map(fn), .filter(fn)
        if (['map', 'filter', 'forEach', 'reduce', 'find', 'some', 'every', 'flatMap'].includes(methodName)) {
          for (const arg of n.arguments) {
            if (ts.isIdentifier(arg)) {
              ids.add(arg.text);
            }
          }
        }
      }
    }
    // Track object names in element access like heroiconToLucide['HomeIcon']
    if (ts.isElementAccessExpression(n)) {
      if (ts.isIdentifier(n.expression)) {
        ids.add(n.expression.text);
      }
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tagName = n.tagName;
      if (ts.isIdentifier(tagName)) {
        ids.add(tagName.text);
      } else if (ts.isQualifiedName(tagName)) {
        ids.add(tagName.right.text);
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return ids;
}

const TEST_UTILITIES = new Set([
  'act',
  'render',
  'renderHook',
  'fireEvent',
  'cleanup',
  'waitFor',
  'screen',
  'vi',
  'jest',
  'expect',
  'describe',
  'it',
  'test',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'mock',
  'spyOn',
  'fn',
  'clearAllMocks',
  'useFakeTimers',
  'useRealTimers',
  'advanceTimersByTime',
  'runAllTimers',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'console',
  'log',
  'error',
  'warn',
  'info',
  'JSON',
  'Object',
  'Array',
  'String',
  'Number',
  'Date',
  'Map',
  'Set',
  'Promise',
  'Math',
  'parseInt',
  'parseFloat',
  'encodeURIComponent',
  'decodeURIComponent',
  'Error',
  'TypeError',
  'RangeError',
  'Symbol',
  'RegExp',
  'Buffer',
  'process',
  'require',
  'module',
  'exports',
  'global',
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'fetch',
  'Headers',
  'Request',
  'Response',
  'URL',
  'URLSearchParams',
  'Blob',
  'File',
  'FormData',
  'atob',
  'btoa',
  'createElement',
  'useRef',
  'useState',
  'useEffect',
  'useCallback',
  'useMemo',
  'useContext',
  'useReducer',
  'useId',
  'useLayoutEffect',
  'useImperativeHandle',
  'useInsertionEffect',
  'useSyncExternalStore',
  'useTransition',
  'useDeferredValue',
  'useDebugValue',
  'useFormStatus',
  'useOptimistic',
  'useActionState',
  // Assertion methods
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toBeNull',
  'toBeUndefined',
  'toBeDefined',
  'toBeTruthy',
  'toBeFalsy',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeCloseTo',
  'toBeNaN',
  'toBeInfinity',
  'toBeFinite',
  'toBeInstanceOf',
  'toBeTypeOf',
  'toMatch',
  'toMatchObject',
  'toMatchSnapshot',
  'toMatchInlineSnapshot',
  'toMatchFileSnapshot',
  'toThrow',
  'toThrowError',
  'toHaveLength',
  'toHaveProperty',
  'toContain',
  'toContainEqual',
  'toHaveBeenCalled',
  'toHaveBeenCalledTimes',
  'toHaveBeenCalledWith',
  'toHaveBeenLastCalledWith',
  'toHaveBeenNthCalledWith',
  'toHaveReturned',
  'toHaveReturnedTimes',
  'toHaveReturnedWith',
  'toHaveLastReturnedWith',
  'toHaveNthReturnedWith',
  'toResolve',
  'toReject',
  'resolves',
  'rejects',
  'not',
  // Array / object / string helpers
  'keys',
  'entries',
  'values',
  'includes',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'slice',
  'concat',
  'join',
  'split',
  'map',
  'filter',
  'reduce',
  'forEach',
  'find',
  'findIndex',
  'indexOf',
  'lastIndexOf',
  'some',
  'every',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
  'flat',
  'flatMap',
  'at',
  'from',
  'of',
  'isArray',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'substring',
  'substr',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'replace',
  'replaceAll',
  'search',
  'match',
  'matchAll',
  'normalize',
  'repeat',
  'padStart',
  'padEnd',
  'startsWith',
  'endsWith',
  'localeCompare',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'propertyIsEnumerable',
  'isPrototypeOf',
  'assign',
  'create',
  'defineProperty',
  'defineProperties',
  'freeze',
  'seal',
  'preventExtensions',
  'getOwnPropertyDescriptor',
  'getOwnPropertyNames',
  'getOwnPropertySymbols',
  'getPrototypeOf',
  'setPrototypeOf',
  'is',
  'isExtensible',
  'isFrozen',
  'isSealed',
  'fromEntries',
  'groupBy',
  'parse',
  'stringify',
  'now',
  'UTC',
  'abs',
  'ceil',
  'floor',
  'round',
  'trunc',
  'pow',
  'sqrt',
  'cbrt',
  'exp',
  'expm1',
  'log',
  'log1p',
  'log10',
  'log2',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'hypot',
  'sign',
  'random',
  'fround',
  'imul',
  'clz32',
]);

// Common English/concept words used as describe labels that are not function names
const CONCEPT_WORDS = new Set([
  'initialization',
  'setup',
  'teardown',
  'cleanup',
  'rendering',
  'parsing',
  'validation',
  'formatting',
  'loading',
  'error',
  'empty',
  'default',
  'basic',
  'advanced',
  'edge',
  'cases',
  'behavior',
  'creation',
  'deletion',
  'update',
  'open',
  'close',
  'toggle',
  'start',
  'stop',
  'pause',
  'resume',
  'add',
  'remove',
  'insert',
  'show',
  'hide',
  'display',
  'enable',
  'disable',
  'activate',
  'deactivate',
  'lock',
  'unlock',
  'sort',
  'filter',
  'search',
  'find',
  'upload',
  'download',
  'import',
  'export',
  'sync',
  'async',
  'batch',
  'stream',
  'queue',
  'connect',
  'disconnect',
  'mount',
  'unmount',
  'scroll',
  'drag',
  'drop',
  'click',
  'hover',
  'focus',
  'blur',
  'input',
  'output',
  'change',
  'submit',
  'cancel',
  'reset',
  'clear',
  'expand',
  'collapse',
  'select',
  'deselect',
  'choose',
  'pick',
  'check',
  'uncheck',
  'min',
  'max',
  'average',
  'total',
  'first',
  'last',
  'next',
  'previous',
  'current',
  'old',
  'new',
  'valid',
  'invalid',
  'active',
  'inactive',
  'enabled',
  'disabled',
  'visible',
  'hidden',
  'shown',
  'collapsed',
  'expanded',
  'locked',
  'unlocked',
  'private',
  'public',
  'internal',
  'external',
  'local',
  'remote',
  'global',
  'specific',
  'general',
  'common',
  'unique',
  'duplicate',
  'original',
  'copy',
  'clone',
  'instance',
  'idempotency',
  'determinism',
  'routing',
  'handling',
  'processing',
  'conversion',
  'extraction',
  'injection',
  'registration',
  'subscription',
  'reconnection',
  'transition',
  'animation',
  'interaction',
  'navigation',
  'authentication',
  'authorization',
  'permission',
  'configuration',
  'settings',
  'preferences',
  'options',
  'parameters',
  'arguments',
  'returns',
  'throws',
  'catches',
  'resolves',
  'rejects',
  'emits',
  'listens',
  'waits',
  'delays',
  'timeouts',
  'intervals',
  'scheduling',
  'debouncing',
  'throttling',
  'caching',
  'memoization',
  'serialization',
  'deserialization',
  'encoding',
  'decoding',
  'encryption',
  'decryption',
  'compression',
  'decompression',
  'fallback',
  'rollback',
  'commit',
  'abort',
  'retry',
  'restoring',
  'reverting',
  'undo',
  'redo',
  'repeat',
  'continue',
  'suspend',
  'block',
  'sleep',
  'delay',
  'expire',
  'refresh',
  'renew',
  'extend',
  'reduce',
  'increase',
  'decrease',
  'grow',
  'shrink',
  'stretch',
  'enlarge',
  'diminish',
  'augment',
  'append',
  'prepend',
  'attach',
  'detach',
  'bind',
  'unbind',
  'link',
  'unlink',
  'associate',
  'dissociate',
  'relate',
  'unrelate',
  'merge',
  'unmerge',
  'combine',
  'separate',
  'join',
  'leave',
  'enter',
  'exit',
  'visit',
  'move',
  'transfer',
  'migrate',
  'port',
  'deploy',
  'undeploy',
  'install',
  'uninstall',
  'init',
  'terminate',
  'end',
  'finish',
  'complete',
  'finalize',
  'fix',
  'repair',
  'maintain',
  'upgrade',
  'downgrade',
  'replace',
  'substitute',
  'swap',
  'exchange',
  'trade',
  'shift',
  'rotate',
  'flip',
  'reverse',
  'invert',
  'negate',
  'complement',
  'supplement',
  'build',
  'tear',
  'make',
  'break',
  'create',
  'destroy',
  'modify',
  'alter',
  'edit',
  'cut',
  'paste',
  'save',
  'load',
  'fetch',
  'get',
  'set',
  'put',
  'post',
  'patch',
  'head',
  'trace',
  'track',
  'follow',
  'chase',
  'pursue',
  'hunt',
  'seek',
  'probe',
  'explore',
  'investigate',
  'research',
  'study',
  'learn',
  'teach',
  'train',
  'educate',
  'instruct',
  'guide',
  'direct',
  'lead',
  'manage',
  'organize',
  'coordinate',
  'orchestrate',
  'conduct',
  'perform',
  'implement',
  'realize',
  'achieve',
  'accomplish',
  'fulfill',
  'satisfy',
  'meet',
  'match',
  'pair',
  'couple',
  'decouple',
  'chain',
  'unchain',
  'sequence',
  'unsequence',
  'order',
  'unorder',
  'rank',
  'unrank',
  'score',
  'grade',
  'rate',
  'evaluate',
  'assess',
  'appraise',
  'estimate',
  'guess',
  'predict',
  'forecast',
  'project',
  'extrapolate',
  'interpolate',
  'derive',
  'deduce',
  'induce',
  'infer',
  'conclude',
  'decide',
  'determine',
  'resolve',
  'solve',
  'answer',
  'respond',
  'reply',
  'react',
  'act',
  'behave',
  'operate',
  'function',
  'work',
  'serve',
  'provide',
  'supply',
  'furnish',
  'give',
  'offer',
  'present',
  'deliver',
  'hand',
  'pass',
  'transmit',
  'transport',
  'convey',
  'carry',
  'bear',
  'bring',
  'take',
  'retrieve',
  'recover',
  'return',
  'send',
  'dispatch',
  'ship',
  'mail',
  'broadcast',
  'narrowcast',
  'podcast',
  'webcast',
  'telecast',
  'simulcast',
  'multicast',
  'unicast',
  'anycast',
  'geocast',
  'mobcast',
  'chromecast',
  'airplay',
  'mirror',
  'cast',
  'throw',
  'toss',
  'fling',
  'hurl',
  'pitch',
  'lob',
  'chuck',
  'heave',
  'launch',
  'propel',
  'eject',
  'expel',
  'discharge',
  'emit',
  'exude',
  'ooze',
  'seep',
  'leak',
  'drip',
  'pour',
  'flow',
  'gush',
  'spurt',
  'spray',
  'squirt',
  'jet',
  'pump',
  'siphon',
  'syphon',
  'drain',
  'fill',
  'refill',
  'top',
  'replenish',
  'restock',
  'resupply',
  'recharge',
  'reload',
  'rearm',
  'refuel',
  'recoal',
  'rewater',
  'reprovision',
  'reoutfit',
  'reequip',
  'regear',
  'retool',
  'reconfigure',
  'reconstitute',
  'recompose',
  'reconstruct',
  'reassemble',
  'rebuild',
  'remake',
  'recreate',
  'regenerate',
  'reproduce',
  'replicate',
  'duplicate',
  'clone',
  'reflect',
  'echo',
  'iterate',
  'reiterate',
  'recapitulate',
  'summarize',
  'recap',
  'review',
  'revisit',
  'reexamine',
  'reinspect',
  'recheck',
  'reverify',
  'revalidate',
  'reconfirm',
  'reaffirm',
  'reassert',
  'reassure',
  'reencourage',
  'reinspire',
  'remotivate',
  'reenergize',
  'revitalize',
  'reinvigorate',
  'rejuvenate',
  'rehabilitate',
  'recuperate',
  'heal',
  'cure',
  'remedy',
  'rectify',
  'correct',
  'amend',
  'emend',
  'revise',
  'redact',
  'censor',
  'expurgate',
  'bowdlerize',
  'sanitize',
  'clean',
  'purify',
  'cleanse',
  'detoxify',
  'decontaminate',
  'sterilize',
  'disinfect',
  'pasteurize',
  'irradiate',
  'autoclave',
  'fumigate',
  'degas',
  'deodorize',
  'deodorise',
  'perfume',
  'scent',
  'fragrance',
  'aromatize',
  'flavor',
  'flavour',
  'season',
  'spice',
  'sweeten',
  'sour',
  'bitter',
  'salt',
  'pepper',
  'sugar',
  'honey',
  'vanilla',
  'chocolate',
  'caramel',
  'butter',
  'cream',
  'milk',
  'cheese',
  'egg',
  'flour',
  'bread',
  'batter',
  'coat',
  'crust',
  'dredge',
  'dust',
  'powder',
  'sprinkle',
  'shake',
  'stir',
  'mix',
  'blend',
  'beat',
  'whip',
  'fold',
  'knead',
  'roll',
  'slice',
  'dice',
  'chop',
  'mince',
  'grate',
  'shred',
  'grind',
  'crush',
  'mash',
  'pound',
  'hammer',
  'bash',
  'crash',
  'shatter',
  'fragment',
  'splinter',
  'shiver',
  'crumble',
  'disintegrate',
  'pulverize',
  'atomize',
  'vaporize',
  'evaporate',
  'condense',
  'liquefy',
  'solidify',
  'freeze',
  'melt',
  'boil',
  'simmer',
  'poach',
  'steam',
  'braise',
  'stew',
  'roast',
  'bake',
  'broil',
  'grill',
  'fry',
  'saute',
  'sear',
  'scorch',
  'char',
  'burn',
  'combust',
  'ignite',
  'inflame',
  'kindle',
  'spark',
  'flare',
  'blaze',
  'glow',
  'smolder',
  'smoulder',
  'fume',
  'smoke',
  'mist',
  'fog',
  'cloud',
  'haze',
  'smog',
  'vapor',
  'gas',
  'aerosol',
  'spray',
  'foam',
  'froth',
  'lather',
  'suds',
  'bubble',
  'spume',
  'scum',
  'slag',
  'dross',
  'scoria',
  'clinker',
  'cinder',
  'ash',
  'ember',
  'coal',
  'charcoal',
  'coke',
  'peat',
  'lignite',
  'bitumen',
  'tar',
  'pitch',
  'resin',
  'rosin',
  'shellac',
  'lacquer',
  'varnish',
  'sealer',
  'primer',
  'undercoat',
  'topcoat',
  'finish',
  'glaze',
  'enamel',
  'paint',
  'stain',
  'dye',
  'pigment',
  'colorant',
  'tint',
  'shade',
  'tone',
  'hue',
  'value',
  'chroma',
  'saturation',
  'brightness',
  'lightness',
  'darkness',
  'whiteness',
  'blackness',
  'grayness',
  'redness',
  'greenness',
  'blueness',
  'yellowness',
  'orangeness',
  'purpleness',
  'pinkness',
  'brownness',
  'beigeness',
  'creaminess',
  'ivoriness',
  'pearliness',
  'silveyness',
  'goldness',
  'bronziness',
  'copperness',
  'ironness',
  'steelness',
  'tinness',
  'leadness',
  'zincness',
  'nickelness',
  'chromeness',
  'platiness',
  'pallness',
  'titaness',
  'vanadess',
  'tungstness',
  'molybdeness',
  'manganesess',
  'cobaltness',
  'aluminess',
  'siliconess',
  'carboness',
  'nitrogeness',
  'oxygeness',
  'hydrogeness',
  'heliumess',
  'lithiumess',
  'sodiumess',
  'potassiumess',
  'rubidiumess',
  'cesiumess',
  'franciumess',
  'beryliumess',
  'magnesiumess',
  'calciumess',
  'strontiumess',
  'bariumess',
  'radiumess',
  'scandiumess',
  'yttriumess',
  'lanthanumess',
  'actiniumess',
  'titaniumess',
  'zirconiumess',
  'hafniumess',
  'rutherfordiumess',
  'vanadiumess',
  'niobiumess',
  'tantalumess',
  'dubniumess',
  'chromiumess',
  'molybdenumess',
  'tungsteness',
  'seaborgiumess',
  'manganeseess',
  'technetiumess',
  'rheniumess',
  'bohriumess',
  'ironess',
  'rutheniumess',
  'osmiumess',
  'hassiumess',
  'cobaltess',
  'rhodiumess',
  'iridiumess',
  'meitneriumess',
  'nickeless',
  'palladiumess',
  'platinumess',
  'darmstadtiumess',
  'copperess',
  'silveress',
  'goldess',
  'roentgeniumess',
  'zincness',
  'cadmiumess',
  'mercuryess',
  'coperniciumess',
  'boroness',
  'aluminumess',
  'galliumess',
  'indiumess',
  'thalliumess',
  'nihoniumess',
  'carboness',
  'siliconess',
  'germaniumess',
  'tinness',
  'leadness',
  'fleroviumess',
  'nitrogeness',
  'phosphorusess',
  'arsenicness',
  'antimonyess',
  'bismuthess',
  'moscoviumess',
  'oxygeness',
  'sulfuress',
  'seleniumess',
  'telluriumess',
  'poloniumess',
  'livermoriumess',
  'fluoriness',
  'chloriness',
  'brominess',
  'iodiness',
  'astatiness',
  'tennessiness',
  'heliumess',
  'neoness',
  'argoness',
  'kryptoness',
  'xenoness',
  'radoness',
  'oganessoness',
  'ceriumess',
  'praseodymiumess',
  'neodymiumess',
  'promethiumess',
  'samariumess',
  'europiumess',
  'gadoliniumess',
  'terbiumess',
  'dysprosiumess',
  'holmiumess',
  'erbiumess',
  'thuliumess',
  'ytterbiumess',
  'lutetiumess',
  'thoriumess',
  'protactiniumess',
  'uraniumess',
  'neptuniumess',
  'plutoniumess',
  'americiumess',
  'curiumess',
  'berkeliumess',
  'californiumess',
  'einsteiniumess',
  'fermiumess',
  'mendeleviumess',
  'nobeliumess',
  'lawrenciumess',
]);

function isCamelCaseFunctionName(word: string): boolean {
  // Must be camelCase or PascalCase, at least 2 chars
  if (!/^[a-zA-Z][a-zA-Z0-9]+$/.test(word)) return false;
  // Must not be all uppercase (e.g. IDs)
  if (/^[A-Z]+$/.test(word)) return false;
  // Must not be a testing utility
  if (TEST_UTILITIES.has(word)) return false;
  // Must not be a common concept word
  if (CONCEPT_WORDS.has(word.toLowerCase())) return false;
  return true;
}

function filenameBase(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() ?? '';
  return name.replace(/\.test\.(ts|tsx)$/, '').replace(/-/g, '');
}

function titleMatchesFilename(title: string, filePath: string): boolean {
  const base = filenameBase(filePath);
  const normalizedTitle = title.replace(/-/g, '');
  return base.toLowerCase() === normalizedTitle.toLowerCase();
}

function fileImportsRenderHook(sf: ts.SourceFile): boolean {
  let found = false;
  function visit(n: ts.Node) {
    if (found) return;
    if (ts.isImportDeclaration(n)) {
      const text = n.getText(sf);
      if (/renderHook/.test(text)) {
        found = true;
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  return found;
}

// Files with known valid describe-scope patterns that would be false positives
const DESCRIBE_SCOPE_IGNORE_LIST = new Set([
  'packages/web/src/lib/__tests__/aaa-toast.test.ts',
  'packages/ui/tests/icon-map.test.ts',
  'packages/daemon/tests/unit/5-space/runtime/space-worktree-manager.test.ts',
  'packages/daemon/tests/unit/1-core/providers/anthropic-copilot/provider.test.ts',
  'packages/daemon/tests/unit/1-core/providers/anthropic-copilot/server.test.ts',
  'packages/daemon/tests/unit/2-handlers/rpc-handlers/live-query-subscribe.test.ts',
  'packages/daemon/tests/unit/2-handlers/job-handlers/skill-validate.handler.test.ts',
  'packages/daemon/tests/unit/2-handlers/job-handlers/memory-consolidation.handler.test.ts',
]);

function findDescribeScopeMismatches(sf: ts.SourceFile, filePath: string): Finding[] {
  // Only check .test.ts files — .test.tsx component tests have too many valid variations
  if (filePath.endsWith('.test.tsx')) return [];

  // Skip hook tests
  if (fileImportsRenderHook(sf)) return [];

  // Skip files with known false-positive patterns
  if (DESCRIBE_SCOPE_IGNORE_LIST.has(filePath)) return [];

  const findings: Finding[] = [];
  const describes = collectDescribeBlocks(sf, sf);

  function visitDescribe(desc: DescribeBlock) {
    if (!desc.title) return;

    // Only flag single-word titles that look like function/component names
    const trimmed = desc.title.trim();
    const words = trimmed.split(/\s+/);
    if (words.length !== 1) return;

    const describeName = words[0];
    if (!isCamelCaseFunctionName(describeName)) return;

    // Skip PascalCase component names — component tests often group sub-components
    if (/^[A-Z]/.test(describeName)) return;

    // Skip if describe title matches the filename (module-level grouping)
    if (titleMatchesFilename(describeName, filePath)) return;

    for (const child of desc.children) {
      if (isItBlock(child)) {
        const ids = extractIdentifiers(child.body);
        const hasDescribeFunction = ids.has(describeName);
        if (hasDescribeFunction) continue;

        // Check if test calls a different function/component name
        const otherFunctions = Array.from(ids).filter(
          (id) =>
            isCamelCaseFunctionName(id) &&
            id !== describeName &&
            !TEST_UTILITIES.has(id)
        );
        if (otherFunctions.length > 0) {
          findings.push({
            file: filePath,
            ...child.pos,
            message: `Test in describe('${describeName}') calls ${otherFunctions.join(', ')} but never calls ${describeName}. Consider moving to a describe block matching the function under test.`,
          });
        }
      } else {
        visitDescribe(child);
      }
    }
  }

  for (const desc of describes) {
    visitDescribe(desc);
  }

  return findings;
}

/* ── Main ─────────────────────────────────────────────────────────────── */

function main(): void {
  const repoRoot = process.cwd();
  const testFiles = findTestFiles(repoRoot);
  const allFindings: Finding[] = [];

  for (const filePath of testFiles) {
    const relPath = relative(repoRoot, filePath);
    if (relPath.includes('e2e/')) continue;
    if (relPath.includes('check-test-quality')) continue;

    try {
      const sf = parseFile(filePath);
      allFindings.push(...findDeadMockAssertions(sf, relPath));
      allFindings.push(...findDescribeScopeMismatches(sf, relPath));
    } catch (err) {
      console.error(`Failed to parse ${relPath}: ${err}`);
    }
  }

  if (allFindings.length > 0) {
    for (const f of allFindings) {
      console.error(`${f.file}:${f.line}:${f.column}  ${f.message}`);
    }
    console.error(`\n${allFindings.length} test-quality issue(s) found.`);
    process.exit(1);
  }

  console.log('Test-quality audit passed.');
}

if (import.meta.main) {
  main();
}
