//! Model catalog, downloads (resumable, sha256-verified) and on-disk layout.
//!
//! The catalog is read from the Hugging Face organisation (`VNPEN_HF_ORG`, default
//! "VNPen"): every `vnpen-<role>-<params>-<version>-GGUF` repo becomes an entry and
//! each of its .gguf files a downloadable quant. It is cached in the data dir; the
//! bundled models.json is the offline fallback and supplies placeholders such as
//! the unreleased realtime model. The task layer downloads by itself; llama-server
//! never touches the network.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use dashmap::DashMap;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::contract::ModelRole;
use crate::error::{EngineError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFile {
    pub file: String,
    pub quant: String,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub role: ModelRole,
    /// "released" | "not_released"
    pub status: String,
    #[serde(default)]
    pub params: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub files: Vec<ModelFile>,
    /// e.g. "v0.1-preview-GGUF"
    #[serde(default)]
    pub version: Option<String>,
}

impl ModelEntry {
    pub fn released(&self) -> bool {
        self.status == "released"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub models: Vec<ModelEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum DownloadState {
    Downloading { downloaded: u64, total: Option<u64> },
    Verifying { total: u64 },
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct FileView {
    #[serde(flatten)]
    pub file: ModelFile,
    pub installed: bool,
    pub bundled: bool,
    pub active: bool,
    pub download: Option<DownloadState>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelView {
    pub id: String,
    pub version: Option<String>,
    pub name: String,
    pub display_name: String,
    pub role: ModelRole,
    pub status: String,
    pub params: Option<String>,
    pub repo: Option<String>,
    pub files: Vec<FileView>,
}

#[derive(Debug, Clone)]
pub struct ActiveModel {
    pub entry: ModelEntry,
    pub file: ModelFile,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CatalogStatus {
    /// "huggingface" | "cache" | "bundled"
    pub source: String,
    pub org: String,
    pub fetched_at_ms: Option<u64>,
    pub refreshing: bool,
    pub error: Option<String>,
}

pub struct ModelStore {
    manifest: RwLock<Manifest>,
    /// Placeholders from the bundled models.json (e.g. unreleased roles).
    fallback: Manifest,
    cache_path: PathBuf,
    catalog: RwLock<CatalogStatus>,
    org: String,
    dir: RwLock<PathBuf>,
    /// Read-only models shipped inside a "完整版" installer.
    bundled: Option<PathBuf>,
    selected: RwLock<HashMap<ModelRole, (String, String)>>,
    downloads: DashMap<String, DownloadState>,
    cancels: DashMap<String, CancellationToken>,
    http: reqwest::Client,
    hf_endpoint: String,
}

fn key(id: &str, file: &str) -> String {
    format!("{id}/{file}")
}

impl ModelStore {
    pub fn load(manifest_path: &Path, dir: PathBuf, bundled: Option<PathBuf>, cache_path: PathBuf) -> Result<Arc<Self>> {
        let raw = std::fs::read_to_string(manifest_path)
            .map_err(|e| EngineError::NotFound(format!("models.json: {e}")))?;
        let fallback: Manifest = serde_json::from_str(&raw)
            .map_err(|e| EngineError::Invalid(format!("models.json: {e}")))?;
        let _ = std::fs::create_dir_all(&dir);
        let org = std::env::var("VNPEN_HF_ORG").unwrap_or_else(|_| "VNPen".into());
        let cached = std::fs::read_to_string(&cache_path).ok().and_then(|s| serde_json::from_str::<Manifest>(&s).ok());
        let (manifest, source) = match cached {
            Some(m) => (m, "cache"),
            None => (fallback.clone(), "bundled"),
        };
        Ok(Arc::new(Self {
            manifest: RwLock::new(manifest),
            fallback,
            cache_path,
            catalog: RwLock::new(CatalogStatus { source: source.into(), org: org.clone(), ..Default::default() }),
            org,
            dir: RwLock::new(dir),
            bundled: bundled.filter(|b| b.is_dir()),
            selected: RwLock::new(HashMap::new()),
            downloads: DashMap::new(),
            cancels: DashMap::new(),
            http: reqwest::Client::builder().user_agent("vnpen-playground/0.1").build().unwrap(),
            hf_endpoint: std::env::var("HF_ENDPOINT").unwrap_or_else(|_| "https://huggingface.co".into()),
        }))
    }

    pub fn dir(&self) -> PathBuf {
        self.dir.read().unwrap().clone()
    }

    pub fn set_dir(&self, dir: PathBuf) -> Result<()> {
        std::fs::create_dir_all(&dir).map_err(|e| EngineError::Invalid(format!("无法使用该目录：{e}")))?;
        *self.dir.write().unwrap() = dir;
        Ok(())
    }

    pub fn entries(&self) -> Vec<ModelEntry> {
        self.manifest.read().unwrap().models.clone()
    }

    fn find(&self, id: &str, file: &str) -> Result<(ModelEntry, ModelFile)> {
        let m = self.manifest.read().unwrap();
        let entry = m.models.iter().find(|e| e.id == id).ok_or_else(|| EngineError::NotFound(format!("模型 {id} 不存在")))?;
        let f = entry.files.iter().find(|f| f.file == file).ok_or_else(|| EngineError::NotFound(format!("文件 {file} 不存在")))?;
        Ok((entry.clone(), f.clone()))
    }

    fn download_path(&self, id: &str, file: &str) -> PathBuf {
        self.dir().join(id).join(file)
    }

    fn bundled_path(&self, id: &str, file: &str) -> Option<PathBuf> {
        self.bundled.as_ref().map(|b| b.join(id).join(file)).filter(|p| p.is_file())
    }

    /// Downloaded copy first, then the bundled one.
    pub fn path(&self, id: &str, file: &str) -> PathBuf {
        let p = self.download_path(id, file);
        if p.is_file() {
            return p;
        }
        self.bundled_path(id, file).unwrap_or(p)
    }

    fn installed(&self, id: &str, file: &str) -> bool {
        !self.downloads.contains_key(&key(id, file)) && self.path(id, file).is_file()
    }

    pub fn is_bundled(&self, id: &str, file: &str) -> bool {
        !self.download_path(id, file).is_file() && self.bundled_path(id, file).is_some()
    }

    /// Newest released entry of a role, else its placeholder.
    pub fn entry_for(&self, role: ModelRole) -> Option<ModelEntry> {
        let all: Vec<ModelEntry> = self.entries().into_iter().filter(|e| e.role == role).collect();
        all.iter().find(|e| e.released()).cloned().or_else(|| all.into_iter().next())
    }

    /// Selected file if installed, else the recommended file of the newest version, else any installed file.
    pub fn active(&self, role: ModelRole) -> Option<ActiveModel> {
        let entries: Vec<ModelEntry> = self.entries().into_iter().filter(|e| e.role == role && e.released()).collect();
        let installed: Vec<(&ModelEntry, &ModelFile)> =
            entries.iter().flat_map(|e| e.files.iter().filter(|f| self.installed(&e.id, &f.file)).map(move |f| (e, f))).collect();
        let selected = self.selected.read().unwrap().get(&role).cloned();
        let (entry, file) = selected
            .and_then(|(id, file)| installed.iter().find(|(e, f)| e.id == id && f.file == file).copied())
            .or_else(|| installed.iter().find(|(_, f)| f.recommended).copied())
            .or_else(|| installed.first().copied())?;
        let path = self.path(&entry.id, &file.file);
        Some(ActiveModel { entry: entry.clone(), file: file.clone(), path })
    }

    pub fn select(&self, id: &str, file: &str) -> Result<ModelRole> {
        let (entry, _) = self.find(id, file)?;
        if !self.installed(id, file) {
            return Err(EngineError::Invalid("该文件尚未下载".into()));
        }
        self.selected.write().unwrap().insert(entry.role, (id.to_string(), file.to_string()));
        Ok(entry.role)
    }

    pub fn catalog_status(&self) -> CatalogStatus {
        self.catalog.read().unwrap().clone()
    }

    /// Re-reads the organisation from Hugging Face. On failure the current catalog stays.
    pub async fn refresh_catalog(&self) -> Result<()> {
        self.catalog.write().unwrap().refreshing = true;
        let result = self.fetch_catalog().await;
        let mut st = self.catalog.write().unwrap();
        st.refreshing = false;
        match result {
            Ok(entries) => {
                let mut models = entries;
                // Keep placeholders for roles the organisation does not publish yet.
                for fb in &self.fallback.models {
                    if !models.iter().any(|m| m.role == fb.role) {
                        models.push(ModelEntry { files: if fb.released() { fb.files.clone() } else { vec![] }, ..fb.clone() });
                    }
                }
                let manifest = Manifest { version: 1, models };
                if let Ok(json) = serde_json::to_string_pretty(&manifest) {
                    let _ = std::fs::write(&self.cache_path, json);
                }
                *self.manifest.write().unwrap() = manifest;
                st.source = "huggingface".into();
                st.fetched_at_ms = Some(crate::history::now_ms());
                st.error = None;
                Ok(())
            }
            Err(e) => {
                st.error = Some(e.to_string());
                Err(e)
            }
        }
    }

    async fn fetch_catalog(&self) -> Result<Vec<ModelEntry>> {
        #[derive(Deserialize)]
        struct Repo {
            id: String,
        }
        let url = format!("{}/api/models?author={}&limit=200", self.hf_endpoint, self.org);
        let repos: Vec<Repo> = self
            .http
            .get(url)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| EngineError::provider(format!("无法读取 Hugging Face 组织 {}：{e}", self.org)))?
            .json()
            .await
            .map_err(|e| EngineError::provider(format!("Hugging Face 返回格式错误：{e}")))?;
        let mut out = Vec::new();
        for r in repos {
            let Some(mut entry) = parse_repo(&r.id) else { continue };
            let files = self.repo_files(&r.id).await?;
            if files.is_empty() {
                continue;
            }
            entry.files = files;
            out.push(entry);
        }
        out.sort_by(|a, b| (a.role as u8, b.version.clone()).cmp(&(b.role as u8, a.version.clone())));
        Ok(out)
    }

    async fn repo_files(&self, repo: &str) -> Result<Vec<ModelFile>> {
        #[derive(Deserialize)]
        struct Lfs {
            oid: String,
            size: u64,
        }
        #[derive(Deserialize)]
        struct Entry {
            path: String,
            lfs: Option<Lfs>,
        }
        let entries: Vec<Entry> = self
            .http
            .get(format!("{}/api/models/{repo}/tree/main", self.hf_endpoint))
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| EngineError::provider(format!("无法读取 {repo}：{e}")))?
            .json()
            .await
            .map_err(|e| EngineError::provider(format!("{repo} 返回格式错误：{e}")))?;
        let mut files: Vec<ModelFile> = entries
            .into_iter()
            .filter(|e| e.path.to_ascii_lowercase().ends_with(".gguf") && !e.path.contains('/'))
            .filter(|e| !["imatrix", "mmproj"].iter().any(|x| e.path.to_ascii_lowercase().contains(x)))
            .map(|e| {
                let quant = quant_of(&e.path);
                ModelFile {
                    recommended: quant == "Q8_0",
                    note: quant_note(&quant).map(str::to_string),
                    sha256: e.lfs.as_ref().map(|l| l.oid.clone()),
                    size: e.lfs.as_ref().map(|l| l.size),
                    file: e.path,
                    quant,
                }
            })
            .collect();
        files.sort_by_key(|f| quant_rank(&f.quant));
        Ok(files)
    }

    pub fn views(&self) -> Vec<ModelView> {
        self.entries()
            .into_iter()
            .map(|e| {
                let active = self.active(e.role).map(|a| a.file.file);
                let files = e
                    .files
                    .iter()
                    .map(|f| FileView {
                        file: f.clone(),
                        installed: self.installed(&e.id, &f.file),
                        bundled: self.is_bundled(&e.id, &f.file),
                        active: active.as_deref() == Some(f.file.as_str()),
                        download: self.downloads.get(&key(&e.id, &f.file)).map(|d| d.clone()),
                    })
                    .collect();
                ModelView {
                    id: e.id,
                    version: e.version,
                    name: e.name,
                    display_name: e.display_name,
                    role: e.role,
                    status: e.status,
                    params: e.params,
                    repo: e.repo,
                    files,
                }
            })
            .collect()
    }

    pub fn start_download(self: &Arc<Self>, id: &str, file: &str) -> Result<()> {
        let (entry, f) = self.find(id, file)?;
        if !entry.released() {
            return Err(EngineError::NotAvailable("该模型即将推出".into()));
        }
        let repo = entry.repo.clone().ok_or_else(|| EngineError::Invalid("缺少 HF 仓库".into()))?;
        let k = key(id, file);
        if matches!(self.downloads.get(&k).as_deref(), Some(DownloadState::Downloading { .. } | DownloadState::Verifying { .. })) {
            return Ok(());
        }
        let cancel = CancellationToken::new();
        self.cancels.insert(k.clone(), cancel.clone());
        self.downloads.insert(k.clone(), DownloadState::Downloading { downloaded: 0, total: f.size });
        let this = self.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            let result = tokio::select! {
                r = this.download(&repo, &id, f) => r,
                _ = cancel.cancelled() => Err(EngineError::Cancelled),
            };
            this.cancels.remove(&k);
            match result {
                Ok(()) => {
                    this.downloads.remove(&k);
                }
                Err(EngineError::Cancelled) => {
                    this.downloads.remove(&k);
                }
                Err(e) => {
                    tracing::warn!("download {k} failed: {e}");
                    this.downloads.insert(k, DownloadState::Failed { message: e.to_string() });
                }
            }
        });
        Ok(())
    }

    /// sha256/size from the HF tree API when models.json has not been synced.
    async fn lfs_meta(&self, repo: &str, file: &str) -> Result<(Option<String>, Option<u64>)> {
        #[derive(Deserialize)]
        struct Lfs {
            oid: String,
            size: u64,
        }
        #[derive(Deserialize)]
        struct Entry {
            path: String,
            lfs: Option<Lfs>,
        }
        let url = format!("{}/api/models/{repo}/tree/main", self.hf_endpoint);
        let entries: Vec<Entry> = self
            .http
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| EngineError::provider(format!("读取 HF 元数据失败：{e}")))?
            .json()
            .await
            .map_err(|e| EngineError::provider(format!("HF 元数据格式错误：{e}")))?;
        Ok(entries
            .into_iter()
            .find(|e| e.path == file)
            .and_then(|e| e.lfs)
            .map(|l| (Some(l.oid), Some(l.size)))
            .unwrap_or((None, None)))
    }

    async fn download(&self, repo: &str, id: &str, mut f: ModelFile) -> Result<()> {
        let k = key(id, &f.file);
        if f.sha256.is_none() {
            let (sha, size) = self.lfs_meta(repo, &f.file).await?;
            f.sha256 = sha;
            f.size = f.size.or(size);
        }
        let expected = f.sha256.clone().ok_or_else(|| EngineError::provider("HF 上找不到该文件的 sha256"))?;
        let final_path = self.download_path(id, &f.file);
        let part = final_path.with_extension("gguf.part");
        tokio::fs::create_dir_all(final_path.parent().unwrap()).await.map_err(io_err)?;

        let mut have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
        let url = format!("{}/{repo}/resolve/main/{}", self.hf_endpoint, f.file);
        let mut req = self.http.get(&url);
        if have > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let resp = req.send().await.map_err(|e| EngineError::provider(format!("下载失败：{e}")))?;
        let status = resp.status();
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            // .part already complete
        } else if !status.is_success() {
            return Err(EngineError::provider(format!("下载失败：HTTP {status}")));
        } else {
            if have > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
                have = 0; // server ignored Range
            }
            let total = resp.content_length().map(|l| l + have).or(f.size);
            let mut out = tokio::fs::OpenOptions::new()
                .create(true)
                .append(have > 0)
                .write(true)
                .truncate(have == 0)
                .open(&part)
                .await
                .map_err(io_err)?;
            let mut stream = resp.bytes_stream();
            let mut done = have;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| EngineError::provider(format!("下载中断：{e}")))?;
                out.write_all(&chunk).await.map_err(io_err)?;
                done += chunk.len() as u64;
                self.downloads.insert(k.clone(), DownloadState::Downloading { downloaded: done, total });
            }
            out.flush().await.map_err(io_err)?;
        }

        let total = tokio::fs::metadata(&part).await.map_err(io_err)?.len();
        self.downloads.insert(k.clone(), DownloadState::Verifying { total });
        let actual = sha256_file(&part).await?;
        if !actual.eq_ignore_ascii_case(&expected) {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(EngineError::provider(format!("sha256 校验失败（期望 {expected}，实际 {actual}）")));
        }
        tokio::fs::rename(&part, &final_path).await.map_err(io_err)?;
        Ok(())
    }

    pub async fn delete(&self, id: &str, file: &str) -> Result<()> {
        self.find(id, file)?;
        if self.is_bundled(id, file) {
            return Err(EngineError::Invalid("内置模型随安装包提供，无法删除".into()));
        }
        let k = key(id, file);
        if let Some((_, c)) = self.cancels.remove(&k) {
            c.cancel();
        }
        self.downloads.remove(&k);
        let path = self.download_path(id, file);
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(path.with_extension("gguf.part")).await;
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::remove_dir(parent).await; // only succeeds if empty
        }
        Ok(())
    }

    pub fn cancel_all(&self) {
        for c in self.cancels.iter() {
            c.cancel();
        }
    }
}

