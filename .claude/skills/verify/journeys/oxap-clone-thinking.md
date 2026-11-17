# OXAP clone thinking refusal

Run `proof-run.sh` with `oxap-clone-thinking.ts` and a fresh evidence directory, following the shared isolated daemon setup. The helper registers a synthetic OXAP provider, creates a parent, and invokes `session.clone.spawn` through the real WebSocket operation door. An explicit `off` level creates a chat, an ordinary clone succeeds, and an unsupported explicit thinking level returns a typed rejection and creates no child; the saved evidence records the reply and session counts. It does not run a model turn.
