//! llama-server process lifecycle: random port, /health polling, warmup,
//! one automatic restart after a crash, idle unload, no leftovers on exit.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::error::{EngineError, Result};

pub const IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);
const START_TIMEOUT: Duration = Duration::from_secs(120);
const REQUEST_WAIT: Duration = Duration::from_secs(45);
const EXPECTED_START: f32 = 12.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "phase", content = "message")]
pub enum Phase {
    Stopped,
    Starting,
    Running,
    Unloaded,
    Failed(String),
}

impl Phase {
    pub fn label(&self) -> &'static str {
        match self {
            Phase::Stopped => "stopped",
            Phase::Starting => "starting",
            Phase::Running => "running",
            Phase::Unloaded => "unloaded",
            Phase::Failed(_) => "failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProcSpec {
    pub model_path: PathBuf,
    /// Used for the warmup request so the system prefix is cached.
    pub warmup_system: String,
    pub unload_when_idle: bool,
}

struct Proc {
    phase: Phase,
    port: u16,
    pid: Option<u32>,
    spec: ProcSpec,
    restarts: u32,
    started_at: Instant,
    last_used: Instant,
    busy: u32,
    stop: CancellationToken,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcStatus {
    pub key: String,
    pub phase: Phase,
    pub port: u16,
    pub model_path: String,
    pub idle_secs: u64,
    pub pid: Option<u32>,
}

pub struct Supervisor {
    bin: Option<PathBuf>,
    log_dir: PathBuf,
    pid_file: PathBuf,
    ctx: u32,
    procs: Mutex<HashMap<String, Proc>>,
    http: reqwest::Client,
    version: Mutex<Option<String>>,
}

/// Released on drop: marks the process idle-eligible again.
pub struct Lease {
    sup: Arc<Supervisor>,
    key: String,
    pub port: u16,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(p) = self.sup.procs.lock().unwrap().get_mut(&self.key) {
            p.busy = p.busy.saturating_sub(1);
            p.last_used = Instant::now();
        }
    }
}

fn free_port() -> Result<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| EngineError::not_ready(format!("无法分配端口：{e}"), None))
}

