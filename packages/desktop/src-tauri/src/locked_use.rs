use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{Duration, Instant};

pub(crate) struct LockedUse {
    stdin: ChildStdin,
}

impl LockedUse {
    pub(crate) fn keep_alive(&mut self) -> std::io::Result<()> {
        writeln!(self.stdin, "alive")
    }
}

fn start(guardian: &Path, idle_seconds: u32, relock: fn()) -> std::io::Result<(LockedUse, Events)> {
    let mut child = Command::new(guardian)
        .arg(idle_seconds.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let (lines, watch) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let mut covered = false;
        let mut ended = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            covered |= line.starts_with("covered ");
            ended = line.starts_with("ended ");
            log::info!("Locked Use guardian: {line}");
            let _ = lines.send(GuardianEvent::Line(line));
        }
        let clean = child.wait().is_ok_and(|status| {
            ended && (status.success() || (!covered && status.code() == Some(2)))
        });
        if !clean {
            relock();
        }
        let _ = lines.send(GuardianEvent::Exited { crashed: !clean });
    });
    Ok((LockedUse { stdin }, watch))
}

const IDLE_SECONDS: u32 = 120;
const UNLOCK: Duration = Duration::from_secs(15);
const RELEASE: Duration = Duration::from_secs(15);
const LOCK_CHECK: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub(super) struct Turn(pub(super) u64, pub(super) watch::Receiver<u64>);

impl Turn {
    pub(super) fn stopped(turn: &Option<Self>) -> bool {
        turn.as_ref().is_some_and(|turn| *turn.1.borrow() >= turn.0)
    }

    pub(super) async fn cancelled(turn: &mut Option<Self>) {
        if let Some(Self(sequence, revoked)) = turn {
            let _ = revoked.wait_for(|value| *value >= *sequence).await;
        } else {
            std::future::pending::<()>().await;
        }
    }
}

/// The one owner of this Mac's Locked Use state. Every start, act, call end, hold, retire
/// and guardian event is a message it handles in order, and only it starts the guardian.
#[derive(Clone)]
pub(crate) struct Gatekeeper {
    messages: mpsc::UnboundedSender<Message>,
}

enum Message {
    Gate {
        worker: String,
        locked: bool,
        turn: Option<Turn>,
        reply: oneshot::Sender<Option<Grant>>,
    },
    Unclaimed {
        session: u64,
    },
    Act {
        worker: String,
        reply: oneshot::Sender<Option<Acting>>,
    },
    Done {
        worker: String,
        id: u64,
        settled: bool,
    },
    Hold {
        worker: String,
    },
    Release {
        worker: String,
        retired: bool,
        reply: oneshot::Sender<()>,
    },
}

enum GuardianEvent {
    Line(String),
    Exited { crashed: bool },
}

type Events = mpsc::UnboundedReceiver<GuardianEvent>;
type LockState = fn() -> Option<bool>;

enum State {
    Idle,
    Suppressed {
        wait_for_lock: bool,
    },
    Starting {
        worker: String,
        turn: Option<Turn>,
        session: u64,
        guardian: LockedUse,
        lines: Events,
        until: Instant,
        reply: oneshot::Sender<Option<Grant>>,
    },
    Owned {
        worker: String,
        turn: Option<Turn>,
        session: u64,
        guardian: LockedUse,
        lines: Events,
    },
    /// The guardian's input is closed; it stays here until the guardian process exits.
    Releasing {
        worker: String,
        lines: Events,
    },
}

/// A call's admission to act, built by the actor. Settled until the caller receives it, so a
/// cancelled admission only ends; dropped unsettled after that, it blocks new starts until a
/// confirmed retire.
pub(crate) struct Acting {
    messages: mpsc::UnboundedSender<Message>,
    worker: String,
    id: u64,
    pub(crate) settled: bool,
}

impl Drop for Acting {
    fn drop(&mut self) {
        let _ = self.messages.send(Message::Done {
            worker: std::mem::take(&mut self.worker),
            id: self.id,
            settled: self.settled,
        });
    }
}

