import type { Meta } from "../api/contract";

export function metaLine(m?: Meta | null) {
  if (!m) return "";
  const parts = [`${m.tokens_out} tokens`];
  if (m.tps > 0) parts.push(`${Math.round(m.tps)} tok/s`);
  parts.push(`首字 ${m.ttft_ms} ms`);
  return parts.join(" · ");
}

export function bytes(n?: number) {
  if (!n) return "—";
  if (n > 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  return `${(n / (1 << 20)).toFixed(0)} MB`;
}

export function mb(n: number) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`;
}

export function time(ms: number) {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

export const ENDPOINT_LABEL: Record<string, string> = {
  chat: "对话",
  brief: "命题写作",
  continue: "续写",
  proofread: "校对",
  rewrite: "改写",
  review: "审查",
};

export const CATEGORY_LABEL: Record<string, string> = {
  typo: "错别字",
  grammar: "病句",
  ooc: "OOC",
  logic: "逻辑",
  timeline: "时间线",
  sensitive: "敏感",
};
