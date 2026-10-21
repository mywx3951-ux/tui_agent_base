# tui-agent-base

用 **TypeScript + Node.js** 从零搭建的 LLM Agent 练习项目，包含三个可独立运行的子系统：

| 子系统 | 入口 | 说明 |
| --- | --- | --- |
| **单 Agent TUI** | `server/src/AI_Agent/tui/Base_tui.ts` | 终端流式对话，模型可调用文件读写/审查工具 |
| **MCP Server** | `server/src/AI_Agent/mcp/main.ts` | 通过 stdio 暴露 `generate_mock` 工具，可接入 Trae / Cursor 等 IDE |
| **多 Agent 调度** | `server/src/Multi_agent/tui.ts` | 主 Agent 拆任务、建 todoList、派发子 Agent（独立进程）执行 |

三个子系统共用同一套底层机制：**流式输出、function calling、多轮对话历史**。

---

## 目录结构

```
tui-agent-base/
├── package.json                    # 根：npm workspaces + 快捷脚本
├── server/
│   ├── .env.example                # 配置模板（真正的 .env 不会进 git）
│   ├── mcp.config.json             # MCP 客户端配置（给 Trae / Cursor 用，路径与机器相关）
│   ├── tsconfig.json
│   ├── package.json
│   └── src/
│       ├── AI_Agent/               # ── 单 Agent ──
│       │   ├── tui/
│       │   │   ├── Base_tui.ts     # 主循环：读输入 → 请求 → 累积工具碎片 → 执行 → 再请求
│       │   │   └── openai_base.ts  # ChatMessage / ToolCall 类型定义
│       │   ├── tools/
│       │   │   └── tools.ts        # 工具定义 + 本地执行 + 流式请求 ask()
│       │   ├── Prompt/
│       │   │   └── prompt.ts       # 系统提示词（角色、工作流程、代码规范）
│       │   └── mcp/                # ── MCP Server ──
│       │       ├── main.ts         # 入口：createServer()
│       │       ├── server.ts       # 注册 generate_mock 工具，stdio 传输
│       │       └── idl/
│       │           └── order-api.json   # 示例 IDL（OpenAPI 格式）
│       └── Multi_agent/            # ── 多 Agent ──
│           ├── tui.ts              # 主 Agent 的 TUI
│           ├── main_agent.ts       # 主 Agent：工具定义、todoList、子进程调度
│           ├── prompt.ts           # 主 Agent 的调度提示词
│           ├── openai_base.ts      # 类型定义
│           ├── redme.md            # 设计草稿（需求说明）
│           └── sub_agent/
│               ├── write_code_agent/   # 子 Agent：写代码
│               │   ├── index.ts
│               │   ├── prompt.ts
│               │   └── tools.ts
│               └── review_code_agent/  # 子 Agent：审查代码
│                   ├── index.ts
│                   ├── prompt.ts
│                   └── tools.ts
```

---

## 快速开始

```bash
# 1. 安装依赖（根目录执行，一次装好所有 workspace）
npm install

# 2. 配置 API Key
cp server/.env.example server/.env
#    然后编辑 server/.env，填入 OPENAI_API_KEY

# 3. 运行
npm start              # 单 Agent TUI
npm run start:multi    # 多 Agent 调度 TUI
npm run mcp            # 启动 MCP Server（通常由 IDE 拉起，不需要手动跑）

npm run typecheck      # 类型检查
```

### `server/.env` 配置

```env
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxx
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-flash
```

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | 必填 |
| `OPENAI_BASE_URL` | 接口地址。OpenAI / DeepSeek / Kimi / 阿里百炼等兼容 OpenAI 格式的服务都可用 |
| `OPENAI_MODEL` | 模型名。DeepSeek 当前为 `deepseek-flash`（旧名 `deepseek-chat` 会被映射到它） |

> `.env` 已在 `.gitignore` 中，不会被提交。**切勿把 API Key 写进代码。**

---

## 一、单 Agent TUI

入口：[`server/src/AI_Agent/tui/Base_tui.ts`](server/src/AI_Agent/tui/Base_tui.ts)

```
用户输入 → ask(messages) ──► 模型
                              │
              ┌───────────────┴────────────────┐
              │ 没有 tool_calls                 │ 有 tool_calls
              ▼                                ▼
       打印文字，本轮结束           累积工具碎片 → 执行工具 → 结果作为
                                   role:"tool" 消息追加 → 再次请求
```

**可用工具**（[`tools/tools.ts`](server/src/AI_Agent/tools/tools.ts)）：

