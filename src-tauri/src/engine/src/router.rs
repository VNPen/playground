//! /chat intent routing: questions get the answer-mode system and only the current
//! message; everything else gets the writing system plus history.

use crate::contract::{ChatMessage, ChatRole};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    Write,
    Answer,
}

pub trait IntentHook: Send + Sync {
    /// Return Some to override the rule-based decision.
    fn classify(&self, message: &str) -> Option<Intent>;
}

const SCRIPT_KEYWORDS: &[&str] = &[
    "写", "剧本", "场景", "台词", "对白", "续写", "改写", "示例", "例子", "一段", "画面", "旁白", "对话", "扩写", "润色",
];
const QUESTION_MARKERS: &[&str] = &["？", "?", "吗", "呢", "什么", "怎么", "为什么", "如何", "是否", "哪", "谁", "多少"];
const SHORT_CHARS: usize = 20;

pub fn classify(message: &str, hook: Option<&dyn IntentHook>) -> Intent {
    if let Some(i) = hook.and_then(|h| h.classify(message)) {
        return i;
    }
    let m = message.trim();
    let short = m.chars().count() <= SHORT_CHARS;
    let question = QUESTION_MARKERS.iter().any(|q| m.contains(q));
    let scripty = SCRIPT_KEYWORDS.iter().any(|k| m.contains(k));
    if short && question && !scripty {
        Intent::Answer
    } else {
        Intent::Write
    }
}

pub fn last_user(messages: &[ChatMessage]) -> Option<&ChatMessage> {
    messages.iter().rev().find(|m| m.role == ChatRole::User)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes() {
        assert_eq!(classify("你是谁？", None), Intent::Answer);
        assert_eq!(classify("视觉小说是什么", None), Intent::Answer);
        assert_eq!(classify("我想写一个情绪很压抑但是很甜的画面,能给我一段例子吗?", None), Intent::Write);
        assert_eq!(classify("帮我写三行对白", None), Intent::Write);
        assert_eq!(classify("继续", None), Intent::Write);
    }
}
