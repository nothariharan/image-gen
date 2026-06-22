/**
 * generate.mjs — robust ChatGPT image generation over an attached Edge (CDP).
 *
 * Strategy (grounded in ChatGPT's actual 2026 DOM):
 *   The finished image renders as:
 *     <img alt="Generated image: ..." src="https://chatgpt.com/backend-api/estuary/content?id=file_...&sig=...">
 *   - alt^="Generated image"  -> stable SEMANTIC selector (not a fragile class)
 *   - src is a SIGNED url (the `sig` query param authorizes it), so it can be
 *     fetched directly from inside the page with no bearer-token handling.
 *
 *   PRIMARY: wait for that <img> to appear, wait until its src STOPS CHANGING
 *     (defeats the preview->final-resolution swap), then fetch the exact src.
 *   FALLBACK 1: image bytes captured at the network level (already authed).
 *   FALLBACK 2: newest large <img> on the page.
 *
 *   The /backend-api/conversation stream is parsed ONLY to detect an explicit
 *   refusal so we can fail fast. ChatGPT fires several conversation POSTs per
 *   turn, so "a stream finished" is never treated as "generation finished".
 */

import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Port can be overridden with IMAGE_GEN_CDP_PORT (defaults to 9222).
const CDP_PORT = process.env.IMAGE_GEN_CDP_PORT || "9222";
const CDP_URL = `http://localhost:${CDP_PORT}`;

const MIN_IMAGE_BYTES = 80 * 1024;   // 80 KB — excludes avatars/icons
const HARD_TIMEOUT_MS = 180_000;     // 3 min absolute ceiling
const SRC_STABLE_MS = 3_000;         // src must be unchanged this long = final
const REFUSAL_MIN_WAIT_MS = 12_000;  // don't honor a refusal read too eagerly

function isConversationUrl(url) {
  return (
    url.includes("/backend-api/conversation") ||
    url.includes("/backend-api/f/conversation")
  );
}

function isChromeImage(url) {
  return /avatar|profile|favicon|sprite|emoji|sentinel/i.test(url);
}

export async function generateImage(prompt, outputPath, { transparent = false } = {}) {
  const finalPrompt = transparent
    ? `${prompt}, isolated subject, transparent background, no background, no shadow`
    : prompt;

  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    throw new Error(
      `Cannot connect to Edge on port ${CDP_PORT}.\n` +
      `Run the launcher: ${path.join(__dirname, "launch-edge.bat")}\n` +
      `(or start Edge/Chrome yourself with --remote-debugging-port=${CDP_PORT})`
    );
  }

  const contexts = browser.contexts();
  const context = contexts.length ? contexts[0] : await browser.newContext();
  const page = await context.newPage();

  /** @type {{url: string, buf: Buffer, at: number}[]} */
  const images = [];          // network-captured image bytes (fallback)
  let listening = false;
  let promptSentAt = 0;
  let refusal = null;

  const onResponse = async (resp) => {
    if (!listening) return;
    const url = resp.url();

    // Parse conversation streams ONLY for refusal detection.
    if (isConversationUrl(url) && resp.request().method() === "POST") {
      try {
        const text = await resp.text();
        const hasImage = /image_asset_pointer|estuary\/content|"content_type"\s*:\s*"image/.test(text);
        if (hasImage) {
          refusal = null;
        } else {
          const m = text.match(
            /(I can't[^"\\]{0,140}|I'm not able to[^"\\]{0,140}|can't (?:create|generate)[^"\\]{0,140}|violates[^"\\]{0,140}|content polic[^"\\]{0,140})/i
          );
          if (m) refusal = m[0];
        }
      } catch { /* ignore */ }
      return;
    }

    // Fallback channel: capture real image bytes.
    const ct = (resp.headers()["content-type"] || "").toLowerCase();
    if (ct.startsWith("image/") && !ct.includes("svg") && !isChromeImage(url)) {
      try {
        const buf = await resp.body();
        if (buf.length >= MIN_IMAGE_BYTES) images.push({ url, buf, at: Date.now() });
      } catch { /* ignore */ }
    }
  };

  page.on("response", onResponse);

  try {
    console.error("[image-gen] Opening ChatGPT...");
    await page.goto("https://chatgpt.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("#prompt-textarea", { state: "visible", timeout: 20_000 });

    promptSentAt = Date.now();
    listening = true;

    console.error("[image-gen] Sending prompt...");
    await page.click("#prompt-textarea");
    await page.keyboard.type(finalPrompt, { delay: 12 });
    await page.keyboard.press("Enter");

    console.error("[image-gen] Waiting for generated image (up to 3 min)...");
    const deadline = Date.now() + HARD_TIMEOUT_MS;

    // PRIMARY: wait for img[alt^="Generated image"] whose src has stabilized.
    const stableSrc = await waitForStableGeneratedImage(page, deadline, () => {
      if (refusal && Date.now() - promptSentAt > REFUSAL_MIN_WAIT_MS) {
        throw new Error(`ChatGPT refused: ${refusal.trim()}`);
      }
    });

    if (stableSrc) {
      console.error("[image-gen] Final image src settled. Fetching exact image...");
      const buf = await fetchInPage(page, stableSrc);
      if (buf && buf.length >= MIN_IMAGE_BYTES) {
        assertValidImage(buf);
        fs.writeFileSync(resolvedOutput, buf);
        console.error(`[image-gen] Saved ${(buf.length / 1024).toFixed(0)} KB -> ${resolvedOutput}`);
        return resolvedOutput;
      }
      // If direct fetch failed, try to match captured bytes by file id.
      const fileId = (stableSrc.match(/id=(file[_-][A-Za-z0-9]+)/) || [])[1];
      if (fileId) {
        const match = images.find((i) => i.url.includes(fileId));
        if (match) {
          assertValidImage(match.buf);
          fs.writeFileSync(resolvedOutput, match.buf);
          console.error(`[image-gen] Saved (matched id) ${(match.buf.length/1024).toFixed(0)} KB -> ${resolvedOutput}`);
          return resolvedOutput;
        }
      }
    }

    // FALLBACK 1: largest captured image after the prompt.
    const fresh = images.filter((i) => i.at >= promptSentAt);
    if (fresh.length) {
      const best = fresh.reduce((a, b) => (b.buf.length > a.buf.length ? b : a));
      assertValidImage(best.buf);
      fs.writeFileSync(resolvedOutput, best.buf);
      console.error(`[image-gen] Saved (captured) ${(best.buf.length/1024).toFixed(0)} KB -> ${resolvedOutput}`);
      return resolvedOutput;
    }

    // FALLBACK 2: any newest large <img>.
    const domBuf = await tryDomFallback(page);
    if (domBuf) {
      assertValidImage(domBuf);
      fs.writeFileSync(resolvedOutput, domBuf);
      console.error(`[image-gen] Saved (dom fallback) -> ${resolvedOutput}`);
      return resolvedOutput;
    }

    throw new Error(
      refusal ? `ChatGPT refused: ${refusal.trim()}` : "Timed out: no image produced within 3 minutes."
    );
  } finally {
    page.off("response", onResponse);
    await page.close(); // close just this tab — Edge stays open
  }
}

