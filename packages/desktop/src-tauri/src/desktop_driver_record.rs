use serde::{Deserialize, Serialize};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use tokio::time::{sleep, timeout, Duration};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Identity {
    pub(super) seconds: u64,
    pub(super) microseconds: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pid: u32,
    started_at: Identity,
}

pub(super) fn directory(base: &Path, worker: &str, create: bool) -> Result<PathBuf> {
    let workers = base.join("workers");
    let directory = workers.join(worker);
    for path in [&workers, &directory] {
        if create {
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
        }
        protected_directory(path)?;
    }
    Ok(directory)
}

fn protected_directory(path: &Path) -> io::Result<()> {
    let metadata = path.symlink_metadata()?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Invalid driver record directory",
        ));
    }
    Ok(())
}

fn protected_file(path: &Path) -> io::Result<File> {
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
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Invalid driver record file",
        ));
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

pub(super) struct Starting {
    path: PathBuf,
    remove_on_drop: bool,
}
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
        let guard = Self {
            path,
            remove_on_drop: true,
        };
        File::open(directory)?.sync_all()?;
        ensure_enabled(directory)?;
        Ok(guard)
    }
    pub(super) fn preserve(&mut self) {
        self.remove_on_drop = false;
    }
    pub(super) fn cleanup_verified(&mut self) {
        self.remove_on_drop = true;
    }
}
impl Drop for Starting {
    fn drop(&mut self) {
        if self.remove_on_drop {
            let _ = std::fs::remove_dir(&self.path);
        }
    }
}

pub(super) fn identity(pid: u32) -> Result<Identity> {
    let info = process(pid)?;
    if info.pbi_uid != unsafe { libc::geteuid() } {
        return Err("driver process identity unavailable".into());
    }
    Ok(birth(&info))
}

fn process(pid: u32) -> Result<libc::proc_bsdinfo> {
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
    if read != size || info.pbi_pid != pid {
        return Err("driver process identity unavailable".into());
    }
    Ok(info)
}

fn birth(info: &libc::proc_bsdinfo) -> Identity {
    Identity {
        seconds: info.pbi_start_tvsec,
        microseconds: info.pbi_start_tvusec,
    }
}

pub(super) fn publish(directory: &Path, pid: u32) -> Result<()> {
    let record = Record {
        pid,
        started_at: identity(pid)?,
    };
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(&serde_json::to_vec(&record)?)?;
    file.as_file().sync_all()?;
    file.persist(directory.join("driver.json"))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

pub(super) fn verify(directory: &Path, pid: u32) -> Result<()> {
    let record = read(directory)?;
    if record.pid != pid || record.started_at != identity(pid)? {
        return Err("driver process identity changed".into());
    }
    Ok(())
}

fn read(directory: &Path) -> io::Result<Record> {
    let mut bytes = Vec::new();
    protected_file(&directory.join("driver.json"))?
        .take(16384)
        .read_to_end(&mut bytes)?;
    let record: Record = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if record.pid <= 1 || record.pid > i32::MAX as u32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid driver PID",
        ));
    }
    Ok(record)
}

pub(super) async fn retire_leftovers(base: &Path) -> Result<()> {
    let workers = base.join("workers");
    match protected_directory(&workers) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    for entry in fs::read_dir(workers)? {
        let directory = entry?.path();
        protected_directory(&directory)?;
        let record = match read(&directory) {
            Ok(record) => record,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        record.retire().await?;
    }
    Ok(())
}

impl Record {
    fn still_running(&self) -> Result<bool> {
        match process(self.pid) {
            Ok(info) => {
                Ok(info.pbi_uid == unsafe { libc::geteuid() } && self.started_at == birth(&info))
            }
            Err(_) if verify_gone(self.pid).is_ok() => Ok(false),
            Err(error) => Err(error),
        }
    }

    async fn retire(&self) -> Result<()> {
        if !self.still_running()? {
            return Ok(());
        }
        if unsafe { libc::kill(self.pid as i32, libc::SIGKILL) } == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
        timeout(Duration::from_secs(2), async {
            while self.still_running()? {
                sleep(Duration::from_millis(20)).await;
            }
            Ok(())
        })
        .await
        .map_err(|_| "stop_unconfirmed: leftover driver did not exit")?
    }
}

pub(super) fn verify_gone(pid: u32) -> Result<()> {
    let gone = unsafe { libc::kill(pid as i32, 0) } == -1
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    if !gone {
        return Err("stop_unconfirmed: driver cleanup incomplete".into());
    }
    Ok(())
}
