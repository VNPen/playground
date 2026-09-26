//! Standalone task layer, for curl testing and for tools outside the Playground.
//! Prints `{"port":..,"token":..}` on stdout once listening.

use std::path::PathBuf;

use vnpen_engine::{start, EngineConfig};

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).with_writer(std::io::stderr).init();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let data_dir = arg("--data-dir").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("vnpen-engine"));
    let cfg = EngineConfig {
        llama_server_path: arg("--llama-server").map(PathBuf::from).or_else(|| {
            let triple = format!("{}-{}", std::env::consts::ARCH, if cfg!(target_os = "macos") { "apple-darwin" } else if cfg!(windows) { "pc-windows-msvc.exe" } else { "unknown-linux-gnu" });
            Some(root.join(format!("binaries/llama-server-{triple}")))
        }),
        presets_dir: arg("--presets").map(PathBuf::from).unwrap_or_else(|| root.join("presets")),
        models_manifest: arg("--models-json").map(PathBuf::from).unwrap_or_else(|| root.join("models.json")),
        models_dir: arg("--models-dir").map(PathBuf::from).unwrap_or_else(|| data_dir.join("models")),
        bundled_models_dir: None,
        data_dir,
        port: arg("--port").and_then(|p| p.parse().ok()).unwrap_or(0),
        token: arg("--token").or_else(|| std::env::var("VNPEN_TOKEN").ok()),
        allow_system_override: true,
        intent_hook: None,
    };
    let handle = match start(cfg).await {
        Ok(h) => h,
        Err(e) => {
            eprintln!("启动失败：{e}");
            std::process::exit(1);
        }
    };
    println!("{}", serde_json::json!({ "port": handle.port, "token": handle.token, "base_url": handle.base_url() }));
    let _ = tokio::signal::ctrl_c().await;
    handle.shutdown();
}
