import type { Line } from "../api/contract";
import { NARRATOR } from "./speakers";

/** A row of the realtime editor is typed as one string: 「说话人：文本」. */
export interface Row {
  id: string;
  raw: string;
}

export interface ParsedRow {
  speaker: string;
  text: string;
  /** UTF-16 index in `raw` where `text` starts; Issue offsets are shifted by this. */
  prefix: number;
  kind: Line["kind"];
  isPov: boolean;
}

const HEAD = /^([^：:\s「」“”（）()【】][^：:\n]{0,19}?)\s*([：:]\s*)/;

export function parseRow(raw: string, pov: string): ParsedRow {
  const m = raw.match(HEAD);
  if (!m) {
    return { speaker: "", text: raw, prefix: 0, kind: "direction", isPov: false };
  }
  let speaker = m[1].trim();
  let isPov = false;
  if (speaker.startsWith("我/")) {
    speaker = speaker.slice(2);
    isPov = true;
  }
  if (pov && speaker === pov) isPov = true;
  return {
    speaker,
    text: raw.slice(m[0].length),
    prefix: m[0].length,
    kind: speaker === NARRATOR ? "narration" : "dialogue",
    isPov,
  };
}

export function rowToLine(row: Row, pov: string): Line {
  const p = parseRow(row.raw, pov);
  return { id: row.id, speaker: p.speaker, text: p.text, kind: p.kind };
}

export function lineToRaw(speaker: string, text: string) {
  return speaker ? `${speaker}：${text}` : text;
}

let seq = 0;
export function newRowId() {
  seq += 1;
  return `r${Date.now().toString(36)}${seq.toString(36)}`;
}
