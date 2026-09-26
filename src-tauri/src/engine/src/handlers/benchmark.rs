//! Playground performance benchmark: prompt processing / generation speed and
//! first-token latency for fixed prompt sizes, plus model load time.
//!
//! llama-server targets use the native /completion endpoint with token-id prompts,
//! `ignore_eos` and no prompt cache, so numbers come from llama.cpp's own timings.
//! External providers can only be timed from the outside, so their numbers are
//! marked as estimates.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{hardware, JsonBody};
use crate::contract::{Hardware, ModelRole};
use crate::error::{ApiError, EngineError, Result};
use crate::prompts::ResolvedSampling;
use crate::providers::{request_body, Chunk, Msg, Provider, Target};
use crate::state::AppState;
use crate::supervisor::Phase;

/// (name, prompt tokens, generated tokens)
const CASES: &[(&str, u32, u32)] = &[("短提示", 128, 128), ("中等提示", 512, 128), ("长提示", 2048, 128)];

const FILLER: &str = "旁白：雨把整条街泡得发白，我们挤在同一把伞下，谁也没先开口。\n玲：……你手好凉。\n旁白：她没有看我，只是把我的手，轻轻塞进了她的外套口袋里。\n悠真：明天还会下雨吗？\n玲：不知道。可是，下雨也没关系。\n";

