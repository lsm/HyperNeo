use serde::{Deserialize, Serialize};
use std::{
    fs::{DirBuilder, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Identity {
    seconds: u64,
    microseconds: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pid: u32,
    started_at: Identity,
    socket: PathBuf,
}

pub(super) fn directory(base: &Path, worker: &str) -> Result<PathBuf> {
    let workers = base.join("workers");
    let directory = workers.join(worker);
    for path in [&workers, &directory] {
        DirBuilder::new()
            .mode(0o700)
            .create(path)
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    Ok(())
                } else {
                    Err(error)
                }
            })?;
        File::open(path.parent().ok_or("Invalid record directory")?)?.sync_all()?;
        let metadata = path.symlink_metadata()?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != 0o700
        {
            return Err("Invalid driver record directory".into());
        }
    }
    Ok(directory)
}

fn protected_file(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o600
        || metadata.nlink() != 1
    {
        return Err("Invalid driver record file".into());
    }
    Ok(file)
}

pub(super) fn latch(directory: &Path) -> Result<()> {
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("stopped"))
    {
        Ok(file) => file.sync_all()?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    File::open(directory)?.sync_all()?;
    Ok(())
}

pub(super) fn ensure_enabled(directory: &Path) -> Result<()> {
    match directory.join("stopped").symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err("Desktop worker is stopped".into()),
    }
}

pub(super) struct Starting(PathBuf);
impl Starting {
    pub(super) fn begin(directory: &Path) -> Result<Self> {
        let path = directory.join("starting");
        if let Err(error) = DirBuilder::new().mode(0o700).create(&path) {
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(error.into());
            }
            latch(directory)?;
            return Err("stop_unconfirmed: previous start incomplete; cleanup is required before re-enabling desktop control".into());
        }
        let guard = Self(path);
        File::open(directory)?.sync_all()?;
        ensure_enabled(directory)?;
        Ok(guard)
    }
}
impl Drop for Starting {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn identity(pid: u32) -> Result<Identity> {
    if pid <= 1 || pid > i32::MAX as u32 {
        return Err("Invalid driver PID".into());
    }
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if read != size || info.pbi_pid != pid || info.pbi_uid != unsafe { libc::geteuid() } {
        return Err("stop_unconfirmed: driver process identity unavailable".into());
    }
    Ok(Identity {
        seconds: info.pbi_start_tvsec,
        microseconds: info.pbi_start_tvusec,
    })
}

pub(super) fn publish(directory: &Path, pid: u32, socket: PathBuf) -> Result<()> {
    let record = Record {
        pid,
        started_at: identity(pid)?,
        socket,
    };
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(&serde_json::to_vec(&record)?)?;
    file.as_file().sync_all()?;
    file.persist(directory.join("driver.json"))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

pub(super) fn verify(directory: &Path, pid: u32, socket: &Path) -> Result<()> {
    let mut bytes = Vec::new();
    protected_file(&directory.join("driver.json"))?
        .take(16384)
        .read_to_end(&mut bytes)?;
    let record: Record = serde_json::from_slice(&bytes)?;
    if record.pid != pid || record.socket != socket || record.started_at != identity(pid)? {
        return Err("stop_unconfirmed: driver process identity changed".into());
    }
    Ok(())
}

pub(super) fn verify_gone(pid: u32, socket: &Path) -> Result<()> {
    let gone = unsafe { libc::kill(pid as i32, 0) } == -1
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    let socket_gone = matches!(socket.symlink_metadata(), Err(error) if error.kind() == std::io::ErrorKind::NotFound);
    if !gone || !socket_gone {
        return Err("stop_unconfirmed: driver cleanup incomplete".into());
    }
    Ok(())
}
