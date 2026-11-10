#[path = "../../../src-tauri/src/desktop_drivers.rs"]
mod desktop_drivers;

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().collect();
    let control = desktop_drivers::Control::bind(args[1].clone().into(), args[2].clone().into(), args[3].clone()).await.unwrap();
    println!("ready");
    tokio::signal::ctrl_c().await.unwrap();
    control.shutdown().await;
}
