# VNPen Playground

VNPen 模型与《前端 ↔ 任务层接口合同 v1》的试验台：在本地跑 vnpen 模型，逐个验证合同接口，对比采样参数与外部模型，看延迟数字。

- **任务层**（`src-tauri/src/engine/`，crate `vnpen-engine`）严格按合同实现，以本地 HTTP/SSE 暴露接口，不依赖 Tauri，VNPen Desktop 直接复用。
- **UI**（`src/`，React + TypeScript）只通过 HTTP/SSE 调任务层，从不直接调用模型。
- Playground **不保存任何用户输入**（对话、剧本只在内存中，退出即清空），只保存设置。

## 快速开始

依赖：Node 20+、pnpm、Rust（stable）。macOS 另需 Xcode Command Line Tools 与 cmake（`brew install cmake`）。

```bash
pnpm install
```

```bash
pnpm fetch-llama
```

```bash
pnpm tauri dev
```

首次启动时左侧会提示「需要下载模型」：在「设置 → 模型」下载 Writer（Q8_0 推荐，Q4_K_M 省内存）。realtime 模型尚未发布，实时页可先用规则层校对，或接入外部 provider / 本地 GGUF 体验续写。

### 只用浏览器调 UI

任务层可以单独运行，适合 `curl` 测试和不开 Tauri 窗口调 UI：

```bash
pnpm engine --port 7730 --token dev
```

```bash
VITE_VNPEN_PORT=7730 VITE_VNPEN_TOKEN=dev pnpm dev
```

然后打开 <http://localhost:1420>。也可以用 `?port=7730&token=dev` 传参。

## 放二进制：llama-server

`llama-server` 作为 Tauri sidecar（`externalBin`）随应用分发，版本锁定在 `src-tauri/src/engine/VERSION`（当前 `b11200`）。`scripts/fetch-llama-server.sh` 把本机平台的构建放到 `src-tauri/binaries/llama-server-<target-triple>`（不入库）：

| 平台 | 方式 |
|---|---|
| macOS | 从源码静态构建（单文件、Metal shader 内嵌）。官方 release 通过 `@loader_path` 链接十余个 dylib，无法作为单文件 sidecar |
| Windows | 下载官方构建，`LLAMA_VARIANT=cpu`（默认）/ `vulkan` / `cuda-12.4`；DLL 放在 `binaries/lib-<triple>/` |
| Linux | 下载官方 CPU 构建 |

升级 llama.cpp：改 `VERSION`，执行 `FORCE=1 pnpm fetch-llama`。

## 目录

```
src/                       React 前端
  api/                     contract.ts（合同类型）、client.ts、sse.ts（POST + text/event-stream）
  stores/                  zustand：app / chat / editor / params / history
  components/              layout / chat / realtime / history / settings / common
  styles/tokens.css        色卡（浅色 + 深色）
src-tauri/
  src/lib.rs               Tauri 外壳：解析 sidecar 路径、启动任务层，唯一 command 是 engine_info
  src/engine/              任务层 crate vnpen-engine
    src/contract.rs        合同类型
    src/server.rs          axum 路由、令牌校验、X-VNPen-Contract 头
    src/handlers/          各接口；generate.rs 是 SSE 共用管线
    src/supervisor.rs      llama-server 进程管理
    src/models.rs          models.json、下载、sha256
    src/providers.rs       vnpen / external / 本地 GGUF
    src/prompts.rs         presets 读取、模板、采样参数校验
    src/parsers.rs         剧本行、JSON Lines、UTF-16 定位、message 模板
    src/rules.rs           校对规则层
    src/router.rs          /chat 意图路由
    src/window.rs          /continue 窗口（攒 80 掉 40）
    src/history.rs         调用记录
    tests/contract.rs      端到端集成测试
  presets/                 system 正式版、说明书版 system、模板、默认采样
  models.json              模型清单
scripts/                   fetch-llama-server.sh、sync-models.mjs、build-full.sh
```

## System Prompt

自家模型的 system 是权重的一部分，**随模型固定**，前端只读展示，不可编辑。用户能编辑的是对话页的 **User Prompt**（即合同里的「附加要求」`extra`），它进入 user 消息，只对 `/brief`、`/chat` 生效；`/continue`、`/proofread`、`/rewrite` 忽略该字段，实时页也不显示该输入框。

