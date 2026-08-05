# AI Proxy Bridge

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)]()

Free access to top-tier AI models (Claude, GPT-4/5, Gemini, DeepSeek, Llama, etc.) through a local OpenAI-compatible API proxy.

Бесплатный доступ к топовым моделям ИИ (Claude, GPT-4/5, Gemini, DeepSeek, Llama и др.) через локальный OpenAI-совместимый API-прокси.

---

![](images/01.png)

## Features | Возможности

- **OpenAI API Compatible | Совместимость с OpenAI API** — Drop-in replacement for any client that supports OpenAI API format (true SSE streaming + non-streaming) | Готовая замена для любого клиента, поддерживающего формат OpenAI API (настоящий SSE-стриминг и обычный режим)
- **Reasoning / "Thoughts" | Рассуждения («мысли»)** — Thinking models stream their reasoning as `reasoning_content` deltas (DeepSeek-style), visible in compatible clients | «Думающие» модели отдают ход рассуждений потоком как `reasoning_content` (в стиле DeepSeek) — видно в совместимых клиентах
- **All Arena Chat Modes | Все режимы чата Arena** — Direct, Battle, Side-by-side and Agent (experimental), selectable per request via model suffixes (`model~battle`, `modelA~vs~modelB`, `model~agent`) or a `mode` field | Direct, Battle, Side-by-side и Agent (экспериментально) — выбор для каждого запроса суффиксом модели (`model~battle`, `modelA~vs~modelB`, `model~agent`) или полем `mode`
- **Direct In-page Requests | Прямые запросы со страницы** — Requests run inside the arena.ai page itself (same-origin `fetch` to `create-evaluation`) — no DOM scraping, no Enter simulation, real token-by-token streaming | Запросы выполняются внутри самой страницы arena.ai (same-origin `fetch` к `create-evaluation`) — без скрапинга DOM и симуляции Enter, настоящий поток токенов
- **Headless Instances | Скрытые инстансы** — Puppeteer sessions run hidden by default: import session cookies once and requests work with no browser window at all | Сессии Puppeteer по умолчанию скрытые: один раз импортируйте session-cookies — и запросы работают вообще без открытия окна браузера
- **Dual Connection Modes | Два режима подключения** — Tampermonkey WebSocket client (recommended) or a hidden Puppeteer instance (auto-created with imported cookies) | WebSocket-клиент Tampermonkey (рекомендуется) или скрытый инстанс Puppeteer (создаётся автоматически при наличии импортированных cookies)
- **300+ Models | Более 300 моделей** — Automatically extracts model list from LMArena, grouped by provider (OpenAI, Anthropic, Google, Meta, DeepSeek, Mistral, etc.) | Автоматическое получение списка моделей с LMArena, сгруппированных по провайдерам (OpenAI, Anthropic, Google, Meta, DeepSeek, Mistral и др.)
- **Model Test Panel | Панель тестирования моделей** — Test any model directly from the app with real-time streaming response | Тестируйте любую модель прямо из приложения с потоковым ответом в реальном времени
- **Multi-Instance Load Balancing | Балансировка нагрузки между инстансами** — Run multiple browser sessions with round-robin request distribution | Запускайте несколько браузерных сессий с распределением запросов по принципу round-robin
- **Cross-Platform | Кроссплатформенность** — Windows, macOS, Linux support via Electron | Поддержка Windows, macOS и Linux благодаря Electron
- **Dark/Light Theme | Тёмная/светлая тема** — Modern UI with provider logos and capability tags | Современный интерфейс с логотипами провайдеров и тегами возможностей
- **Real-time Logs | Логи в реальном времени** — Built-in log viewer for debugging | Встроенный просмотрщик логов для отладки

---

## Architecture | Архитектура

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

### How It Works | Как это работает