/**
 * Polls for the newest <img alt="Generated image…"> and returns its src once
 * that src has remained unchanged for SRC_STABLE_MS (i.e. the final, not the
 * preview). Calls onTick each poll so callers can bail on refusal.
 */
async function waitForStableGeneratedImage(page, deadline, onTick) {
  let lastSrc = null;
  let stableSince = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    if (onTick) onTick();

    const src = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img[alt^="Generated image"]')];
      if (!imgs.length) return null;
      const el = imgs[imgs.length - 1];
      return el.currentSrc || el.src || null;
    });

    if (!src) continue;

    if (src === lastSrc) {
      if (Date.now() - stableSince >= SRC_STABLE_MS) return src;
    } else {
      lastSrc = src;
      stableSince = Date.now();
    }
  }
  return lastSrc; // best effort if we hit the deadline mid-stability
}

/** Fetch a URL from inside the page (signed estuary URLs are self-authorizing). */
async function fetchInPage(page, url) {
  try {
    const dataUrl = await page.evaluate(async (u) => {
      const r = await fetch(u);
      if (!r.ok) return null;
      const blob = await r.blob();
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.readAsDataURL(blob);
      });
    }, url);
    if (!dataUrl) return null;
    return Buffer.from(String(dataUrl).split(",")[1], "base64");
  } catch {
    return null;
  }
}

/** Grab the newest large <img> and fetch it from inside the page. */
async function tryDomFallback(page) {
  const src = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll("img")]
      .filter((i) => i.naturalWidth >= 256 && i.naturalHeight >= 256);
    return imgs.length ? imgs[imgs.length - 1].src : null;
  });
  if (!src) return null;
  const buf = await fetchInPage(page, src);
  return buf && buf.length >= MIN_IMAGE_BYTES ? buf : null;
}

/** Throw if the buffer is not a PNG/JPEG/WebP raster. */
function assertValidImage(buf) {
  const isPng = buf.slice(0, 8).toString("hex") === "89504e470d0a1a0a";
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isWebp =
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP";
  if (!isPng && !isJpeg && !isWebp) {
    throw new Error("Captured data is not a valid image (corrupt or wrong response).");
  }
}
