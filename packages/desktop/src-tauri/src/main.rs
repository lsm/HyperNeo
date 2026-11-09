#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod proof;

fn main() {
    #[cfg(target_os = "macos")]
    proof::run();

    #[cfg(not(target_os = "macos"))]
    hyperneo_lib::run();
}
