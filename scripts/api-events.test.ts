import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { z } from '../packages/daemon/node_modules/zod/index.js';
import { THINKING_LEVELS } from '../packages/shared/src/types.ts';
import { CLIENT_EVENT_SCHEMAS } from '../packages/daemon/src/lib/operations/client-event-schemas.ts';
import { clientEventMethods, saveApiSurface, serializeApiSurface } from './api-surface.ts';
import { diffApiSurfaces, formatApiDiff, type ApiSurface } from './api-diff.ts';
import { extractPhoneEventMethods } from './api-phone-methods.ts';

const events = [
  'liveQuery.delta',
  'liveQuery.snapshot',
  'neo.changed',
  'neo.speech',
  'state.session',
  'state.settings',
  'voice.stream.text',
];
const payloads = {
  'liveQuery.delta': {
    subscriptionId: 'view',
    added: [{ id: 'message', text: 'Hello' }],
    version: 2,
    rowCount: 1,
  },
  'liveQuery.snapshot': {
    subscriptionId: 'view',
    rows: [{ id: 'message', text: 'Hello' }],
    version: 1,
  },
  'neo.changed': {},
  'neo.speech': { type: 'say', id: 'speech', sessionId: 'neo:fixture', text: 'Hello' },
  'state.session': {
    worker: null,
    sessionInfo: null,
    agentState: { status: 'idle' },
    commandsData: { availableCommands: [] },
    error: null,
    timestamp: 123,
    revision: 1,
    version: 1,
    daemonEpoch: 'boot',
  },
  'state.settings': {
    settings: { language: 'zh-Hans', settingSources: ['user'] },
    timestamp: 123,
    version: 1,
  },
  'voice.stream.text': { streamId: 'stream', text: 'Hello', isFinal: false },
};
test('direct event-message constructors and typed parameter objects are discovered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-methods-'));
  try {
    const file = join(dir, 'events.ts');
    writeFileSync(
      file,
      `declare function createEventMessage(value: {method: string; data: unknown; sessionId: string}): void;
      createEventMessage({method:'neo.speech',data:{},sessionId:'global'});
      const method = 'voice.stream.text';
      createEventMessage({method,data:{},sessionId:'global'});
      const parameters = {method:'liveQuery.snapshot' as const,data:{},sessionId:'global'};
      createEventMessage(parameters);`
    );
    expect(clientEventMethods(ts.createProgram([file], {}), [file])).toEqual([
      'liveQuery.snapshot',
      'neo.speech',
      'voice.stream.text',
    ]);
    writeFileSync(
      file,
      `declare function createEventMessage(value: {method: string}): void; declare const method: string; createEventMessage({method});`
    );
    expect(() => clientEventMethods(ts.createProgram([file], {}), [file])).toThrow('Unresolved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('every configured phone event has a payload contract, including direct message producers', () => {
  expect(Object.keys(CLIENT_EVENT_SCHEMAS).sort()).toEqual(events);
  for (const method of events) {
    const name = method as keyof typeof CLIENT_EVENT_SCHEMAS;
    expect(CLIENT_EVENT_SCHEMAS[name].safeParse(payloads[name]).success).toBe(true);
  }
});
test('speech variants retain their own required fields and discriminator', () => {
  const schema = CLIENT_EVENT_SCHEMAS['neo.speech'];
  for (const value of [
    { type: 'stop', sessionId: 'neo:fixture' },
    {
      type: 'say',
      id: 'speech',
      sessionId: 'neo:fixture',
      text: 'Hi',
      format: 'pcm16',
      sampleRate: 24000,
    },
    { type: 'audio', id: 'speech', sessionId: 'neo:fixture', seq: 0, pcm: 'AAAA' },
    { type: 'end', id: 'speech', sessionId: 'neo:fixture', seq: 1 },
    { type: 'failed', id: 'speech', sessionId: 'neo:fixture' },
  ])
    expect(schema.safeParse(value).success).toBe(true);
  expect(
    schema.safeParse({
      type: 'audio',
      id: 'speech',
      sessionId: 'neo:fixture',
      seq: 'wrong',
      pcm: 'AAAA',
    }).success
  ).toBe(false);
  expect(schema.safeParse({ type: 'unknown', sessionId: 'neo:fixture' }).success).toBe(false);
});
test('bad voice, query, settings and session data cannot look valid', () => {
  expect(
    CLIENT_EVENT_SCHEMAS['voice.stream.text'].safeParse({
      streamId: 'stream',
      text: 'Hi',
      isFinal: 'yes',
    }).success
  ).toBe(false);
  expect(
    CLIENT_EVENT_SCHEMAS['liveQuery.snapshot'].safeParse({
      subscriptionId: 'view',
      rows: 'wrong',
      version: 1,
    }).success
  ).toBe(false);
  expect(
    CLIENT_EVENT_SCHEMAS['liveQuery.delta'].safeParse({ subscriptionId: 'view', version: 'wrong' })
      .success
  ).toBe(false);
  expect(
    CLIENT_EVENT_SCHEMAS['state.settings'].safeParse({
      settings: { language: 'unexpected' },
      timestamp: 123,
    }).success
  ).toBe(false);
  expect(
    CLIENT_EVENT_SCHEMAS['state.session'].safeParse({
      ...payloads['state.session'],
      agentState: { status: 'unknown' },
    }).success
  ).toBe(false);
});
test('populated session states retain phone-read fields and extensible metadata', () => {
  const session = {
    ...payloads['state.session'],
    worker: { id: 'fixture', adapter: 'hyperneo', name: null, label: 'Public worker' },
    sessionInfo: {
      id: 'fixture',
      title: 'Public session',
      workspacePath: null,
      createdAt: 'now',
      lastActiveAt: 'now',
      status: 'active',
      config: { model: 'model', provider: 'provider', thinkingLevel: 'think32k', future: true },
      metadata: { pendingModelSwitch: { model: 'next', provider: 'provider' }, future: true },
    },
  };
  for (const agentState of [
    { status: 'idle' },
    { status: 'queued', messageId: 'message' },
    { status: 'processing', messageId: 'message', phase: 'thinking' },
    {
      status: 'waiting_for_input',
      pendingQuestion: {
        toolUseId: 'tool',
        askedAt: 1,
        questions: [
          {
            question: 'Continue?',
            header: 'Next step',
            multiSelect: false,
            options: [{ label: 'Yes', description: 'Continue the public fixture' }],
          },
        ],
      },
    },
    { status: 'rate_limit_cooldown', retryCount: 1, maxRetries: 3, retryAt: 1 },
    { status: 'interrupted' },
  ])
    expect(
      CLIENT_EVENT_SCHEMAS['state.session'].safeParse({ ...session, agentState }).success
    ).toBe(true);
  const exported = JSON.parse(serializeApiSurface([], events, [], CLIENT_EVENT_SCHEMAS));
  expect(exported.eventSchemas['state.settings'].properties.settings.additionalProperties).not.toBe(
    false
  );
});
test('question headers and option descriptions remain required on the wire', () => {
  const question = {
    question: 'Continue?',
    header: 'Next step',
    multiSelect: false,
    options: [{ label: 'Yes', description: 'Continue' }],
  };
  const valid = (value: unknown) =>
    CLIENT_EVENT_SCHEMAS['state.session'].safeParse({
      ...payloads['state.session'],
      agentState: {
        status: 'waiting_for_input',
        pendingQuestion: { toolUseId: 'tool', askedAt: 1, questions: [value] },
      },
    }).success;
  expect(valid(question)).toBe(true);
  expect(valid({ ...question, header: undefined })).toBe(false);
  expect(valid({ ...question, options: [{ label: 'Yes' }] })).toBe(false);
});
test('session config model and session status retain their producer constraints', () => {
  const base = {
    id: 'fixture',
    title: 'Public session',
    workspacePath: null,
    createdAt: 'now',
    lastActiveAt: 'now',
    status: 'active',
    config: { model: 'model' },
    metadata: {},
  };
  const valid = (sessionInfo: unknown) =>
    CLIENT_EVENT_SCHEMAS['state.session'].safeParse({ ...payloads['state.session'], sessionInfo })
      .success;
  expect(valid(base)).toBe(true);
  expect(valid({ ...base, config: {} })).toBe(false);
  expect(valid({ ...base, status: 'not-a-session-status' })).toBe(false);
});
test('generated event data schemas are stable and expose field types', () => {
  const first = serializeApiSurface([], events, [], CLIENT_EVENT_SCHEMAS);
  const again = serializeApiSurface([], [...events].reverse(), [], CLIENT_EVENT_SCHEMAS);
  expect(first).toBe(again);
  const surface = JSON.parse(first);
  expect(surface.eventSchemas['voice.stream.text'].properties.isFinal.type).toBe('boolean');
  expect(surface.eventSchemas['liveQuery.snapshot'].properties.rows.type).toBe('array');
  const session = surface.eventSchemas['state.session'].properties.sessionInfo.anyOf.find(
    (item: { type: string }) => item.type === 'object'
  );
  expect(session.properties.config.properties.thinkingLevel.enum).toEqual([...THINKING_LEVELS]);
  expect(
    surface.eventSchemas['neo.speech'].oneOf ?? surface.eventSchemas['neo.speech'].anyOf
  ).toHaveLength(5);
  expect(() => serializeApiSurface([], [], [], CLIENT_EVENT_SCHEMAS)).toThrow('event');
});