正式版全文（来自 `train/MODELS.md`，任务层从 `presets/` 读取，前端不硬编码）：

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

**writer · 回答版**（意图路由用；v0.1 未训练，作为提示词补丁）

```
你是 VNPen，由 MewBaka 工作室发布的视觉小说专项模型。请直接回答用户的问题，不要输出剧本，使用简体中文。
```

`/chat` 意图路由：短句（≤ 20 字）+ 疑问标记 + 无剧本关键词 → 回答版 system，只发当前句；否则写作版 system + 历史。规则写在 `router.rs`，可通过 `IntentHook` 替换。

外部模型使用 `presets/external/*.txt` 的「说明书版」system，按接口各一份，Playground 可在设置中逐接口编辑，Desktop 只读。

Playground 提供「解锁 system（实验）」开关（默认关），开启时红字提示「模型未在此 system 下训练，输出可能不稳定」；Desktop 不提供（`EngineConfig.allow_system_override = false`）。

两个模型的 chat template 已烘进 GGUF：llama-server 以 `--jinja` 启动，请求固定 `chat_template_kwargs.enable_thinking = false`。调用历史里的「渲染后 Prompt」由 llama-server `/apply-template` 生成，与实际发送给模型的完全一致。

默认采样（`presets/sampling.json`）：temperature 0.8、top_p 0.95、top_k 40、repeat_penalty 1.1、repeat_last_n 256、stop `<|im_end|>` `<|endoftext|>`。任务层拒绝会破坏格式的组合（temperature < 0.5、repeat_penalty < 1.0 等）并返回 400。

## 模型列表

模型列表在启动时读取自 Hugging Face 组织 **VNPen**（可用 `VNPEN_HF_ORG` 改组织，`HF_ENDPOINT` 用镜像）：每个名为 `vnpen-<writer|realtime>-<参数量>-<版本>-GGUF` 的仓库是一个模型，显示为「Writer v0.1-preview-GGUF」这样的名称，仓库里每个 `.gguf` 文件（排除 imatrix / mmproj）是一个可下载的量化版本，sha256 与大小取自 LFS 元数据。结果缓存在数据目录的 `catalog.json`，设置 → 模型可手动刷新。离线时依次使用缓存和安装包内的 `models.json`。组织里还没有的角色（目前是 realtime）保留 `models.json` 中的占位条目，显示「即将推出」。

### models.json（离线兜底）

```jsonc
{
  "version": 1,
  "models": [
    {
      "id": "vnpen-writer-2b-v0.1-preview",      // 目录名，模型存放于 <模型目录>/<id>/<file>
      "name": "vnpen-writer",                    // 列表显示名
      "display_name": "vnpen-writer-2b-v0.1-preview-GGUF",
      "role": "writer",                          // writer | realtime
      "status": "released",                      // released | not_released（UI 显示「即将推出」，不可选）
      "params": "2B",
      "repo": "VNPen/vnpen-writer-2b-v0.1-preview-GGUF",
      "files": [
        { "file": "writer-2b-preview-Q8_0.gguf", "quant": "Q8_0", "recommended": true, "note": "推荐",
          "sha256": "…", "size": 0 }             // 不要手填，见下
      ]
    }
  ]
}
```

`pnpm sync-models` 按上面的规则从组织重新生成此文件，`tauri build` 前自动执行；不要手填 `sha256` / `size`。下载由任务层完成（断点续传、写 `.part`、sha256 校验通过后改名），llama-server 不联网。国内网络可设置 `HF_ENDPOINT` 使用镜像。

## 添加外部提供者

设置 → 提供者 → 添加：名称、Base URL（OpenAI 兼容，不含 `/v1`）、API Key、模型名、能力位（思考、JSON mode、延迟）。可逐接口覆盖说明书版 system。配置保存在应用设置中，启动时推送给任务层（`PUT /v1/vnpen/_playground/providers/external`）。外部模型给出的校对 Issue 一律 `confidence: low`、`source: external`。

本地 GGUF：设置 → 提供者 → 本地 GGUF，选择文件；任务层用它临时起一个 llama-server（空闲 10 分钟卸载），仅本次运行有效。

## 把 engine crate 接进 Desktop

