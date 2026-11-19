#[path = "../../../src-tauri/src/desktop_drivers.rs"]
mod desktop_drivers;

struct FixtureLogger;
impl log::Log for FixtureLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        eprintln!("{}", record.args());
    }
    fn flush(&self) {}
}
static LOGGER: FixtureLogger = FixtureLogger;

fn main() {
    std::thread::spawn(|| {
        let served =
            std::panic::catch_unwind(|| tokio::runtime::Runtime::new().unwrap().block_on(serve()));
        std::process::exit(if served.is_ok() { 0 } else { 101 });
    });
    core_foundation::runloop::CFRunLoop::run_current();
}

async fn serve() {
    log::set_logger(&LOGGER).unwrap();
    log::set_max_level(log::LevelFilter::Info);
    let args: Vec<_> = std::env::args().collect();
    let mode = args.get(4).map(String::as_str);
    let base = if mode == Some("missing-data") {
        None
    } else {
        Some(args[1].clone().into())
    };
    let binary = if mode == Some("missing-binary") {
        Err(std::io::Error::from(std::io::ErrorKind::NotFound))
    } else {
        Ok(args[2].clone().into())
    };
    #[cfg(test)]
    if mode == Some("accept-error") {
        desktop_drivers::inject_accept_failure();
    }
    let child = std::env::var("FIXTURE_SIDECAR_CONNECTOR")
        .ok()
        .map(|script| {
            std::process::Command::new(std::env::var("FIXTURE_PYTHON").unwrap())
                .args(["-I", &script])
                .arg(std::path::Path::new(&args[1]).join("desktop/control.sock"))
                .arg(std::env::var("FIXTURE_SIDECAR_REPLY").unwrap())
                .spawn()
                .unwrap()
        });
    let sidecar = std::sync::Arc::new(std::sync::Mutex::new(child));
    let fixture_dir = std::path::PathBuf::from(&args[1]);
    let desktop_ready = std::sync::Arc::new(move || {
        use std::io::Write;
        let mut events = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(fixture_dir.join("permission-checks"))
            .unwrap();
        writeln!(events, "check").unwrap();
        !fixture_dir.join("permissions-missing").exists()
    });
    let control = desktop_drivers::Control::setup(
        base,
        binary,
        args[3].clone(),
        sidecar.clone(),
        desktop_ready,
    )
    .await;
    let mut shutdown_signal =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).unwrap();
    println!("ready");
    shutdown_signal.recv().await;
    if let Some(control) = control {
        control.shutdown().await;
    }
    if let Some(mut child) = sidecar.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    };
}
