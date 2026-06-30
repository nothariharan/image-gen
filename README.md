<div align="center">
  <img src="assets/logo.png" width="140" alt="image-gen logo" />
  <h1>image-gen</h1>
  <p>an mcp server that gives your ai agent a paintbrush — no api key required</p>
</div>

---

it drives your own already-logged-in browser to chatgpt.com, types the prompt, waits for dall-e to finish, and downloads the exact png to disk. that's it. your agent gets image generation for free because it's borrowing the chatgpt session you already have open.

the reason this exists: every other image generation integration wants an openai api key and burns through credits. this one doesn't. if you're logged into chatgpt in your browser, your agent can generate images — hero banners, icons, illustrations, whatever — and wire them directly into the project it's building.

---

## how it actually works

playwright connects to your real running browser over the chrome devtools protocol (port 9222). it finds your existing chatgpt tab or opens a new one, types the prompt, and waits for `img[alt^="Generated image"]` to appear and stabilize. that selector is semantic and has held up across several chatgpt frontend rewrites. once the image src stops changing for 3 seconds (defeats the preview→final resolution swap), it fetches the signed url from inside the page — the signature in the url makes it self-authorizing, no bearer token needed.

**fallback chain:**
1. wait for `img[alt^="Generated image"]` src to stabilize → fetch it from inside the page
2. largest `image/*` network response captured during generation (≥ 80kb, already auth'd by your session)
3. newest large `<img>` on the page

it also parses the `/backend-api/conversation` stream just enough to catch refusals so it fails fast instead of hanging for 3 minutes.

why not just call the openai api directly? a few reasons: no key needed, it uses your existing chatgpt plan (including plus/pro quality), and driving a real browser sidesteps bot detection entirely. the tradeoff is that it's slower and depends on your browser staying open.

---

## requirements

- node 18+
- microsoft edge or chrome, running with `--remote-debugging-port=9222`
- a chatgpt account, logged in in that browser
- windows for the `launch-edge.bat` helper (mac/linux works fine, just launch the browser yourself)

---

## setup

**clone and install:**

```bash
git clone https://github.com/nothariharan/image-gen.git
cd image-gen
npm install
```

**start edge with remote debugging:**

the easiest way on windows is to double-click `launch-edge.bat`. it closes any running edge instance and relaunches it with the debug port enabled, restoring your existing tabs.

if you want it permanently, edit your edge shortcut target:
```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
```

fully close edge first — if edge is already running without the flag, opening a new window just joins the existing process and the debug port never opens.

**verify it works:**
```bash
node setup-session.mjs
# → Connected! The browser has N open context(s).
```

**register with your agent:**

```bash
# claude code (global, works in every project)
claude mcp add -s user image-gen node /absolute/path/to/image-gen/mcp-server.mjs
```

for claude desktop, cursor, or anything else that reads an mcp json config:

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

## the generate_image tool

| parameter | type | description |
|---|---|---|
| `prompt` | string (required) | what to generate. the more specific the better — subject, style, palette, mood, composition. |
| `filename` | string | output filename without extension. defaults to `generated_<timestamp>`. |
| `output_dir` | string | where to save. defaults to the agent's cwd. |
| `transparent_background` | boolean | appends "isolated subject, transparent background, no shadow" to the prompt. use for icons, logos, ui assets. |
| `reference_images` | string[] | local file paths to attach as visual context before the prompt is sent. see below. |

returns the absolute path of the saved file.

```jsonc
// basic hero image
{ "prompt": "rainy city street at night, neon reflections, cinematic, wide shot",
  "filename": "hero", "output_dir": "./public" }

// transparent icon
{ "prompt": "minimalist calendar icon, thin lines, dark blue",
  "filename": "icon-calendar", "output_dir": "./public/icons",
  "transparent_background": true }

// variation of something already generated
{ "prompt": "same character but angrier, keep the art style",
  "filename": "mascot-angry", "output_dir": "./public",
  "reference_images": ["./public/mascot.png"] }
```

---

## tab reuse and thread control

the mcp doesn't open a new chatgpt tab on every call. on each invocation it scans your open browser tabs for the first one on `chatgpt.com` and reuses it, then leaves it open when done.

**what this means in practice:**

- leave the tab open → all generations go into the same conversation thread. the model has memory of everything it generated earlier in that thread, which matters when you're iterating.
- close the chatgpt tab → the next call opens a fresh tab to `chatgpt.com`, starting a new conversation.
- want a specific thread → navigate to that conversation in edge before calling the tool.

**collision detection:** when reusing a thread that already has images, the mcp snapshots the `src` of every `img[alt^="Generated image"]` in the dom before sending the prompt. the image detector then only looks at srcs that weren't in that snapshot. so no matter how long the conversation gets, it always picks up the new image and not a previous one.

---

## reference images

pass local file paths in `reference_images` to attach them to the chatgpt composer before the prompt goes in — same as manually dragging a file into the chat. useful for:

- **variations** — "same composition, night version"
- **style transfer** — attach a palette or mood reference and ask to match it
- **iterative refinement** — generate → save → use as reference → refine → repeat
- **multi-reference** — attach a sketch, a color swatch, and a style example all at once

```jsonc
{
  "prompt": "refine this, make the lighting warmer and add depth to the background",
  "filename": "scene-v2",
  "reference_images": ["./output/scene-v1.png"]
}
```

if a file path doesn't exist, that file is skipped with a warning and generation continues. errors in the upload step are non-fatal — the prompt still goes through, just without the attachment.

---

## using it automatically with claude code

add this to `~/.claude/CLAUDE.md` so the agent reaches for images without being asked:

```markdown
## image generation
when building or editing any website or app, if any visual would improve it —
hero images, illustrations, icons, empty states — call generate_image and wire
the result in. don't ask first. save to public/ or assets/. use
transparent_background: true for anything placed on a colored section. when
iterating on an image, pass the previous version in reference_images.
```

---

## drawbacks and known issues

this approach has real tradeoffs worth knowing about:

**it's slow.** chatgpt dall-e generation typically takes 15–60 seconds per image. there's a 3-minute hard timeout. if you need fast generation for a tight loop, this isn't the right tool.

**it depends on your browser staying open.** if edge crashes, gets restarted without the debug flag, or you get logged out of chatgpt, the next call will fail. the error messages are specific enough to tell you what happened.

**the chatgpt dom can change.** the `img[alt^="Generated image"]` selector has been stable across several frontend rewrites, but it's not a contract. if chatgpt ships a big ui overhaul, this might need an update. the fallback chain (network capture → dom scan) covers most cases if the primary selector breaks.

**rate limits apply.** chatgpt has per-account generation limits, especially on free plans. hitting a rate limit shows up as a timeout or refusal, not a clear error message. if generation stops working, check chatgpt manually.

**reference image uploads depend on the file input selector.** if chatgpt changes how its attachment button works, `page.setInputFiles('input[type="file"]', ...)` might stop finding the input. the upload step is non-fatal so generation still proceeds, but without the attachment.

**one image at a time.** calls are synchronous. there's no queue or concurrency.

---

## macos / linux

no `.bat`, but the setup is identical. launch with the debug port:

```bash
# macos (edge)
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --remote-debugging-port=9222 &

# macos (chrome)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 &

# linux
google-chrome --remote-debugging-port=9222 &
```

override the port: `IMAGE_GEN_CDP_PORT=9223 node mcp-server.mjs`

---

## troubleshooting

| symptom | fix |
|---|---|
| `cannot connect to edge on port 9222` | edge isn't running with the debug flag. run `launch-edge.bat` or add it to your shortcut. fully close edge first. |
| `chatgpt refused` | prompt hit a content policy. rephrase it. |
| timed out after 3 minutes | check you're still logged into chatgpt. could also be a rate limit — open chatgpt manually and see if it generates there. |
| mcp uses the wrong thread | it picks the first chatgpt.com tab it finds. close the tabs you don't want it to use. |
| reference images not showing up | paths must be resolvable from the mcp process. check the console output for "skipping missing" warnings. |
| previous image returned instead of new one | this is guarded against by the pre-prompt dom snapshot. if it still happens, open an issue with the prompt and thread length. |

---

## license

[mit](./LICENSE) — not affiliated with openai or anthropic.
