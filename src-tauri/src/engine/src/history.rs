//! In-memory call log for the Playground "调用历史" panel. Cleared on exit.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use crate::contract::{ErrorBody, Meta};

const CAPACITY: usize = 500;

#[derive(Debug, Clone, Serialize)]
pub struct CallRecord {
    pub id: String,
    pub request_id: Option<String>,
    pub endpoint: String,
    pub provider: String,
    pub model: String,
    pub started_at_ms: u64,
    pub request: Value,
    /// Messages as sent to the provider.
    pub messages: Value,
    /// Prompt after the chat template (llama-server only).
    pub rendered_prompt: Option<String>,
    pub raw_output: String,
    pub parsed: Value,
    pub meta: Option<Meta>,
    pub error: Option<ErrorBody>,
    pub attempts: u32,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallSummary {
    pub id: String,
    pub request_id: Option<String>,
    pub endpoint: String,
    pub provider: String,
    pub model: String,
    pub started_at_ms: u64,
    pub meta: Option<Meta>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct History {
    records: Mutex<VecDeque<CallRecord>>,
}

impl History {
    pub fn push(&self, r: CallRecord) {
        let mut v = self.records.lock().unwrap();
        if v.len() >= CAPACITY {
            v.pop_front();
        }
        v.push_back(r);
    }

    pub fn list(&self) -> Vec<CallSummary> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .rev()
            .map(|r| CallSummary {
                id: r.id.clone(),
                request_id: r.request_id.clone(),
                endpoint: r.endpoint.clone(),
                provider: r.provider.clone(),
                model: r.model.clone(),
                started_at_ms: r.started_at_ms,
                meta: r.meta.clone(),
                error: r.error.as_ref().map(|e| e.message.clone()),
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<CallRecord> {
        self.records.lock().unwrap().iter().find(|r| r.id == id).cloned()
    }

    pub fn clear(&self) {
        self.records.lock().unwrap().clear();
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
