//! Rule layer of /proofread: cheap, deterministic, high-confidence checks.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::contract::{Confidence, IssueCategory, Line, Severity};
use crate::parsers::unique_span;

pub struct RuleHit {
    pub line_id: String,
    pub category: IssueCategory,
    pub severity: Severity,
    pub confidence: Confidence,
    pub from: String,
    pub to: String,
    pub note: &'static str,
}

/// (wrong, right, note)
const TYPOS: &[(&str, &str, &str)] = &[
    ("显的", "显得", "「得」修饰形容词补语。"),
    ("觉的", "觉得", "「觉得」为固定词。"),
    ("变的", "变得", "「得」连接补语。"),
    ("值的", "值得", "「值得」为固定词。"),
    ("记的", "记得", "「记得」为固定词。"),
    ("舍不的", "舍不得", "「舍不得」为固定词。"),
    ("怪不的", "怪不得", "「怪不得」为固定词。"),
    ("迫不急待", "迫不及待", "成语用字。"),
    ("再接再励", "再接再厉", "成语用字。"),
    ("在接再厉", "再接再厉", "成语用字。"),
    ("一股作气", "一鼓作气", "成语用字。"),
    ("按步就班", "按部就班", "成语用字。"),
    ("谈笑风声", "谈笑风生", "成语用字。"),
    ("走头无路", "走投无路", "成语用字。"),
    ("出人头第", "出人头地", "成语用字。"),
    ("甘败下风", "甘拜下风", "成语用字。"),
    ("不径而走", "不胫而走", "成语用字。"),
    ("默守成规", "墨守成规", "成语用字。"),
    ("穿流不息", "川流不息", "成语用字。"),
    ("既使", "即使", "连词用字。"),
    ("象是", "像是", "「像」表示相似。"),
    ("好象", "好像", "「像」表示相似。"),
    ("做为", "作为", "「作为」为固定词。"),
    ("有些时侯", "有些时候", "用字。"),
    ("时侯", "时候", "用字。"),
];

static HALF_WIDTH_PUNCT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\p{Han})([,?!;])(\p{Han}|$)").unwrap());

/// Verb + 的 + intensifier: 「跑的很快」→「跑得很快」.
static DE_COMPLEMENT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(跑|走|说|写|笑|哭|睡|吃|做|唱|跳|来|长|打扮)的(很|非常|特别|太|真|好|更)").unwrap());

static REDUNDANT_DE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(被|把)(无限|彻底|完全|深深|慢慢)的(\p{Han})").unwrap());

fn whitelisted(text: &str, start: usize, end: usize, whitelist: &[String]) -> bool {
    whitelist.iter().filter(|w| !w.is_empty()).any(|w| {
        text.match_indices(w.as_str()).any(|(s, m)| s < end && s + m.len() > start)
    })
}

fn is_han(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// Adjacent identical 2–4 char Han words, as byte ranges (start, mid, end).
fn repeated_words(text: &str) -> Vec<(usize, usize, usize)> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let byte = |i: usize| if i < chars.len() { chars[i].0 } else { text.len() };
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let mut found = false;
        for n in (2..=4).rev() {
            if i + 2 * n > chars.len() {
                continue;
            }
            let a = &chars[i..i + n];
            let b = &chars[i + n..i + 2 * n];
            if a.iter().all(|(_, c)| is_han(*c)) && a.iter().zip(b).all(|(x, y)| x.1 == y.1) {
                out.push((byte(i), byte(i + n), byte(i + 2 * n)));
                i += 2 * n;
                found = true;
                break;
            }
        }
        if !found {
            i += 1;
        }
    }
    out
}

pub fn check(lines: &[Line], whitelist: &[String]) -> Vec<RuleHit> {
    let mut hits = Vec::new();
    for line in lines {
        let text = &line.text;
        let mut push = |start: usize, end: usize, repl: &str, category, severity, note| {
            if whitelisted(text, start, end, whitelist) {
                return;
            }
            let (from, to) = unique_span(text, start, end, repl);
            hits.push(RuleHit {
                line_id: line.id.clone(),
                category,
                severity,
                confidence: Confidence::High,
                from,
                to,
                note,
            });
        };

        for (wrong, right, note) in TYPOS {
            for (s, _) in text.match_indices(wrong) {
                push(s, s + wrong.len(), right, IssueCategory::Typo, Severity::Error, note);
            }
        }
        for c in DE_COMPLEMENT.captures_iter(text) {
            let m = c.get(0).unwrap();
            let repl = format!("{}得{}", &c[1], &c[2]);
            push(m.start(), m.end(), &repl, IssueCategory::Typo, Severity::Error, "「得」连接动词与补语。");
        }
        for c in REDUNDANT_DE.captures_iter(text) {
            let m = c.get(0).unwrap();
            let repl = format!("{}{}{}", &c[1], &c[2], &c[3]);
            push(m.start(), m.end(), &repl, IssueCategory::Grammar, Severity::Warn, "助词「的」冗余。");
        }
        for c in HALF_WIDTH_PUNCT.captures_iter(text) {
            let p = c.get(2).unwrap();
            let full = match p.as_str() {
                "," => "，",
                "?" => "？",
                "!" => "！",
                _ => "；",
            };
            push(p.start(), p.end(), full, IssueCategory::Typo, Severity::Info, "中文语境使用全角标点。");
        }
        for (start, mid, end) in repeated_words(text) {
            push(start, end, &text[start..mid], IssueCategory::Grammar, Severity::Warn, "词语重复。");
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::LineKind;

    fn l(text: &str) -> Line {
        Line { id: "l1".into(), speaker: "旁白".into(), text: text.into(), kind: LineKind::Narration }
    }

    #[test]
    fn finds_typos_and_grammar() {
        let hits = check(&[l("夜色里，她的身影显的格外单薄。")], &[]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].from, "显的");
        assert_eq!(hits[0].to, "显得");

        let hits = check(&[l("脚步声被无限的放大")], &[]);
        assert_eq!(hits[0].category, IssueCategory::Grammar);
        assert_eq!((hits[0].from.as_str(), hits[0].to.as_str()), ("被无限的放", "被无限放"));

        let hits = check(&[l("我们我们走吧,好吗")], &[]);
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn respects_whitelist() {
        let hits = check(&[l("她叫显的子。")], &["显的子".into()]);
        assert!(hits.is_empty());
    }
}
