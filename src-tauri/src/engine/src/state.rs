use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use dashmap::DashMap;
use tokio_util::sync::CancellationToken;

use crate::contract::ModelRole;
use crate::error::{EngineError, Result};
use crate::history::History;
use crate::models::ModelStore;
use crate::prompts::Presets;
use crate::providers::{Client, ExternalConfig, GgufConfig, Provider, Target, VNPEN_PROVIDER};
use crate::router::IntentHook;
use crate::supervisor::{ProcSpec, Supervisor};
use crate::window::ContinueWindow;

/// Which system prompt an endpoint needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Continue,
    Proofread,
    Rewrite,
    Brief,
    ChatWrite,
    ChatAnswer,
}

impl Purpose {
    fn external_key(self) -> &'static str {
        match self {
            Purpose::Continue => "continue",
            Purpose::Proofread => "proofread",
            Purpose::Rewrite => "rewrite",
            Purpose::Brief => "brief",
            Purpose::ChatWrite => "chat",
            Purpose::ChatAnswer => "chat_answer",
        }
    }
}

pub struct AppState {
    pub token: String,
    pub port: std::sync::atomic::AtomicU16,
    pub presets: RwLock<Presets>,
    pub models: Arc<ModelStore>,
    pub sup: Arc<Supervisor>,
    pub client: Client,
    pub history: History,
    pub window: ContinueWindow,
    pub cancels: DashMap<String, CancellationToken>,
    pub externals: RwLock<Vec<ExternalConfig>>,
    pub ggufs: RwLock<Vec<GgufConfig>>,
    /// Playground: true (experimental unlock); Desktop: false.
    pub allow_system_override: bool,
    pub intent_hook: Option<Box<dyn IntentHook>>,
    pub sys: Mutex<sysinfo::System>,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn ctx(&self) -> u32 {
        self.presets.read().unwrap().sampling.ctx
    }

    pub fn provider(&self, id: Option<&str>) -> Result<Provider> {
        let id = id.filter(|s| !s.is_empty()).unwrap_or(VNPEN_PROVIDER);
        if id == VNPEN_PROVIDER {
            return Ok(Provider::Vnpen);
        }
        if let Some(c) = self.externals.read().unwrap().iter().find(|c| c.id == id) {
            return Ok(Provider::External(c.clone()));
        }
        if let Some(c) = self.ggufs.read().unwrap().iter().find(|c| c.id == id) {
            return Ok(Provider::Gguf(c.clone()));
        }
        Err(EngineError::Invalid(format!("未知 provider：{id}")))
    }

    pub fn system_for(&self, provider: &Provider, purpose: Purpose, role: ModelRole, override_: Option<&str>) -> String {
        if let Some(o) = override_.filter(|o| self.allow_system_override && !o.trim().is_empty()) {
            return o.trim().to_string();
        }
        let p = self.presets.read().unwrap();
        match provider {
            Provider::Vnpen => match (role, purpose) {
                (ModelRole::Realtime, _) => p.realtime_system.clone(),
                (ModelRole::Writer, Purpose::ChatAnswer) => p.writer_system_answer.clone(),
                (ModelRole::Writer, _) => p.writer_system_write.clone(),
            },
            Provider::External(c) => c
                .system_overrides
                .get(purpose.external_key())
                .filter(|s| !s.trim().is_empty())
                .cloned()
                .unwrap_or_else(|| p.external.get(purpose.external_key()).cloned().unwrap_or_default()),
            Provider::Gguf(_) => p.external.get(purpose.external_key()).cloned().unwrap_or_default(),
        }
    }

    /// Resolves where to send a request, starting llama-server when needed.
    pub async fn target(&self, provider: &Provider, role: ModelRole) -> Result<Target> {
        match provider {
            Provider::Vnpen => {
                let entry = self.models.entry_for(role).ok_or_else(|| EngineError::NotAvailable(format!("没有 {} 模型", role.as_str())))?;
                if !entry.released() {
                    return Err(EngineError::NotAvailable(format!("{} 模型即将推出", role.as_str())));
                }
                let active = self
                    .models
                    .active(role)
                    .ok_or_else(|| EngineError::not_ready(format!("{} 模型尚未下载，请在设置中下载", entry.name), Some(0.0)))?;
                let warmup_system = {
                    let p = self.presets.read().unwrap();
                    if role == ModelRole::Realtime { p.realtime_system.clone() } else { p.writer_system_write.clone() }
                };
                let spec = ProcSpec { model_path: active.path.clone(), warmup_system, unload_when_idle: role == ModelRole::Writer };
                let lease = self.sup.acquire(role.as_str(), spec).await?;
                Ok(Target {
                    provider_id: VNPEN_PROVIDER.into(),
                    model: format!("{} {}", active.entry.display_name, active.file.quant),
                    base_url: format!("http://127.0.0.1:{}", lease.port),
                    api_key: None,
                    llama: true,
                    _lease: Some(lease),
                })
            }
            Provider::Gguf(c) => {
                let warmup_system = self.presets.read().unwrap().external.get("chat").cloned().unwrap_or_default();
                let spec = ProcSpec { model_path: PathBuf::from(&c.path), warmup_system, unload_when_idle: true };
                let lease = self.sup.acquire(&format!("gguf:{}", c.id), spec).await?;
                Ok(Target {
                    provider_id: c.id.clone(),
                    model: c.name.clone(),
                    base_url: format!("http://127.0.0.1:{}", lease.port),
                    api_key: None,
                    llama: true,
                    _lease: Some(lease),
                })
            }
            Provider::External(c) => Ok(Target {
                provider_id: c.id.clone(),
                model: c.model.clone(),
                base_url: c.base_url.clone(),
                api_key: c.api_key.clone(),
                llama: false,
                _lease: None,
            }),
        }
    }
}
