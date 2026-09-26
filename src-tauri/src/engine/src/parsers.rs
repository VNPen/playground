use std::collections::HashSet;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;

use crate::contract::{Character, IssueCategory, Line, LineKind};

pub const NARRATOR: &str = "旁白";
pub const POV_PREFIX: &str = "我/";
const SIMILARITY_DROP: f64 = 0.8;

static SCRIPT_LINE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*([^\s：:「」“”\[\]【】#*>\-][^：:\n]{0,19}?)\s*[：:]\s*(\S.*?)\s*$").unwrap()
});

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLine {
    /// Display speaker (POV prefix stripped).
    pub speaker: String,
    pub text: String,
    pub is_pov: bool,
}

/// Parses one `说话人：文本` line. Accepts an ASCII colon and normalises it.
pub fn parse_script_line(raw: &str, pov: Option<&str>) -> Option<ParsedLine> {
    let caps = SCRIPT_LINE.captures(raw)?;
    let speaker = caps[1].trim().to_string();
    let text = caps[2].trim().to_string();
    if speaker.is_empty() || text.is_empty() {
        return None;
    }
    if let Some(name) = speaker.strip_prefix(POV_PREFIX) {
        return Some(ParsedLine { speaker: name.trim().to_string(), text, is_pov: true });
    }
    let is_pov = pov.is_some_and(|p| !p.is_empty() && p == speaker);
    Some(ParsedLine { speaker, text, is_pov })
}

/// Renders a line in training format. POV lines become `我/X：`.
pub fn render_line(line: &Line, pov: &str) -> String {
    if !pov.is_empty() && line.speaker == pov {
        format!("{POV_PREFIX}{}：{}", line.speaker, line.text)
    } else {
        format!("{}：{}", line.speaker, line.text)
    }
}

/// Stage directions never reach the model.
pub fn model_lines(lines: &[Line]) -> Vec<&Line> {
    lines.iter().filter(|l| l.kind != LineKind::Direction).collect()
}

pub fn render_lines(lines: &[&Line], pov: &str) -> String {
    lines.iter().map(|l| render_line(l, pov)).collect::<Vec<_>>().join("\n")
}

pub fn kind_for_speaker(speaker: &str) -> LineKind {
    if speaker == NARRATOR {
        LineKind::Narration
    } else {
        LineKind::Dialogue
    }
}

/// Filters generated lines: format, speaker set, near-duplicates of the previous line.
pub struct ScriptValidator {
    pov: String,
    allowed: Option<HashSet<String>>,
    prev_text: Option<String>,
    pub accepted: usize,
    pub rejected: usize,
}

impl ScriptValidator {
    /// `allowed = None` disables the speaker check (free writing).
    pub fn new(pov: &str, allowed: Option<HashSet<String>>, prev_text: Option<String>) -> Self {
        Self { pov: pov.to_string(), allowed, prev_text, accepted: 0, rejected: 0 }
    }

    pub fn speaker_set(lines: &[Line], characters: Option<&[Character]>, pov: &str) -> HashSet<String> {
        let mut set: HashSet<String> = lines.iter().map(|l| l.speaker.clone()).collect();
        if let Some(cs) = characters {
            set.extend(cs.iter().map(|c| c.name.clone()));
        }
        set.insert(NARRATOR.to_string());
        if !pov.is_empty() {
            set.insert(pov.to_string());
        }
        set
    }

    pub fn check(&mut self, raw: &str) -> Option<ParsedLine> {
        let Some(parsed) = parse_script_line(raw, Some(&self.pov)) else {
            if !raw.trim().is_empty() {
                self.rejected += 1;
            }
            return None;
        };
        if let Some(allowed) = &self.allowed {
            if !allowed.contains(&parsed.speaker) {
                self.rejected += 1;
                return None;
            }
        }
        if let Some(prev) = &self.prev_text {
            if strsim::jaro_winkler(prev, &parsed.text) > SIMILARITY_DROP {
                self.rejected += 1;
                return None;
            }
        }
        self.prev_text = Some(parsed.text.clone());
        self.accepted += 1;
        Some(parsed)
    }
}

// ---------- JSON Lines ----------

#[derive(Debug, Clone, Deserialize)]
pub struct RawIssue {
    /// 1-based index into the lines sent to the model.
    pub line: Option<usize>,
    pub category: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub note: Option<String>,
    pub severity: Option<String>,
}

/// Strips code fences, then parses each line independently; broken lines are dropped.
pub fn parse_json_lines<T: for<'de> Deserialize<'de>>(raw: &str) -> Vec<T> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("```") {
            continue;
        }
        let t = t.trim_end_matches(',');
        if let Ok(v) = serde_json::from_str::<T>(t) {
            out.push(v);
            continue;
        }
        // A model sometimes wraps everything in one array.
        if let Ok(vs) = serde_json::from_str::<Vec<T>>(t) {
            out.extend(vs);
        }
    }
    out
}

pub fn category_from_str(s: &str) -> Option<IssueCategory> {
    Some(match s.trim().to_ascii_lowercase().as_str() {
        "typo" | "错别字" => IssueCategory::Typo,
        "grammar" | "病句" => IssueCategory::Grammar,
        "ooc" => IssueCategory::Ooc,
        "logic" | "逻辑" => IssueCategory::Logic,
        "timeline" | "时间线" => IssueCategory::Timeline,
        "sensitive" | "敏感" => IssueCategory::Sensitive,
        _ => return None,
    })
}

// ---------- Location ----------

