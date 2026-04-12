# AI Proxy Bridge

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)]()

Free access to top-tier AI models (Claude, GPT-4/5, Gemini, DeepSeek, Llama, etc.) through a local OpenAI-compatible API proxy.

通过本地 OpenAI 兼容 API 代理，免费使用 Claude、GPT-4/5、Gemini、DeepSeek、Llama 等顶级 AI 模型。

---

![](images/01.png)

## Features | 特性

- **OpenAI API Compatible** — Drop-in replacement for any client that supports OpenAI API format (streaming + non-streaming)
- **Dual Connection Modes** — Tampermonkey WebSocket client (recommended) or Puppeteer browser automation
- **300+ Models** — Automatically extracts model list from LMArena, grouped by provider (OpenAI, Anthropic, Google, Meta, DeepSeek, Mistral, etc.)
- **Model Test Panel** — Test any model directly from the app with real-time streaming response
- **Multi-Instance Load Balancing** — Run multiple browser sessions with round-robin request distribution
- **Cross-Platform** — Windows, macOS, Linux support via Electron
- **Dark/Light Theme** — Modern UI with provider logos and capability tags
- **Real-time Logs** — Built-in log viewer for debugging

---

## Architecture | 架构

```
┌─────────────────┐     ┌──────────────────────────────────────┐     ┌──────────────────┐
│  AI Client      │────▶│  AI Proxy Bridge (Electron App)      │────▶│  lmarena.ai      │
│  (Cherry Studio │     │                                      │     │  (Browser Page)  │
│   / VS Code /   │     │  ┌──────────────────────────────┐   │     │                  │
│   Any OpenAI    │     │  │  Proxy Server (Express + WS) │   │     │  ┌────────────┐  │
│   Client)       │◀────│  │  :61001                      │◀───│─────│  │ Tampermonkey│  │
│                 │     │  └──────────────────────────────┘   │     │  │ Userscript  │  │
└─────────────────┘     │                                      │     │  └────────────┘  │
                        │  ┌──────────────────────────────┐   │     │                  │
                        │  │  Browser Manager (Puppeteer) │───│────▶│  ┌────────────┐  │
                        │  └──────────────────────────────┘   │     │  │ Chrome/Edge │  │
                        └──────────────────────────────────────┘     │  └────────────┘  │
                                                                    └──────────────────┘
```

### How It Works | 工作原理

1. The app runs a local HTTP+WebSocket server on port `61001`
2. A Tampermonkey userscript in your browser connects via WebSocket
3. When an AI client sends a request to the local API, the proxy forwards it to the userscript
4. The userscript hijacks the page's own `fetch` request to LMArena, replacing the model ID and message content
5. The response is streamed back through the proxy in OpenAI-compatible format

---

## Quick Start | 快速开始

### 1. Install | 安装

Download from [Releases](https://github.com/Vogadero/AIProxyBridge/releases):

| OS | File |
|---|---|
| Windows | `AI-Proxy-Bridge-Setup.exe` |
| macOS | `AI-Proxy-Bridge.dmg` |
| Linux | `AI-Proxy-Bridge.AppImage` |

Or build from source:

```bash
git clone https://github.com/Vogadero/AIProxyBridge.git
cd AIProxyBridge
npm install
npm run dev
```

### 2. Start Service | 启动服务

Launch the app and click "Start Service" | 启动应用，点击「启动服务」

### 3. Connect Browser | 连接浏览器

**Recommended: Tampermonkey Userscript** (recommended mode)

1. Install [Tampermonkey](https://www.tampermonkey.net/) extension in your browser
2. Create a new script and paste the contents of [`scripts/bridge-userscript.js`](scripts/bridge-userscript.js)
3. Open [lmarena.ai](https://lmarena.ai) and log in with Google
4. The page title will show a checkmark when connected

**Alternative: Puppeteer Browser**

1. Click "New Instance" in the "Browser Instances" tab
2. Log in with Google in the new browser window
3. Send one message to verify the connection

### 4. Configure Client | 配置客户端

In any OpenAI API compatible client:

| Setting | Value |
|---|---|
| API Base URL | `http://127.0.0.1:61001` |
| API Key | `123456` |
| Model | Any model from the list (e.g., `claude-3-5-sonnet-20241022`) |

### Supported Clients | 支持的客户端

- [Cherry Studio](https://www.cherry-ai.com/) — AI chat client
- [Continue](https://continue.dev/) — VS Code / JetBrains AI coding assistant
- [Kilo Code](https://kilocode.ai/) — VS Code AI coding plugin
- [Immersive Translate](https://immersivetranslate.com/) — Browser translation extension
- Any client that supports OpenAI API format

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/models` | GET | List available models (OpenAI format) |
| `/v1/chat/completions` | POST | Chat completion (streaming + non-streaming) |
| `/health` | GET | Health check |

Example request:

```bash
curl http://127.0.0.1:61001/v1/chat/completions \
  -H "Authorization: Bearer 123456" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

---

## Development | 开发

### Prerequisites

- Node.js 20+
- npm

### Commands

```bash
npm install          # Install dependencies
npm run dev          # Run in development mode
npm run build        # Build for current platform
npm run build:win    # Build for Windows
npm run build:mac    # Build for macOS
npm run build:linux  # Build for Linux
```

### Project Structure

```
AIProxyBridge/
├── main.js                 # Electron main process
├── preload.js              # IPC bridge (renderer ↔ main)
├── renderer/
│   ├── index.html          # UI (5-tab SPA)
│   ├── renderer.js         # UI logic
│   └── styles.css          # Styles
├── src/
│   ├── proxy-server.js     # Express + WebSocket proxy server
│   └── browser-manager.js  # Puppeteer browser automation
├── scripts/
│   └── bridge-userscript.js # Tampermonkey userscript
└── package.json
```

---

## FAQ | 常见问题

**Model list is empty?** | 模型列表为空？
> Make sure the service is running and a browser client is connected. Click "Refresh List". | 确保服务已启动且浏览器客户端已连接，点击「刷新列表」。

**No API response?** | API 请求没有响应？
> Check if the browser page is still on lmarena.ai and the title shows a checkmark. | 检查浏览器页面是否仍在 lmarena.ai，标题是否显示勾号。

**429 Rate Limit Error?** | 遇到 429 错误？
> This is reCAPTCHA verification. Try sending a message manually in the browser first, then retry. | 这是 reCAPTCHA 验证。先在浏览器中手动发送一条消息，然后重试。

---

## License | 许可证

[MIT License](LICENSE)

---

## Disclaimer | 免责声明

This project is for educational and research purposes only. Use of this tool to access AI services may violate the terms of service of the platforms involved. The user assumes all responsibility for any consequences arising from the use of this tool.

本项目仅供学习和研究使用。使用本工具访问 AI 服务可能违反相关平台的服务条款。使用者需自行承担使用本工具产生的任何后果。