#[derive(Debug, Deserialize)]
pub struct BenchRequest {
    pub provider: Option<String>,
    pub reps: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaseResult {
    pub name: String,
    pub rep: u32,
    pub prompt_tokens: u64,
    pub gen_tokens: u64,
    pub pp_tps: f64,
    pub tg_tps: f64,
    pub ttft_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BenchEnv {
    pub provider: String,
    pub model: String,
    pub backend: String,
    pub version: String,
    pub ctx: u32,
    pub estimated: bool,
    pub hardware: Hardware,
    pub os: String,
}

fn ev<T: Serialize>(name: &str, data: &T) -> Event {
    Event::default().event(name).json_data(data).unwrap_or_else(|_| Event::default().event(name))
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

pub async fn benchmark(State(st): State<Arc<AppState>>, JsonBody(req): JsonBody<BenchRequest>) -> Response {
    let reps = req.reps.unwrap_or(2).clamp(1, 5);
    let provider = match st.provider(req.provider.as_deref()) {
        Ok(p) => p,
        Err(e) => return ApiError(e, None).into_response(),
    };
    Sse::new(run(st, provider, reps)).keep_alive(KeepAlive::default()).into_response()
}

fn run(st: Arc<AppState>, provider: Provider, reps: u32) -> impl Stream<Item = std::result::Result<Event, Infallible>> {
    async_stream::stream! {
        let key = match &provider {
            Provider::Vnpen => Some(ModelRole::Writer.as_str().to_string()),
            Provider::Gguf(c) => Some(format!("gguf:{}", c.id)),
            Provider::External(_) => None,
        };
        let was_loaded = key.as_ref().is_some_and(|k| st.sup.phase(k) == Phase::Running);
        yield Ok(ev("stage", &json!({ "message": if was_loaded { "模型已加载" } else { "加载模型…" } })));
        let t0 = Instant::now();
        let target = match st.target(&provider, ModelRole::Writer).await {
            Ok(t) => t,
            Err(e) => {
                yield Ok(ev("error", &e.body(None)));
                return;
            }
        };
        let load_ms = if was_loaded || !target.llama { None } else { Some(t0.elapsed().as_millis() as u64) };
        let env = BenchEnv {
            provider: target.provider_id.clone(),
            model: target.model.clone(),
            backend: if target.llama { "llama.cpp".into() } else { "OpenAI 兼容接口".into() },
            version: if target.llama { st.sup.version() } else { "—".into() },
            ctx: st.ctx(),
            estimated: !target.llama,
            hardware: hardware(&st),
            os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        };
        yield Ok(ev("env", &json!({ "env": env, "load_ms": load_ms })));

        let http = reqwest::Client::builder().pool_max_idle_per_host(0).build().unwrap();
        let tokens = if target.llama {
            match filler_tokens(&http, &target).await {
                Ok(t) => Some(t),
                Err(e) => {
                    yield Ok(ev("error", &e.body(None)));
                    return;
                }
            }
        } else {
            None
        };

        // Warm-up so the first measured case does not pay one-time costs.
        yield Ok(ev("stage", &json!({ "message": "预热…" })));
        let warm = match &tokens {
            Some(t) => llama_case(&http, &target, t, 32, 8).await.map(|_| ()),
            None => external_case(&st, &target, 32, 8).await.map(|_| ()),
        };
        if let Err(e) = warm {
            yield Ok(ev("error", &e.body(None)));
            return;
        }

        let total = CASES.len() as u32 * reps;
        let mut done = 0u32;
        let mut results: Vec<CaseResult> = Vec::new();
        for (name, pp, tg) in CASES {
            for rep in 1..=reps {
                yield Ok(ev("stage", &json!({ "message": format!("{name} · 第 {rep}/{reps} 次"), "done": done, "total": total })));
                let r = match &tokens {
                    Some(t) => llama_case(&http, &target, t, *pp, *tg).await,
                    None => external_case(&st, &target, *pp, *tg).await,
                };
                match r {
                    Ok(mut c) => {
                        c.name = name.to_string();
                        c.rep = rep;
                        done += 1;
                        yield Ok(ev("case", &json!({ "result": c, "done": done, "total": total })));
                        results.push(c);
                    }
                    Err(e) => {
                        yield Ok(ev("error", &e.body(None)));
                        return;
                    }
                }
            }
        }
        yield Ok(ev("done", &json!({ "results": results, "load_ms": load_ms, "env": env })));
    }
}

async fn filler_tokens(http: &reqwest::Client, target: &Target) -> Result<Vec<Value>> {
    let v: Value = http
        .post(format!("{}/tokenize", target.base_url))
        .json(&json!({ "content": FILLER.repeat(8), "add_special": false }))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| EngineError::provider(format!("tokenize 失败：{e}")))?
        .json()
        .await
        .map_err(|e| EngineError::provider(format!("tokenize 返回格式错误：{e}")))?;
    let t = v["tokens"].as_array().cloned().unwrap_or_default();
    if t.is_empty() {
        return Err(EngineError::provider("tokenize 返回为空"));
    }
    Ok(t)
}

async fn llama_case(http: &reqwest::Client, target: &Target, base: &[Value], pp: u32, tg: u32) -> Result<CaseResult> {
    let prompt: Vec<Value> = base.iter().cycle().take(pp as usize).cloned().collect();
    let body = json!({
        "prompt": prompt,
        "n_predict": tg,
        "ignore_eos": true,
        "cache_prompt": false,
        "temperature": 0.0,
        "stream": false,
    });
    let t0 = Instant::now();
    let v: Value = http
        .post(format!("{}/completion", target.base_url))
        .json(&body)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| EngineError::provider(format!("基准请求失败：{e}")))?
        .json()
        .await
        .map_err(|e| EngineError::provider(format!("基准返回格式错误：{e}")))?;
    let total_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let t = &v["timings"];
    let prompt_ms = t["prompt_ms"].as_f64().unwrap_or(0.0);
    let predicted_n = t["predicted_n"].as_f64().unwrap_or(0.0);
    let predicted_ms = t["predicted_ms"].as_f64().unwrap_or(0.0);
    let per_token = if predicted_n > 0.0 { predicted_ms / predicted_n } else { 0.0 };
    Ok(CaseResult {
        name: String::new(),
        rep: 0,
        prompt_tokens: t["prompt_n"].as_u64().unwrap_or(pp as u64),
        gen_tokens: predicted_n as u64,
        pp_tps: round1(t["prompt_per_second"].as_f64().unwrap_or(0.0)),
        tg_tps: round1(t["predicted_per_second"].as_f64().unwrap_or(0.0)),
        ttft_ms: round1(prompt_ms + per_token),
        total_ms: round1(total_ms),
    })
}

/// Outside timing only: prompt length is approximated by characters.
async fn external_case(st: &AppState, target: &Target, pp: u32, tg: u32) -> Result<CaseResult> {
    let text: String = FILLER.chars().cycle().take(pp as usize).collect();
    let sampling = ResolvedSampling {
        temperature: 0.7,
        top_p: 1.0,
        top_k: 40,
        repeat_penalty: 1.0,
        repeat_last_n: 64,
        max_tokens: tg,
        stop: vec![],
        thinking: false,
    };
    let messages = vec![Msg::user(format!("{text}\n\n请续写上面的剧本。"))];
    let body = request_body(target, &messages, &sampling, true);
    let t0 = Instant::now();
    let mut ttft = None;
    let mut out_chars = 0u64;
    let mut usage = (None, None);
    let mut s = Box::pin(st.client.stream(target, body).await?);
    while let Some(c) = s.next().await {
        match c? {
            Chunk::Text(t) => {
                ttft.get_or_insert(t0.elapsed().as_secs_f64() * 1000.0);
                out_chars += t.chars().count() as u64;
            }
            Chunk::Finish { prompt_tokens, completion_tokens, .. } => usage = (prompt_tokens, completion_tokens),
        }
    }
    let total_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let ttft = ttft.unwrap_or(total_ms);
    let prompt_tokens = usage.0.unwrap_or(pp as u64);
    let gen = usage.1.unwrap_or(out_chars);
    let gen_secs = (total_ms - ttft) / 1000.0;
    Ok(CaseResult {
        name: String::new(),
        rep: 0,
        prompt_tokens,
        gen_tokens: gen,
        pp_tps: round1(if ttft > 0.0 { prompt_tokens as f64 / (ttft / 1000.0) } else { 0.0 }),
        tg_tps: round1(if gen_secs > 0.0 && gen > 1 { (gen - 1) as f64 / gen_secs } else { 0.0 }),
        ttft_ms: round1(ttft),
        total_ms: round1(total_ms),
    })
}
