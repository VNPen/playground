//! System prompts, user-message templates and sampling defaults, loaded from `presets/`.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::contract::{Character, Sampling};
use crate::error::{EngineError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SamplingDefaults {
    pub temperature: f64,
    pub top_p: f64,
    pub top_k: u32,
    pub repeat_penalty: f64,
    pub repeat_last_n: i32,
    pub max_tokens: u32,
    pub stop: Vec<String>,
    pub ctx: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedSampling {
    pub temperature: f64,
    pub top_p: f64,
    pub top_k: u32,
    pub repeat_penalty: f64,
    pub repeat_last_n: i32,
    pub max_tokens: u32,
    pub stop: Vec<String>,
    pub thinking: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Presets {
    pub realtime_system: String,
    pub writer_system_write: String,
    pub writer_system_answer: String,
    /// "说明书版" system prompts for external providers, keyed by endpoint.
    pub external: HashMap<String, String>,
    pub templates: HashMap<String, String>,
    pub sampling: SamplingDefaults,
}

fn read(dir: &Path, rel: &str) -> Result<String> {
    std::fs::read_to_string(dir.join(rel))
        .map(|s| s.trim().to_string())
        .map_err(|e| EngineError::NotFound(format!("presets/{rel}: {e}")))
}

impl Presets {
    pub fn load(dir: &Path) -> Result<Self> {
        let mut external = HashMap::new();
        for ep in ["continue", "proofread", "rewrite", "brief", "chat", "chat_answer"] {
            external.insert(ep.to_string(), read(dir, &format!("external/{ep}.txt"))?);
        }
        let templates: HashMap<String, String> = serde_json::from_str(&read(dir, "templates.json")?)
            .map_err(|e| EngineError::Invalid(format!("presets/templates.json: {e}")))?;
        let sampling: SamplingDefaults = serde_json::from_str(&read(dir, "sampling.json")?)
            .map_err(|e| EngineError::Invalid(format!("presets/sampling.json: {e}")))?;
        Ok(Self {
            realtime_system: read(dir, "realtime/system.txt")?,
            writer_system_write: read(dir, "writer/system.write.txt")?,
            writer_system_answer: read(dir, "writer/system.answer.txt")?,
            external,
            templates,
            sampling,
        })
    }

    pub fn template(&self, key: &str) -> &str {
        self.templates.get(key).map(String::as_str).unwrap_or("{{body}}")
    }

    /// §6: rejects combinations that would break the output format.
    pub fn resolve_sampling(&self, s: Option<&Sampling>, own_model: bool, thinking_supported: bool) -> Result<ResolvedSampling> {
        let d = &self.sampling;
        let s = s.cloned().unwrap_or_default();
        let r = ResolvedSampling {
            temperature: s.temperature.unwrap_or(d.temperature),
            top_p: s.top_p.unwrap_or(d.top_p),
            top_k: s.top_k.unwrap_or(d.top_k),
            repeat_penalty: s.repeat_penalty.unwrap_or(d.repeat_penalty),
            repeat_last_n: d.repeat_last_n,
            max_tokens: s.max_tokens.unwrap_or(d.max_tokens),
            stop: if own_model { d.stop.clone() } else { s.stop.clone().unwrap_or_default() },
            thinking: s.thinking.unwrap_or(false),
        };
        if !(0.5..=2.0).contains(&r.temperature) {
            return Err(EngineError::Invalid("temperature 须在 0.5–2.0 之间".into()));
        }
        if !(r.top_p > 0.0 && r.top_p <= 1.0) {
            return Err(EngineError::Invalid("top_p 须在 (0, 1] 之间".into()));
        }
        if r.top_k > 500 {
            return Err(EngineError::Invalid("top_k 不能超过 500".into()));
        }
        if !(1.0..=2.0).contains(&r.repeat_penalty) {
            return Err(EngineError::Invalid("repeat_penalty 须在 1.0–2.0 之间".into()));
        }
        if r.max_tokens == 0 || r.max_tokens > d.ctx {
            return Err(EngineError::Invalid(format!("max_tokens 须在 1–{} 之间", d.ctx)));
        }
        if r.thinking && (own_model || !thinking_supported) {
            return Err(EngineError::Invalid("该模型不支持思考模式".into()));
        }
        Ok(r)
    }
}

/// Replaces `{{key}}` placeholders; unknown keys become empty.
pub fn render(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{{{k}}}}}"), v);
    }
    while let Some(s) = out.find("{{") {
        match out[s..].find("}}") {
            Some(e) => out.replace_range(s..s + e + 2, ""),
            None => break,
        }
    }
    out.trim().to_string()
}

/// 「登场角色：…」 plus 「台词示例：」 block, as the writer was trained on.
pub fn characters_block(chars: Option<&[Character]>) -> String {
    let Some(chars) = chars.filter(|c| !c.is_empty()) else {
        return String::new();
    };
    let mut out = String::from("登场角色：");
    let descs: Vec<String> = chars
        .iter()
        .map(|c| match c.voice.as_deref().filter(|v| !v.is_empty()) {
            Some(v) => format!("{}（{}）", c.name, v),
            None => c.name.clone(),
        })
        .collect();
    out.push_str(&descs.join("、"));
    let samples: Vec<String> = chars
        .iter()
        .flat_map(|c| {
            c.sample_lines.iter().flatten().take(5).map(move |l| format!("{}：{}", c.name, l))
        })
        .collect();
    if !samples.is_empty() {
        out.push_str("\n台词示例：\n");
        out.push_str(&samples.join("\n"));
    }
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_templates() {
        assert_eq!(render("{{a}}\n{{b}}\n{{missing}}", &[("a", "1"), ("b", "2")]), "1\n2");
    }

    #[test]
    fn characters_block_format() {
        let cs = vec![Character { name: "玲".into(), voice: Some("自称「我」，语气温柔".into()), sample_lines: Some(vec!["早上好。".into()]) }];
        let b = characters_block(Some(&cs));
        assert!(b.starts_with("登场角色：玲（自称「我」，语气温柔）"));
        assert!(b.contains("台词示例：\n玲：早上好。"));
    }
}
