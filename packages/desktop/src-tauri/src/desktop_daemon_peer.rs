use std::{
    path::Path,
    process::Child,
    sync::{Arc, Mutex},
};

pub(super) type ChildSlot = Arc<Mutex<Option<Child>>>;

pub(super) fn admitted(pid: u32, runtime: &Path, child: &ChildSlot) -> bool {
    let held = child.lock().unwrap();
    if held.as_ref().is_some_and(|child| child.id() == pid) {
        return true;
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Advert {
        pid: u32,
        started_at: u64,
    }
    let advert = std::fs::read(runtime)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Advert>(&bytes).ok());
    let Some(advert) = advert.filter(|advert| advert.pid == pid) else {
        return false;
    };
    let Some((seconds, micros)) = i32::try_from(pid).ok().and_then(super::target::started_at)
    else {
        return false;
    };
    let started = u128::from(seconds) * 1_000_000 + u128::from(micros);
    let advertised = u128::from(advert.started_at) * 1000;
    advertised
        .checked_sub(started)
        .is_some_and(|elapsed| elapsed <= 60_000_000)
}

// Keep the PID reserved until its authority is withdrawn and the child is reaped.
pub(crate) fn wait_unreaped(pid: u32) -> std::io::Result<(Option<i32>, Option<i32>)> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        if unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT) } == 0
        {
            return Ok(if info.si_code == libc::CLD_EXITED {
                (Some(info.si_status), None)
            } else {
                (None, Some(info.si_status))
            });
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sidecar_authority_ends_before_its_pid_is_reaped() {
        let child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        let slot = Arc::new(Mutex::new(Some(child)));
        let run = tempfile::tempdir().unwrap();
        let runtime = run.path().join("runtime.json");
        assert_eq!(wait_unreaped(pid).unwrap(), (Some(0), None));
        assert!(admitted(pid, &runtime, &slot));
        let mut child = slot.lock().unwrap().take().unwrap();
        assert!(!admitted(pid, &runtime, &slot));
        child.wait().unwrap();
    }
}
