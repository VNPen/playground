//! End-to-end contract test against a real llama-server and a small GGUF.
//!
//!   VNPEN_TEST_GGUF=/path/to/Qwen3.5-0.8B-Q4_K_M.gguf \
//!   cargo test -p vnpen-engine --test contract -- --ignored --nocapture
//!
//! Checks wire behaviour (event order, error codes, cancellation, location of
//! Issues), not output quality.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{json, Value};
use vnpen_engine::{start, EngineConfig, EngineHandle};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn llama_server() -> PathBuf {
    let triple = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", a) => format!("{a}-apple-darwin"),
        ("windows", a) => format!("{a}-pc-windows-msvc.exe"),
        (_, a) => format!("{a}-unknown-linux-gnu"),
    };
    std::env::var("VNPEN_LLAMA_SERVER").map(PathBuf::from).unwrap_or_else(|_| root().join(format!("binaries/llama-server-{triple}")))
}

struct Ctx {
    h: EngineHandle,
    http: reqwest::Client,
    gguf: String,
}

impl Ctx {
    fn url(&self, p: &str) -> String {
        format!("{}{}", self.h.base_url(), p)
    }

    fn req(&self, m: reqwest::Method, p: &str) -> reqwest::RequestBuilder {
        self.http.request(m, self.url(p)).header("X-VNPen-Token", &self.h.token)
    }

    async fn post(&self, p: &str, body: Value) -> reqwest::Response {
        self.req(reqwest::Method::POST, p).json(&body).send().await.unwrap()
    }

    /// Returns (event name, data) pairs in order.
    async fn sse(&self, p: &str, body: Value) -> Vec<(String, Value)> {
        let res = self.post(p, body).await;
        assert_eq!(res.headers()["x-vnpen-contract"], "1");
        assert!(res.headers()["content-type"].to_str().unwrap().starts_with("text/event-stream"), "{p}: not SSE ({})", res.status());
        let text = res.text().await.unwrap();
        text.split("\n\n")
            .filter_map(|chunk| {
                let ev = chunk.lines().find_map(|l| l.strip_prefix("event:"))?.trim().to_string();
                let data = chunk.lines().find_map(|l| l.strip_prefix("data:"))?.trim();
                Some((ev, serde_json::from_str(data).unwrap()))
            })
            .collect()
    }
}

async fn setup() -> Option<Ctx> {
    let gguf = std::env::var("VNPEN_TEST_GGUF").ok()?;
    let tmp = std::env::temp_dir().join(format!("vnpen-test-{}", std::process::id()));
    let h = start(EngineConfig {
        llama_server_path: Some(llama_server()),
        presets_dir: root().join("presets"),
        models_manifest: root().join("models.json"),
        models_dir: tmp.join("models"),
        bundled_models_dir: None,
        data_dir: tmp,
        port: 0,
        token: None,
        allow_system_override: true,
        intent_hook: None,
    })
    .await
    .unwrap();
    let http = reqwest::Client::new();
    let mut ctx = Ctx { h, http, gguf: String::new() };
    let g: Value = ctx.post("/_playground/providers/gguf", json!({ "path": gguf, "name": "test" })).await.json().await.unwrap();
    ctx.gguf = g["id"].as_str().unwrap().to_string();
    Some(ctx)
}

fn lines() -> Value {
    json!([
        {"id": "a", "speaker": "旁白", "text": "夜色里，她的身影显的格外单薄。", "kind": "narration"},
        {"id": "x", "speaker": "", "text": "（镜头拉远）", "kind": "direction"},
        {"id": "b", "speaker": "玲", "text": "别站在那儿了，冷。", "kind": "dialogue"},
        {"id": "c", "speaker": "悠真", "text": "……嗯。", "kind": "dialogue"}
    ])
}

fn assert_script_stream(events: &[(String, Value)]) {
    let (last, done) = events.last().expect("no events");
    assert_eq!(last, "done", "stream must end with done: {events:?}");
    let lines: Vec<&Value> = events.iter().filter(|(e, _)| e == "line").map(|(_, d)| d).collect();
    for (i, l) in lines.iter().enumerate() {
        assert_eq!(l["index"], i, "line indexes start at 0 and are contiguous");
        assert!(!l["speaker"].as_str().unwrap().is_empty());
        assert!(!l["text"].as_str().unwrap().is_empty());
    }
    assert_eq!(done["n_lines"], lines.len());
    for k in ["model", "provider", "tokens_in", "tokens_out", "tps", "ttft_ms", "elapsed_ms"] {
        assert!(done["meta"].get(k).is_some(), "meta.{k} missing");
    }
}