1. The app runs a local HTTP+WebSocket server on port `61001` | Приложение запускает локальный HTTP+WebSocket сервер на порту `61001`
2. A Tampermonkey userscript in your browser connects via WebSocket | Юзерскрипт Tampermonkey в вашем браузере подключается по WebSocket
3. When an AI client sends a request to the local API, the proxy forwards it to the userscript | Когда ИИ-клиент отправляет запрос к локальному API, прокси пересылает его юзерскрипту
4. The userscript (or a hidden Puppeteer instance with cookies) sends the real `create-evaluation` request **from inside the arena.ai page** — same-origin HTTPS + the page's own session, with a reCAPTCHA token minted on the spot | Юзерскрипт (или скрытый инстанс Puppeteer с cookies) отправляет настоящий запрос `create-evaluation` **изнутри страницы arena.ai** — same-origin HTTPS + собственная сессия страницы, токен reCAPTCHA создаётся на месте
5. The raw arena stream (`a0:` text / `ag:` reasoning / `ad:` finish+usage lines) is parsed token-by-token and forwarded as OpenAI SSE (`delta.content` and `delta.reasoning_content`) | Сырой поток арены (строки `a0:` текст / `ag:` рассуждения / `ad:` завершение+usage) разбирается потокенно и пересылается как OpenAI SSE (`delta.content` и `delta.reasoning_content`)

---

## Quick Start | Быстрый старт

### 1. Install | Установка

