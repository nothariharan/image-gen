# 🎨 image-gen — MCP Image Generation via ChatGPT

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets any
AI agent or CLI tool — **Claude Code, Claude Desktop, Cursor, Windsurf, Cline**, etc. —
**generate real images on demand**.

It works by driving your **own, already-logged-in Edge/Chrome browser** to `chatgpt.com`,
typing the prompt, waiting for the image, and downloading the exact file to disk.

> **No API key. No OpenAI billing. No token juggling.** It reuses the ChatGPT session
> you're already logged into, so image generation is effectively free with any ChatGPT plan.

---

## ✨ Why this exists

Most "generate an image" integrations need a paid API key (OpenAI Images, Stability, etc.).
This one doesn't. If you have a ChatGPT account open in your browser, your agent can now
create:

- 🖼️ Hero images & banners for websites
- 🎯 Icons & UI illustrations (with transparent backgrounds)
- 🦊 Mascots, avatars, logos
- 🎨 Empty-state art, decorative backgrounds, placeholder visuals

…and **drop them straight into the project it's building** (e.g. into `public/` or `assets/`).

### How an agent uses it

```
You: "Build me a landing page for a coffee shop"
        ↓
Agent writes the HTML/CSS
        ↓
Agent calls generate_image("warm cozy coffee shop hero, morning light, watercolor")
        ↓
MCP opens ChatGPT in your Edge, generates, downloads → public/hero.png
        ↓
Agent wires <img src="/hero.png"> into the page
        ↓
You get a finished page with real images, not gray placeholder boxes.
```

---

## 🧠 How it works (and why it's reliable)

```
  Your agent (Claude Code / Cursor / …)
            │  MCP stdio
            ▼
     mcp-server.mjs  ──►  generate.mjs
            │                  │  Playwright over CDP (port 9222)
            │                  ▼
            │        Your REAL running Edge/Chrome  ──►  chatgpt.com
            │                  │   (uses your existing login — no bot checks)
            │                  ▼
            │         opens a tab, types prompt, waits, downloads
            ▼                  │
       saved PNG  ◄────────────┘   (tab closes, your browser stays open)
```

Earlier naive approaches all failed, so this one is built around what actually survives
ChatGPT's frontend:

| Approach | Problem | This project |
|---|---|---|
| Raw HTTP to `backend-api` | 403 + CSP + bot detection | ❌ avoided |
| Fresh Playwright browser | endless "are you a robot" loops | ❌ avoided |
| `img[src*="oaiusercontent"]` selector | URL moved to `estuary/content` | ❌ avoided |
| Hover "download" button | appears on hover, renames, rerenders | ⚠️ last-resort only |
| **Connect to your real browser via CDP** | — | ✅ **primary** |

**Download logic** (each step falls back to the next):

1. **Primary** — wait for `img[alt^="Generated image"]` (stable semantic selector), poll
   until its `src` **stops changing for 3 s** (defeats the preview→final swap), then fetch
   that exact `src`. ChatGPT serves it from a **signed, self-authorizing URL**
   (`…/backend-api/estuary/content?id=file_…&sig=…`), so a plain in-page fetch works.
2. **Fallback 1** — the largest `image/*` network response captured during generation
   (≥ 80 KB, already authenticated by your session).
3. **Fallback 2** — the newest large `<img>` on the page.

It validates PNG/JPEG/WebP magic bytes before saving, and parses the `conversation` stream
**only** to detect refusals (so it fails fast instead of hanging).

---

## 📋 Requirements

