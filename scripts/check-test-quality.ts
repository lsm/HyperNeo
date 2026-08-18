#!/usr/bin/env bun

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

interface Finding {
  file: string;
  line: number;
  column: number;
  message: string;
}

function findTestFiles(dir: string, files: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      findTestFiles(path, files);
    } else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
      files.push(path);
    }
  }
  return files;
}

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

interface MockInfo {
  modulePath: string;
  componentName: string | null;
  selectors: Set<string>;
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
  const match = modulePath.match(/\/([^/]+?)(?:\.[jt]sx?)?$/);
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
          selectors: new Set(),
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
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text;
      if (name === 'each') {
        const obj = callee.expression;
        if (ts.isIdentifier(obj)) {
          if (obj.text === 'describe') return { kind: 'describe', call: node };
          if (obj.text === 'it' || obj.text === 'test') return { kind: 'it', call: node };
        }
        if (ts.isPropertyAccessExpression(obj)) {
          const innerName = obj.name.text;
          if (innerName === 'only' || innerName === 'skip') {
            const innerObj = obj.expression;
            if (ts.isIdentifier(innerObj)) {
              if (innerObj.text === 'describe') return { kind: 'describe', call: node };
              if (innerObj.text === 'it' || innerObj.text === 'test')
                return { kind: 'it', call: node };
            }
          }
        }
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

function findDeadMockAssertions(sf: ts.SourceFile, filePath: string): Finding[] {
  const findings: Finding[] = [];
  const mocks = collectTopLevelMocks(sf).filter(isComponentMock);
  if (mocks.length === 0) return findings;

  const describes = collectDescribeBlocks(sf, sf);

  for (const mock of mocks) {
    function visitForMock(node: ts.Node) {
      if (isMockCall(node)) {
        const path = getCallArgString(sf, node, 0);
        if (path === mock.modulePath && node.arguments.length >= 2) {
          const factory = node.arguments[1];
          const text = nodeText(sf, factory);
          const testIdMatches = text.matchAll(/data-testid=(?:"|')([^"']+)/g);
          for (const m of testIdMatches) {
            mock.selectors.add(m[1]);
          }
          const classMatches = text.matchAll(/class=(?:"|')([^"']+)/g);
          for (const m of classMatches) {
            for (const cls of m[1].split(/\s+/)) {
              if (cls.startsWith('prose') || cls.startsWith('bg-') || cls.startsWith('text-')) {
                mock.selectors.add(`.${cls}`);
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

  function hasMockSpecificQuery(node: ts.Node, selectors: Set<string>): boolean {
    if (ts.isCallExpression(node)) {
      const text = nodeText(sf, node);
      for (const sel of selectors) {
        if (text.includes(`"${sel}"`) || text.includes(`'${sel}'`)) {
          return true;
        }
      }
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found) found = hasMockSpecificQuery(child, selectors);
    });
    return found;
  }

  function visitIt(itBlock: ItBlock) {
    const renderCall = findRenderCall(itBlock.body);
    if (!renderCall) return;

    const hasContainerAssert = hasContainerTextContentAssertion(itBlock.body);
    if (!hasContainerAssert) return;

    if (!itBlock.title) return;
    const lowerTitle = itBlock.title.toLowerCase();

    for (const mock of mocks) {
      if (!mock.componentName) continue;
      const lowerComponent = mock.componentName.toLowerCase();
      const mentionsComponent =
        lowerTitle.includes(lowerComponent) ||
        lowerTitle.includes(`via ${lowerComponent}`) ||
        lowerTitle.includes(`through ${lowerComponent}`);

      const impliesComponentInvolved =
        lowerTitle.includes('render') ||
        lowerTitle.includes('markdown') ||
        lowerTitle.includes('via') ||
        lowerTitle.includes('through') ||
        lowerTitle.includes('pass') ||
        lowerTitle.includes('delegate');

      if (mentionsComponent && impliesComponentInvolved) {
        const hasMockQuery = hasMockSpecificQuery(itBlock.body, mock.selectors);
        if (hasMockQuery) continue;
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
          if (
            ![
              'expect',
              'vi',
              'jest',
              'console',
              'Array',
              'Object',
              'JSON',
              'Math',
              'Date',
              'Map',
              'Set',
              'Promise',
              'Error',
              'RegExp',
              'Buffer',
              'process',
              'window',
              'document',
              'localStorage',
              'sessionStorage',
            ].includes(obj.text)
          ) {
            ids.add(methodName);
            ids.add(obj.text);
          }
        } else {
          ids.add(methodName);
        }
        if (
          ['map', 'filter', 'forEach', 'reduce', 'find', 'some', 'every', 'flatMap'].includes(
            methodName
          )
        ) {
          for (const arg of n.arguments) {
            if (ts.isIdentifier(arg)) {
              ids.add(arg.text);
            }
          }
        }
      }
    }
    if (ts.isPropertyAccessExpression(n)) {
      const obj = n.expression;
      if (ts.isIdentifier(obj)) {
        if (
          ![
            'expect',
            'vi',
            'jest',
            'console',
            'Array',
            'Object',
            'JSON',
            'Math',
            'Date',
            'Map',
            'Set',
            'Promise',
            'Error',
            'RegExp',
            'Buffer',
            'process',
            'window',
            'document',
            'localStorage',
            'sessionStorage',
          ].includes(obj.text)
        ) {
          ids.add(obj.text);
        }
      }
    }
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

const CONCEPT_WORDS = new Set([
  'constructor',
  'integration',
  'signals',
  'timestamps',
  'invariants',
  'diagnostics',
  'lifecycle',
  'resilience',
  'enqueue',
  'deduplication',
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
  'reinspire',
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
  'revise',
  'sanitize',
  'clean',
  'purify',
  'cleanse',
  'detoxify',
  'decontaminate',
  'sterilize',
  'disinfect',
]);

function isCamelCaseFunctionName(word: string): boolean {
  if (!/^[a-zA-Z][a-zA-Z0-9]+$/.test(word)) return false;
  if (/^[A-Z]+$/.test(word)) return false;
  if (TEST_UTILITIES.has(word)) return false;
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

function fileImportsName(sf: ts.SourceFile, name: string): boolean {
  let found = false;
  function visit(n: ts.Node) {
    if (found) return;
    if (ts.isImportDeclaration(n)) {
      const clause = n.importClause;
      if (clause) {
        if (clause.name && clause.name.text === name) {
          found = true;
          return;
        }
        if (clause.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            for (const elem of clause.namedBindings.elements) {
              if (elem.name.text === name) {
                found = true;
                return;
              }
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  return found;
}

const DESCRIBE_SCOPE_IGNORE_LIST = new Set([
  'packages/web/src/lib/__tests__/aaa-toast.test.ts',
  'packages/ui/tests/icon-map.test.ts',
  'packages/daemon/tests/unit/5-space/runtime/space-worktree-manager.test.ts',
  'packages/daemon/tests/unit/1-core/providers/anthropic-copilot/provider.test.ts',
  'packages/daemon/tests/unit/1-core/providers/anthropic-copilot/server.test.ts',
  'packages/daemon/tests/unit/2-handlers/rpc-handlers/live-query-subscribe.test.ts',
  'packages/daemon/tests/unit/2-handlers/job-handlers/skill-validate.handler.test.ts',
  'packages/daemon/tests/unit/2-handlers/job-handlers/memory-consolidation.handler.test.ts',
  'packages/shared/tests/logger.test.ts',
]);

function findDescribeScopeMismatches(sf: ts.SourceFile, filePath: string): Finding[] {
  if (filePath.endsWith('.test.tsx')) return [];

  if (fileImportsRenderHook(sf)) return [];

  if (DESCRIBE_SCOPE_IGNORE_LIST.has(filePath)) return [];

  const findings: Finding[] = [];
  const describes = collectDescribeBlocks(sf, sf);

  function visitDescribe(desc: DescribeBlock) {
    for (const child of desc.children) {
      if (!isItBlock(child)) {
        visitDescribe(child);
      }
    }

    if (!desc.title) return;

    const trimmed = desc.title.trim();
    const words = trimmed.split(/\s+/);
    if (words.length !== 1) return;

    const describeName = words[0];
    if (!isCamelCaseFunctionName(describeName)) return;

    if (/^[A-Z]/.test(describeName)) return;

    if (titleMatchesFilename(describeName, filePath)) return;

    if (!fileImportsName(sf, describeName)) return;

    for (const child of desc.children) {
      if (isItBlock(child)) {
        const ids = extractIdentifiers(child.body);
        const hasDescribeFunction = ids.has(describeName);
        if (hasDescribeFunction) continue;

        const otherFunctions = Array.from(ids).filter(
          (id) => isCamelCaseFunctionName(id) && id !== describeName && !TEST_UTILITIES.has(id)
        );
        if (otherFunctions.length > 0) {
          findings.push({
            file: filePath,
            ...child.pos,
            message: `Test in describe('${describeName}') calls ${otherFunctions.join(', ')} but never calls ${describeName}. Consider moving to a describe block matching the function under test.`,
          });
        }
      }
    }
  }

  for (const desc of describes) {
    visitDescribe(desc);
  }

  return findings;
}

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
