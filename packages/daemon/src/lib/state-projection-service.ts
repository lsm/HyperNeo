import type { MessageHub, AgentProcessingState, IClientEventGateway } from '@hyperneo/shared';
import type { SessionManager } from './session-manager.ts';
import type { AuthManager } from './auth-manager.ts';
import type { SettingsManager } from './settings-manager.ts';
import type { ProviderCredentialManager } from './credentials/provider-credential-manager.ts';
import type { Config } from '../config.ts';
import type { Database } from '../storage/database.ts';
import type { ReactiveDatabase } from '../storage/reactive-database.ts';
import { Logger } from './logger.ts';
import type {
  SessionsState,
  SystemState,
  SettingsState,
  GlobalStateSnapshot,
  SessionStateSnapshot,
  SessionState,
  SDKMessagesState,
  SDKMessagesUpdate,
} from '@hyperneo/shared';
import type { Session } from '@hyperneo/shared';
import { ClientEventGateway, STATE_CHANNELS } from '@hyperneo/shared';
import { SDKMessageRepository } from '../storage/repositories/sdk-message-repository.ts';
import type { DaemonInternalEventMap, InternalEventBus } from './internal-event-bus.ts';
import { sanitizeGlobalSettings } from './rpc-handlers/settings-handlers.ts';

const VERSION = '0.1.1';
const CLAUDE_SDK_VERSION = '0.1.37';
const startTime = Date.now();

export class StateProjectionService {
  private channelVersions = new Map<string, number>();
  private sessionRevisions = new Map<string, number>();
  private readonly bootEpoch: string;
  private logger = new Logger('StateProjectionService');

  private clientEvents: IClientEventGateway;

  private apiConnectionState: import('@hyperneo/shared').ApiConnectionState = {
    status: 'connected',
    timestamp: Date.now(),
  };

  private sessionCache = new Map<string, Session>();
  private processingStateCache = new Map<string, AgentProcessingState>();
  private commandsCache = new Map<string, string[]>();
  private errorCache = new Map<
    string,
    { message: string; details?: unknown; occurredAt: number } | null
  >();

  constructor(
    private messageHub: MessageHub,
    private sessionManager: SessionManager,
    private authManager: AuthManager,
    private settingsManager: SettingsManager,
    private config: Config,
    private db?: Database,
    private internalEventBus?: InternalEventBus<DaemonInternalEventMap>,
    clientEvents?: IClientEventGateway,
    private credentialManager?: ProviderCredentialManager,
    private reactiveDb?: ReactiveDatabase
  ) {
    this.clientEvents = clientEvents ?? new ClientEventGateway({ hub: messageHub });
    this.bootEpoch = crypto.randomUUID();
    this.setupHandlers();
    this.setupEventBusSubscriptions();
  }

  getClientEventGateway(): IClientEventGateway {
    return this.clientEvents;
  }

