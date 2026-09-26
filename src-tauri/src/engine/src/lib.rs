//! VNPen task layer. Implements 《前端 ↔ 任务层 接口合同 v1》 as a local HTTP/SSE
//! service. Has no Tauri dependency so VNPen Desktop can embed the same crate.

pub mod contract;
pub mod error;
pub mod handlers;
pub mod history;
pub mod models;
pub mod parsers;
pub mod prompts;
pub mod providers;
pub mod router;
pub mod rules;
pub mod server;
pub mod state;
pub mod supervisor;
pub mod window;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tokio_util::sync::CancellationToken;

use crate::error::{EngineError, Result};

pub struct EngineConfig {
    /// llama-server executable; `None` or missing file = own models unavailable.
    pub llama_server_path: Option<PathBuf>,
    pub presets_dir: PathBuf,
    pub models_manifest: PathBuf,
    pub models_dir: PathBuf,
    /// Read-only models shipped with a "完整版" installer; `None` for the normal build.
    pub bundled_models_dir: Option<PathBuf>,
    /// Logs go to `data_dir/logs`.
    pub data_dir: PathBuf,
    /// 0 = random.
    pub port: u16,
    /// `None` = random token.
    pub token: Option<String>,
    /// Playground: true ("解锁 system（实验）"); Desktop: false.
    pub allow_system_override: bool,
    pub intent_hook: Option<Box<dyn router::IntentHook>>,
}

pub struct EngineHandle {
    pub port: u16,
    pub token: String,
    pub state: Arc<state::AppState>,
    shutdown: CancellationToken,
}

impl EngineHandle {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1/vnpen", self.port)
    }

    /// Kills llama-server children synchronously; safe to call from an exit hook.
    pub fn shutdown(&self) {
        self.shutdown.cancel();
        self.state.models.cancel_all();
        self.state.sup.kill_all_blocking();
    }
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn random_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

pub async fn start(cfg: EngineConfig) -> Result<EngineHandle> {
    let presets = prompts::Presets::load(&cfg.presets_dir)?;
    let models = models::ModelStore::load(&cfg.models_manifest, cfg.models_dir.clone(), cfg.bundled_models_dir.clone(), cfg.data_dir.join("catalog.json"))?;
    let sup = supervisor::Supervisor::new(cfg.llama_server_path.clone(), cfg.data_dir.join("logs"), presets.sampling.ctx);
    let token = cfg.token.clone().unwrap_or_else(random_token);
    let state = Arc::new(state::AppState {
        token: token.clone(),
        port: AtomicU16::new(0),
        presets: RwLock::new(presets),
        models,
        sup,
        client: providers::Client::default(),
        history: history::History::default(),
        window: window::ContinueWindow::default(),
        cancels: dashmap::DashMap::new(),
        externals: RwLock::new(Vec::new()),
        ggufs: RwLock::new(Vec::new()),
        allow_system_override: cfg.allow_system_override,
        intent_hook: cfg.intent_hook,
        sys: Mutex::new(sysinfo::System::new()),
        data_dir: cfg.data_dir.clone(),
    });

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", cfg.port))
        .await
        .map_err(|e| EngineError::not_ready(format!("无法监听端口：{e}"), None))?;
    let port = listener.local_addr().map_err(|e| EngineError::not_ready(e.to_string(), None))?.port();
    state.port.store(port, Ordering::Relaxed);

    let shutdown = CancellationToken::new();
    let app = server::router(state.clone());
    let stop = shutdown.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).with_graceful_shutdown(async move { stop.cancelled().await }).await;
    });
    let catalog = state.models.clone();
    tokio::spawn(async move {
        if let Err(e) = catalog.refresh_catalog().await {
            tracing::warn!("model catalog refresh failed: {e}");
        }
    });
    tracing::info!("vnpen-engine listening on 127.0.0.1:{port}");
    Ok(EngineHandle { port, token, state, shutdown })
}
