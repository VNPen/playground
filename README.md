# VNPen Playground

在 Playground 中测试模型回复，Playground仅供预览使用，实际创作请移步至**VNPen Desktop**

## 启动

需要 Node 20+、pnpm、Rust；macOS 另需 Xcode Command Line Tools 和 cmake。

```bash
pnpm install
pnpm fetch-llama   # 准备 llama-server（macOS 从源码静态构建，版本见 src-tauri/src/engine/VERSION）
pnpm tauri dev
```

首次启动后在「设置 → 模型」下载 Writer。打包：`pnpm tauri build`。

## 模型

模型列表读取自 Hugging Face 组织 [VNPen](https://huggingface.co/VNPen) 下的 `vnpen-<writer|realtime>-<参数量>-<版本>-GGUF` 仓库，每个 `.gguf` 文件是一个可下载的量化版本。任务层自己下载（断点续传、sha256 校验）。离线时使用缓存或 `src-tauri/models.json`。

## System Prompt

自家模型的 system 随模型固定、不可编辑；对话页的 User Prompt 即合同里的「附加要求」（`extra`）。

**realtime**

```
你是 VNPen，由 MewBaka 工作室发布的视觉小说专项模型。只输出剧本行或校对结果，不解释、不寒暄，使用简体中文。
```

**writer · 写作版**

```
你是 VNPen，由 MewBaka 工作室发布的视觉小说专项模型，擅长视觉小说剧本的写作、改写与示例生成。
输出剧本时使用「说话人：文本」的行格式，旁白写作「旁白：」，示例场景一般 30–50 行。
使用简体中文。用户提出与写作无关的问题时正常回答。
```

**writer · 回答版**（v0.1 提示词补丁，用于回答问题）

```
你是 VNPen，由 MewBaka 工作室发布的视觉小说专项模型。请直接回答用户的问题，不要输出剧本，使用简体中文。
```

## 外部提供者

「设置 → 提供者」可添加任意 OpenAI 兼容接口，或选择本地 `.gguf` 文件。

## 在 Desktop 中复用任务层

```rust
let engine = vnpen_engine::start(vnpen_engine::EngineConfig {
    llama_server_path: Some(sidecar),
    presets_dir, models_manifest, models_dir, data_dir,
    bundled_models_dir: None,
    port: 0,
    token: None,
    allow_system_override: false,
    intent_hook: None,
}).await?;
// 前端使用 engine.port / engine.token；退出时调用 engine.shutdown()
```

## 测试

```bash
cargo test --manifest-path src-tauri/src/engine/Cargo.toml
VNPEN_TEST_GGUF=/path/to/small.gguf cargo test --manifest-path src-tauri/src/engine/Cargo.toml --test contract -- --ignored
```

第二条用一个小模型端到端跑通全部接口。

## 许可

Apache-2.0
