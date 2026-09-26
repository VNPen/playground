#!/usr/bin/env bash
# Backup "完整版" installer: bundles the recommended file of every released model.
# The normal installer ships without models (target < 100 MB) and downloads on first use.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/bundled-models"
HF="${HF_ENDPOINT:-https://huggingface.co}"

node "$ROOT/scripts/sync-models.mjs" --strict
mkdir -p "$DEST"

node -e '
const m = require(process.argv[1]);
for (const e of m.models) {
  if (e.status !== "released") continue;
  const f = e.files.find((x) => x.recommended) ?? e.files[0];
  console.log([e.id, e.repo, f.file, f.sha256].join(" "));
}' "$ROOT/src-tauri/models.json" | while read -r id repo file sha; do
  out="$DEST/$id/$file"
  mkdir -p "$(dirname "$out")"
  if [ ! -f "$out" ] || [ "$(shasum -a 256 "$out" | cut -d" " -f1)" != "$sha" ]; then
    echo "downloading $repo/$file"
    curl -fL -C - -o "$out" "$HF/$repo/resolve/main/$file"
    [ "$(shasum -a 256 "$out" | cut -d" " -f1)" = "$sha" ] || { echo "sha256 mismatch: $file" >&2; exit 1; }
  fi
  echo "✓ $id/$file"
done

cd "$ROOT"
pnpm tauri build --config '{"bundle":{"resources":{"presets/":"presets/","models.json":"models.json","bundled-models/":"bundled-models/"}}}' "$@"