| 工具 | 作用 |
| --- | --- |
| `create_directory` | 创建文件夹（支持多层） |
| `read_file` | 读取文件内容 |
| `create_file` | 创建文件（已存在则失败） |
| `edit_file` | 覆盖写入已有文件 |
| `review_code` | 粗筛代码（检查括号配平），返回通过/不通过 |

一次用户提问内最多来回 `MAX_ROUNDS = 10` 轮工具调用，防止模型陷入死循环。

---

## 二、MCP Server

入口：[`server/src/AI_Agent/mcp/main.ts`](server/src/AI_Agent/mcp/main.ts)，核心在 [`server.ts`](server/src/AI_Agent/mcp/server.ts)。

- 基于 `@modelcontextprotocol/sdk` 的**低层 `Server` API**，配 `StdioServerTransport`
- 暴露一个工具：`generate_mock`
- 入参 `ApiUrl`（如 `/order/api`），服务端按约定映射到 `idl/order-api.json`，把 **IDL 完整内容原样返回**，由调用方的 AI 据此生成 mock 数据

```
/order/api  →  idl/order-api.json  →  读取内容 + 提示语  →  返回给调用方 AI
```

**注意**：这个 MCP Server **自己不生成 mock 数据**，只负责"按 URL 找到 IDL 并交给 AI"。生成动作发生在调用方的模型里 —— 这是刻意的职责划分。

### 在 Trae / Cursor 里使用

IDE 需要一个 MCP 客户端配置。项目里已生成好 [`server/mcp.config.json`](server/mcp.config.json)：

```json
{
  "mcpServers": {
    "mock-generate": {
      "command": "/绝对路径/node",
      "args": ["/绝对路径/node_modules/tsx/dist/cli.mjs", "/绝对路径/server/src/AI_Agent/mcp/main.ts"],
      "cwd": "/绝对路径/server"
    }
  }
}
```

把里面的绝对路径换成你机器上的实际路径，然后粘贴进 IDE 的 MCP 配置（Trae 的配置文件在 `~/Library/Application Support/Trae CN/User/mcp.json`）。

> ⚠️ **为什么不写 `"command": "npx"`？**
> 如果 node 由 **nvm** 管理，IDE 作为 GUI 应用不会加载 `~/.zshrc`，spawn 子进程时 PATH 通常只有 `/usr/bin:/bin`，**找不到 `npx`**，配置看起来正常却连不上。
> 解决办法：用 **node 的绝对路径** + **tsx 的真实 JS 入口**（`node_modules/tsx/dist/cli.mjs`，**不能**用 `node_modules/.bin/tsx`，那是 shell 脚本，node 无法直接执行）。

---

## 三、多 Agent 调度

入口：[`server/src/Multi_agent/tui.ts`](server/src/Multi_agent/tui.ts)，核心在 [`main_agent.ts`](server/src/Multi_agent/main_agent.ts)。

设计目标（见 [`redme.md`](server/src/Multi_agent/redme.md)）：主 Agent 负责拆解与调度，子 Agent 在**独立进程**中执行具体任务，实现隔离。

```
用户需求
   │
   ▼
主 Agent（main_agent.ts）
   ├─ create_todo_list   → 生成任务清单 todos[]
   ├─ call_subagent      → spawn 子进程，阻塞等待 finish 消息
   │      ├─ write_code_agent   （独立进程，写文件）
   │      └─ review_code_agent  （独立进程，审查文件）
   └─ 根据 finish 消息判断：继续派发 / 重试 / 汇总结束
```

### 1. 主 Agent 的工具

| 工具 | 作用 |
| --- | --- |
| `create_todo_list` | 创建/覆盖任务清单。每项含 `id`、`title`、`agent`、`description` |
| `call_subagent` | 按名称启动子 Agent 进程，传入 `task`，阻塞等待 `finish` 消息 |

任务状态机：`pending → running → done / failed`，结果记录在 `Todo.result`。

### 2. 主 Agent ↔ 子 Agent 的通信协议

子 Agent 是**独立进程**，通过三种方式通信：

| 方向 | 通道 | 内容 |
| --- | --- | --- |
| 主 → 子 | **环境变量** | `SUBAGENT_NAME`、`SUBAGENT_TASK` |
| 子 → 主 | **stdout 特殊行** | `@@FINISH@@{"name":"...","ok":true,"result":"..."}` |
| 子 → 主 | **stderr / 普通 stdout 行** | 日志，原样透传给用户 |

