# blog2media HTTP API

Next.js App Router 本地服务（默认端口由 `start-bg.sh` 设为 **9300**）。

- 根地址：`http://127.0.0.1:9300`
- 上游仓库：`DanielMax937/media-blog`（本地目录名 `blog2media`）

## 环境变量

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI 兼容 API 密钥；本地 agent-im 网关可使用占位值 |
| `OPENAI_BASE_URL` | OpenAI 兼容 API Base URL；当前推荐 `http://127.0.0.1:3300/v1` |
| `OPENAI_MODEL` | 可选，格式 `runner/model`；留空时使用网关默认模型 |
| `CHROME_DEVTOOLS_MCP_URL` | 可选，local-service **chrome-dev-mcp-server** 根地址，默认 `http://127.0.0.1:9223`（与 `CDS_BASE_URL` 二选一） |
| `CDS_NAVIGATION_TIMEOUT_MS` | 可选，`new_page` 导航超时（毫秒），默认 `120000` |

## 端点

### `GET /api/health`

健康检查，供 local-service `checkCommand` 使用。

**响应示例：** `200`，body：`{"status":"ok"}`

---

### `POST /api/generate-blog`

从给定 URL 抓取页面正文（**local-service `chrome-dev-mcp-server` REST**，非 Playwright），经 LLM 抽取主文，再按策略生成博客风格内容。

**前置：** 本机已启动 `chrome-dev-mcp-server`（默认 `http://127.0.0.1:9223`），可用 `local-service start chrome-dev-mcp-server` 或项目自带脚本。

**请求头：** `Content-Type: application/json`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | 是 | 要抓取的文章/页面 URL |
| `type` | string | 否 | 生成策略：`rednote`（默认）、`medium` |

**成功：** `200`，JSON 结构由具体 Strategy 返回（见 `lib/strategies/`）。

**错误：**

- `400`：`{"error":"URL is required"}`
- `500`：抽取失败或生成失败

---

### `POST /api/rednote`

独立 Rednote 流水线（抓取 → 正文抽取 → Rednote 策略含 XHS 配图 → 上传 Markdown → 写入 SQLite）。抓取使用 **chrome-dev-mcp-server**（与 `/api/generate-blog` 相同）。本接口 **入队** 后 **在同一 Node 进程内异步** 执行 `runRednoteJob`（不阻塞 HTTP 响应）；完成后写入 `generation_log` 并更新 `rednote_job`。**无需**单独 `rednote-worker` 进程。

**请求头：** `Content-Type: application/json`

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | 是 | 文章页 URL |

**成功：** `202 Accepted`

```json
{ "jobId": "550e8400-e29b-41d4-a716-446655440000" }
```

**错误：** `400`（缺 url）、`500`（入队失败）

---

### `GET /api/rednote/[jobId]`

查询异步任务状态；成功时结果与旧版同步接口一致（含 `urls` 扁平列表）。

**成功：** `200`

```json
{
  "jobId": "…",
  "status": "queued | processing | completed | failed",
  "sourceUrl": "https://…",
  "error": null,
  "mdUrl": null,
  "imageUrls": null,
  "generationLogId": null,
  "createdAt": "…",
  "updatedAt": "…",
  "urls": null
}
```

- `status === "completed"` 时：`mdUrl`、`imageUrls`、`generationLogId` 有值；`urls` 为 `[mdUrl, ...imageUrls]`（与旧版 `POST` 返回的数组一致）。
- `status === "failed"` 时：`error` 为错误信息。

**错误：** `404`（未知 `jobId`）

---

## 本地脚本

| 脚本 | 说明 |
|------|------|
| `./start-bg.sh` | 后台启动 `next dev`，默认 `-p 9300` |
| `./stop-bg.sh` | 按端口停止进程 |

日志：`./blog2media.log`，PID：`./blog2media.pid`。

**抓取依赖：** 请在本机启动 **chrome-dev-mcp-server**（与 Cursor 使用的 Chrome DevTools MCP 一致），见 local-service 或 `chrome-dev-mcp-server` 仓库说明。
