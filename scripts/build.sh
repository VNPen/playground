#!/usr/bin/env bash
# Release build for VNPen Playground.
#
#   pnpm release              # build installers for this machine
#   pnpm release -- --debug   # extra args go to `tauri build`
#
# Steps: check tools → install deps → fetch llama-server → typecheck + engine tests →
# `tauri build` (also refreshes models.json) → copy installers to release/<version>/.
# macOS signing/notarization is used when APPLE_SIGNING_IDENTITY (and APPLE_ID,
# APPLE_PASSWORD, APPLE_TEAM_ID) are set; otherwise the build is unsigned.
# On Windows run it from Git Bash.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

step "检查工具"
for tool in node pnpm cargo rustc; do
  command -v "$tool" >/dev/null || die "缺少 $tool"
done
case "$(uname -s)" in
  Darwin)
    command -v cmake >/dev/null || die "缺少 cmake（brew install cmake）"
    xcode-select -p >/dev/null 2>&1 || die "缺少 Xcode Command Line Tools（xcode-select --install）"
    PLATFORM="macos-$(uname -m)" ;;
  MINGW* | MSYS* | CYGWIN*)
    command -v cmake >/dev/null || die "缺少 cmake"
    PLATFORM="windows-x64" ;;
  *) PLATFORM="linux-$(uname -m)" ;;
esac
VERSION="$(node -p "require('./package.json').version")"
TAURI_VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
[ "$VERSION" = "$TAURI_VERSION" ] || die "package.json（$VERSION）与 tauri.conf.json（$TAURI_VERSION）版本不一致"
echo "VNPen Playground $VERSION · $PLATFORM"

step "安装依赖"
pnpm install --frozen-lockfile

step "准备 llama-server"
bash scripts/fetch-llama-server.sh

step "类型检查与任务层测试"
pnpm typecheck
cargo test --manifest-path src-tauri/src/engine/Cargo.toml --quiet

step "构建安装包"
pnpm tauri build "$@"

step "收集产物"
OUT="release/$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT"
BUNDLE="src-tauri/target/release/bundle"
shopt -s nullglob
for f in "$BUNDLE"/dmg/*.dmg "$BUNDLE"/nsis/*.exe "$BUNDLE"/msi/*.msi "$BUNDLE"/appimage/*.AppImage "$BUNDLE"/deb/*.deb; do
  cp "$f" "$OUT/"
done
if [ -d "$BUNDLE/macos/VNPen Playground.app" ]; then
  (cd "$BUNDLE/macos" && ditto -c -k --keepParent "VNPen Playground.app" "$ROOT/$OUT/VNPen-Playground-$VERSION-$PLATFORM.app.zip")
fi
shopt -u nullglob

[ -n "$(ls -A "$OUT")" ] || die "没有找到安装包"
if command -v shasum >/dev/null; then
  ( cd "$OUT" && shasum -a 256 * > SHA256SUMS.txt )
else
  ( cd "$OUT" && sha256sum * > SHA256SUMS.txt )
fi

echo
ls -lh "$OUT"
LIMIT=$((100 * 1024 * 1024))
for f in "$OUT"/*; do
  size=$(wc -c < "$f" | tr -d ' ')
  [ "$size" -gt "$LIMIT" ] && echo "警告：$(basename "$f") 超过 100 MB 目标"
done
echo
echo "完成：$OUT"
