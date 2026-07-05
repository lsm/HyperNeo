use std::sync::Mutex;
use tauri::{
	menu::{Menu, MenuItem},
	tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
	Manager, Runtime,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_shell::process::CommandChild;

// Store the sidecar child process for cleanup.
struct SidecarState {
	child: Mutex<Option<CommandChild>>,
}

const DAEMON_URL: &str = "http://localhost:9283";

fn kill_sidecar<R: Runtime>(app: &tauri::AppHandle<R>) {
	if let Some(state) = app.try_state::<SidecarState>() {
		if let Ok(mut guard) = state.child.lock() {
			if let Some(child) = guard.take() {
				let _ = child.kill();
			}
		}
	}
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

			// In release mode the desktop app owns the daemon lifecycle and spawns
			// the bundled sidecar. In debug mode the developer runs `make dev` separately
			// and the webview points straight at devUrl, so there's nothing to spawn.
			#[cfg(not(debug_assertions))]
			{
				use tauri::Emitter;
				use tauri_plugin_shell::ShellExt;

				let sidecar_state = app.state::<SidecarState>();
				let app_handle = app.handle().clone();

				// Per-user workspace directory. Kept under ~/.hyperneo but in a
				// "workspace" subdir so it is not the same path as the daemon data dir.
				let workspace = dirs::home_dir()
					.expect("Could not find home directory")
					.join(".hyperneo")
					.join("workspace");
				let workspace_str = workspace.to_string_lossy().to_string();

				// Spawn the bundled `hyperneo` sidecar.
				let sidecar_command = app
					.shell()
					.sidecar("hyperneo")
					.expect("Failed to create sidecar command")
					.args(["--port", "9283", "--workspace", &workspace_str]);

				let (mut rx, child) = sidecar_command
					.spawn()
					.expect("Failed to spawn hyperneo sidecar");

				// Stash child so we can kill it on shutdown.
				*sidecar_state.child.lock().unwrap() = Some(child);

				let app_handle_for_events = app_handle.clone();
				tauri::async_runtime::spawn(async move {
					use tauri_plugin_shell::process::CommandEvent;
					while let Some(event) = rx.recv().await {
						match event {
							CommandEvent::Stdout(line_bytes) => {
								let line = String::from_utf8_lossy(&line_bytes);
								log::info!("[hyperneo] {}", line.trim());
							}
							CommandEvent::Stderr(line_bytes) => {
								let line = String::from_utf8_lossy(&line_bytes);
								log::error!("[hyperneo] {}", line.trim());
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
									app_handle_for_events.emit("hyperneo-terminated", payload.code);
							}
							_ => {}
						}
					}
				});

				log::info!("HyperNeo desktop app started with hyperneo daemon");

				// Poll the daemon's health endpoint, then navigate the webview off
				// the loading splash and onto the live UI.
				let window = app
					.get_webview_window("main")
					.expect("Main window not found");

				tauri::async_runtime::spawn(async move {
					let mut ready = false;
					for attempt in 1..=30 {
						tokio::time::sleep(std::time::Duration::from_millis(500)).await;
						match reqwest::get(format!("{}/api/health", DAEMON_URL)).await {
							Ok(response) if response.status().is_success() => {
								log::info!("Daemon ready after {} attempts", attempt);
								ready = true;
								break;
							}
							_ => {
								log::debug!("Waiting for daemon... attempt {}", attempt);
							}
						}
					}

					if ready {
						match tauri::Url::parse(DAEMON_URL) {
							Ok(url) => {
								if let Err(e) = window.navigate(url) {
									log::error!("Failed to navigate to daemon: {}", e);
								}
							}
							Err(e) => {
								log::error!("Invalid DAEMON_URL '{}': {}", DAEMON_URL, e);
							}
						}
					} else {
						log::error!("Daemon failed to start within timeout");
						let _ = app_handle.emit("hyperneo-start-failed", "Daemon failed to start");
					}
				});
			}

			#[cfg(debug_assertions)]
			{
				log::info!(
					"Development mode: expecting hyperneo daemon at {}",
					DAEMON_URL
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
