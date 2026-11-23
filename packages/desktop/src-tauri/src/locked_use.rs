use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Duration, Instant};

pub(crate) struct LockedUse {
    stdin: ChildStdin,
}

impl LockedUse {
    pub(crate) fn keep_alive(&mut self) -> std::io::Result<()> {
        writeln!(self.stdin, "alive")
    }
}

pub(crate) fn start(
    guardian: &Path,
    idle_seconds: u32,
    relock: fn(),
) -> std::io::Result<(LockedUse, mpsc::UnboundedReceiver<String>)> {
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
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            covered |= line.starts_with("covered ");
            log::info!("Locked Use guardian: {line}");
            let _ = lines.send(line);
        }
        let ended = child.wait().is_ok_and(|status| status.success());
        if covered && !ended {
            relock();
        }
    });
    Ok((LockedUse { stdin }, watch))
}

const IDLE_SECONDS: u32 = 120;
const UNLOCK: Duration = Duration::from_secs(15);
const RELEASE: Duration = Duration::from_secs(15);

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
    Retired {
        worker: String,
        reply: oneshot::Sender<()>,
    },
}

type Lines = mpsc::UnboundedReceiver<String>;

enum State {
    Idle,
    Starting {
        worker: String,
        session: u64,
        guardian: LockedUse,
        lines: Lines,
        until: Instant,
        reply: oneshot::Sender<Option<Grant>>,
    },
    Owned {
        worker: String,
        session: u64,
        guardian: LockedUse,
        lines: Lines,
    },
    /// The guardian's input is closed; it stays here until the guardian process exits.
    Releasing {
        worker: String,
        lines: Lines,
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
    ) -> (Self, impl std::future::Future<Output = ()> + Send) {
        let (messages, inbox) = mpsc::unbounded_channel();
        let own = messages.downgrade();
        (Self { messages }, run(inbox, own, guardian, enabled))
    }

    pub(crate) async fn gate(&self, worker: &str, locked: bool) -> bool {
        let (reply, answer) = oneshot::channel();
        let gate = Message::Gate {
            worker: worker.to_owned(),
            locked,
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
        let (reply, answer) = oneshot::channel();
        let retired = Message::Retired {
            worker: worker.to_owned(),
            reply,
        };
        self.messages.send(retired).is_ok()
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

async fn run(
    mut inbox: mpsc::UnboundedReceiver<Message>,
    own: mpsc::WeakUnboundedSender<Message>,
    path: PathBuf,
    enabled: impl Fn(&str) -> bool,
) {
    let mut state = State::Idle;
    let mut blocked = BTreeSet::new();
    let mut acting: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
    let mut ids = 0u64;
    let mut waiting: Vec<oneshot::Sender<()>> = Vec::new();
    loop {
        let (message, line) = match &mut state {
            State::Idle => (inbox.recv().await, None),
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
                        session,
                        guardian,
                        lines,
                        until,
                        reply,
                    },
                    Some(line),
                ) => {
                    if line == "unlocked" {
                        let grant = own.upgrade().filter(|_| enabled(&worker)).map(|messages| Grant {
                            handback: Some((messages, session)),
                        });
                        match grant.map(|grant| reply.send(Some(grant))) {
                            Some(Ok(())) => State::Owned {
                                worker,
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
                            session,
                            guardian,
                            lines,
                            until,
                            reply,
                        };
                        if line.starts_with("ended ") {
                            release(starting)
                        } else {
                            starting
                        }
                    }
                }
                (state, Some(_)) => state,
                (state, None) => {
                    drop(release(state));
                    for reply in waiting.drain(..) {
                        let _ = reply.send(());
                    }
                    State::Idle
                }
            };
            continue;
        }
        let Some(message) = message else {
            return;
        };
        state = match message {
            Message::Gate {
                worker,
                locked,
                reply,
            } => match state {
                State::Idle if !locked => {
                    let _ = reply.send(YES);
                    State::Idle
                }
                State::Idle => {
                    let quiet = blocked.is_empty() && acting.is_empty();
                    let started = (quiet && path.exists() && enabled(&worker))
                        .then(|| start(&path, IDLE_SECONDS, lock_screen).ok())
                        .flatten();
                    match started {
                        Some((guardian, lines)) => State::Starting {
                            worker,
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
                } if owner == worker => {
                    if !locked && guardian.keep_alive().is_ok() {
                        let _ = reply.send(YES);
                        State::Owned {
                            worker: owner,
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
                State::Owned {
                    session: owned, ..
                } if owned == session => release(state),
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
                let live = acting.get_mut(&worker).is_some_and(|calls| calls.remove(&id));
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
            Message::Retired { worker, reply } => {
                blocked.remove(&worker);
                acting.remove(&worker);
                let state = release_for(state, &worker);
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

pub(crate) fn lock_screen() {
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
    use std::sync::atomic::{AtomicUsize, Ordering};

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
        while let Some(line) = watch.blocking_recv() {
            last = line;
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
        assert_eq!(watch.blocking_recv().unwrap(), "covered 1");
        assert_eq!(watch.blocking_recv().unwrap(), "got alive");
        drop(use_);
        assert_eq!(watch.blocking_recv().unwrap(), "ended owner_gone");
        assert!(watch.blocking_recv().is_none());
    }
}
