import { describe, test, expect } from 'bun:test';
import {
  MessageType,
  GLOBAL_SESSION_ID,
  createEventMessage,
  createRequestMessage,
  createResponseMessage,
  createErrorResponseMessage,
  isValidMessage,
  isEventMessage,
  isRequestMessage,
  isResponseMessage,
  validateMethod,
} from '../src/message-hub/protocol.ts';

describe('MessageHub Protocol', () => {
  describe('Message Type Constants', () => {
    test('should define all message types', () => {
      expect(MessageType.EVENT).toBe(MessageType.EVENT);
      expect(MessageType.PING).toBe(MessageType.PING);
      expect(MessageType.PONG).toBe(MessageType.PONG);
      expect(MessageType.REQUEST).toBe(MessageType.REQUEST);
      expect(MessageType.RESPONSE).toBe(MessageType.RESPONSE);
    });

    test('should define global session ID', () => {
      expect(GLOBAL_SESSION_ID).toBe('global');
    });
  });

  describe('Message Creators', () => {
    test('createEventMessage should create valid EVENT message', () => {
      const msg = createEventMessage({
        method: 'user.created',
        data: { userId: 123 },
        sessionId: 'session1',
        id: 'evt123',
      });

      expect(msg.type).toBe(MessageType.EVENT);
      expect(msg.sessionId).toBe('session1');
      expect(msg.method).toBe('user.created');
      expect(msg.data).toEqual({ userId: 123 });
      expect(msg.id).toBe('evt123');
      expect(msg.timestamp).toBeTruthy();
    });

    test('createRequestMessage should create valid REQUEST message', () => {
      const msg = createRequestMessage({
        method: 'test.request',
        data: { foo: 'bar' },
        sessionId: 'session1',
        id: 'req123',
      });

      expect(msg.type).toBe(MessageType.REQUEST);
      expect(msg.sessionId).toBe('session1');
      expect(msg.method).toBe('test.request');
      expect(msg.data).toEqual({ foo: 'bar' });
      expect(msg.id).toBe('req123');
      expect(msg.timestamp).toBeTruthy();
    });

    test('createResponseMessage should create valid RESPONSE message', () => {
      const msg = createResponseMessage({
        method: 'test.method',
        data: { result: 'success' },
        sessionId: 'session1',
        requestId: 'req123',
        id: 'rsp456',
      });

      expect(msg.type).toBe(MessageType.RESPONSE);
      expect(msg.requestId).toBe('req123');
      expect(msg.sessionId).toBe('session1');
      expect(msg.method).toBe('test.method');
      expect(msg.data).toEqual({ result: 'success' });
      expect(msg.id).toBe('rsp456');
      expect(msg.timestamp).toBeTruthy();
    });

    test('createErrorResponseMessage should create valid error RESPONSE message', () => {
      const msg = createErrorResponseMessage({
        method: 'test.method',
        error: {
          code: 'TEST_ERROR',
          message: 'Something went wrong',
        },
        sessionId: 'session1',
        requestId: 'req123',
        id: 'err789',
      });

      expect(msg.type).toBe(MessageType.RESPONSE);
      expect(msg.requestId).toBe('req123');
      expect(msg.sessionId).toBe('session1');
      expect(msg.method).toBe('test.method');
      expect(msg.error).toBe('Something went wrong');
      expect(msg.errorCode).toBe('TEST_ERROR');
      expect(msg.id).toBe('err789');
      expect(msg.timestamp).toBeTruthy();
    });

    test('createErrorResponseMessage should handle string error', () => {
      const msg = createErrorResponseMessage({
        method: 'test.method',
        error: 'Simple error message',
        sessionId: 'session1',
        requestId: 'req123',
        id: 'err999',
      });

      expect(msg.type).toBe(MessageType.RESPONSE);
      expect(msg.error).toBe('Simple error message');
      expect(msg.errorCode).toBeUndefined();
    });
  });

  describe('Message Validators', () => {
    test('isValidMessage should validate message structure', () => {
      const validMsg = createRequestMessage({
        method: 'test.method',
        data: {},
        sessionId: 'session1',
        id: 'msg1',
      });
      expect(isValidMessage(validMsg)).toBe(true);

      expect(isValidMessage({})).toBe(false);
      expect(isValidMessage({ id: '123' })).toBe(false);
      expect(isValidMessage({ id: '123', type: 'REQ' })).toBe(false);
      expect(isValidMessage({ id: '123', type: 'REQ', sessionId: 's1' })).toBe(false);
    });

    test('isEventMessage should identify EVENT messages', () => {
      const eventMsg = createEventMessage({
        method: 'event.happened',
        data: {},
        sessionId: 's1',
        id: 'msg1',
      });
      const requestMsg = createRequestMessage({
        method: 'event.request',
        data: {},
        sessionId: 's1',
        id: 'msg2',
      });

      expect(isEventMessage(eventMsg)).toBe(true);
      expect(isEventMessage(requestMsg)).toBe(false);
    });

    test('isRequestMessage should identify REQUEST messages', () => {
      const requestMsg = createRequestMessage({
        method: 'test.request',
        data: {},
        sessionId: 's1',
        id: 'msg1',
      });
      const eventMsg = createEventMessage({
        method: 'test.event',
        data: {},
        sessionId: 's1',
        id: 'msg2',
      });

      expect(isRequestMessage(requestMsg)).toBe(true);
      expect(isRequestMessage(eventMsg)).toBe(false);
    });

    test('isResponseMessage should identify RESPONSE messages', () => {
      const responseMsg = createResponseMessage({
        method: 'test',
        data: {},
        sessionId: 's1',
        requestId: 'req1',
        id: 'msg1',
      });
      const errorMsg = createErrorResponseMessage({
        method: 'test',
        error: 'fail',
        sessionId: 's1',
        requestId: 'req1',
        id: 'msg2',
      });
      const requestMsg = createRequestMessage({
        method: 'test',
        data: {},
        sessionId: 's1',
        id: 'msg3',
      });

      expect(isResponseMessage(responseMsg)).toBe(true);
      expect(isResponseMessage(errorMsg)).toBe(true);
      expect(isResponseMessage(requestMsg)).toBe(false);
    });
  });

  describe('Method Validation', () => {
    test('should accept valid method names', () => {
      expect(validateMethod('session.create')).toBe(true);
      expect(validateMethod('user.updated')).toBe(true);
      expect(validateMethod('client.getViewportInfo')).toBe(true);
      expect(validateMethod('deeply.nested.method.name')).toBe(true);
      expect(validateMethod('method_with_underscore.test')).toBe(true);
      expect(validateMethod('method-with-dash.test')).toBe(true);
    });

    test('should reject invalid method names', () => {
      expect(validateMethod('no-dot')).toBe(false);
      expect(validateMethod('.starts-with-dot')).toBe(false);
      expect(validateMethod('ends-with-dot.')).toBe(false);
      expect(validateMethod('has space.method')).toBe(false);
      expect(validateMethod('has@symbol.method')).toBe(false);
      expect(validateMethod('')).toBe(false);
    });
  });

  describe('Message IDs', () => {
    test('should use provided message ID', () => {
      const msg1 = createRequestMessage({
        method: 'test.request',
        data: {},
        sessionId: 's1',
        id: 'custom-id-1',
      });
      const msg2 = createRequestMessage({
        method: 'test.request',
        data: {},
        sessionId: 's1',
        id: 'custom-id-2',
      });

      expect(msg1.id).toBe('custom-id-1');
      expect(msg2.id).toBe('custom-id-2');
      expect(msg1.id).not.toBe(msg2.id);
    });

    test('should include timestamp in all messages', () => {
      const msg = createRequestMessage({
        method: 'test.request',
        data: {},
        sessionId: 's1',
        id: 'msg1',
      });
      const timestamp = new Date(msg.timestamp);

      expect(timestamp.getTime()).toBeGreaterThan(Date.now() - 1000);
      expect(timestamp.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });
});