```toml
[dependencies]
vnpen-engine = { git = "https://github.com/vnpen/playground", package = "vnpen-engine" }
```

```rust
let handle = vnpen_engine::start(vnpen_engine::EngineConfig {
    llama_server_path: Some(sidecar_path),
    presets_dir,                 // 随应用打包的 presets/
    models_manifest,             // models.json
    models_dir,                  // 用户可选的模型目录
    bundled_models_dir: None,
    data_dir,                    // 日志写到 data_dir/logs
    port: 0,                     // 随机端口
    token: None,                 // 随机令牌
    allow_system_override: false, // Desktop 不提供解锁
    intent_hook: None,
}).await?;
// 把 handle.port / handle.token 交给前端；退出时 handle.shutdown()（同步杀掉全部 llama-server）
```

`/v1/vnpen/_playground/*` 是 Playground 专用接口（调用历史、模型下载、provider 管理），不属于合同。

## 接口速查

所有请求带 `X-VNPen-Token`，所有响应带 `X-VNPen-Contract: 1`。生成类接口返回 SSE（`line` / `delta` / `done` / `error`）；参数错误等预检失败返回 JSON 错误体与对应 HTTP 状态。

```bash
curl -s -H 'X-VNPen-Token: dev' http://127.0.0.1:7730/v1/vnpen/status
```

```bash
curl -N -H 'X-VNPen-Token: dev' -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"写三行雨中的对白"}]}' http://127.0.0.1:7730/v1/vnpen/chat
```

| 接口 | 说明 |
|---|---|
| `GET /status` | 引擎、模型（含 `state`：not_released / not_downloaded / stopped / starting / running / unloaded）、provider、硬件 |
| `POST /continue` | SSE，realtime；任务层维护窗口，累积到 80 行时丢前 40 行，保证前缀命中 prefix cache；按 `max_lines` 停 |
| `POST /proofread` | 同步；规则层 + 模型层（重打分层 `Rescorer` 留接口）；找不到位置的 Issue 不下发；`offset/length` 为 UTF-16 码元 |
| `POST /rewrite` | SSE；light → realtime，heavy → writer；`done.diff` |
| `POST /brief` | SSE，writer |
| `POST /chat` | SSE，writer；意图路由；`done.blocks` |
| `POST /review` | v0.1 返回 `501 not_available` |
| `DELETE /requests/{id}` | 取消，幂等；断开连接同样立即中止生成 |

realtime 模型未发布时，自家 provider 的 `/continue`、`/rewrite light` 返回 `not_available`（不会偷偷改用 writer），`/proofread` 只跑规则层。

## 测试

```bash
cargo test --manifest-path src-tauri/src/engine/Cargo.toml
```

端到端集成测试用一个约 0.8B 的公开 GGUF（例如 `unsloth/Qwen3.5-0.8B-GGUF` 的 Q4_K_M）跑通全部接口，验证事件顺序、错误码、取消、Issue 定位与进程清理，不验证输出质量：

```bash
VNPEN_TEST_GGUF=/path/to/Qwen3.5-0.8B-Q4_K_M.gguf cargo test --manifest-path src-tauri/src/engine/Cargo.toml --test contract -- --ignored
```

## 色卡

主色 `#3F3A9E`，定义在 `src/styles/tokens.css`。浅色为默认，深色为中性黑灰底（主色只用于强调），标题栏的外观按钮在「跟随系统 / 浅色 / 深色」间切换。

| Token | 浅色 | 用途 |
|---|---|---|
| `--brand-50`…`--brand-900` | `#EEEDF8` … `#3F3A9E`(600) … `#1A1842` | 主色阶 |
| `--brand` | `#3F3A9E` | 主按钮、选中态、文字 LOGO、滑块、链接 |
| `--brand-soft` | `#EEEDF8` | 选中卡片底色、标签、用户消息气泡 |
| `--bg` / `--sidebar` / `--card` / `--sunken` | `#F7F6FB` / `#F1F0F8` / `#FFFFFF` / `#F4F3FA` | 页面 / 侧栏 / 卡片 / 内嵌区域 |
| `--line` / `--line-strong` | `#E4E2F0` / `#D3D0E6` | 分隔线、边框 |
| `--fg` / `--fg2` / `--muted` | `#1E1C3A` / `#5B5878` / `#8C89A6` | 正文 / 次要文字 / 说明 |
| `--err` | `#D64545` | 错别字标签、高置信问题（红色实线下划线）、错误横幅 |
| `--warn` | `#C98A12` | 病句标签、低置信问题（黄色虚线下划线）、加载中 |
| `--ok` | `#2E8B57` | 引擎运行、校对延迟、diff 新文本 |
| `--info` | `#3B6FD9` | 提示条、OOC/逻辑等审查类标签 |
| `--spk-1`…`--spk-8` | 玫红、青、琥珀、紫、绿、锈红、蓝、梅 | 说话人，按出场顺序分配 |
| `--narration` | `#6F6C8C` | 旁白说话人 |
| `--ghost` | `#A9A6C2` | 续写灰字 |

