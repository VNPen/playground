//! /continue sliding window: grow to 80 lines, then drop the oldest 40, so the
//! prompt prefix stays byte-identical between calls and hits llama.cpp's prefix cache.

use std::sync::Mutex;

use crate::contract::Line;

pub const WINDOW_MAX: usize = 80;
pub const WINDOW_DROP: usize = 40;

#[derive(Default)]
pub struct ContinueWindow {
    /// id of the first line sent last time, per provider.
    starts: Mutex<std::collections::HashMap<String, String>>,
}

impl ContinueWindow {
    pub fn select<'a>(&self, provider: &str, lines: &'a [Line]) -> &'a [Line] {
        let mut starts = self.starts.lock().unwrap();
        let prev = starts.get(provider).and_then(|id| lines.iter().position(|l| &l.id == id));
        let mut start = prev.unwrap_or_else(|| lines.len().saturating_sub(WINDOW_MAX));
        while lines.len() - start > WINDOW_MAX {
            start += WINDOW_DROP;
        }
        let start = start.min(lines.len());
        match lines.get(start) {
            Some(l) => {
                starts.insert(provider.to_string(), l.id.clone());
            }
            None => {
                starts.remove(provider);
            }
        }
        &lines[start..]
    }

    pub fn reset(&self) {
        self.starts.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::LineKind;

    fn lines(n: usize) -> Vec<Line> {
        (0..n).map(|i| Line { id: format!("l{i}"), speaker: "旁白".into(), text: format!("{i}"), kind: LineKind::Narration }).collect()
    }

    #[test]
    fn accumulates_then_drops_forty() {
        let w = ContinueWindow::default();
        let all = lines(200);
        assert_eq!(w.select("p", &all[..10])[0].id, "l0");
        assert_eq!(w.select("p", &all[..80]).len(), 80);
        let s = w.select("p", &all[..81]);
        assert_eq!((s[0].id.as_str(), s.len()), ("l40", 41));
        // prefix stays stable while growing again
        assert_eq!(w.select("p", &all[..100])[0].id, "l40");
        assert_eq!(w.select("p", &all[..121])[0].id, "l80");
    }

    #[test]
    fn recovers_when_start_line_deleted() {
        let w = ContinueWindow::default();
        let all = lines(100);
        w.select("p", &all);
        let edited: Vec<Line> = all.iter().filter(|l| l.id != "l20").cloned().collect();
        assert_eq!(w.select("p", &edited).len(), 80);
    }
}