const dataSurface = (schema?: unknown): ApiSurface => ({
  operations: [],
  events: ['neo.speech'],
  ...(schema ? { eventSchemas: { 'neo.speech': schema } } : {}),
});
test('event payload changes use result compatibility rules and phone coverage', () => {
  const old = dataSurface({
    type: 'object',
    properties: { type: { type: 'string', enum: ['say'] }, text: { type: 'string' } },
    required: ['type', 'text'],
  });
  const next = dataSurface({
    type: 'object',
    properties: { type: { type: 'string', enum: ['say', 'audio'] } },
    required: ['type'],
  });
  const changes = diffApiSurfaces(old, next, ['neo.speech']);
  expect(changes).toContainEqual(
    expect.objectContaining({
      operation: 'neo.speech',
      path: 'event.data.type',
      level: 'risky',
      phoneUsed: true,
    })
  );
  expect(changes).toContainEqual(
    expect.objectContaining({ path: 'event.data.text', level: 'breaking' })
  );
});
test('first payload coverage is explicit and never claims historical compatibility', () => {
  const changes = diffApiSurfaces(dataSurface(), dataSurface({ type: 'string' }), ['neo.speech']);
  expect(changes).toEqual([
    expect.objectContaining({ coverageOnly: true, level: 'safe', path: 'event.data' }),
  ]);
  expect(formatApiDiff('before', 'after', changes)).toContain(
    'phone-used operations: 0 breaking, 0 risky, 0 safe'
  );
  expect(formatApiDiff('before', 'after', changes)).toContain('untracked');
  expect(
    diffApiSurfaces(dataSurface({ type: 'string' }), dataSurface(), ['neo.speech'])[0]?.level
  ).toBe('breaking');
});
test('phone source inventory separates literal event subscriptions from requests', () => {
  expect(
    extractPhoneEventMethods(
      'hub.onEvent("neo.speech") { _ in }; hub.invoke("neo.snapshot"); hub.onEvent("neo.speech") { _ in }'
    )
  ).toEqual(['neo.speech']);
});
test('payload schema edits actually produce different exported contracts', () => {
  const a = serializeApiSurface([], ['voice.stream.text'], [], {
    'voice.stream.text': z.object({ isFinal: z.boolean() }),
  });
  const b = serializeApiSurface([], ['voice.stream.text'], [], {
    'voice.stream.text': z.object({ isFinal: z.string() }),
  });
  expect(a).not.toBe(b);
  const directory = mkdtempSync(join(tmpdir(), 'event-drift-'));
  try {
    const file = join(directory, 'surface.json');
    saveApiSurface(file, a, false);
    expect(() => saveApiSurface(file, b, true)).toThrow('changed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  expect(diffApiSurfaces(JSON.parse(a), JSON.parse(b), ['voice.stream.text'])[0]).toMatchObject({
    path: 'event.data.isFinal',
    level: 'breaking',
  });
});