impl Supervisor {
    pub fn new(bin: Option<PathBuf>, log_dir: PathBuf, ctx: u32) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&log_dir);
        let bin = bin.filter(|b| b.is_file());
        let pid_file = log_dir.join("llama-server.pids");
        reap_stale(&pid_file);
        let sup = Arc::new(Self {
            bin,
            log_dir,
            pid_file,
            ctx,
            procs: Mutex::new(HashMap::new()),
            http: reqwest::Client::new(),
            version: Mutex::new(None),
        });
        let weak = Arc::downgrade(&sup);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(30));
            loop {
                tick.tick().await;
                let Some(sup) = weak.upgrade() else { break };
                sup.reap_idle();
            }
        });
        sup
    }

    pub fn available(&self) -> bool {
        self.bin.is_some()
    }

    pub fn version(&self) -> String {
        if let Some(v) = self.version.lock().unwrap().clone() {
            return v;
        }
        let Some(bin) = &self.bin else { return "missing".into() };
        let out = std::process::Command::new(bin).arg("--version").output();
        let v = out
            .ok()
            .map(|o| String::from_utf8_lossy(if o.stdout.is_empty() { &o.stderr } else { &o.stdout }).to_string())
            .and_then(|s| s.lines().find(|l| l.contains("version")).map(|l| l.trim().to_string()))
            .unwrap_or_else(|| "unknown".into());
        *self.version.lock().unwrap() = Some(v.clone());
        v
    }

    pub fn statuses(&self) -> Vec<ProcStatus> {
        let procs = self.procs.lock().unwrap();
        let mut v: Vec<ProcStatus> = procs
            .iter()
            .map(|(k, p)| ProcStatus {
                key: k.clone(),
                phase: p.phase.clone(),
                port: p.port,
                model_path: p.spec.model_path.display().to_string(),
                idle_secs: p.last_used.elapsed().as_secs(),
                pid: p.pid,
            })
            .collect();
        v.sort_by(|a, b| a.key.cmp(&b.key));
        v
    }

    pub fn phase(&self, key: &str) -> Phase {
        self.procs.lock().unwrap().get(key).map(|p| p.phase.clone()).unwrap_or(Phase::Stopped)
    }

    pub fn pids(&self) -> Vec<u32> {
        self.procs.lock().unwrap().values().filter_map(|p| p.pid).collect()
    }

    /// Returns a lease on a running process, starting it (and waiting a bounded time) if needed.
    pub async fn acquire(self: &Arc<Self>, key: &str, spec: ProcSpec) -> Result<Lease> {
        if self.bin.is_none() {
            return Err(EngineError::not_ready("未找到 llama-server，可执行 scripts/fetch-llama-server.sh", None));
        }
        let deadline = Instant::now() + REQUEST_WAIT;
        loop {
            let action = {
                let mut procs = self.procs.lock().unwrap();
                match procs.get_mut(key) {
                    Some(p) if p.spec.model_path != spec.model_path => Some(true), // model switched
                    Some(p) => match &p.phase {
                        Phase::Running => {
                            p.busy += 1;
                            p.last_used = Instant::now();
                            return Ok(Lease { sup: self.clone(), key: key.to_string(), port: p.port });
                        }
                        Phase::Starting => None,
                        Phase::Failed(msg) if p.restarts > 1 => {
                            let msg = msg.clone();
                            // Allow a manual retry by the next request after a short cool-down.
                            if p.last_used.elapsed() < Duration::from_secs(30) {
                                return Err(EngineError::not_ready(format!("推理引擎启动失败：{msg}"), None));
                            }
                            Some(false)
                        }
                        _ => Some(false),
                    },
                    None => Some(false),
                }
            };
            if let Some(switch) = action {
                if switch {
                    self.stop(key).await;
                }
                self.spawn(key, spec.clone(), 0)?;
            }
            if Instant::now() >= deadline {
                return Err(EngineError::not_ready("模型加载中", Some(self.progress(key))));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn progress(&self, key: &str) -> f32 {
        self.procs
            .lock()
            .unwrap()
            .get(key)
            .map(|p| (p.started_at.elapsed().as_secs_f32() / EXPECTED_START).min(0.95))
            .unwrap_or(0.0)
    }

    fn spawn(self: &Arc<Self>, key: &str, spec: ProcSpec, restarts: u32) -> Result<()> {
        let bin = self.bin.clone().unwrap();
        let port = free_port()?;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_dir.join(format!("{}.log", key.replace([':', '/'], "_"))))
            .map_err(|e| EngineError::not_ready(format!("无法写日志：{e}"), None))?;
        let log2 = log.try_clone().map_err(|e| EngineError::not_ready(e.to_string(), None))?;
        let mut child = Command::new(&bin)
            .args(llama_args(&spec.model_path, port, self.ctx))
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log2))
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| EngineError::not_ready(format!("无法启动 llama-server：{e}"), None))?;
        let pid = child.id();
        let stop = CancellationToken::new();
        {
            let mut procs = self.procs.lock().unwrap();
            let now = Instant::now();
            procs.insert(
                key.to_string(),
                Proc { phase: Phase::Starting, port, pid, spec: spec.clone(), restarts, started_at: now, last_used: now, busy: 0, stop: stop.clone() },
            );
        }
        self.write_pids();
        tracing::info!("llama-server[{key}] starting on port {port} (pid {pid:?})");

        // Readiness + warmup.
        let this = self.clone();
        let k = key.to_string();
        let ready_stop = stop.clone();
        let warm_spec = spec.clone();
        tokio::spawn(async move {
            let ok = tokio::select! {
                r = this.wait_healthy(port) => r,
                _ = ready_stop.cancelled() => return,
            };
            if !ok {
                this.set_phase(&k, Phase::Failed("启动超时".into()));
                ready_stop.cancel();
                return;
            }
            this.warmup(port, &warm_spec.warmup_system).await;
            let mut procs = this.procs.lock().unwrap();
            if let Some(p) = procs.get_mut(&k) {
                if p.phase == Phase::Starting && p.port == port {
                    p.phase = Phase::Running;
                    p.last_used = Instant::now();
                }
            }
        });

        // Exit monitor: owns the child.
        let this = self.clone();
        let k = key.to_string();
        tokio::spawn(async move {
            tokio::select! {
                status = child.wait() => {
                    let crashed = {
                        let procs = this.procs.lock().unwrap();
                        procs.get(&k).is_some_and(|p| p.port == port && matches!(p.phase, Phase::Running | Phase::Starting))
                    };
                    if crashed {
                        tracing::warn!("llama-server[{k}] exited unexpectedly: {status:?}");
                        if restarts == 0 {
                            let _ = this.spawn(&k, spec, 1);
                        } else {
                            this.set_phase(&k, Phase::Failed(format!("进程退出：{status:?}")));
                            if let Some(p) = this.procs.lock().unwrap().get_mut(&k) { p.restarts = 2; p.pid = None; p.last_used = Instant::now(); }
                            this.write_pids();
                        }
                    }
                }
                _ = stop.cancelled() => {
                    let _ = child.kill().await;
                }
            }
        });
        Ok(())
    }

    /// Survives a crash of this process so the next start can reap orphans.
    fn write_pids(&self) {
        let pids: Vec<String> = self.pids().iter().map(u32::to_string).collect();
        let _ = std::fs::write(&self.pid_file, pids.join("\n"));
    }

    fn set_phase(&self, key: &str, phase: Phase) {
        if let Some(p) = self.procs.lock().unwrap().get_mut(key) {
            p.phase = phase;
        }
    }

    async fn wait_healthy(&self, port: u16) -> bool {
        let url = format!("http://127.0.0.1:{port}/health");
        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(r) = self.http.get(&url).timeout(Duration::from_secs(2)).send().await {
                if r.status().is_success() {
                    return true;
                }
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        false
    }

    async fn warmup(&self, port: u16, system: &str) {
        let body = serde_json::json!({
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": "你好"}],
            "max_tokens": 1,
            "chat_template_kwargs": {"enable_thinking": false},
        });
        let _ = self
            .http
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .json(&body)
            .timeout(Duration::from_secs(60))
            .send()
            .await;
    }

    pub async fn stop(&self, key: &str) {
        let token = {
            let mut procs = self.procs.lock().unwrap();
            procs.get_mut(key).map(|p| {
                p.phase = Phase::Stopped;
                p.pid = None;
                p.stop.clone()
            })
        };
        if let Some(t) = token {
            t.cancel();
            self.write_pids();
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub async fn restart_all(&self) {
        let keys: Vec<String> = self.procs.lock().unwrap().keys().cloned().collect();
        for k in &keys {
            self.stop(k).await;
        }
        self.procs.lock().unwrap().clear();
    }

    fn reap_idle(&self) {
        let mut unloaded = false;
        {
            let mut procs = self.procs.lock().unwrap();
            for (k, p) in procs.iter_mut() {
                if p.spec.unload_when_idle && p.phase == Phase::Running && p.busy == 0 && p.last_used.elapsed() >= IDLE_UNLOAD {
                    tracing::info!("llama-server[{k}] idle for 10 min, unloading");
                    p.phase = Phase::Unloaded;
                    p.pid = None;
                    p.stop.cancel();
                    unloaded = true;
                }
            }
        }
        if unloaded {
            self.write_pids();
        }
    }

    /// Synchronous kill for app exit, when the async runtime may already be gone.
    pub fn kill_all_blocking(&self) {
        {
            let mut procs = self.procs.lock().unwrap();
            for p in procs.values_mut() {
                p.stop.cancel();
                if let Some(pid) = p.pid.take() {
                    kill_pid(pid);
                }
                p.phase = Phase::Stopped;
            }
        }
        let _ = std::fs::remove_file(&self.pid_file);
    }
}

fn llama_args(model: &Path, port: u16, ctx: u32) -> Vec<String> {
    vec![
        "-m".into(),
        model.display().to_string(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "-c".into(),
        ctx.to_string(),
        "-np".into(),
        "1".into(),
        "-ngl".into(),
        "999".into(),
        "--jinja".into(),
        "--cache-reuse".into(),
        "256".into(),
        "--no-webui".into(),
    ]
}

/// Kills llama-server processes left behind by a previous run that did not exit cleanly.
fn reap_stale(pid_file: &Path) {
    let Ok(raw) = std::fs::read_to_string(pid_file) else { return };
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    for pid in raw.lines().filter_map(|l| l.trim().parse::<u32>().ok()) {
        let is_llama = sys
            .process(sysinfo::Pid::from_u32(pid))
            .is_some_and(|p| p.name().to_string_lossy().contains("llama-server"));
        if is_llama {
            tracing::warn!("reaping stale llama-server pid {pid}");
            kill_pid(pid);
        }
    }
    let _ = std::fs::remove_file(pid_file);
}

fn kill_pid(pid: u32) {
    #[cfg(unix)]
    let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).status();
    #[cfg(windows)]
    let _ = std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).status();
}
