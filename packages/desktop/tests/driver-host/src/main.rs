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

#[cfg(test)]
mod deadline_tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tokio::time::{advance, Instant};

    #[tokio::test(start_paused = true)]
    async fn owner_timeout_never_dispatches_after_late_approval() {
        let (send, receive) = tokio::sync::oneshot::channel::<()>();
        let (answer, receiver) = tokio::sync::oneshot::channel::<()>();
        let granted = Arc::new(AtomicBool::new(false));
        let dispatched = Arc::new(AtomicBool::new(false));
        let stored = granted.clone();
        tokio::spawn(async move {
            let _ = receive.await;
            stored.store(true, Ordering::SeqCst);
            let _ = answer.send(());
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        let sent = dispatched.clone();
        let request = tokio::spawn(async move {
            let result = super::desktop_drivers::owner_answer(deadline, async move {
                let _ = receiver.await;
                "allowed"
            })
            .await;
            if result == "allowed" {
                sent.store(true, Ordering::SeqCst);
            }
            result
        });
        advance(Duration::from_secs(20)).await;
        assert_eq!(request.await.unwrap(), "waiting_for_owner");
        send.send(()).unwrap();
        tokio::task::yield_now().await;
        assert!(granted.load(Ordering::SeqCst));
        assert!(!dispatched.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn owner_approval_before_deadline_allows_the_current_call() {
        let deadline = Instant::now() + Duration::from_secs(20);
        let (send, receive) = tokio::sync::oneshot::channel::<()>();
        let request = tokio::spawn(async move {
            super::desktop_drivers::owner_answer(deadline, async move {
                let _ = receive.await;
                "allowed"
            })
            .await
        });
        advance(Duration::from_secs(19)).await;
        send.send(()).unwrap();
        assert_eq!(request.await.unwrap(), "allowed");
    }
}

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
    let control =
        desktop_drivers::Control::setup(base, binary, args[3].clone(), sidecar.clone()).await;
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
