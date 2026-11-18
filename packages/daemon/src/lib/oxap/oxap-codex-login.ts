import { generateUUID, type JsonRpcNotification } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { startCodexBootstrapServer, type CodexAppServer } from '../drivers/codex-app-server.ts';
import type { OxapReopenEvents, OxapReopenStore } from './oxap-reopen.ts';

const SIGN_IN_FAILURE = 'Codex is not signed in. Sign in, then send again.';
const LOGIN_TIMEOUT_MS = 15 * 60_000;
type AuthMessage = Extract<SDKMessage, { type: 'auth_status' }>;
type Completion = { loginId?: string; success?: boolean; error?: string | null };
type Code = { loginId: string; verificationUrl: string; userCode: string };
type Login = { code: Promise<Code>; done: Promise<Completion> };
let pending: Login | undefined;

function beginLogin(
  server: CodexAppServer,
  subscribe: (receive: (completion: Completion) => void) => void,
  exited: Promise<void>
): Login {
  let show!: (code: Code) => void;
  let fail!: (error: unknown) => void;
  const code = new Promise<Code>((resolve, reject) => {
    show = resolve;
    fail = reject;
  });
  const done = (async () => {
    const notifications: Completion[] = [];
    let receive: ((completion: Completion) => void) | undefined;
    subscribe((completion) => {
      if (receive) receive(completion);
      else notifications.push(completion);
    });
    const started = (await server.call('account/login/start', {
      type: 'chatgptDeviceCode',
    })) as Code;
    show(started);
    return await new Promise<Completion>((resolve, reject) => {
      const timer = setTimeout(() => {
        void server.call('account/login/cancel', { loginId: started.loginId }).catch(() => {});
        resolve({ loginId: started.loginId, success: false, error: SIGN_IN_FAILURE });
      }, LOGIN_TIMEOUT_MS);
      void exited.then(() => {
        clearTimeout(timer);
        reject(new Error('Codex app-server exited during sign-in'));
      });
      receive = (completion) => {
        if (completion.loginId !== started.loginId) return;
        clearTimeout(timer);
        resolve(completion);
      };
      for (const completion of notifications) receive(completion);
    });
  })().catch((error: unknown) => {
    fail(error);
    throw error;
  });
  const login = { code, done };
  void done.then(
    () => {
      if (pending === login) pending = undefined;
    },
    () => {
      if (pending === login) pending = undefined;
    }
  );
  return login;
}

async function status(
  sessionId: string,
  uuid: AuthMessage['uuid'],
  output: string[],
  isAuthenticating: boolean,
  db: OxapReopenStore,
  hub: OxapReopenEvents,
  error?: string
): Promise<void> {
  const message: AuthMessage = {
    type: 'auth_status',
    uuid,
    session_id: sessionId,
    output,
    isAuthenticating,
    ...(error ? { error } : {}),
  };
  const saved = isAuthenticating
    ? await db.saveSDKMessage(sessionId, message)
    : await db.updateAuthStatusMessage(sessionId, message);
  if (!saved) throw new Error('Could not save auth status');
  hub.event(
    'state.sdkMessages.delta',
    { added: [message], timestamp: Date.now() },
    {
      channel: `session:${sessionId}`,
    }
  );
}

export async function checkCodexLogin(
  sessionId: string,
  db: OxapReopenStore,
  hub: OxapReopenEvents,
  executable: string
): Promise<void> {
  let receive: ((completion: Completion) => void) | undefined;
  const notify = (message: JsonRpcNotification) => {
    if (message.method === 'account/login/completed') receive?.(message.params as Completion);
  };
  let reportExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    reportExit = resolve;
  });
  const server = await startCodexBootstrapServer(executable, notify, reportExit);
  let owned: Login | undefined;
  let finished = false;
  try {
    const account = (await server.call('account/read', { refreshToken: false })) as {
      account: unknown;
    };
    if (account.account !== null) return;
    const login =
      pending ??
      (pending = owned =
        beginLogin(
          server,
          (callback) => {
            receive = callback;
          },
          exited
        ));
    const code = await login.code;
    const uuid = generateUUID() as AuthMessage['uuid'];
    await status(
      sessionId,
      uuid,
      [`Open ${code.verificationUrl}`, `Enter code ${code.userCode}`],
      true,
      db,
      hub
    );
    let completion: Completion;
    try {
      completion = await login.done;
      finished = true;
    } catch (error) {
      completion = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await status(
      sessionId,
      uuid,
      [],
      false,
      db,
      hub,
      completion.success ? undefined : (completion.error ?? SIGN_IN_FAILURE)
    );
    if (!completion.success) throw new Error(SIGN_IN_FAILURE);
  } finally {
    if (owned && !finished) {
      void owned.done
        .then(
          () => server.close(),
          () => server.close()
        )
        .catch(() => {});
    } else {
      await server.close();
    }
  }
}
