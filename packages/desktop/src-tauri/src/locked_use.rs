use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{ChildStdin, Command, Stdio};
use std::thread::JoinHandle;

pub(crate) struct LockedUse {
    stdin: ChildStdin,
}

impl LockedUse {
    pub(crate) fn keep_alive(&mut self) -> std::io::Result<()> {
        writeln!(self.stdin, "alive")
    }

    pub(crate) fn stop(&mut self) -> std::io::Result<()> {
        writeln!(self.stdin, "stop")
    }
}

pub(crate) fn start(
    guardian: &Path,
    idle_seconds: u32,
    relock: fn(),
) -> std::io::Result<(LockedUse, JoinHandle<String>)> {
    let mut child = Command::new(guardian)
        .arg(idle_seconds.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let watch = std::thread::spawn(move || {
        let mut covered = false;
        let mut last = String::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            covered |= line.starts_with("covered ");
            last = line;
        }
        let ended = child.wait().is_ok_and(|status| status.success());
        if covered && !ended {
            relock();
        }
        last
    });
    Ok((LockedUse { stdin }, watch))
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
        let last = watch.join().unwrap();
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
    fn stop_reaches_the_guardian() {
        let _serial = SERIAL.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let guardian = dir.path().join("guardian");
        std::fs::write(
            &guardian,
            "#!/bin/sh\necho 'covered 1'\nread line\nread line\necho \"ended $line\"\n",
        )
        .unwrap();
        std::fs::set_permissions(
            &guardian,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let (mut use_, watch) = start(&guardian, 60, count).unwrap();
        use_.keep_alive().unwrap();
        use_.stop().unwrap();
        assert_eq!(watch.join().unwrap(), "ended stop");
    }
}
