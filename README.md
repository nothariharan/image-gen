<div align="center">
  <img src="assets/logo.png" width="140" alt="image-gen logo" />
  <h1>image-gen</h1>
  <p>an mcp server that gives your ai agent a paintbrush — no api key required</p>
</div>

---

It drives your own already-logged-in browser to chatgpt.com, types the prompt, waits for dall-e to finish, and downloads the exact png to disk. That's it. Your agent gets image generation for free because it's borrowing the chatgpt session you already have open.

The reason this exists: every other image generation integration wants an openai api key and burns through credits. This one doesn't. If you're logged into chatgpt in your browser, your agent can generate images — hero banners, icons, illustrations, whatever — and wire them directly into the project it's building.

---

## How It Works

Playwright connects to your real running browser over the chrome devtools protocol (port 9222). It finds your existing chatgpt tab or opens a new one, types the prompt, and waits for `img[alt^="Generated image"]` to appear and stabilize. That selector is semantic and has held up across several chatgpt frontend rewrites. Once the image src stops changing for 3 seconds (defeats the preview→final resolution swap), it fetches the signed url from inside the page — the signature in the url makes it self-authorizing, no bearer token needed.

**Fallback chain:**
1. Wait for `img[alt^="Generated image"]` src to stabilize → fetch it from inside the page
2. Largest `image/*` network response captured during generation (≥ 80kb, already auth'd by your session)
3. Newest large `<img>` on the page

It also parses the `/backend-api/conversation` stream just enough to catch refusals so it fails fast instead of hanging for 3 minutes.

Why not just call the openai api directly? A few reasons: no key needed, it uses your existing chatgpt plan (including plus/pro quality), and driving a real browser sidesteps bot detection entirely. The tradeoff is that it's slower and depends on your browser staying open.

---

## Requirements

- Node 18+
- Microsoft Edge or Chrome, running with `--remote-debugging-port=9222`
- A chatgpt account, logged in in that browser
- Windows for the `launch-edge.bat` helper (mac/linux works fine, just launch the browser yourself)

---

## Setup

**Clone and install:**

```bash
git clone https://github.com/nothariharan/image-gen.git
cd image-gen
npm install
```

**Start Edge with remote debugging:**

The easiest way on Windows is to double-click `launch-edge.bat`. It closes any running Edge instance and relaunches it with the debug port enabled, restoring your existing tabs.

If you want it permanently, edit your Edge shortcut target:
```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
```

Fully close Edge first — if Edge is already running without the flag, opening a new window just joins the existing process and the debug port never opens.

**Verify it works:**
```bash
node setup-session.mjs
# → Connected! The browser has N open context(s).
```

**Register with your agent:**

```bash
# Claude Code (global, works in every project)
claude mcp add -s user image-gen node /absolute/path/to/image-gen/mcp-server.mjs
```

For Claude Desktop, Cursor, or anything else that reads an mcp json config:

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

---

## The generate_image Tool

| Parameter | Type | Description |
|---|---|---|
| `prompt` | string (required) | What to generate. The more specific the better — subject, style, palette, mood, composition. |
| `filename` | string | Output filename without extension. Defaults to `generated_<timestamp>`. |
| `output_dir` | string | Where to save. Defaults to the agent's cwd. |
| `transparent_background` | boolean | Appends "isolated subject, transparent background, no shadow" to the prompt. Use for icons, logos, ui assets. |
| `reference_images` | string[] | Local file paths to attach as visual context before the prompt is sent. See below. |

Returns the absolute path of the saved file.

```jsonc
// Basic hero image
{ "prompt": "rainy city street at night, neon reflections, cinematic, wide shot",
  "filename": "hero", "output_dir": "./public" }

// Transparent icon
{ "prompt": "minimalist calendar icon, thin lines, dark blue",
  "filename": "icon-calendar", "output_dir": "./public/icons",
  "transparent_background": true }

// Variation of something already generated
{ "prompt": "same character but angrier, keep the art style",
  "filename": "mascot-angry", "output_dir": "./public",
  "reference_images": ["./public/mascot.png"] }
```

---

## Tab Reuse and Thread Control

The mcp doesn't open a new chatgpt tab on every call. On each invocation it scans your open browser tabs for the first one on `chatgpt.com` and reuses it, then leaves it open when done.

**What this means in practice:**

- Leave the tab open → all generations go into the same conversation thread. The model has memory of everything it generated earlier in that thread, which matters when you're iterating.
- Close the chatgpt tab → the next call opens a fresh tab to `chatgpt.com`, starting a new conversation.
- Want a specific thread → navigate to that conversation in Edge before calling the tool.

**Collision detection:** When reusing a thread that already has images, the mcp snapshots the `src` of every `img[alt^="Generated image"]` in the dom before sending the prompt. The image detector then only looks at srcs that weren't in that snapshot. So no matter how long the conversation gets, it always picks up the new image and not a previous one.

---

## Reference Images

Pass local file paths in `reference_images` to attach them to the chatgpt composer before the prompt goes in — same as manually dragging a file into the chat. Useful for:

- **Variations** — "same composition, night version"
- **Style transfer** — attach a palette or mood reference and ask to match it
- **Iterative refinement** — generate → save → use as reference → refine → repeat
- **Multi-reference** — attach a sketch, a color swatch, and a style example all at once

```jsonc
{
  "prompt": "refine this, make the lighting warmer and add depth to the background",
  "filename": "scene-v2",
  "reference_images": ["./output/scene-v1.png"]
}
```

If a file path doesn't exist, that file is skipped with a warning and generation continues. Errors in the upload step are non-fatal — the prompt still goes through, just without the attachment.

---

## Using It Automatically with Claude Code

Add this to `~/.claude/CLAUDE.md` so the agent reaches for images without being asked:

```markdown
## Image Generation
When building or editing any website or app, if any visual would improve it —
hero images, illustrations, icons, empty states — call generate_image and wire
the result in. Don't ask first. Save to public/ or assets/. Use
transparent_background: true for anything placed on a colored section. When
iterating on an image, pass the previous version in reference_images.
```

---

## Drawbacks and Known Issues

This approach has real tradeoffs worth knowing about:

**It's slow.** ChatGPT dall-e generation typically takes 15–60 seconds per image. There's a 3-minute hard timeout. If you need fast generation for a tight loop, this isn't the right tool.

**It depends on your browser staying open.** If Edge crashes, gets restarted without the debug flag, or you get logged out of chatgpt, the next call will fail. The error messages are specific enough to tell you what happened.

**The chatgpt dom can change.** The `img[alt^="Generated image"]` selector has been stable across several frontend rewrites, but it's not a contract. If chatgpt ships a big ui overhaul, this might need an update. The fallback chain (network capture → dom scan) covers most cases if the primary selector breaks.

**Rate limits apply.** ChatGPT has per-account generation limits, especially on free plans. Hitting a rate limit shows up as a timeout or refusal, not a clear error message. If generation stops working, check chatgpt manually.

**Reference image uploads depend on the file input selector.** If chatgpt changes how its attachment button works, `page.setInputFiles('input[type="file"]', ...)` might stop finding the input. The upload step is non-fatal so generation still proceeds, but without the attachment.

**One image at a time.** Calls are synchronous. There's no queue or concurrency.

---

## macOS / Linux

No `.bat`, but the setup is identical. Launch with the debug port:

```bash
# macOS (Edge)
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --remote-debugging-port=9222 &

# macOS (Chrome)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 &

# Linux
google-chrome --remote-debugging-port=9222 &
```

Override the port: `IMAGE_GEN_CDP_PORT=9223 node mcp-server.mjs`

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot connect to Edge on port 9222` | Edge isn't running with the debug flag. Run `launch-edge.bat` or add it to your shortcut. Fully close Edge first. |
| `ChatGPT refused` | Prompt hit a content policy. Rephrase it. |
| Timed out after 3 minutes | Check you're still logged into chatgpt. Could also be a rate limit — open chatgpt manually and see if it generates there. |
| MCP uses the wrong thread | It picks the first chatgpt.com tab it finds. Close the tabs you don't want it to use. |
| Reference images not showing up | Paths must be resolvable from the mcp process. Check the console output for "skipping missing" warnings. |
| Previous image returned instead of new one | This is guarded against by the pre-prompt dom snapshot. If it still happens, open an issue with the prompt and thread length. |

---

## License

[MIT](./LICENSE) — not affiliated with OpenAI or Anthropic.
