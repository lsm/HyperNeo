use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
	menu::{Menu, MenuItem},
	tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
	Emitter, Manager, Runtime,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_shell::process::CommandChild;

// Store the sidecar child process for cleanup.
struct SidecarState {
	child: Mutex<Option<CommandChild>>,
}

// Serializes startup resolution so the readiness poll and the sidecar's
// termination handler never both claim (and never both report) the outcome.
#[derive(Default)]
struct StartupState {
	finished: AtomicBool,
	last_daemon_error: Mutex<Option<String>>,
}

fn remember_daemon_error<R: Runtime>(app: &tauri::AppHandle<R>, line: &str) {
	let trimmed = line.trim();
	if trimmed.is_empty() {
		return;
	}
	// The daemon's stderr also carries non-fatal noise (e.g. an SDK prefetch
	// warning). Keep the first line that names a real startup failure.
	let is_fatal = trimmed.contains("Fatal")
		|| trimmed.contains("already running with this database")
		|| trimmed.contains("Failed to initialize daemon");
	if !is_fatal {
		return;
	}
	if let Some(state) = app.try_state::<StartupState>() {
		if let Ok(mut guard) = state.last_daemon_error.lock() {
			if guard.is_none() {
				*guard = Some(trimmed.to_string());
			}
		}
	}
}

fn last_daemon_error<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
	app.try_state::<StartupState>()
		.and_then(|state| state.last_daemon_error.lock().ok().and_then(|guard| guard.clone()))
}

const DAEMON_PORT: u16 = 9283;

#[derive(serde::Deserialize)]
struct RuntimeDescriptor {
	pid: u32,
	port: u16,
	url: Option<String>,
}

fn kill_sidecar<R: Runtime>(app: &tauri::AppHandle<R>) {
	if let Some(state) = app.try_state::<SidecarState>() {
		if let Ok(mut guard) = state.child.lock() {
			if let Some(child) = guard.take() {
				let _ = child.kill();
			}
		}
	}
}

// A running daemon advertises where it listens in <data-dir>/runtime.json so the
// desktop app can attach instead of spawning a second daemon onto the same
// SQLite file (whose PID lock would reject it).
fn runtime_descriptor_path() -> Option<PathBuf> {
	let base = match std::env::var("HYPERNEO_DATA_DIR") {
		Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
		_ => dirs::home_dir()?.join(".hyperneo"),
	};
	Some(base.join("runtime.json"))
}

fn read_runtime_descriptor() -> Option<RuntimeDescriptor> {
	let path = runtime_descriptor_path()?;
	let raw = std::fs::read_to_string(path).ok()?;
	serde_json::from_str(&raw).ok()
}

fn daemon_url(port: u16) -> String {
	format!("http://127.0.0.1:{port}")
}

async fn probe_daemon(url: &str, attempts: u32, delay: Duration) -> bool {
	let target = format!("{}/", url.trim_end_matches('/'));
	for attempt in 1..=attempts {
		tokio::time::sleep(delay).await;
		match reqwest::get(&target).await {
			Ok(response) if response.status().is_success() => {
				log::info!("Daemon answered at {} after {} attempt(s)", target, attempt);
				return true;
			}
			_ => log::debug!("Waiting for daemon at {} (attempt {})", target, attempt),
		}
	}
	false
}

fn navigate<R: Runtime>(window: &tauri::WebviewWindow<R>, url: &str, startup: &StartupState) {
	if startup.finished.swap(true, Ordering::SeqCst) {
		return;
	}
	match tauri::Url::parse(url) {
		Ok(parsed) => {
			if let Err(error) = window.navigate(parsed) {
				log::error!("Failed to navigate the window to {}: {}", url, error);
			}
		}
		Err(error) => log::error!("Invalid daemon URL '{}': {}", url, error),
	}
}

// Reached from Rust so it renders even if the splash's own script is blocked by
// the CSP: at worst the injected snippet mutates the DOM directly. The splash may
// not have parsed yet, so the snippet installs a hook and polls for the nodes.
fn reveal_startup_failure<R: Runtime>(window: &tauri::WebviewWindow<R>, message: &str) {
	let payload =
		serde_json::to_string(message).unwrap_or_else(|_| "\"HyperNeo could not start\"".into());
	let js = format!(
		"(function(){{var m={payload},tries=0;\
function apply(){{\
var s=document.getElementById('status'),sp=document.getElementById('spinner'),\
b=document.getElementById('error'),d=document.getElementById('error-detail');\
if(!b){{return false;}}\
if(typeof window.__hyperneoShowStartupError==='function'){{window.__hyperneoShowStartupError(m);return true;}}\
if(d)d.textContent=m;if(sp)sp.style.display='none';if(s)s.style.display='none';\
b.style.display='block';return true;}}\
if(!apply()){{var iv=setInterval(function(){{if(apply()||++tries>200)clearInterval(iv);}},50);}}}})();"
	);
	if let Err(error) = window.eval(js) {
		log::error!("Failed to surface the startup error in the window: {}", error);
	}
}

