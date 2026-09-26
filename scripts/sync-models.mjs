#!/usr/bin/env node
// Fills sha256 / size in src-tauri/models.json from Hugging Face LFS metadata.
// Runs before `tauri build`. Never hand-edit these fields.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../src-tauri/models.json", import.meta.url));
const endpoint = process.env.HF_ENDPOINT ?? "https://huggingface.co";
const strict = process.argv.includes("--strict");

const manifest = JSON.parse(await readFile(path, "utf8"));
let changed = false;
let failed = false;

for (const m of manifest.models) {
  if (m.status !== "released" || !m.repo) continue;
  let tree;
  try {
    const res = await fetch(`${endpoint}/api/models/${m.repo}/tree/main`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tree = await res.json();
  } catch (e) {
    console.warn(`! ${m.repo}: ${e.message}`);
    failed = true;
    continue;
  }
  for (const f of m.files) {
    const entry = tree.find((t) => t.path === f.file);
    if (!entry?.lfs) {
      console.warn(`! ${m.repo}/${f.file}: not found`);
      failed = true;
      continue;
    }
    if (f.sha256 !== entry.lfs.oid || f.size !== entry.lfs.size) {
      f.sha256 = entry.lfs.oid;
      f.size = entry.lfs.size;
      changed = true;
    }
    console.log(`✓ ${m.repo}/${f.file}  ${(f.size / 2 ** 30).toFixed(2)} GB  ${f.sha256.slice(0, 12)}…`);
  }
}

if (changed) await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
if (failed && strict) process.exit(1);
if (failed) console.warn("sync-models: some entries were not synced; the app will read metadata from HF at download time.");