/// A yes to a gate. One that hands over the Mac returns it to the actor unless received.
pub(crate) struct Grant {
    handback: Option<(mpsc::UnboundedSender<Message>, u64)>,
}

impl Drop for Grant {
    fn drop(&mut self) {
        if let Some((messages, session)) = self.handback.take() {
            let _ = messages.send(Message::Unclaimed { session });
        }
    }
}

const YES: Option<Grant> = Some(Grant { handback: None });

impl Gatekeeper {
    pub(crate) fn new(
        guardian: PathBuf,
        enabled: impl Fn(&str) -> bool + Send + 'static,
        lock_state: Option<LockState>,
    ) -> (Self, impl std::future::Future<Output = ()> + Send) {
        let (messages, inbox) = mpsc::unbounded_channel();
        let own = messages.downgrade();
        (
            Self { messages },
            run(inbox, own, guardian, enabled, lock_state),
        )
    }

    pub(super) async fn gate(&self, worker: &str, locked: bool, turn: Option<Turn>) -> bool {
        let (reply, answer) = oneshot::channel();
        let gate = Message::Gate {
            worker: worker.to_owned(),
            locked,
            turn,
            reply,
        };
        if self.messages.send(gate).is_err() {
            return false;
        }
        let Ok(Some(mut grant)) = answer.await else {
            return false;
        };
        grant.handback = None;
        true
    }

    pub(crate) async fn act(&self, worker: &str) -> Option<Acting> {
        let (reply, answer) = oneshot::channel();
        let act = Message::Act {
            worker: worker.to_owned(),
            reply,
        };
        self.messages.send(act).ok()?;
        let mut acting = answer.await.ok()??;
        acting.settled = false;
        Some(acting)
    }

    pub(crate) fn hold(&self, worker: &str) {
        let _ = self.messages.send(Message::Hold {
            worker: worker.to_owned(),
        });
    }

    /// Clears the worker's marks and ends its session; true once its guardian has exited.
    pub(crate) async fn retired(&self, worker: &str) -> bool {
        self.wait_for_release(worker, true).await
    }

    pub(super) async fn cancel_turn(&self, worker: &str) -> bool {
        self.wait_for_release(worker, false).await
    }

    async fn wait_for_release(&self, worker: &str, retired: bool) -> bool {
        let (reply, answer) = oneshot::channel();
        let release = Message::Release {
            worker: worker.to_owned(),
            retired,
            reply,
        };
        self.messages.send(release).is_ok()
            && tokio::time::timeout(RELEASE, answer)
                .await
                .is_ok_and(|done| done.is_ok())
    }
}

fn release(state: State) -> State {
    match state {
        State::Starting {
            worker,
            lines,
            reply,
            ..
        } => {
            let _ = reply.send(None);
            State::Releasing { worker, lines }
        }
        State::Owned { worker, lines, .. } => State::Releasing { worker, lines },
        other => other,
    }
}

fn release_for(state: State, worker: &str) -> State {
    match &state {
        State::Starting { worker: owner, .. } | State::Owned { worker: owner, .. }
            if owner == worker =>
        {
            release(state)
        }
        _ => state,
    }
}

fn suppressed(wait_for_lock: bool) -> State {
    log::info!("Locked Use suppressed");
    State::Suppressed { wait_for_lock }
}

fn observe_lock(state: State, locked: Option<bool>) -> State {
    match (state, locked) {
        (State::Suppressed { .. }, Some(true)) => State::Suppressed {
            wait_for_lock: false,
        },
        (
            State::Suppressed {
                wait_for_lock: false,
            },
            Some(false),
        ) => {
            log::info!("Locked Use suppression cleared after unlock");
            State::Idle
        }
        (state, _) => state,
    }
}

