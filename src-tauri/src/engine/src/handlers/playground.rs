//! Playground-only endpoints under `/v1/vnpen/_playground/`. Not part of the contract.

use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{JsonBody, St};
use crate::error::{ApiError, EngineError};
use crate::history::{CallRecord, CallSummary};
use crate::providers::{ExternalConfig, GgufConfig, VNPEN_PROVIDER};

type ApiResult<T> = std::result::Result<T, ApiError>;

pub async fn calls(State(st): St) -> Json<Vec<CallSummary>> {
    Json(st.history.list())
}

pub async fn call(State(st): St, Path(id): Path<String>) -> ApiResult<Json<CallRecord>> {
    st.history.get(&id).map(Json).ok_or_else(|| EngineError::NotFound("记录不存在".into()).into())
}

pub async fn clear_calls(State(st): St) -> StatusCode {
    st.history.clear();
    StatusCode::NO_CONTENT
}

pub async fn models(State(st): St) -> Json<Value> {
    Json(json!({ "dir": st.models.dir(), "models": st.models.views() }))
}

#[derive(Deserialize)]
pub struct FileRef {
    id: String,
    file: String,
}

pub async fn download(State(st): St, JsonBody(r): JsonBody<FileRef>) -> ApiResult<StatusCode> {
    st.models.start_download(&r.id, &r.file)?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn delete_model(State(st): St, JsonBody(r): JsonBody<FileRef>) -> ApiResult<StatusCode> {
    let active = st.models.entries().into_iter().find(|e| e.id == r.id).and_then(|e| st.models.active(e.role).map(|a| (e.role, a)));
    if let Some((role, a)) = active {
        if a.file.file == r.file {
            st.sup.stop(role.as_str()).await;
        }
    }
    st.models.delete(&r.id, &r.file).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn select_model(State(st): St, JsonBody(r): JsonBody<FileRef>) -> ApiResult<StatusCode> {
    st.models.select(&r.id, &r.file)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct DirReq {
    path: String,
}

pub async fn set_models_dir(State(st): St, JsonBody(r): JsonBody<DirReq>) -> ApiResult<StatusCode> {
    st.models.set_dir(PathBuf::from(r.path))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn providers(State(st): St) -> Json<Value> {
    Json(json!({
        "external": *st.externals.read().unwrap(),
        "gguf": *st.ggufs.read().unwrap(),
    }))
}

/// Replaces the whole external list; the frontend owns persistence of settings.
pub async fn put_externals(State(st): St, JsonBody(list): JsonBody<Vec<ExternalConfig>>) -> ApiResult<StatusCode> {
    for c in &list {
        if c.id.is_empty() || c.id == VNPEN_PROVIDER || c.id.starts_with("gguf-") {
            return Err(EngineError::Invalid(format!("provider id 不可用：{}", c.id)).into());
        }
        if !(c.base_url.starts_with("http://") || c.base_url.starts_with("https://")) {
            return Err(EngineError::Invalid(format!("{} 的 URL 需以 http(s):// 开头", c.name)).into());
        }
    }
    *st.externals.write().unwrap() = list;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct GgufReq {
    path: String,
    name: Option<String>,
}

pub async fn add_gguf(State(st): St, JsonBody(r): JsonBody<GgufReq>) -> ApiResult<Json<GgufConfig>> {
    let p = PathBuf::from(&r.path);
    if !p.is_file() || p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("gguf")) != Some(true) {
        return Err(EngineError::Invalid("请选择存在的 .gguf 文件".into()).into());
    }
    let name = r.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| p.file_stem().unwrap().to_string_lossy().to_string());
    let cfg = GgufConfig { id: format!("gguf-{}", &uuid::Uuid::new_v4().to_string()[..8]), name, path: r.path };
    st.ggufs.write().unwrap().push(cfg.clone());
    Ok(Json(cfg))
}

pub async fn remove_gguf(State(st): St, Path(id): Path<String>) -> StatusCode {
    st.sup.stop(&format!("gguf:{id}")).await;
    st.ggufs.write().unwrap().retain(|g| g.id != id);
    StatusCode::NO_CONTENT
}

pub async fn engine(State(st): St) -> Json<Value> {
    Json(json!({ "available": st.sup.available(), "version": st.sup.version(), "processes": st.sup.statuses() }))
}

pub async fn restart(State(st): St) -> StatusCode {
    st.sup.restart_all().await;
    st.window.reset();
    StatusCode::NO_CONTENT
}

pub async fn presets(State(st): St) -> Json<Value> {
    let p = st.presets.read().unwrap();
    Json(json!({
        "realtime_system": p.realtime_system,
        "writer_system_write": p.writer_system_write,
        "writer_system_answer": p.writer_system_answer,
        "external": p.external,
        "templates": p.templates,
        "sampling": p.sampling,
        "allow_system_override": st.allow_system_override,
    }))
}
