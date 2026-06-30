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
- 🖼️→🖼️ Variations or remixes of existing images (via reference images)

…and **drop them straight into the project it's building** (e.g. into `public/` or `assets/`).

### How an agent uses it

```
You: "Build me a landing page for a coffee shop"
        ↓
Agent writes the HTML/CSS
        ↓
Agent calls generate_image("warm cozy coffee shop hero, morning light, watercolor")
        ↓
MCP finds your open ChatGPT tab, types the prompt, waits, downloads → public/hero.png
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
            │         finds/opens a tab, types prompt, waits, downloads
            ▼                  │
       saved PNG  ◄────────────┘   (tab stays open — reused next call)
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
| `reference_images` | string[] | | Local file paths to attach as visual references. See [Reference images](#-reference-images-img2img) below. |

**Returns:** the absolute path of the saved PNG.

### Example calls

```jsonc
// Hero image into a project's public folder
{
  "prompt": "minimalist mountain range at dawn, soft gradient, vector",
  "filename": "hero",
  "output_dir": "./public"
}

// Transparent icon
{
  "prompt": "search magnifying glass icon, line art, blue",
  "filename": "icon-search",
  "output_dir": "./public/icons",
  "transparent_background": true
}

// Variation of an existing image
{
  "prompt": "same composition but in a dark moody noir style",
  "filename": "hero-dark",
  "output_dir": "./public",
  "reference_images": ["./public/hero.png"]
}

// Style transfer from a palette/mood image
{
  "prompt": "product shot of a coffee mug, match this color palette and lighting",
  "filename": "product-mug",
  "output_dir": "./public",
  "reference_images": ["./references/palette.jpg", "./references/lighting-ref.jpg"]
}
```

---

## ♻️ Tab reuse & thread control

The MCP no longer opens a fresh ChatGPT tab on every call. Instead it scans your
open browser tabs and **reuses the first one it finds on `chatgpt.com`**, then leaves
it open when done.

**Why this matters:**

| You want | What to do |
|---|---|
| Continue the **same** chat thread | Leave the ChatGPT tab open between calls. All generations land in the same conversation, so you can reference prior images in new prompts. |
| Start a **fresh** chat | Close the ChatGPT tab in Edge before calling the tool. The MCP opens a new tab to `chatgpt.com` (new conversation). |
| Use a **specific** conversation | Navigate to that conversation in Edge before calling. The MCP picks up whichever tab is open. |

**New-image collision protection:** when a tab is reused in a thread that already has
generated images, the MCP snapshots the `src` of every existing `img[alt^="Generated image"]`
before sending the prompt. The image detector then filters to only images that were **not
in that snapshot** — so previously generated images in the thread are never mistakenly
returned as the new result, regardless of how long the conversation is.

---

## 🖼️ Reference images (img2img)

Pass `reference_images` as an array of **absolute local file paths** to attach those
images to the ChatGPT prompt as visual context:

```jsonc
{
  "prompt": "redesign this logo with a modern flat style, keep the color scheme",
  "filename": "logo-v2",
  "reference_images": ["C:/Users/you/project/public/logo-old.png"]
}
```

ChatGPT receives the images as attachments alongside your text prompt — the same as if
you had manually dragged files into the chat box. Use cases:

- **Variations** — "same character, different pose"
- **Style transfer** — attach a reference image and ask to match its mood/palette
- **Iteration** — generate an image, save it, then use it as a reference for the next
  generation, refining incrementally
- **Multi-reference** — attach a sketch + a color palette + a style reference all at once

> **File paths must be absolute** (or resolvable from where the MCP server runs).
> Missing files are skipped with a warning; the generation proceeds without them.

### Iterative workflow example

```
1. generate_image("robot mascot, chibi style, blue and white")
   → saves robot-v1.png

2. generate_image("same robot, add wings and a cape, keep the chibi style",
     reference_images=["./public/robot-v1.png"])
   → saves robot-v2.png

3. generate_image("render robot-v2 in a dramatic space background",
     reference_images=["./public/robot-v2.png"])
   → saves robot-v3.png
```

Each call continues in the same ChatGPT thread (tab is kept open), so the model has
full context of every prior generation when processing the next request.

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
colored sections, set transparent_background: true. When iterating on an image
that was already generated, pass the previous file path in reference_images so
ChatGPT can use it as visual context.
```

Now when you say *"build me a portfolio site,"* the agent generates and embeds real artwork
on its own, and when you say *"make the hero darker,"* it automatically passes the previous
hero as a reference image.

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
| MCP keeps using the wrong chat thread | The MCP picks the first `chatgpt.com` tab it finds. Close unwanted ChatGPT tabs so only the one you want is open. |
| Reference images not being used | Check that paths are absolute and the files exist. The MCP logs a warning for missing files. Also confirm ChatGPT didn't show a "file too large" error in the tab. |
| Timed out, no image | You may not be logged into chatgpt.com in that browser, or hit a rate limit. Open ChatGPT manually and check. |
| Wrong/low-res image | Shouldn't happen — it waits for the src to stabilize and filters out pre-existing images. If it does, file an issue with the prompt. |
| Generation picks up a previous image from the thread | This is protected against by the pre-prompt DOM snapshot. If it still happens, file an issue. |

---

## ⚖️ Notes & limitations

- This automates **your own** ChatGPT session in **your own** browser. Use it in line with
  OpenAI's terms of service. It's intended for personal/development use.
- Generation speed depends on ChatGPT (~10–80 s per image).
- Image quality/capabilities are whatever your ChatGPT plan provides.
- Reference image uploads use the same file-input mechanism as manual drag-and-drop; very
  large files may take longer to upload before the prompt is sent.
- This project is not affiliated with OpenAI or Anthropic.

## 📄 License

[MIT](./LICENSE)
