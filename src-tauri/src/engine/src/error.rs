use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::Value;

use crate::contract::{ErrorBody, ErrorCode};

#[derive(Debug, Clone, thiserror::Error)]
pub enum EngineError {
    #[error("{message}")]
    EngineNotReady { message: String, progress: Option<f32> },
    #[error("模型输出全部未通过格式校验（已重试一次）")]
    FormatInvalid,
    #[error("上下文过长")]
    ContextTooLong { max_lines: usize },
    #[error("{message}")]
    Provider { message: String, detail: Option<Value>, retryable: bool },
    #[error("{0}")]
    NotAvailable(String),
    #[error("请求已取消")]
    Cancelled,
    #[error("{0}")]
    Invalid(String),
    #[error("令牌无效")]
    Unauthorized,
    #[error("{0}")]
    NotFound(String),
}

impl EngineError {
    pub fn not_ready(message: impl Into<String>, progress: Option<f32>) -> Self {
        EngineError::EngineNotReady { message: message.into(), progress }
    }

    pub fn provider(message: impl Into<String>) -> Self {
        EngineError::Provider { message: message.into(), detail: None, retryable: true }
    }

    pub fn body(&self, request_id: Option<String>) -> ErrorBody {
        let (code, retryable, progress, max_lines, detail) = match self {
            EngineError::EngineNotReady { progress, .. } => {
                (ErrorCode::EngineNotReady, true, *progress, None, None)
            }
            EngineError::FormatInvalid => (ErrorCode::FormatInvalid, true, None, None, None),
            EngineError::ContextTooLong { max_lines } => {
                (ErrorCode::ContextTooLong, false, None, Some(*max_lines), None)
            }
            EngineError::Provider { detail, retryable, .. } => {
                (ErrorCode::ProviderError, *retryable, None, None, detail.clone())
            }
            EngineError::NotAvailable(_) => (ErrorCode::NotAvailable, false, None, None, None),
            EngineError::Cancelled => (ErrorCode::Cancelled, false, None, None, None),
            EngineError::Invalid(_) => (ErrorCode::InvalidRequest, false, None, None, None),
            EngineError::Unauthorized => (ErrorCode::Unauthorized, false, None, None, None),
            EngineError::NotFound(_) => (ErrorCode::NotFound, false, None, None, None),
        };
        ErrorBody {
            code,
            message: self.to_string(),
            retryable,
            progress,
            max_lines,
            detail,
            request_id,
        }
    }

    pub fn status(&self) -> StatusCode {
        match self {
            EngineError::EngineNotReady { .. } => StatusCode::SERVICE_UNAVAILABLE,
            EngineError::FormatInvalid => StatusCode::UNPROCESSABLE_ENTITY,
            EngineError::ContextTooLong { .. } => StatusCode::PAYLOAD_TOO_LARGE,
            EngineError::Provider { .. } => StatusCode::BAD_GATEWAY,
            EngineError::NotAvailable(_) => StatusCode::NOT_IMPLEMENTED,
            EngineError::Cancelled => StatusCode::from_u16(499).unwrap(),
            EngineError::Invalid(_) => StatusCode::BAD_REQUEST,
            EngineError::Unauthorized => StatusCode::UNAUTHORIZED,
            EngineError::NotFound(_) => StatusCode::NOT_FOUND,
        }
    }
}

/// A sync-endpoint error carrying the caller's request_id back.
pub struct ApiError(pub EngineError, pub Option<String>);

impl From<EngineError> for ApiError {
    fn from(e: EngineError) -> Self {
        ApiError(e, None)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0.status(), Json(self.0.body(self.1))).into_response()
    }
}

pub type Result<T> = std::result::Result<T, EngineError>;