fn fail_startup<R: Runtime>(
	app: &tauri::AppHandle<R>,
	window: &tauri::WebviewWindow<R>,
	message: &str,
	startup: &StartupState,
) {
	if startup.finished.swap(true, Ordering::SeqCst) {
		return;
	}
	let full = match last_daemon_error(app) {
		Some(detail) => format!("{message}\n\nDaemon said: {detail}"),
		None => message.to_string(),
	};
	log::error!("{}", full);
	let _ = app.emit("hyperneo-start-failed", full.clone());
	reveal_startup_failure(window, &full);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let app = tauri::Builder::default()
		.plugin(tauri_plugin_shell::init())
		.plugin(tauri_plugin_notification::init())
		.plugin(tauri_plugin_global_shortcut::Builder::new().build())
		.manage(SidecarState {
			child: Mutex::new(None),
		})
		.manage(StartupState::default())
		.setup(|app| {
			// Setup logging.
			app.handle().plugin(
				tauri_plugin_log::Builder::default()
					.level(if cfg!(debug_assertions) {
						log::LevelFilter::Info
					} else {
						log::LevelFilter::Warn
					})
					.build(),
			)?;

			// System tray menu.
			let show_item = MenuItem::with_id(app, "show", "Show HyperNeo", true, None::<&str>)?;
			let hide_item = MenuItem::with_id(app, "hide", "Hide HyperNeo", true, None::<&str>)?;
			let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

			let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

			let _tray = TrayIconBuilder::new()
				.icon(app.default_window_icon().unwrap().clone())
				.menu(&menu)
				.show_menu_on_left_click(false)
				.on_menu_event(|app, event| match event.id.as_ref() {
					"show" => {
						if let Some(window) = app.get_webview_window("main") {
							let _ = window.show();
							let _ = window.set_focus();
						}
					}
					"hide" => {
						if let Some(window) = app.get_webview_window("main") {
							let _ = window.hide();
						}
					}
					"quit" => {
						// Kill the bundled daemon before exit; app.exit(0) calls
						// std::process::exit which skips Drop, so without this the
						// child can outlive the desktop app.
						kill_sidecar(app);
						app.exit(0);
					}
					_ => {}
				})
				.on_tray_icon_event(|tray, event| {
					if let TrayIconEvent::Click {
						button: MouseButton::Left,
						button_state: MouseButtonState::Up,
						..
					} = event
					{
						let app = tray.app_handle();
						if let Some(window) = app.get_webview_window("main") {
							let _ = window.show();
							let _ = window.set_focus();
						}
					}
				})
				.build(app)?;

			// Global shortcut: Cmd+Shift+K (macOS) / Ctrl+Shift+K (Windows/Linux).
			#[cfg(target_os = "macos")]
			let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyK);
			#[cfg(not(target_os = "macos"))]
			let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyK);

			let app_handle = app.handle().clone();
			app.global_shortcut()
				.on_shortcut(shortcut, move |_app, _shortcut, _event| {
					if let Some(window) = app_handle.get_webview_window("main") {
						if window.is_visible().unwrap_or(false) {
							let _ = window.hide();
						} else {
							let _ = window.show();
							let _ = window.set_focus();
						}
					}
				})?;

			log::info!("Global shortcut registered: Cmd/Ctrl+Shift+K to toggle window");

			// In release mode the desktop app owns the daemon lifecycle: it first
			// attaches to a daemon that is already running (advertised in
			// <data-dir>/runtime.json), and otherwise spawns the bundled sidecar on
			// its own data dir so it never collides with a CLI or launchd daemon.
			// In debug mode the developer runs `make dev` separately and the webview
			// points straight at devUrl, so there's nothing to spawn.
			#[cfg(not(debug_assertions))]
			{
				use tauri_plugin_shell::process::CommandEvent;
				use tauri_plugin_shell::ShellExt;

				let app_handle = app.handle().clone();
				let window = app
					.get_webview_window("main")
					.expect("Main window not found");

				tauri::async_runtime::spawn(async move {
					let startup = app_handle.state::<StartupState>();

					// 1. Prefer a daemon that is already running, so the desktop app
					// shares one dataset with a CLI or launchd daemon.
					if let Some(descriptor) = read_runtime_descriptor() {
						let url = descriptor
							.url
							.clone()
							.unwrap_or_else(|| daemon_url(descriptor.port));
						log::info!(
							"Found a running daemon advert (pid {}) at {}",
							descriptor.pid,
							url
						);
						if probe_daemon(&url, 6, Duration::from_millis(200)).await {
							log::info!("Attaching to the running daemon at {}", url);
							navigate(&window, &url, &startup);
							return;
						}
						log::warn!("The advertised daemon at {} did not answer; spawning one", url);
					}

					// 2. Spawn the bundled `hyperneo` sidecar.
					let workspace = dirs::home_dir()
						.expect("Could not find home directory")
						.join(".hyperneo")
						.join("workspace");
					let workspace_str = workspace.to_string_lossy().to_string();

					let sidecar_command =
						match app_handle
							.shell()
							.sidecar("hyperneo")
							.map(|command| {
								command.args(["--port", "9283", "--workspace", &workspace_str])
							}) {
							Ok(command) => command,
							Err(error) => {
								fail_startup(
									&app_handle,
									&window,
									&format!(
										"Could not prepare the bundled hyperneo daemon: {error}"
									),
									&startup,
								);
								return;
							}
						};

					let (mut rx, child) = match sidecar_command.spawn() {
						Ok(spawned) => spawned,
						Err(error) => {
							fail_startup(
								&app_handle,
								&window,
								&format!("Could not launch the bundled hyperneo daemon: {error}"),
								&startup,
							);
							return;
						}
					};

					// Stash the child so we can kill it on shutdown.
					if let Some(state) = app_handle.try_state::<SidecarState>() {
						if let Ok(mut guard) = state.child.lock() {
							*guard = Some(child);
						}
					}

					let handle_for_events = app_handle.clone();
					tauri::async_runtime::spawn(async move {
						while let Some(event) = rx.recv().await {
							match event {
								CommandEvent::Stdout(line_bytes) => {
									let line = String::from_utf8_lossy(&line_bytes);
									log::info!("[hyperneo] {}", line.trim());
								}
								CommandEvent::Stderr(line_bytes) => {
									let line = String::from_utf8_lossy(&line_bytes);
									log::error!("[hyperneo] {}", line.trim());
									remember_daemon_error(&handle_for_events, &line);
								}
								CommandEvent::Error(err) => {
									log::error!("[hyperneo] Error: {}", err);
								}
								CommandEvent::Terminated(payload) => {
									log::warn!(
										"[hyperneo] Process terminated with code: {:?}",
										payload.code
									);
									let _ =
										handle_for_events.emit("hyperneo-terminated", payload.code);
									// Surface an early exit at once instead of letting the
									// splash spin until the readiness poll times out.
									if let (Some(state), Some(window)) = (
										handle_for_events.try_state::<StartupState>(),
										handle_for_events.get_webview_window("main"),
									) {
										let code = payload
											.code
											.map(|value| value.to_string())
											.unwrap_or_else(|| "unknown".to_string());
										fail_startup(
											&handle_for_events,
											&window,
											&format!(
												"The bundled hyperneo daemon exited before the UI was ready (exit code {code})."
											),
											&state,
										);
									}
								}
								_ => {}
							}
						}
					});

					log::info!("HyperNeo desktop app spawned the hyperneo daemon");

					// 3. Wait for the daemon, then move the webview off the splash.
					let url = daemon_url(DAEMON_PORT);
					if probe_daemon(&url, 30, Duration::from_millis(500)).await {
						navigate(&window, &url, &startup);
					} else {
						fail_startup(
							&app_handle,
							&window,
							"The bundled hyperneo daemon did not start within 15 seconds.",
							&startup,
						);
					}
				});
			}

			#[cfg(debug_assertions)]
			{
				log::info!(
					"Development mode: expecting hyperneo daemon at {}",
					daemon_url(DAEMON_PORT)
				);
				log::info!("Run 'make dev PORT=9283' from the monorepo root to start the daemon");
			}

			Ok(())
		})
		.on_window_event(|window, event| {
			// Close-to-tray in release builds; close-to-quit in debug for easier dev.
			if let tauri::WindowEvent::CloseRequested { api, .. } = event {
				#[cfg(not(debug_assertions))]
				{
					let _ = window.hide();
					api.prevent_close();
				}
				#[cfg(debug_assertions)]
				{
					let _ = window;
					let _ = api;
				}
			}
		})
		.build(tauri::generate_context!())
		.expect("error while building tauri application");

	app.run(|app_handle, event| match event {
		tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
			kill_sidecar(app_handle);
		}
		_ => {}
	});
}
