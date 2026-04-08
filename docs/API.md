# blog2media HTTP API

Next.js App Router 本地服务（默认端口由 `start-bg.sh` 设为 **9300**）。

- 根地址：`http://127.0.0.1:9300`
- 上游仓库：`DanielMax937/media-blog`（本地目录名 `blog2media`）

## 环境变量

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI 兼容 API 密钥（抓取后正文抽取与内容生成） |
| `OPENAI_BASE_URL` | 可选，自定义 API Base URL |

## 端点

### `GET /api/health`

健康检查，供 local-service `checkCommand` 使用。

**响应示例：** `200`，body：`{"status":"ok"}`

---

### `POST /api/generate-blog`

从给定 URL 用 Playwright 抓取页面正文，经 LLM 抽取主文，再按策略生成博客风格内容。

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

## 本地脚本

| 脚本 | 说明 |
|------|------|
| `./start-bg.sh` | 后台启动 `next dev`，默认 `-p 9300` |
| `./stop-bg.sh` | 按端口停止进程 |

日志：`./blog2media.log`，PID：`./blog2media.pid`。