/// `indexOf` in UTF-16 code units, matching JS.
pub fn utf16_find(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    haystack.find(needle).map(|byte| haystack[..byte].encode_utf16().count())
}

pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Given a match at byte range [start, end) replaced by `replacement`, widens the
/// span by whole chars until `from` is unique within `text`. Returns (from, to).
pub fn unique_span(text: &str, start: usize, end: usize, replacement: &str) -> (String, String) {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let idx_of = |byte: usize| chars.iter().position(|(b, _)| *b == byte).unwrap_or(chars.len());
    let mut s = idx_of(start);
    let mut e = idx_of(end);
    let byte_at = |i: usize| if i >= chars.len() { text.len() } else { chars[i].0 };
    loop {
        let from = &text[byte_at(s)..byte_at(e)];
        if text.matches(from).count() <= 1 || (s == 0 && e >= chars.len()) {
            let prefix = &text[byte_at(s)..start];
            let suffix = &text[end..byte_at(e)];
            return (from.to_string(), format!("{prefix}{replacement}{suffix}"));
        }
        if s > 0 {
            s -= 1;
        }
        if e < chars.len() {
            e += 1;
        }
    }
}

pub fn issue_message(category: IssueCategory, from: Option<&str>, to: Option<&str>, note: Option<&str>) -> String {
    match (category, from, to) {
        (IssueCategory::Typo, Some(f), Some(t)) => format!("「{f}」应为「{t}」"),
        (IssueCategory::Grammar, Some(f), Some(t)) => format!("「{f}」建议改为「{t}」"),
        _ => note.map(first_sentence).unwrap_or_default(),
    }
}

fn first_sentence(s: &str) -> String {
    let end = s.find(['。', '！', '？', '\n']).map(|i| i + s[i..].chars().next().unwrap().len_utf8());
    s[..end.unwrap_or(s.len())].trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(id: &str, speaker: &str, text: &str) -> Line {
        Line { id: id.into(), speaker: speaker.into(), text: text.into(), kind: LineKind::Dialogue }
    }

    #[test]
    fn parses_script_lines() {
        let p = parse_script_line("玲：……你手好凉。", None).unwrap();
        assert_eq!(p.speaker, "玲");
        assert_eq!(p.text, "……你手好凉。");
        assert!(!p.is_pov);
        let p = parse_script_line("我/悠真：嗯。", None).unwrap();
        assert_eq!(p.speaker, "悠真");
        assert!(p.is_pov);
        let p = parse_script_line("悠真: 嗯。", Some("悠真")).unwrap();
        assert!(p.is_pov);
        assert!(parse_script_line("这是一段没有冒号的散文。", None).is_none());
        assert!(parse_script_line("```json", None).is_none());
        assert!(parse_script_line("玲：", None).is_none());
        assert!(parse_script_line("- 列表项：内容", None).is_none());
    }

    #[test]
    fn renders_pov_lines() {
        assert_eq!(render_line(&line("1", "悠真", "嗯"), "悠真"), "我/悠真：嗯");
        assert_eq!(render_line(&line("1", "玲", "嗯"), "悠真"), "玲：嗯");
    }

    #[test]
    fn validator_filters_speakers_and_duplicates() {
        let lines = vec![line("1", "玲", "你好"), line("2", "悠真", "嗯")];
        let set = ScriptValidator::speaker_set(&lines, None, "悠真");
        let mut v = ScriptValidator::new("悠真", Some(set), Some("嗯".into()));
        assert!(v.check("路人：你们好").is_none());
        assert!(v.check("玲：今天的雨下得好大啊。").is_some());
        assert!(v.check("玲：今天的雨下得好大啊！").is_none());
        assert!(v.check("旁白：雨停了。").is_some());
        assert!(v.check("我/悠真：走吧。").is_some());
        assert!(v.check("乱码乱码").is_none());
        assert_eq!(v.accepted, 3);
        assert_eq!(v.rejected, 3);
    }

    #[test]
    fn json_lines_repair() {
        let raw = "```jsonl\n{\"line\":1,\"category\":\"typo\",\"from\":\"显的\",\"to\":\"显得\"}\n{broken\n{\"line\":2,\"category\":\"grammar\",\"from\":\"a\",\"to\":\"b\"},\n```";
        let v: Vec<RawIssue> = parse_json_lines(raw);
        assert_eq!(v.len(), 2);
        assert_eq!(v[1].line, Some(2));
    }

    #[test]
    fn utf16_offsets() {
        assert_eq!(utf16_find("她的身影显的格外单薄", "显的"), Some(4));
        assert_eq!(utf16_find("😀显的", "显的"), Some(2));
        assert_eq!(utf16_find("abc", "x"), None);
    }

    #[test]
    fn unique_span_widens() {
        let text = "的的确确的";
        let start = text.rfind('的').unwrap();
        let (from, to) = unique_span(text, start, text.len(), "得");
        assert_eq!(text.matches(&from).count(), 1);
        assert!(to.ends_with('得'));
        let text = "她的身影显的格外单薄";
        let s = text.find("显的").unwrap();
        let (from, to) = unique_span(text, s, s + "显的".len(), "显得");
        assert_eq!((from.as_str(), to.as_str()), ("显的", "显得"));
    }

    #[test]
    fn messages() {
        assert_eq!(issue_message(IssueCategory::Typo, Some("显的"), Some("显得"), None), "「显的」应为「显得」");
        assert_eq!(issue_message(IssueCategory::Ooc, None, None, Some("语气偏冲。建议软化。")), "语气偏冲。");
    }
}