`@@FINISH@@` 是约定的结束标记，主 Agent 逐行解析子进程输出，遇到它就 `settle` 并返回结果。子 Agent 超时（5 分钟）会被强制 `kill` 并返回失败。

### 3. 子 Agent 的能力

| 子 Agent | 工具 | 说明 |
| --- | --- | --- |
| `write_code` | `write_code` | 写代码到指定文件，目录不存在会自动创建 |
| `review_code` | `review_code` | 审查文件，返回 `✅ 通过` 或 `❌ 不通过 + 原因` |

子 Agent 通过 `ok` 字段汇报结果：`write_code` 未真正写文件则返回 `ok=false`；`review_code` 审查未通过则返回 `ok=false`。

---

## 核心机制（三个子系统共用）

### 1. 流式输出与"工具调用碎片"

请求时带 `stream: true`，SDK 返回 `AsyncIterable`。用 `for await` 消费，每次拿到一个 `chunk`：

```ts
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  if (delta?.content) process.stdout.write(delta.content);   // 打字机
  for (const tc of delta?.tool_calls ?? []) {                // 工具调用碎片
    const cur = pending.get(tc.index) ?? { id: '', name: '', args: '' };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name = tc.function.name;
    if (tc.function?.arguments) cur.args += tc.function.arguments;
    pending.set(tc.index, cur);
  }
}
```

**关键坑**：流式下 `tool_calls` 的 `arguments` 会被切成单字符碎片陆续到达（`"{"`、`"\""`、`"path"`…），必须**按 `index` 分组合并字符串**，等流结束才能 `JSON.parse`。

### 2. Function Calling 的循环本质

一次工具调用 = **两次 API 请求**：

1. 第 1 次请求 → 模型返回 `tool_calls`（它只是"请求"，不执行）
2. 本地执行工具 → 把 **`assistant` 完整消息（含 `tool_calls`）** 和 **`role:"tool"` 结果消息** 追加进历史
3. 第 2 次请求 → 模型基于真实结果回答

两条硬性约束：

- `tool_call_id` 必须与请求时的 `id` **完全一致**，否则 400
- `assistant` 消息必须**原样保留 `tool_calls`**，不能只存 `content`，否则 400

### 3. 多轮对话

模型本身无状态。"记忆"来自客户端每次把**完整历史**重新发送：

```ts
messages.push({ role: 'user', content: input });
await handleTurn(messages);   // 内部会把 assistant / tool 消息追加进去
```

---

## 已知限制与注意事项

- **⚠️ 工具没有沙箱**：`AI_Agent/tools/tools.ts` 的 `executeTool` 直接操作传入路径，**没有目录限制**，模型可以让它读写任意位置。这是学习项目，请勿在生产环境直接使用；需要沙箱可参考"路径必须落在指定根目录内"的校验写法。
- **子进程无输出上限**：子 Agent 的 stdout 会被累积解析，任务过大时注意内存。
- **`review_code` 只是粗筛**：目前仅检查括号配平，不涉及语法解析，不能替代真正的 lint / 编译。
- **`mcp.config.json` 含绝对路径**：与机器相关，换机器需重新生成；不要提交自己的用户目录敏感信息到公开仓库。
- **模型名会变**：DeepSeek 当前推荐 `deepseek-flash`，旧名会被静默映射。若发现日志里模型名与配置不一致，说明用的是旧别名。

---

## Roadmap

- [ ] 子 Agent 增加 `run_code`（执行代码）与 `report`（汇总结果）
- [ ] 主 Agent 支持并行派发互不依赖的任务
- [ ] 工具执行增加沙箱与人工确认
- [ ] MCP Server 增加更多工具（如按 IDL 直接校验 mock 数据）
- [ ] 把 `ChatMessage` / 工具定义抽到 `packages/shared` 供 `web/` 复用

---

## 学习路径建议

1. 先看 [`Base_tui.ts`](server/src/AI_Agent/tui/Base_tui.ts)：理解「读输入 → 流式请求 → 累积工具碎片 → 执行 → 再请求」这条主循环。
2. 再看 [`tools.ts`](server/src/AI_Agent/tools/tools.ts)：理解「模型只请求，本地才执行」。
3. 然后看 [`mcp/server.ts`](server/src/AI_Agent/mcp/server.ts)：理解工具如何通过 stdio + JSON-RPC 暴露给外部 IDE。
4. 最后看 [`Multi_agent/main_agent.ts`](server/src/Multi_agent/main_agent.ts)：理解进程隔离、`@@FINISH@@` 协议与 todoList 调度。
