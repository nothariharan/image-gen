---
name: chatgpt-image-gen
description: >-
  Generate clean professional website and app image assets through the
  image-gen MCP (a real logged-in ChatGPT session in Edge or Chrome). Use when
  the user invokes /chatgpt-image-gen, @chatgpt-image-gen, or attaches this
  skill, or asks for ChatGPT image assets, image-gen, or generate_image.
  Agents often skip the MCP and use a built-in image tool; this skill is the
  explicit path that forces generate_image and saves a real PNG into the project.
disable-model-invocation: true
---

# ChatGPT image-gen

## Why this skill exists

Installing the image-gen MCP is not enough. Agents often ignore it and call a built-in image tool instead. Invoking this skill (`/chatgpt-image-gen` or `@chatgpt-image-gen`) is how a person gets the agent to use their logged-in ChatGPT session and drop a real PNG into the project.

## Hard rules

1. **NEVER** call Cursor's built-in `GenerateImage` tool, or any other built-in image generator.
2. **ALWAYS** call the image-gen MCP tool `generate_image`.
   - Cursor usually exposes the server as `user-image-gen` when `mcp.json` uses the key `image-gen`.
   - Claude Code and Claude Desktop usually expose it as `image-gen`.
   - Discover the tool first, then call `generate_image` on that server.
3. If that MCP is unavailable, stop and tell the user. Do not fall back to a built-in image tool. Point them at the image-gen README: clone the repo, `npm install`, `npm run login`, register the MCP, and install this skill.

## Transparency / "black background" (do not loop)

ChatGPT transparent PNGs often have a **soft gray shadow only at the bottom**. Dark IDE themes also make real alpha look black. That is **not** a baked-in solid background.

After every `generate_image` call:

1. Read the returned `TRANSPARENCY_REPORT` and `verdict`.
2. Prefer the **checkerboard preview** path (`.preview.png`) when judging transparency.
3. **DO NOT regenerate** when:
   - verdict is `TRANSPARENT_OK`, or
   - the only problem is a soft bottom gradient / dark look in the IDE, or
   - ChatGPT's card chrome shows Edit/share with a shadow under the image.
4. **ONLY** regenerate for background if verdict is `OPAQUE_BAKED_BACKGROUND` (or the subject itself is wrong).

## How to generate

1. Discover/confirm the image-gen server and its `generate_image` tool.
2. Call it with:
   - `prompt` — detailed English image prompt (subject, style, palette, composition, intended UI use)
   - `filename` — kebab-case name, no extension
   - `output_dir` — absolute path to the project's `public/`, `assets/`, or similar
   - `transparent_background` — `true` for icons, logos, and UI marks
   - `reference_images` — optional absolute paths when the user wants a variation of an existing file
3. Embed the returned **asset** path (not the `.preview.png`) in the project.
4. Verify the PNG exists on disk before claiming success.

## Auth

- Dedicated Edge (or Chrome) profile `edge-auth-profile` + attach-first on port 9222. This does not touch the daily browser.
- Auto-clicks **Welcome back / Choose an account**.
- Restores and saves `chatgpt-storage.json`.
- If login is missing, tell the user to run `npm run login` once inside the image-gen repo (the folder that contains `mcp-server.mjs`).

## Prompting tips

- One asset per call. Multiple assets means multiple `generate_image` calls. The MCP queues them.
- Prefer awaiting one image before starting the next when possible — faster feedback if something fails.
- Include subject, style, palette, composition, and intended UI use.
- Save under the active project's static asset folder so paths work in the site.
