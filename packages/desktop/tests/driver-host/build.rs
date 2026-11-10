fn main() {
    println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/swift");
}
