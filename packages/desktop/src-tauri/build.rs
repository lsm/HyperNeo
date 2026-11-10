fn main() {
	if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
		println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/swift");
	}

	tauri_build::build()
}