const QUANT_ORDER: &[&str] = &["Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q4_K_M", "Q4_K_S", "IQ4_XS", "Q3_K_M", "BF16", "F16"];

fn quant_rank(q: &str) -> usize {
    QUANT_ORDER.iter().position(|x| *x == q).unwrap_or(QUANT_ORDER.len())
}

fn quant_note(q: &str) -> Option<&'static str> {
    match q {
        "Q8_0" => Some("推荐"),
        "Q4_K_M" => Some("省内存"),
        "BF16" | "F16" => Some("原始精度"),
        _ => None,
    }
}

/// "writer-2b-preview-Q4_K_M.gguf" → "Q4_K_M"
fn quant_of(file: &str) -> String {
    let stem = file.trim_end_matches(".gguf").trim_end_matches(".GGUF");
    stem.rsplit(['-', '.']).next().unwrap_or(stem).to_ascii_uppercase()
}

/// "VNPen/vnpen-writer-2b-v0.1-preview-GGUF" → Writer entry with version "v0.1-preview-GGUF".
pub fn parse_repo(repo_id: &str) -> Option<ModelEntry> {
    static RE: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)^vnpen-(writer|realtime)-(\d+(?:\.\d+)?[bm])-(.+-gguf)$").unwrap());
    let name = repo_id.rsplit('/').next()?;
    let c = RE.captures(name)?;
    let role = if c[1].eq_ignore_ascii_case("writer") { ModelRole::Writer } else { ModelRole::Realtime };
    let label = if role == ModelRole::Writer { "Writer" } else { "Realtime" };
    let version = c[3].to_string();
    let id = name[..name.len() - "-GGUF".len()].to_string();
    Some(ModelEntry {
        id,
        name: format!("vnpen-{}", role.as_str()),
        display_name: format!("{label} {version}"),
        role,
        status: "released".into(),
        params: Some(c[2].to_ascii_uppercase()),
        repo: Some(repo_id.to_string()),
        files: vec![],
        version: Some(version),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_repo_names() {
        let e = parse_repo("VNPen/vnpen-writer-2b-v0.1-preview-GGUF").unwrap();
        assert_eq!(e.id, "vnpen-writer-2b-v0.1-preview");
        assert_eq!(e.display_name, "Writer v0.1-preview-GGUF");
        assert_eq!(e.params.as_deref(), Some("2B"));
        assert_eq!(e.role, ModelRole::Writer);
        assert!(parse_repo("VNPen/vnpen-writer-2b-v0.1-preview").is_none());
        assert_eq!(parse_repo("VNPen/vnpen-realtime-0.8b-v0.2-GGUF").unwrap().display_name, "Realtime v0.2-GGUF");
    }

    #[test]
    fn parses_quants() {
        assert_eq!(quant_of("writer-2b-preview-Q4_K_M.gguf"), "Q4_K_M");
        assert_eq!(quant_of("writer-2b-preview-BF16.gguf"), "BF16");
        assert_eq!(quant_of("qwen2.5-0.5b-instruct-q4_k_m.gguf"), "Q4_K_M");
    }
}

fn io_err(e: std::io::Error) -> EngineError {
    EngineError::provider(format!("文件读写失败：{e}"))
}

pub async fn sha256_file(path: &Path) -> Result<String> {
    let mut f = tokio::fs::File::open(path).await.map_err(io_err)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).await.map_err(io_err)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}