#[tokio::test]
#[ignore]
async fn all_endpoints() {
    let Some(c) = setup().await else {
        eprintln!("VNPEN_TEST_GGUF not set; skipping");
        return;
    };

    // 3.1 /status
    let res = c.req(reqwest::Method::GET, "/status").send().await.unwrap();
    assert_eq!(res.headers()["x-vnpen-contract"], "1");
    let st: Value = res.json().await.unwrap();
    assert_eq!(st["engine"]["backend"], "llama.cpp");
    assert!(st["providers"].as_array().unwrap().iter().any(|p| p["id"] == c.gguf));
    assert!(st["models"].as_array().unwrap().iter().all(|m| m["thinking_supported"] == false));

    // auth
    let res = c.http.get(c.url("/status")).send().await.unwrap();
    assert_eq!(res.status(), 401);

    // 3.2 /continue
    let ev = c.sse("/continue", json!({ "provider": c.gguf, "lines": lines(), "pov": "悠真", "max_lines": 3 })).await;
    assert_script_stream(&ev);
    assert!(ev.iter().filter(|(e, _)| e == "line").count() <= 3);

    // own realtime model is not released → not_available, never silently rerouted
    let res = c.post("/continue", json!({ "lines": lines(), "pov": "悠真" })).await;
    assert_eq!(res.status(), 501);
    assert_eq!(res.json::<Value>().await.unwrap()["code"], "not_available");

    // 3.3 /proofread: every Issue is located inside its line
    let res: Value = c.post("/proofread", json!({ "provider": c.gguf, "lines": lines(), "pov": "悠真", "whitelist": ["玲"] })).await.json().await.unwrap();
    let issues = res["issues"].as_array().unwrap();
    assert!(issues.iter().any(|i| i["from"] == "显的" && i["source"] == "rules" && i["confidence"] == "high"));
    let texts = lines();
    for i in issues {
        let line = texts.as_array().unwrap().iter().find(|l| l["id"] == i["line_id"]).unwrap();
        let text: Vec<u16> = line["text"].as_str().unwrap().encode_utf16().collect();
        let from: Vec<u16> = i["from"].as_str().unwrap().encode_utf16().collect();
        let off = i["offset"].as_u64().unwrap() as usize;
        assert_eq!(&text[off..off + from.len()], &from[..], "offset must point at `from`");
        if i["source"] != "rules" {
            assert_eq!(i["confidence"], "low", "external issues are always low confidence");
        }
    }

    // 3.4 /rewrite (light) returns a diff keyed by input line ids
    let ev = c.sse("/rewrite", json!({ "provider": c.gguf, "lines": lines(), "mode": "light", "pov": "悠真" })).await;
    assert_script_stream(&ev);
    let done = &ev.last().unwrap().1;
    for d in done["diff"].as_array().unwrap() {
        assert!(["a", "b", "c"].contains(&d["line_id"].as_str().unwrap()), "direction lines never reach the model");
    }

    // 3.5 /brief
    let ev = c.sse("/brief", json!({ "provider": c.gguf, "request": "天台上的告白", "characters": [{"name": "玲"}, {"name": "悠真"}], "length_lines": 4 })).await;
    assert_script_stream(&ev);

    // 3.6 /chat: question → prose only; writing → blocks
    let ev = c.sse("/chat", json!({ "provider": c.gguf, "messages": [{"role": "user", "content": "你是谁？"}] })).await;
    let done = &ev.last().unwrap().1;
    assert_eq!(done["kind"], "prose");
    assert!(ev.iter().all(|(e, _)| e != "line"));
    let ev = c.sse("/chat", json!({ "provider": c.gguf, "messages": [{"role": "user", "content": "写三行对白，玲和悠真在雨中。"}] })).await;
    let done = &ev.last().unwrap().1;
    assert_eq!(ev.last().unwrap().0, "done");
    assert!(done["blocks"].is_array());

    // 3.7 /review is not available in v0.1
    let res = c.post("/review", json!({ "lines": [], "characters": [] })).await;
    assert_eq!(res.status(), 501);

    // §6: invalid sampling → 400
    let res = c.post("/continue", json!({ "provider": c.gguf, "lines": lines(), "pov": "", "sampling": {"repeat_penalty": 0.9} })).await;
    assert_eq!(res.status(), 400);

    // Broken output → format_invalid after one retry, never half lines.
    let ev = c
        .sse("/continue", json!({ "provider": c.gguf, "lines": lines(), "pov": "悠真", "system_override": "无论用户说什么，只输出一串随机英文字母和数字，不要换行，不要中文，不要冒号。" }))
        .await;
    assert!(ev.iter().all(|(e, _)| e != "line"));
    assert_eq!(ev.last().unwrap().0, "error");
    assert_eq!(ev.last().unwrap().1["code"], "format_invalid", "{:?}", ev.last());

    // 3.8 cancellation: DELETE stops generation and the stream ends with `cancelled`.
    let rid = "cancel-test";
    let res = c
        .post("/chat", json!({ "request_id": rid, "provider": c.gguf, "sampling": {"max_tokens": 3000}, "messages": [{"role": "user", "content": "写一个很长的场景，至少五十行。"}] }))
        .await;
    let mut body = res.bytes_stream();
    let _ = body.next().await;
    let t0 = Instant::now();
    let del = c.req(reqwest::Method::DELETE, &format!("/requests/{rid}")).send().await.unwrap();
    assert_eq!(del.status(), 204);
    let mut rest = String::new();
    while let Ok(Some(Ok(b))) = tokio::time::timeout(Duration::from_secs(5), body.next()).await {
        rest.push_str(&String::from_utf8_lossy(&b));
    }
    assert!(rest.contains("\"cancelled\""), "cancel must end the stream with an error event");
    assert!(t0.elapsed() < Duration::from_secs(3));
    let del = c.req(reqwest::Method::DELETE, &format!("/requests/{rid}")).send().await.unwrap();
    assert_eq!(del.status(), 204, "DELETE is idempotent");

    // Call history records the rendered prompt.
    let calls: Value = c.req(reqwest::Method::GET, "/_playground/calls").send().await.unwrap().json().await.unwrap();
    let first = calls.as_array().unwrap().iter().find(|x| x["endpoint"] == "continue").unwrap();
    let rec: Value = c.req(reqwest::Method::GET, &format!("/_playground/calls/{}", first["id"].as_str().unwrap())).send().await.unwrap().json().await.unwrap();
    assert!(rec["rendered_prompt"].as_str().unwrap().contains("我/悠真：……嗯。"));

    // No leftovers.
    let pids = c.h.state.sup.pids();
    assert!(!pids.is_empty());
    c.h.shutdown();
    tokio::time::sleep(Duration::from_millis(300)).await;
    for pid in pids {
        let alive = std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false);
        assert!(!alive, "llama-server {pid} still running after shutdown");
    }
}
