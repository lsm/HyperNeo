fn main() {
	if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
		println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
		println!("cargo:rerun-if-changed=src/desktop_permissions_hint.m");
		cc::Build::new()
			.file("src/desktop_permissions_hint.m")
			.flag("-fobjc-arc")
			.compile("desktop_permissions_hint");
		println!("cargo:rustc-link-lib=framework=AppKit");
		println!("cargo:rustc-link-lib=framework=CoreGraphics");
	}

	tauri_build::build()
}