## 与原型的差异（UI 缺陷修正）

- 思考模式对自家模型置灰显示「不支持」；Stop 序列只对外部模型显示（合同不允许用说话人名作 stop）。
- 采样默认值改为合同值（0.8 / 0.95），滑块下限 temperature 0.5、repeat_penalty 1.0。
- 上下文占用按 4096 计算，75% / 90% 变黄 / 红。
- System Prompt 栏改为 User Prompt（`extra`）；实时页不显示；system 在设置里只读查看。
- 实时页只显示校对类 Issue；OOC 等审查类放在「整场审查（v0.2）」占位卡片。下划线只用红实线 / 黄虚线两种。
- 新增 POV、登场角色（声音提示）与校对白名单；编辑区加行号；校对浮层锚定到下划线处，不再塞 meta 数字。
- 续写灰字（Tab 接受 / Esc 忽略）、行选择 + 轻 / 重度改写与 diff 预览、对话剧本块「插入到实时编辑区」、生成中可停止。
- 引擎状态分别显示 writer / realtime 等进程；错误横幅按错误码给出重试 / 去下载；各处空状态；图标按钮均有 aria-label 与提示。
- 调用历史为 Opencode 式小卡片（tokens、首字、速度、耗时），点开可看渲染后 Prompt、原始输出、解析结果与 Raw JSON。

## 性能测试

设置 → 性能测试：选择本地 Writer、本地 GGUF 或外部接口，每项重复 1–3 次取平均。固定三组用例（提示 128 / 512 / 2048 tokens，各生成 128 tokens），给出提示处理速度、生成速度、首字延迟和冷启动加载耗时，并记录模型、llama.cpp 版本与硬件，可复制为 Markdown 表格。本地模型通过 llama-server `/completion` 以 token id 作为提示、`ignore_eos`、关闭提示缓存、贪心采样运行，数值取自 llama.cpp 自身计时；外部接口只能从外部计时，提示处理速度为估算。接口：`POST /v1/vnpen/_playground/benchmark`（SSE：`stage` / `env` / `case` / `done` / `error`）。进行中的测试同时显示在侧栏任务卡片中。

## 窗口

无边框窗口：macOS 使用透明标题栏（`titleBarStyle: Overlay`，保留红绿灯，位于侧栏顶部），Windows / Linux 关闭系统装饰（`tauri.windows.conf.json`、`tauri.linux.conf.json`），由应用在标题栏右侧绘制最小化 / 最大化 / 关闭按钮。顶栏和侧栏顶部可拖动窗口。

## 打包

- 安装包不含模型，首次启用时下载；目标体积 < 100 MB（macOS 静态 llama-server 约 17 MB）。
- macOS（Apple Silicon 优先）：sidecar 随应用一起签名公证。设置 `APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` 后执行 `pnpm tauri build`。
- Windows：NSIS 安装包（当前用户安装）。CPU 版 llama-server 作为 sidecar；可选把 CUDA / Vulkan 构建放到 `src-tauri/llama/{cuda,vulkan}/` 并加入 `bundle.resources`，启动时检测 `nvcuda.dll` / `vulkan-1.dll` 选择，都没有则回退 CPU。签名通过 `bundle.windows.signCommand` 配置。
- 完整版（含模型）安装包备用脚本：`scripts/build-full.sh`，把各已发布模型的推荐文件打进 `bundled-models/`，以只读方式使用，不可在应用内删除。
- 退出时任务层同步结束全部 llama-server 进程；卸载前在设置中删除模型即可删干净模型目录。

## 许可

Apache-2.0