Download from [Releases](https://github.com/Vogadero/AIProxyBridge/releases): | Скачайте из [Releases](https://github.com/Vogadero/AIProxyBridge/releases):

| OS | File | Файл |
|---|---|---|
| Windows | `AI-Proxy-Bridge-Setup.exe` | `AI-Proxy-Bridge-Setup.exe` |
| macOS | `AI-Proxy-Bridge.dmg` | `AI-Proxy-Bridge.dmg` |
| Linux | `AI-Proxy-Bridge.AppImage` | `AI-Proxy-Bridge.AppImage` |

Or build from source: | Или соберите из исходников:

```bash
git clone https://github.com/Vogadero/AIProxyBridge.git
cd AIProxyBridge
npm install
npm run dev
```

### 2. Start Service | Запуск сервиса

Launch the app and click "Start Service" | Запустите приложение и нажмите «Start Service»

### 3. Connect Browser | Подключение браузера

**Recommended: Tampermonkey Userscript | Рекомендуется: юзерскрипт Tampermonkey** (recommended mode | рекомендуемый режим)

1. Install [Tampermonkey](https://www.tampermonkey.net/) extension in your browser | Установите расширение [Tampermonkey](https://www.tampermonkey.net/) в ваш браузер
2. Create a new script and paste the contents of [`scripts/bridge-userscript.js`](scripts/bridge-userscript.js) | Создайте новый скрипт и вставьте содержимое файла [`scripts/bridge-userscript.js`](scripts/bridge-userscript.js)
3. Open [lmarena.ai](https://lmarena.ai) and log in with Google | Откройте [lmarena.ai](https://lmarena.ai) и войдите через Google
4. The page title will show a checkmark when connected | При успешном подключении в заголовке страницы появится галочка

**Alternative: hidden Puppeteer instance (no browser window) | Альтернатива: скрытый инстанс Puppeteer (без окна браузера)**

1. On the "Browser Instances" tab, paste session cookies exported from `arena.ai` (EditThisCookie → JSON) and click "Import Cookies" | На вкладке «Browser Instances» вставьте session-cookies, экспортированные с `arena.ai` (EditThisCookie → JSON), и нажмите «Import Cookies»
2. The instance is created automatically on the first request — fully headless | Инстанс создаётся автоматически при первом запросе — полностью без окна
3. No cookies? The instance tries an automatic **anonymous sign-up** on arena (Cloudflare Turnstile + reCAPTCHA) — watch the Logs to see it succeed | Нет cookies? Инстанс попробует автоматическую **анонимную регистрацию** на арене (Cloudflare Turnstile + reCAPTCHA) — следите за логами

### 4. Configure Client | Настройка клиента

In any OpenAI API compatible client: | В любом клиенте, совместимом с OpenAI API:

| Setting | Настройка | Value | Значение |
|---|---|---|---|
| API Base URL | Базовый URL API | `http://127.0.0.1:61001` | `http://127.0.0.1:61001` |
| API Key | Ключ API | `123456` | `123456` |
| Model | Модель | Any model from the list (e.g., `claude-3-5-sonnet-20241022`) | Любая модель из списка (например, `claude-3-5-sonnet-20241022`) |

### Supported Clients | Поддерживаемые клиенты

- [Cherry Studio](https://www.cherry-ai.com/) — AI chat client | ИИ-чат клиент
- [Continue](https://continue.dev/) — VS Code / JetBrains AI coding assistant | ИИ-ассистент программиста для VS Code / JetBrains
- [Kilo Code](https://kilocode.ai/) — VS Code AI coding plugin | ИИ-плагин для программирования в VS Code
- [Immersive Translate](https://immersivetranslate.com/) — Browser translation extension | Расширение для перевода в браузере
- Any client that supports OpenAI API format | Любой клиент с поддержкой формата OpenAI API

---

## API Endpoints | API-эндпоинты

| Endpoint | Эндпоинт | Method | Метод | Description | Описание |
|---|---|---|---|---|---|
| `/v1/models` | `/v1/models` | GET | GET | List available models (OpenAI format) | Список доступных моделей (формат OpenAI) |
| `/v1/chat/completions` | `/v1/chat/completions` | POST | POST | Chat completion (streaming + non-streaming) | Генерация ответа в чате (потоковая и обычная) |
| `/health` | `/health` | GET | GET | Health check | Проверка работоспособности |

Example request: | Пример запроса:

```bash
curl http://127.0.0.1:61001/v1/chat/completions \
  -H "Authorization: Bearer 123456" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Claude Sonnet 4.5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Chat Modes & Model Suffixes | Режимы чата и суффиксы моделей

Select the arena chat mode per request via the `model` field suffix (or explicit body fields): | Режим чата выбирается для каждого запроса суффиксом в поле `model` (или явными полями тела):

| Model value | Значение model | Mode | Режим |
|---|---|---|---|
| `GPT-5.2` | `GPT-5.2` | direct (default) | direct (по умолчанию) |
| `GPT-5.2~direct` | `GPT-5.2~direct` | direct | direct |
| `GPT-5.2~battle` | `GPT-5.2~battle` | battle (two anonymous models) | battle (две анонимные модели) |
| `GPT-5.2~vs~Claude Sonnet 4.5` | `GPT-5.2~vs~Claude Sonnet 4.5` | side-by-side | side-by-side |
| `GPT-5.2~agent` | `GPT-5.2~agent` | agent (experimental) | agent (экспериментально) |

You can also send explicit fields: `"mode": "side-by-side"`, `"modelB": "o3"`. | Можно также передавать явные поля: `"mode": "side-by-side"`, `"modelB": "o3"`.

- Battle/side-by-side answers are combined in one message with `**Model A:**` / `**Model B:**` labels. | Ответы battle/side-by-side объединяются в одно сообщение с метками `**Model A:**` / `**Model B:**`.
- Thinking models emit their reasoning as `delta.reasoning_content` chunks and `message.reasoning_content` in non-streaming replies. | «Думающие» модели отдают рассуждения чанками `delta.reasoning_content`, а в обычном ответе — полем `message.reasoning_content`.
- Challenge-free reCAPTCHA: a token is minted inside the browser page per request; HTTP 429/403 is retried once automatically. | reCAPTCHA без ручных действий: токен создаётся внутри страницы браузера на каждый запрос; при HTTP 429/403 выполняется один автоматический повтор.

---

## Development | Разработка

### Prerequisites | Требования

- Node.js 20+
- npm

### Commands | Команды

```bash
npm install          # Install dependencies | Установить зависимости
npm run dev          # Run in development mode | Запуск в режиме разработки
npm run build        # Build for current platform | Сборка для текущей платформы
npm run build:win    # Build for Windows | Сборка для Windows
npm run build:mac    # Build for macOS | Сборка для macOS
npm run build:linux  # Build for Linux | Сборка для Linux
```

### Project Structure | Структура проекта

```
AIProxyBridge/
├── main.js                 # Electron main process | Главный процесс Electron
├── preload.js              # IPC bridge (renderer ↔ main) | IPC-мост (renderer ↔ main)
├── renderer/
│   ├── index.html          # UI (5-tab SPA) | Интерфейс (SPA из 5 вкладок)
│   ├── renderer.js         # UI logic | Логика интерфейса
│   └── styles.css          # Styles | Стили
├── src/
│   ├── proxy-server.js     # Express + WebSocket proxy server | Прокси-сервер Express + WebSocket
│   └── browser-manager.js  # Puppeteer browser automation | Автоматизация браузера Puppeteer
├── scripts/
│   └── bridge-userscript.js # Tampermonkey userscript | Юзерскрипт Tampermonkey
└── package.json
```

---

## FAQ | Частые вопросы

**Model list is empty? | Список моделей пуст?**
> Make sure the service is running and a browser client is connected. Click "Refresh List". | Убедитесь, что сервис запущен и браузерный клиент подключён. Нажмите «Refresh List».

**No API response? | API не отвечает?**
> Check if the browser page is still on lmarena.ai and the title shows a checkmark. | Проверьте, что страница браузера всё ещё открыта на lmarena.ai и в заголовке отображается галочка.

**429 Rate Limit Error? | Ошибка 429 (превышение лимита запросов)?**
> This is reCAPTCHA verification. Try sending a message manually in the browser first, then retry. | Это проверка reCAPTCHA. Сначала отправьте сообщение вручную в браузере, затем повторите попытку.

**HTTP 500 from arena.ai? | Ошибка HTTP 500 от arena.ai?**
> Almost always means "no session": since March 2026 arena requires a signed-in (or anonymously signed-up) session for chat requests. The app reacts automatically: it performs the anonymous sign-up (`/nextjs-api/sign-up`: reCAPTCHA + Cloudflare Turnstile) and repeats the request — watch the Logs, you will see each step. If the sign-up cannot complete in your environment (Turnstile blocked), import fresh session cookies — the export must include `arena-auth-prod-v1` (or the split pair `arena-auth-prod-v1.0`/`.1`) and be pasted COMPLETELY (from `[{` to `}]`), otherwise JSON parsing fails. | Почти всегда означает «нет сессии»: с марта 2026 arena требует авторизованную (или анонимно зарегистрированную) сессию. Приложение реагирует автоматически: выполняет анонимную регистрацию (`/nextjs-api/sign-up`: reCAPTCHA + Cloudflare Turnstile) и повторяет запрос — смотрите каждый шаг в логах. Если регистрация не проходит в вашем окружении (Turnstile заблокирован), импортируйте свежие session-cookies — экспорт обязан содержать `arena-auth-prod-v1` (или разделённую пару `arena-auth-prod-v1.0`/`.1`) и быть вставлен ПОЛНОСТЬЮ (от `[{` до `}]`), иначе JSON не распарсится.

**"Cookies don't log me in"? | «Куки не логинят»?**
> Open the Logs right after importing: the app reports how many cookies Chrome accepted and whether the auth cookie is present (the check now sees httpOnly cookies). If some cookies are "rejected by Chrome", re-export them. Since 1.1.3 cookies are applied one-by-one, so a single malformed entry can no longer break the whole import. | Откройте логи сразу после импорта: приложение сообщает, сколько cookie принял Chrome и есть ли среди них auth-cookie (проверка теперь видит httpOnly-куки). Если какие-то cookie «rejected by Chrome» — экспортируйте заново. С версии 1.1.3 cookie применяются по одной, поэтому одна «битая» запись больше не ломает весь импорт.

---

## License | Лицензия

[MIT License](LICENSE)

---

## Disclaimer | Отказ от ответственности

This project is for educational and research purposes only. Use of this tool to access AI services may violate the terms of service of the platforms involved. The user assumes all responsibility for any consequences arising from the use of this tool.

Данный проект предназначен исключительно для образовательных и исследовательских целей. Использование этого инструмента для доступа к сервисам ИИ может нарушать условия использования соответствующих платформ. Пользователь несёт полную ответственность за любые последствия, возникающие в результате использования данного инструмента.
