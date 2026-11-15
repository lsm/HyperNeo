use std::{
    process::Child,
    sync::{Arc, Mutex},
};

pub(super) type ChildSlot = Arc<Mutex<Option<Child>>>;

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