  private setupEventBusSubscriptions(): void {
    if (!this.internalEventBus) {
      this.logger.warn(
        'No InternalEventBus provided; state projection will not receive cache updates'
      );
      return;
    }

    this.internalEventBus.subscribe(
      'api.connection',
      (data) => {
        this.apiConnectionState = data as import('@hyperneo/shared').ApiConnectionState;
      },
      { subscriberName: 'StateProjectionService.apiConnection' }
    );

    this.internalEventBus.subscribe(
      'session.created',
      (data) => {
        const { session } = data as unknown as { session: Session };
        this.sessionCache.set(session.id, session);
        this.processingStateCache.set(session.id, { status: 'idle' });
      },
      { subscriberName: 'StateProjectionService.sessionCreated' }
    );

    this.internalEventBus.subscribe(
      'session.updated',
      async (data) => {
        const { sessionId, session, processingState } = data as unknown as {
          sessionId: string;
          session?: Partial<Session>;
          processingState?: AgentProcessingState;
        };

        if (session) {
          const existing = this.sessionCache.get(sessionId);
          if (existing) {
            this.sessionCache.set(sessionId, { ...existing, ...session });
          }
        }
        if (processingState) {
          this.processingStateCache.set(sessionId, processingState);
        }

        await this.broadcastSessionUpdateFromCache(sessionId);
      },
      { subscriberName: 'StateProjectionService.sessionUpdated' }
    );

    this.internalEventBus.subscribe(
      'session.deleted',
      (data) => {
        const { sessionId } = data as unknown as { sessionId: string };

        this.sessionCache.delete(sessionId);
        this.processingStateCache.delete(sessionId);
        this.commandsCache.delete(sessionId);
        this.errorCache.delete(sessionId);

        this.channelVersions.delete(`${STATE_CHANNELS.SESSION}:${sessionId}`);
        this.channelVersions.delete(`${STATE_CHANNELS.SESSION_SDK_MESSAGES}:${sessionId}`);
        this.channelVersions.delete(`${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta:${sessionId}`);
        this.sessionRevisions.delete(sessionId);
      },
      { subscriberName: 'StateProjectionService.sessionDeleted' }
    );

    this.internalEventBus.subscribe(
      'settings.updated',
      async () => {
        await this.broadcastSettingsChange();
      },
      { subscriberName: 'StateProjectionService.settingsUpdated' }
    );

    this.internalEventBus.subscribe(
      'commands.updated',
      (data) => {
        const { sessionId, commands } = data as unknown as {
          sessionId: string;
          commands: string[];
        };
        this.commandsCache.set(sessionId, commands);
      },
      { subscriberName: 'StateProjectionService.commandsUpdated' }
    );

    this.internalEventBus.subscribe(
      'session.error',
      (data) => {
        const { sessionId, error, details } = data as unknown as {
          sessionId: string;
          error: string;
          details?: unknown;
        };
        this.errorCache.set(sessionId, {
          message: error,
          details,
          occurredAt: Date.now(),
        });
        this.persistSessionError(sessionId, details);
      },
      { subscriberName: 'StateProjectionService.sessionError' }
    );

    this.internalEventBus.subscribe(
      'session.errorClear',
      (data) => {
        const { sessionId } = data as unknown as { sessionId: string };
        this.errorCache.set(sessionId, null);
        this.persistSessionError(sessionId, null);
      },
      { subscriberName: 'StateProjectionService.sessionErrorClear' }
    );
  }

  private persistSessionError(sessionId: string, details: unknown): void {
    if (!this.db) return;
    try {
      const db = this.db.getDatabase();
      if (!details) {
        db.prepare('UPDATE sessions SET last_error = NULL WHERE id = ?').run(sessionId);
        this.reactiveDb?.notifyChange('sessions');
        return;
      }
      const err = details as {
        category?: unknown;
        userMessage?: unknown;
        message?: unknown;
        metadata?: Record<string, unknown> | undefined;
      };
      const category = typeof err.category === 'string' ? err.category : null;
      if (!category) return;
      const message =
        (typeof err.userMessage === 'string' && err.userMessage) ||
        (typeof err.message === 'string' && err.message) ||
        '';
      const providerIdRaw = err.metadata?.providerId;
      const snapshot: Record<string, unknown> = { category, message };
      if (typeof providerIdRaw === 'string') snapshot.providerId = providerIdRaw;
      db.prepare('UPDATE sessions SET last_error = ? WHERE id = ?').run(
        JSON.stringify(snapshot),
        sessionId
      );
      this.reactiveDb?.notifyChange('sessions');
    } catch (err) {
      this.logger.warn(`Failed to persist session error for ${sessionId}:`, err);
    }
  }

  private async broadcastSessionUpdateFromCache(sessionId: string): Promise<void> {
    try {
      await this.broadcastSessionStateChange(sessionId);
    } catch (error) {
      this.logger.warn(`Failed to broadcast session update for ${sessionId}:`, error);
    }
  }

  private incrementVersion(channel: string): number {
    const current = this.channelVersions.get(channel) || 0;
    const next = current + 1;
    this.channelVersions.set(channel, next);
    return next;
  }

  private nextSessionRevision(sessionId: string): number {
    const current = this.sessionRevisions.get(sessionId) || 0;
    const next = current + 1;
    this.sessionRevisions.set(sessionId, next);
    return next;
  }

  private setupHandlers(): void {
    this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SNAPSHOT, async () => {
      return await this.getGlobalSnapshot();
    });