async fn run(
    mut inbox: mpsc::UnboundedReceiver<Message>,
    own: mpsc::WeakUnboundedSender<Message>,
    path: PathBuf,
    enabled: impl Fn(&str) -> bool,
    lock_state: Option<LockState>,
) {
    let mut state = if lock_state.is_some_and(|read| read() != Some(false)) {
        suppressed(false)
    } else {
        State::Idle
    };
    let mut owner_input = false;
    let mut blocked = BTreeSet::new();
    let mut acting: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
    let mut ids = 0u64;
    let mut waiting: Vec<oneshot::Sender<()>> = Vec::new();
    loop {
        let (message, line) = match &mut state {
            State::Idle => (inbox.recv().await, None),
            State::Suppressed { .. } => tokio::select! {
                message = inbox.recv() => (message, None),
                _ = tokio::time::sleep(LOCK_CHECK), if lock_state.is_some() => {
                    state = observe_lock(state, lock_state.and_then(|read| read()));
                    continue;
                }
            },
            State::Starting { lines, until, .. } => {
                let until = *until;
                tokio::select! {
                    message = inbox.recv() => (message, None),
                    line = lines.recv() => (None, Some(line)),
                    _ = tokio::time::sleep_until(until) => {
                        state = release(state);
                        continue;
                    }
                }
            }
            State::Owned { lines, .. } | State::Releasing { lines, .. } => tokio::select! {
                message = inbox.recv() => (message, None),
                line = lines.recv() => (None, Some(line)),
            },
        };
        if let Some(line) = line {
            state = match (state, line) {
                (
                    State::Starting {
                        worker,
                        turn,
                        session,
                        guardian,
                        lines,
                        until,
                        reply,
                    },
                    Some(GuardianEvent::Line(line)),
                ) => {
                    if line == "unlocked" && !Turn::stopped(&turn) {
                        let grant =
                            own.upgrade()
                                .filter(|_| enabled(&worker))
                                .map(|messages| Grant {
                                    handback: Some((messages, session)),
                                });
                        match grant.map(|grant| reply.send(Some(grant))) {
                            Some(Ok(())) => State::Owned {
                                worker,
                                turn,
                                session,
                                guardian,
                                lines,
                            },
                            Some(Err(mut back)) => {
                                if let Some(grant) = back.as_mut() {
                                    grant.handback = None;
                                }
                                State::Releasing { worker, lines }
                            }
                            None => State::Releasing { worker, lines },
                        }
                    } else {
                        let starting = State::Starting {
                            worker,
                            turn,
                            session,
                            guardian,
                            lines,
                            until,
                            reply,
                        };
                        if line == "unlocked" || line == "owner_input" || line.starts_with("ended ")
                        {
                            owner_input |= line == "owner_input";
                            release(starting)
                        } else {
                            starting
                        }
                    }
                }
                (state, Some(GuardianEvent::Line(line))) => {
                    if line == "owner_input" {
                        owner_input = true;
                        release(state)
                    } else {
                        state
                    }
                }
                (state, event) => {
                    let crashed = !matches!(event, Some(GuardianEvent::Exited { crashed: false }));
                    drop(release(state));
                    let state = if crashed {
                        observe_lock(suppressed(true), lock_state.and_then(|read| read()))
                    } else if owner_input {
                        suppressed(false)
                    } else {
                        State::Idle
                    };
                    owner_input = false;
                    for reply in waiting.drain(..) {
                        let _ = reply.send(());
                    }
                    state
                }
            };
            continue;
        }
        let Some(message) = message else {
            return;
        };
        if matches!(&state, State::Starting { turn, .. } | State::Owned { turn, .. } if Turn::stopped(turn))
        {
            state = release(state);
        }
        state = match message {
            Message::Gate {
                worker,
                locked,
                turn,
                reply,
            } => match if matches!(state, State::Suppressed { .. }) {
                observe_lock(state, lock_state.map_or(Some(locked), |read| read()))
            } else {
                state
            } {
                state if Turn::stopped(&turn) => {
                    let _ = reply.send(None);
                    state
                }
                State::Idle if !locked => {
                    let _ = reply.send(YES);
                    State::Idle
                }
                State::Idle => {
                    let quiet = blocked.is_empty() && acting.is_empty();
                    #[cfg(not(test))]
                    let relock = lock_screen;
                    #[cfg(test)]
                    let relock = || {};
                    let started = (quiet && path.exists() && enabled(&worker))
                        .then(|| start(&path, IDLE_SECONDS, relock).ok())
                        .flatten();
                    match started {
                        Some((guardian, lines)) => State::Starting {
                            worker,
                            turn,
                            session: {
                                ids += 1;
                                ids
                            },
                            guardian,
                            lines,
                            until: Instant::now() + UNLOCK,
                            reply,
                        },
                        None => {
                            let _ = reply.send(None);
                            State::Idle
                        }
                    }
                }
                State::Owned {
                    worker: owner,
                    session,
                    mut guardian,
                    lines,
                    turn: current,
                } if owner == worker => {
                    if !locked && guardian.keep_alive().is_ok() {
                        let _ = reply.send(YES);
                        State::Owned {
                            worker: owner,
                            turn: turn.or(current),
                            session,
                            guardian,
                            lines,
                        }
                    } else {
                        let _ = reply.send(None);
                        State::Releasing {
                            worker: owner,
                            lines,
                        }
                    }
                }
                state => {
                    let _ = reply.send(None);
                    state
                }
            },
            Message::Unclaimed { session } => match state {
                State::Owned { session: owned, .. } if owned == session => release(state),
                state => state,
            },
            Message::Act { worker, reply } => {
                let allowed = match &state {
                    State::Idle => true,
                    State::Owned { worker: owner, .. } => *owner == worker,
                    _ => false,
                };
                let admission = allowed.then(|| own.upgrade()).flatten().map(|messages| {
                    ids += 1;
                    acting.entry(worker.clone()).or_default().insert(ids);
                    Acting {
                        messages,
                        worker,
                        id: ids,
                        settled: true,
                    }
                });
                let _ = reply.send(admission);
                state
            }
            Message::Done {
                worker,
                id,
                settled,
            } => {
                let live = acting
                    .get_mut(&worker)
                    .is_some_and(|calls| calls.remove(&id));
                if acting.get(&worker).is_some_and(BTreeSet::is_empty) {
                    acting.remove(&worker);
                }
                if live && !settled {
                    blocked.insert(worker);
                }
                state
            }
            Message::Hold { worker } => {
                let state = release_for(state, &worker);
                blocked.insert(worker);
                state
            }
            Message::Release {
                worker,
                retired,
                reply,
            } => {
                let state = if retired {
                    blocked.remove(&worker);
                    acting.remove(&worker);
                    release_for(state, &worker)
                } else {
                    state
                };
                match &state {
                    State::Releasing {
                        worker: releasing, ..
                    } if *releasing == worker => waiting.push(reply),
                    _ => {
                        let _ = reply.send(());
                    }
                }
                state
            }
        };
    }
}

