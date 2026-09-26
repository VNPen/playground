use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::Router;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::contract::CONTRACT_VERSION;
use crate::error::{ApiError, EngineError};
use crate::handlers::{self, playground, proofread};
use crate::state::AppState;

pub const TOKEN_HEADER: &str = "x-vnpen-token";
pub const CONTRACT_HEADER: &str = "x-vnpen-contract";

async fn auth(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }
    let ok = req.headers().get(TOKEN_HEADER).and_then(|v| v.to_str().ok()) == Some(st.token.as_str());
    if !ok {
        return ApiError(EngineError::Unauthorized, None).into_response();
    }
    next.run(req).await
}

fn allowed_origin(origin: &HeaderValue) -> bool {
    let o = origin.to_str().unwrap_or("");
    o.starts_with("tauri://")
        || o.starts_with("http://tauri.localhost")
        || o.starts_with("https://tauri.localhost")
        || o.starts_with("http://localhost:")
        || o.starts_with("http://127.0.0.1:")
}

pub fn router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/status", get(handlers::status))
        .route("/continue", post(handlers::continue_))
        .route("/proofread", post(proofread::proofread))
        .route("/rewrite", post(handlers::rewrite))
        .route("/brief", post(handlers::brief))
        .route("/chat", post(handlers::chat))
        .route("/review", post(handlers::review))
        .route("/requests/{id}", delete(handlers::cancel))
        .route("/_playground/calls", get(playground::calls).delete(playground::clear_calls))
        .route("/_playground/calls/{id}", get(playground::call))
        .route("/_playground/models", get(playground::models))
        .route("/_playground/models/download", post(playground::download))
        .route("/_playground/models/delete", post(playground::delete_model))
        .route("/_playground/models/select", post(playground::select_model))
        .route("/_playground/models/dir", post(playground::set_models_dir))
        .route("/_playground/providers", get(playground::providers))
        .route("/_playground/providers/external", put(playground::put_externals))
        .route("/_playground/providers/gguf", post(playground::add_gguf))
        .route("/_playground/providers/gguf/{id}", delete(playground::remove_gguf))
        .route("/_playground/engine", get(playground::engine))
        .route("/_playground/engine/restart", post(playground::restart))
        .route("/_playground/presets", get(playground::presets))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state);

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|o, _| allowed_origin(o)))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, HeaderName::from_static(TOKEN_HEADER)])
        .expose_headers([HeaderName::from_static(CONTRACT_HEADER)]);

    Router::new()
        .nest("/v1/vnpen", api)
        .layer(SetResponseHeaderLayer::overriding(HeaderName::from_static(CONTRACT_HEADER), HeaderValue::from_static(CONTRACT_VERSION)))
        .layer(cors)
}
