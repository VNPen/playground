use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, RunEvent};
use vnpen_engine::{start, EngineConfig, EngineHandle};

#[derive(Clone, Serialize)]
struct EngineInfo {
    port: u16,
    token: String,
    base_url: String,
    error: Option<String>,
    llama_server: Option<String>,
    data_dir: String,
}

struct EngineState {
    info: EngineInfo,
    handle: Mutex<Option<EngineHandle>>,
}

/// The only Tauri command: tells the UI where the task layer listens.
#[tauri::command]
fn engine_info(state: tauri::State<EngineState>) -> EngineInfo {
    state.info.clone()
}

fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// macOS/Linux: the sidecar sits next to the main executable.
/// Windows: optional CUDA / Vulkan builds under resources/llama/<variant>/, else the CPU sidecar.
fn llama_server_path(resource_dir: &Path) -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    if cfg!(windows) {
        let sys32 = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join("System32");
        let mut variants = Vec::new();
        if sys32.join("nvcuda.dll").is_file() {
            variants.push("cuda");
        }
        if sys32.join("vulkan-1.dll").is_file() {
            variants.push("vulkan");
        }
        for v in variants {
            let p = resource_dir.join("llama").join(v).join(exe_name("llama-server"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let p = exe_dir.join(exe_name("llama-server"));
    p.is_file().then_some(p)
}

fn resource(resource_dir: &Path, rel: &str) -> PathBuf {
    let bundled = resource_dir.join(rel);
    if bundled.exists() {
        bundled
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
    }
}

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let llama = llama_server_path(&resource_dir);
            let cfg = EngineConfig {
                llama_server_path: llama.clone(),
                presets_dir: resource(&resource_dir, "presets"),
                models_manifest: resource(&resource_dir, "models.json"),
                models_dir: data_dir.join("models"),
                bundled_models_dir: Some(resource_dir.join("bundled-models")),
                data_dir: data_dir.clone(),
                port: 0,
                token: None,
                allow_system_override: true,
                intent_hook: None,
            };
            let (info, handle) = match tauri::async_runtime::block_on(start(cfg)) {
                Ok(h) => (
                    EngineInfo {
                        port: h.port,
                        token: h.token.clone(),
                        base_url: h.base_url(),
                        error: None,
                        llama_server: llama.map(|p| p.display().to_string()),
                        data_dir: data_dir.display().to_string(),
                    },
                    Some(h),
                ),
                Err(e) => (
                    EngineInfo {
                        port: 0,
                        token: String::new(),
                        base_url: String::new(),
                        error: Some(e.to_string()),
                        llama_server: None,
                        data_dir: data_dir.display().to_string(),
                    },
                    None,
                ),
            };
            app.manage(EngineState { info, handle: Mutex::new(handle) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine_info])
        .build(tauri::generate_context!())
        .expect("error while building VNPen Playground")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(h) = app.state::<EngineState>().handle.lock().unwrap().take() {
                    h.shutdown();
                }
            }
        });
}