#[cfg(not(test))]
fn lock_screen() {
    let lock = unsafe {
        let login = libc::dlopen(
            c"/System/Library/PrivateFrameworks/login.framework/Versions/Current/login".as_ptr(),
            libc::RTLD_LAZY,
        );
        if login.is_null() {
            return;
        }
        libc::dlsym(login, c"SACLockScreenImmediate".as_ptr())
    };
    if !lock.is_null() {
        let lock: extern "C" fn() = unsafe { std::mem::transmute(lock) };
        lock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    static RELOCKS: AtomicUsize = AtomicUsize::new(0);
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn count() {
        RELOCKS.fetch_add(1, Ordering::SeqCst);
    }

    fn run(script: &str) -> (usize, String) {
        let _serial = SERIAL.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let guardian = dir.path().join("guardian");
        std::fs::write(&guardian, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(
            &guardian,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let before = RELOCKS.load(Ordering::SeqCst);
        let (_use, watch) = start(&guardian, 60, count).unwrap();
        let (mut watch, mut last) = (watch, String::new());
        while let Some(event) = watch.blocking_recv() {
            if let GuardianEvent::Line(line) = event {
                last = line;
            }
        }
        (RELOCKS.load(Ordering::SeqCst) - before, last)
    }

    #[test]
    fn relocks_when_the_guardian_is_killed_after_covering() {
        assert_eq!(
            run("echo 'covered 1'; echo unlocked; kill -9 $$"),
            (1, "unlocked".into())
        );
    }

    #[test]
    fn relocks_when_the_guardian_is_killed_before_covering() {
        assert_eq!(run("kill -9 $$"), (1, String::new()));
    }

    #[test]
    fn relocks_when_the_guardian_fails_to_relock() {
        assert_eq!(
            run("echo 'covered 1'; echo 'ended idle relock_failed'; exit 3"),
            (1, "ended idle relock_failed".into())
        );
    }

    #[test]
    fn leaves_the_screen_alone_after_a_clean_end() {
        assert_eq!(
            run("echo 'covered 1'; echo 'ended stopped'"),
            (0, "ended stopped".into())
        );
    }

    #[test]
    fn leaves_the_screen_alone_when_a_start_gate_refuses() {
        assert_eq!(
            run("echo 'ended not_locked'; exit 2"),
            (0, "ended not_locked".into())
        );
    }

    #[tokio::test]
    async fn a_locked_launch_and_a_crash_both_refuse_workers_until_manual_unlock() {
        static LOCKED: AtomicBool = AtomicBool::new(true);
        let dir = tempfile::tempdir().unwrap();
        let guardian = dir.path().join("guardian");
        std::fs::write(
            &guardian,
            "#!/bin/sh\necho 'covered 1'\necho unlocked\nwhile read line; do :; done\nkill -9 $$\n",
        )
        .unwrap();
        std::fs::set_permissions(
            &guardian,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let (gate, task) = Gatekeeper::new(
            guardian,
            |_| true,
            Some(|| Some(LOCKED.load(Ordering::SeqCst))),
        );
        tokio::spawn(task);
        assert!(!gate.gate("first", true, None).await);
        LOCKED.store(false, Ordering::SeqCst);
        assert!(gate.gate("first", false, None).await);

        LOCKED.store(true, Ordering::SeqCst);
        assert!(gate.gate("first", true, None).await);
        LOCKED.store(false, Ordering::SeqCst);
        assert!(gate.retired("first").await);
        assert!(!gate.gate("second", false, None).await);
        LOCKED.store(true, Ordering::SeqCst);
        assert!(!gate.gate("second", true, None).await);
        LOCKED.store(false, Ordering::SeqCst);
        assert!(gate.gate("second", false, None).await);
    }

    #[test]
    fn keep_alive_reaches_the_guardian_and_dropping_ends_it() {
        let _serial = SERIAL.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let guardian = dir.path().join("guardian");
        std::fs::write(
            &guardian,
            "#!/bin/sh\necho 'covered 1'\nread line\necho \"got $line\"\nread line || echo 'ended owner_gone'\n",
        )
        .unwrap();
        std::fs::set_permissions(
            &guardian,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let (mut use_, mut watch) = start(&guardian, 60, count).unwrap();
        use_.keep_alive().unwrap();
        assert!(
            matches!(watch.blocking_recv(), Some(GuardianEvent::Line(line)) if line == "covered 1")
        );
        assert!(
            matches!(watch.blocking_recv(), Some(GuardianEvent::Line(line)) if line == "got alive")
        );
        drop(use_);
        assert!(
            matches!(watch.blocking_recv(), Some(GuardianEvent::Line(line)) if line == "ended owner_gone")
        );
        assert!(matches!(
            watch.blocking_recv(),
            Some(GuardianEvent::Exited { crashed: false })
        ));
        assert!(watch.blocking_recv().is_none());
    }
}