- **Node.js 18+**
- **Microsoft Edge** or **Google Chrome** (Edge is the default lookup)
- A **ChatGPT account** you're logged into in that browser
- Windows (the helper `launch-edge.bat` is Windows; macOS/Linux users just pass the
  `--remote-debugging-port` flag manually — see [Other platforms](#-macos--linux))

---

## 🚀 Setup

### 1. Clone & install

```bash
git clone https://github.com/nothariharan/image-gen.git
cd image-gen
npm install
```

### 2. Start your browser with remote debugging

The MCP connects to your real browser over the Chrome DevTools Protocol, which must be
enabled with a launch flag.

**Easiest (Windows):** double-click **`launch-edge.bat`**. It closes any running Edge and
relaunches it with the debug port, restoring your tabs and keeping you logged in.

**Permanent (recommended):** add the flag to your Edge shortcut so it's always on:

1. Right-click your Edge taskbar icon → **Properties**
2. In **Target**, add a space then the flag at the very end:
   ```
   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
   ```
3. Click **OK**, fully close Edge, and reopen it from that shortcut.

> ⚠️ If Edge is already running **without** the flag, clicking the shortcut just opens a new
> window in the old process. You must fully close Edge first (or use `launch-edge.bat`,
> which does it for you).

### 3. Log in to ChatGPT

In that browser, go to **chatgpt.com** and make sure you're logged in. That's the session
the MCP reuses.

### 4. Verify the connection

```bash
node setup-session.mjs
# → "Connected! The browser has N open context(s)."
```

### 5. Register the MCP with your agent

**Claude Code (global, available in every project):**

```bash
claude mcp add -s user image-gen node /absolute/path/to/image-gen/mcp-server.mjs
```

**Claude Desktop / Cursor / other** — add to the client's MCP config (JSON):

```json
{
  "mcpServers": {
    "image-gen": {
      "command": "node",
      "args": ["/absolute/path/to/image-gen/mcp-server.mjs"]
    }
  }
}
```

Restart your agent. You should now see the `generate_image` tool available.

---

## 🛠️ The `generate_image` tool

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | ✅ | What to generate. Be specific: subject, style, colors, mood, composition. |
| `filename` | string | | Output filename **without** extension. Default `generated_<timestamp>`. |
| `output_dir` | string | | Where to save. Default: the agent's current working directory. |
| `transparent_background` | boolean | | `true` for icons/logos/UI art — auto-appends "transparent background, no shadow" to the prompt. |

**Returns:** the absolute path of the saved PNG.

### Example calls

```jsonc
// Hero image into a project's public folder
{ "prompt": "minimalist mountain range at dawn, soft gradient, vector",
  "filename": "hero", "output_dir": "./public" }

// Transparent icon
{ "prompt": "search magnifying glass icon, line art, blue",
  "filename": "icon-search", "output_dir": "./public/icons",
  "transparent_background": true }
```

---

## 🤖 Make your agent use it *automatically*

The real power is the agent reaching for images **without being asked**. For **Claude Code**,
add this to your global `~/.claude/CLAUDE.md` (this repo's behavior is already tuned for it):

```markdown
## Image Generation
When building or editing any website/app, if a visual would improve it —
hero images, section illustrations, feature icons, empty-state art — use the
`generate_image` MCP tool and wire the result in. Don't ask first; just do it.
Save into the project's public/ or assets/ folder. For icons/logos placed on
colored sections, set transparent_background: true.
```

Now when you say *"build me a portfolio site,"* the agent generates and embeds real artwork
on its own.

---

## 🍎 macOS / Linux

There's no `.bat`, but the mechanism is identical — launch your browser with the debug port:

```bash
# macOS (Edge)
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --remote-debugging-port=9222

# macOS (Chrome)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

Then run `node setup-session.mjs` to verify. Everything else is the same.

> You can change the port with the `IMAGE_GEN_CDP_PORT` environment variable (default `9222`).

---

## 🩺 Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot connect to Edge on port 9222` | Edge isn't running with the debug flag. Run `launch-edge.bat` or add the flag to your shortcut. Fully close Edge first. |
| `ChatGPT refused …` | The prompt hit a content policy. Rephrase it. |
| "Browser opens then closes / goes to home page" | **Expected.** The MCP opens a tab, generates, saves, then closes *that tab* — your browser stays open. The image is saved before the tab closes. |
| Timed out, no image | You may not be logged into chatgpt.com in that browser, or hit a rate limit. Open ChatGPT manually and check. |
| Wrong/low-res image | Shouldn't happen — it waits for the src to stabilize. If it does, file an issue with the prompt. |

---

## ⚖️ Notes & limitations

- This automates **your own** ChatGPT session in **your own** browser. Use it in line with
  OpenAI's terms of service. It's intended for personal/development use.
- Generation speed depends on ChatGPT (~10–80 s per image).
- Image quality/capabilities are whatever your ChatGPT plan provides.
- This project is not affiliated with OpenAI or Anthropic.

## 📄 License

[MIT](./LICENSE)
