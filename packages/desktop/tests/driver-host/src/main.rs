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

#[tokio::main]
async fn main() {
    log::set_logger(&LOGGER).unwrap();
    log::set_max_level(log::LevelFilter::Warn);
    let args: Vec<_> = std::env::args().collect();
    let control = desktop_drivers::Control::setup(
        args[1].clone().into(),
        args[2].clone().into(),
        args[3].clone(),
    )
    .await;
    #[cfg(test)]
    if args.get(4).map(String::as_str) != Some("unapproved") {
        if let Some(control) = &control {
            control.enable_fixture_starts();
        }
    }
    let mut shutdown_signal =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).unwrap();
    println!("ready");
    shutdown_signal.recv().await;
    if let Some(control) = control {
        control.shutdown().await;
    }
}
