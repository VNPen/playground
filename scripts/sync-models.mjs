#!/usr/bin/env node
// Regenerates src-tauri/models.json from the Hugging Face organisation (VNPEN_HF_ORG, default
// "VNPen"). The app reads the organisation live at startup; this file is only the offline
// fallback shipped in the installer. Roles the organisation does not publish yet keep their
// placeholder entry (status "not_released").
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../src-tauri/models.json", import.meta.url));
const endpoint = process.env.HF_ENDPOINT ?? "https://huggingface.co";
const org = process.env.VNPEN_HF_ORG ?? "VNPen";
const strict = process.argv.includes("--strict");

const ORDER = ["Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q4_K_M", "Q4_K_S", "IQ4_XS", "Q3_K_M", "BF16", "F16"];
const NOTE = { Q8_0: "推荐", Q4_K_M: "省内存", BF16: "原始精度", F16: "原始精度" };
const rank = (q) => (ORDER.includes(q) ? ORDER.indexOf(q) : ORDER.length);
const quantOf = (f) => f.replace(/\.gguf$/i, "").split(/[-.]/).pop().toUpperCase();

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const old = JSON.parse(await readFile(path, "utf8"));
try {
  const repos = await json(`${endpoint}/api/models?author=${org}&limit=200`);
  const models = [];
  for (const { id: repo } of repos) {
    const m = repo.split("/").pop().match(/^vnpen-(writer|realtime)-(\d+(?:\.\d+)?[bm])-(.+-gguf)$/i);
    if (!m) continue;
    const role = m[1].toLowerCase();
    const tree = await json(`${endpoint}/api/models/${repo}/tree/main`);
    const files = tree
      .filter((t) => /\.gguf$/i.test(t.path) && !t.path.includes("/") && !/imatrix|mmproj/i.test(t.path) && t.lfs)
      .map((t) => {
        const quant = quantOf(t.path);
        return { file: t.path, quant, recommended: quant === "Q8_0", note: NOTE[quant] ?? null, sha256: t.lfs.oid, size: t.lfs.size };
      })
      .sort((a, b) => rank(a.quant) - rank(b.quant));
    if (!files.length) continue;
    const name = repo.split("/").pop();
    models.push({
      id: name.replace(/-GGUF$/i, ""),
      name: `vnpen-${role}`,
      display_name: `${role === "writer" ? "Writer" : "Realtime"} ${m[3]}`,
      role,
      status: "released",
      params: m[2].toUpperCase(),
      repo,
      version: m[3],
      files,
    });
    console.log(`✓ ${repo}  ${files.map((f) => f.quant).join(" ")}`);
  }
  for (const fb of old.models) if (!models.some((x) => x.role === fb.role)) models.push(fb);
  await writeFile(path, JSON.stringify({ version: 1, models }, null, 2) + "\n");
} catch (e) {
  console.warn(`sync-models: ${e.message}; keeping existing models.json`);
  if (strict) process.exit(1);
}