    this.messageHub.onRequest(STATE_CHANNELS.SESSION_SNAPSHOT, async (data) => {
      const { sessionId } = data as { sessionId: string };
      return await this.getSessionSnapshot(sessionId);
    });

    this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SYSTEM, async () => {
      return await this.getSystemState();
    });

    this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SESSIONS, async () => {
      return await this.getSessionsState();
    });

    this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SETTINGS, async () => {
      return await this.getSettingsState();
    });

    this.messageHub.onRequest(STATE_CHANNELS.SESSION, async (data) => {
      const { sessionId } = data as { sessionId: string };
      return await this.getSessionState(sessionId);
    });

    this.messageHub.onRequest(STATE_CHANNELS.SESSION_SDK_MESSAGES, async (data) => {
      const { sessionId, since } = data as {
        sessionId: string;
        since?: number;
      };
      return await this.getSDKMessagesState(sessionId, since);
    });
  }

  async getGlobalSnapshot(): Promise<GlobalStateSnapshot> {
    const [sessions, system, settings] = await Promise.all([
      this.getSessionsState(),
      this.getSystemState(),
      this.getSettingsState(),
    ]);

    return {
      sessions,
      system,
      settings,
      meta: {
        channel: 'global',
        sessionId: 'global',
        lastUpdate: Date.now(),
        version: this.channelVersions.get('global') || 0,
      },
    };
  }

  private async getSystemState(): Promise<SystemState> {
    const authStatus = await this.authManager.getAuthStatus();

    return {
      version: VERSION,
      claudeSDKVersion: CLAUDE_SDK_VERSION,

      defaultModel: this.config.defaultModel,
      maxSessions: this.config.maxSessions,
      storageLocation: this.config.dbPath,
      workspaceRoot: this.config.workspaceRoot,

      auth: authStatus,

      health: {
        status: 'ok' as const,
        version: VERSION,
        uptime: Date.now() - startTime,
        sessions: {
          active: this.sessionManager.getActiveSessions(),
          total: this.sessionManager.getTotalSessions(),
        },
      },

      apiConnection: this.apiConnectionState,

      credentialStore: this.credentialManager?.getCredentialStoreStatus() ?? {
        backend: 'database',
        keychainAvailable: false,
      },

      timestamp: Date.now(),
    };
  }

  private async getSettingsState(): Promise<SettingsState> {
    const settings = sanitizeGlobalSettings(
      this.settingsManager.getGlobalSettings(),
      this.credentialManager
    );
    return {
      settings,
      timestamp: Date.now(),
    };
  }

  private async getSessionsState(): Promise<SessionsState> {
    const settings = this.settingsManager.getGlobalSettings();

    const allSessions = this.sessionManager.listSessions({ includeArchived: true });
    const hasArchivedSessions = allSessions.some((s) => s.status === 'archived');

    const sessions = settings.showArchived ? allSessions : this.sessionManager.listSessions();

    return {
      sessions,
      hasArchivedSessions,
      timestamp: Date.now(),
    };
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionStateSnapshot> {
    const [session, sdkMessages] = await Promise.all([
      this.getSessionState(sessionId),
      this.getSDKMessagesState(sessionId),
    ]);

    return {
      session,
      sdkMessages,
      meta: {
        channel: 'session',
        sessionId,
        lastUpdate: Date.now(),
        version: this.channelVersions.get(`session:${sessionId}`) || 0,
      },
    };
  }

  private async getSessionState(sessionId: string): Promise<SessionState> {
    const agentSession = await this.sessionManager.getSessionAsync(sessionId);
    if (!agentSession) {
      if (sessionId.startsWith('room:') || sessionId.startsWith('conv:')) {
        return {
          sessionInfo: null,
          agentState: { status: 'idle' },
          commandsData: { availableCommands: [] },
          error: null,
          timestamp: Date.now(),
          revision: this.nextSessionRevision(sessionId),
          daemonEpoch: this.bootEpoch,
        };
      }
      throw new Error('Session not found');
    }

    const revision = this.nextSessionRevision(sessionId);

    const sessionData = agentSession.getSessionData();
    const agentState =
      this.processingStateCache.get(sessionId) ?? agentSession.getProcessingState();
    const commands = await agentSession.getSlashCommands();

    const error = this.errorCache.get(sessionId) || null;

    return {
      sessionInfo: sessionData,
      agentState: agentState,
      commandsData: {
        availableCommands: commands,
      },
      error: error,
      timestamp: Date.now(),
      revision,
      daemonEpoch: this.bootEpoch,
    };
  }

  private async getSDKMessagesState(sessionId: string, since?: number): Promise<SDKMessagesState> {
    const agentSession = await this.sessionManager.getSessionAsync(sessionId);
    if (!agentSession) {
      if ((sessionId.startsWith('room:') || sessionId.startsWith('conv:')) && this.db) {
        const sdkMessageRepo = new SDKMessageRepository(this.db.getDatabase());
        const { messages: sdkMessages, hasMore } = sdkMessageRepo.getSDKMessages(
          sessionId,
          100,
          undefined,
          since
        );
        return { sdkMessages, hasMore, timestamp: Date.now() };
      }
      throw new Error('Session not found');
    }

    const { messages: sdkMessages, hasMore } = agentSession.getSDKMessages(100, undefined, since);

    return {
      sdkMessages,
      hasMore,
      timestamp: Date.now(),
    };
  }

  async broadcastSystemChange(): Promise<void> {
    const version = this.incrementVersion(STATE_CHANNELS.GLOBAL_SYSTEM);
    const state = { ...(await this.getSystemState()), version };

    this.messageHub.event(STATE_CHANNELS.GLOBAL_SYSTEM, state, {
      channel: 'global',
    });
  }

  async broadcastSettingsChange(): Promise<void> {
    const version = this.incrementVersion(STATE_CHANNELS.GLOBAL_SETTINGS);
    const state = { ...(await this.getSettingsState()), version };

    this.messageHub.event(STATE_CHANNELS.GLOBAL_SETTINGS, state, {
      channel: 'global',
    });
  }

  async broadcastSessionStateChange(sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }

    const version = this.incrementVersion(`${STATE_CHANNELS.SESSION}:${sessionId}`);

    try {
      const state = { ...(await this.getSessionState(sessionId)), version };

      this.messageHub.event(STATE_CHANNELS.SESSION, state, {
        channel: `session:${sessionId}`,
      });
    } catch (error) {
      this.logger.warn(
        `[StateProjectionService] Failed to broadcast session state for ${sessionId}:`,
        error instanceof Error ? error.message : error
      );

      const cachedProcessingState = this.processingStateCache.get(sessionId);
      const cachedSession = this.sessionCache.get(sessionId);
      if (cachedProcessingState && cachedSession) {
        try {
          const fallbackState = {
            sessionInfo: cachedSession,
            agentState: cachedProcessingState,
            commandsData: { availableCommands: this.commandsCache.get(sessionId) || [] },
            error: this.errorCache.get(sessionId) ?? null,
            timestamp: Date.now(),
            version,
            revision: this.nextSessionRevision(sessionId),
            daemonEpoch: this.bootEpoch,
          };
          this.messageHub.event(STATE_CHANNELS.SESSION, fallbackState, {
            channel: `session:${sessionId}`,
          });
        } catch (fallbackError) {
          this.logger.error(
            `[StateProjectionService] Fallback broadcast also failed for ${sessionId}:`,
            fallbackError instanceof Error ? fallbackError.message : fallbackError
          );
        }
      }
    }
  }

  async broadcastSDKMessagesChange(sessionId: string): Promise<void> {
    const version = this.incrementVersion(`${STATE_CHANNELS.SESSION_SDK_MESSAGES}:${sessionId}`);
    const state = { ...(await this.getSDKMessagesState(sessionId)), version };

    this.messageHub.event(STATE_CHANNELS.SESSION_SDK_MESSAGES, state, {
      channel: `session:${sessionId}`,
    });
  }

  async broadcastSDKMessagesDelta(sessionId: string, update: SDKMessagesUpdate): Promise<void> {
    const version = this.incrementVersion(
      `${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta:${sessionId}`
    );
    this.messageHub.event(
      `${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta`,
      { ...update, version },
      { channel: `session:${sessionId}` }
    );
  }
}
