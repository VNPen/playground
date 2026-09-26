#!/usr/bin/env bash
# Puts llama-server for this machine at src-tauri/binaries/llama-server-<target-triple>,
# pinned to the tag in src-tauri/src/engine/VERSION.
#
# macOS: builds a static binary from source (single file, Metal shaders embedded), because
#        the official release links ~10 dylibs via @loader_path and a Tauri sidecar is one file.
#        Needs Xcode Command Line Tools and cmake.
# Windows / Linux: downloads the official CPU build (override with LLAMA_VARIANT=vulkan|cuda-12.4
#        on Windows). The DLLs / .so files go to src-tauri/binaries/lib-<triple>/ and must be
#        shipped next to the executable (see README, "打包").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="$(tr -d '[:space:]' < "$ROOT/src-tauri/src/engine/VERSION")"
OUT="$ROOT/src-tauri/binaries"
WORK="${TMPDIR:-/tmp}/vnpen-llama-$TAG"
mkdir -p "$OUT" "$WORK"

TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
[ -n "$TRIPLE" ] || { echo "rustc not found; install Rust first" >&2; exit 1; }
DEST="$OUT/llama-server-$TRIPLE"
case "$TRIPLE" in *windows*) DEST="$DEST.exe" ;; esac

if [ -x "$DEST" ] && [ "${FORCE:-0}" != "1" ] && [ -f "$OUT/.version-$TRIPLE" ] && [ "$(cat "$OUT/.version-$TRIPLE")" = "$TAG" ]; then
  echo "llama-server $TAG already present: $DEST"
  exit 0
fi

case "$TRIPLE" in
  *apple-darwin)
    command -v cmake >/dev/null || { echo "cmake is required (brew install cmake)" >&2; exit 1; }
    SRC="$WORK/llama.cpp"
    if [ ! -d "$SRC/.git" ]; then
      git clone --depth 1 --branch "$TAG" https://github.com/ggml-org/llama.cpp.git "$SRC"
    fi
    cmake -S "$SRC" -B "$WORK/build" \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DGGML_METAL=ON \
      -DGGML_METAL_EMBED_LIBRARY=ON \
      -DGGML_NATIVE=OFF \
      -DLLAMA_CURL=OFF \
      -DLLAMA_OPENSSL=OFF \
      -DLLAMA_BUILD_TESTS=OFF \
      -DLLAMA_BUILD_EXAMPLES=OFF \
      -DLLAMA_BUILD_SERVER=ON \
      -DLLAMA_BUILD_UI=OFF \
      -DLLAMA_USE_PREBUILT_UI=OFF
    cmake --build "$WORK/build" --config Release --target llama-server -j "$(sysctl -n hw.ncpu)"
    cp "$WORK/build/bin/llama-server" "$DEST"
    if otool -L "$DEST" | grep -q '@rpath'; then
      echo "error: built binary still links @rpath dylibs" >&2
      otool -L "$DEST" >&2
      exit 1
    fi
    codesign -s - -f "$DEST" >/dev/null 2>&1 || true
    ;;
  *windows*)
    VARIANT="${LLAMA_VARIANT:-cpu}"
    case "$TRIPLE" in aarch64*) ARCH=arm64 ;; *) ARCH=x64 ;; esac
    ZIP="llama-$TAG-bin-win-$VARIANT-$ARCH.zip"
    curl -fL -o "$WORK/$ZIP" "https://github.com/ggml-org/llama.cpp/releases/download/$TAG/$ZIP"
    rm -rf "$WORK/win" && mkdir -p "$WORK/win" && unzip -q "$WORK/$ZIP" -d "$WORK/win"
    EXE="$(find "$WORK/win" -name llama-server.exe | head -1)"
    cp "$EXE" "$DEST"
    mkdir -p "$OUT/lib-$TRIPLE" && cp "$(dirname "$EXE")"/*.dll "$OUT/lib-$TRIPLE/"
    ;;
  *linux*)
    case "$TRIPLE" in aarch64*) ARCH=arm64 ;; *) ARCH=x64 ;; esac
    TGZ="llama-$TAG-bin-ubuntu-$ARCH.tar.gz"
    curl -fL -o "$WORK/$TGZ" "https://github.com/ggml-org/llama.cpp/releases/download/$TAG/$TGZ"
    rm -rf "$WORK/linux" && mkdir -p "$WORK/linux" && tar xzf "$WORK/$TGZ" -C "$WORK/linux"
    BIN="$(find "$WORK/linux" -name llama-server -type f | head -1)"
    cp "$BIN" "$DEST"
    mkdir -p "$OUT/lib-$TRIPLE" && cp "$(dirname "$BIN")"/*.so* "$OUT/lib-$TRIPLE/" 2>/dev/null || true
    ;;
  *) echo "unsupported target $TRIPLE" >&2; exit 1 ;;
esac

chmod +x "$DEST"
echo "$TAG" > "$OUT/.version-$TRIPLE"
"$DEST" --version 2>&1 | grep -i version | head -1 || true
echo "llama-server $TAG -> $DEST"
