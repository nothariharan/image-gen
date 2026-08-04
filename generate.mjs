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
import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Port can be overridden with IMAGE_GEN_CDP_PORT (defaults to 9222).
export const CDP_PORT = process.env.IMAGE_GEN_CDP_PORT || "9222";
export const CDP_URL = `http://localhost:${CDP_PORT}`;

/** Dedicated Edge profile — login once here; never mixes with your daily browser. */
export const AUTH_PROFILE_DIR =
  process.env.IMAGE_GEN_PROFILE_DIR || path.join(__dirname, "edge-auth-profile");

/** Cookie/localStorage backup (gitignore). Refresh via: node login-once.mjs */
export const STORAGE_STATE_PATH =
  process.env.IMAGE_GEN_STORAGE_STATE || path.join(__dirname, "chatgpt-storage.json");

const MIN_IMAGE_BYTES = 80 * 1024;   // 80 KB — excludes avatars/icons
const HARD_TIMEOUT_MS = 180_000;     // 3 min absolute ceiling
const SRC_STABLE_MS = 3_000;         // src must be unchanged this long = final
const REFUSAL_MIN_WAIT_MS = 12_000;  // don't honor a refusal read too eagerly
const CDP_LAUNCH_TIMEOUT_MS = 30_000;
const LOGIN_WAIT_MS = 120_000;       // wait for user to finish ChatGPT login once

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isConversationUrl(url) {
  return (
    url.includes("/backend-api/conversation") ||
    url.includes("/backend-api/f/conversation")
  );
}

function isChromeImage(url) {
  return /avatar|profile|favicon|sprite|emoji|sentinel/i.test(url);
}

/** True if Edge/Chrome is already listening on the CDP port. */
export function cdpReady(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(`${CDP_URL}/json/version`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function findEdgeExecutable() {
  const candidates = [
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/**
 * Attach-first: if CDP is already up, do nothing (never kill Edge).
 * Otherwise launch a SECOND Edge instance with the dedicated auth profile.
 * Does NOT taskkill your daily browser.
 */
export async function ensureEdgeWithCdp() {
  if (await cdpReady()) {
    console.error(`[image-gen] Attaching to existing browser on :${CDP_PORT}`);
    return;
  }

  if (process.platform !== "win32") {
    throw new Error(
      `Cannot connect to a browser on port ${CDP_PORT}. ` +
      `Start Chrome/Edge with --remote-debugging-port=${CDP_PORT} --remote-allow-origins=* ` +
      `--user-data-dir=<auth-profile> (see login-once.mjs)`,
    );
  }

  const edge = findEdgeExecutable();
  if (!edge) {
    throw new Error("Microsoft Edge not found. Install Edge, then retry.");
  }

  fs.mkdirSync(AUTH_PROFILE_DIR, { recursive: true });
  console.error(
    `[image-gen] No browser on :${CDP_PORT} — launching dedicated auth profile:\n` +
    `  ${AUTH_PROFILE_DIR}`,
  );

  spawn(
    edge,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${AUTH_PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://chatgpt.com",
    ],
    { detached: true, stdio: "ignore" },
  ).unref();

  const deadline = Date.now() + CDP_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await cdpReady(1000)) {
      console.error("[image-gen] Auth-profile Edge CDP is ready.");
      await sleep(2000);
      return;
    }
    await sleep(400);
  }

  throw new Error(
    `Launched auth-profile Edge but port ${CDP_PORT} never opened.\n` +
    `Run once: node login-once.mjs\n` +
    `Or: ${path.join(__dirname, "launch-edge.bat")}`,
  );
}

/** Inject saved cookies if the live profile has no ChatGPT session yet. */
export async function applyStorageState(context) {
  if (!fs.existsSync(STORAGE_STATE_PATH)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, "utf8"));
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    if (!cookies.length) return false;
    await context.addCookies(cookies);
    console.error(`[image-gen] Applied ${cookies.length} cookie(s) from chatgpt-storage.json`);
    return true;
  } catch (err) {
    console.error(`[image-gen] Could not apply storage state: ${err.message}`);
    return false;
  }
}

/** Persist cookies/localStorage after a successful login. */
export async function saveStorageState(context) {
  try {
    const state = await context.storageState();
    fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
    console.error(`[image-gen] Saved session → ${STORAGE_STATE_PATH}`);
  } catch (err) {
    console.error(`[image-gen] Could not save storage state: ${err.message}`);
  }
}

async function hasChatGptSession(page) {
  const cookies = await page.context().cookies("https://chatgpt.com");
  return cookies.some((c) => /session-token/i.test(c.name));
}

async function promptReady(page) {
  try {
    return (await page.locator("#prompt-textarea").count()) > 0;
  } catch {
    return false;
  }
}

/**
 * ChatGPT often sticks on the "Welcome back / Choose an account" picker.
 * Click the saved account automatically (no password entry).
 */
async function tryClickAccountPicker(page) {
  const preferredEmail =
    process.env.IMAGE_GEN_CHATGPT_EMAIL || "nothariharan@gmail.com";

  const modalVisible = await page
    .getByText(/Choose an account to continue|Welcome back/i)
    .first()
    .isVisible()
    .catch(() => false);

  if (!modalVisible) return false;

  console.error(`[image-gen] Account picker detected — clicking ${preferredEmail}...`);

  // Prefer the known account email.
  const byEmail = page.getByText(preferredEmail, { exact: false }).first();
  if (await byEmail.isVisible().catch(() => false)) {
    await byEmail.click({ timeout: 8_000 }).catch(async () => {
      // Email text may be nested; click its nearest clickable ancestor via JS.
      await page.evaluate((email) => {
        const el = [...document.querySelectorAll("button, [role='button'], a, div")]
          .find((n) => (n.textContent || "").includes(email));
        if (el) el.click();
      }, preferredEmail);
    });
    await sleep(2500);
    return true;
  }

  // Fallback: first visible email-looking account row.
  const anyEmail = page.locator("text=/[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}/").first();
  if (await anyEmail.isVisible().catch(() => false)) {
    console.error("[image-gen] Preferred email not found — clicking first saved account...");
    await anyEmail.click({ timeout: 8_000 }).catch(() => {});
    await sleep(2500);
    return true;
  }

  // Last resort: click a row that looks like the account card ("awe" name, etc.).
  const clicked = await page.evaluate(() => {
    const root = [...document.querySelectorAll("button, [role='button'], div")]
      .find((n) => /@[\\w.-]+\\.[A-Za-z]{2,}/.test(n.textContent || "") && (n.textContent || "").length < 200);
    if (!root) return false;
    root.click();
    return true;
  });
  if (clicked) {
    await sleep(2500);
    return true;
  }

  return false;
}

/**
 * Ensure ChatGPT is logged in. Auto-clicks the account picker when present.
 * Only waits on the user for real password/OAuth flows that need interaction.
 * Saves chatgpt-storage.json after a successful login.
 */
export async function ensureChatGptLoggedIn(page, { waitForManual = true } = {}) {
  const context = page.context();

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  if (!page.url().includes("chatgpt.com")) {
    await page.goto("https://chatgpt.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  // Restore cookies from backup if this profile has no session yet.
  if (!(await hasChatGptSession(page))) {
    const applied = await applyStorageState(context);
    if (applied) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await sleep(1500);
    }
  }

  // Fast path: already logged in with a usable composer.
  if ((await hasChatGptSession(page)) && (await promptReady(page))) {
    await tryClickAccountPicker(page);
    if (await promptReady(page)) {
      await saveStorageState(context);
      return;
    }
  }

  console.error("[image-gen] Ensuring ChatGPT login (auth profile + account-picker)...");
  await tryClickAccountPicker(page);

  if (!(await hasChatGptSession(page)) && !(await promptReady(page))) {
    const needsLogin = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return /log in|sign up|welcome back|choose an account/i.test(text);
    }).catch(() => true);

    if (needsLogin || page.url().includes("/auth/")) {
      if (!page.url().includes("chatgpt.com") || page.url().includes("/auth/login")) {
        await page.goto("https://chatgpt.com", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        }).catch(() => {});
      }
      await tryClickAccountPicker(page);

      if (!(await hasChatGptSession(page)) && !(await promptReady(page))) {
        const stillPicker = await page
          .getByText(/Choose an account to continue|Welcome back/i)
          .first()
          .isVisible()
          .catch(() => false);
        if (!stillPicker) {
          await page.goto("https://chatgpt.com/auth/login", {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          }).catch(() => {});
          await tryClickAccountPicker(page);
        }
      }
    }
  }

  const deadline = Date.now() + (waitForManual ? LOGIN_WAIT_MS : 20_000);
  while (Date.now() < deadline) {
    await tryClickAccountPicker(page);

    if (await hasChatGptSession(page)) {
      if (!page.url().includes("chatgpt.com") || page.url().includes("/auth/")) {
        await page.goto("https://chatgpt.com", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      }
      await tryClickAccountPicker(page);
      const ready = await page
        .waitForSelector("#prompt-textarea", { state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      if (ready) {
        console.error("[image-gen] ChatGPT login ready.");
        await saveStorageState(context);
        return;
      }
    }

    await sleep(1500);
  }

  throw new Error(
    "ChatGPT login did not complete in the dedicated auth profile.\n" +
    `Run once: node ${path.join(__dirname, "login-once.mjs")}\n` +
    "Log in fully in that Edge window, then retry. Session is saved for next time.",
  );
}

export async function generateImage(prompt, outputPath, { transparent = false, referenceImages = [] } = {}) {
  const finalPrompt = transparent
    ? `${prompt}, isolated subject, transparent background, no background, no shadow`
    : prompt;

  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });

  await ensureEdgeWithCdp();

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    throw new Error(
      `Cannot connect to Edge on port ${CDP_PORT} even after auto-launch.\n` +
      `Run once: node ${path.join(__dirname, "login-once.mjs")}`,
    );
  }

  // Reuse an existing open ChatGPT tab if one is available; otherwise open a new one.
  let page = null;
  let needsNavigation = false;
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes("chatgpt.com")) {
        page = p;
        break;
      }
    }
    if (page) break;
  }
  if (!page) {
    const contexts = browser.contexts();
    const context = contexts.length ? contexts[0] : await browser.newContext();
    page = await context.newPage();
    needsNavigation = true;
  }

  await ensureChatGptLoggedIn(page);

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
    if (needsNavigation) {
      console.error("[image-gen] Opening ChatGPT...");
      await page.goto("https://chatgpt.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
    } else {
      console.error(`[image-gen] Reusing existing ChatGPT tab (${page.url()})...`);
    }
    await page.waitForSelector("#prompt-textarea", { state: "visible", timeout: 20_000 });

    // Snapshot every generated-image src already in the DOM before we send the prompt.
    // The detector will ignore these and only surface images that appear after this point.
    const existingImageSrcs = new Set(await page.evaluate(() =>
      [...document.querySelectorAll('img[alt^="Generated image"]')]
        .map(el => el.currentSrc || el.src)
        .filter(Boolean)
    ));
    console.error(`[image-gen] Found ${existingImageSrcs.size} pre-existing image(s) in thread — will ignore them.`);

    // Attach reference images BEFORE typing the prompt so ChatGPT sees them as context.
    if (referenceImages.length > 0) {
      await uploadReferenceImages(page, referenceImages);
    }

    promptSentAt = Date.now();
    listening = true;

    console.error("[image-gen] Sending prompt...");
    await page.click("#prompt-textarea");
    await page.keyboard.type(finalPrompt, { delay: 12 });
    await page.keyboard.press("Enter");

    console.error("[image-gen] Waiting for generated image (up to 3 min)...");
    const deadline = Date.now() + HARD_TIMEOUT_MS;

    // PRIMARY: wait for img[alt^="Generated image"] whose src has stabilized
    // AND whose src was not present before we sent the prompt.
    const stableSrc = await waitForStableGeneratedImage(page, deadline, existingImageSrcs, () => {
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
    // Tab stays open — the user controls which chat thread to reuse vs. start fresh.
  }
}

/**
 * Attaches local image files to the ChatGPT composer as visual references.
 * Uses the hidden file input that backs ChatGPT's attachment button.
 * Missing files are skipped with a warning; errors are non-fatal.
 */
async function uploadReferenceImages(page, imagePaths) {
  const validPaths = imagePaths
    .map(p => path.resolve(p))
    .filter(p => {
      if (!fs.existsSync(p)) {
        console.error(`[image-gen] Skipping missing reference image: ${p}`);
        return false;
      }
      return true;
    });

  if (!validPaths.length) return;

  console.error(`[image-gen] Attaching ${validPaths.length} reference image(s)...`);

  // Baseline: count blob-URL previews already on screen so we can detect new ones.
  const beforeCount = await page.evaluate(() =>
    document.querySelectorAll('img[src^="blob:"]').length
  );

  try {
    await page.setInputFiles('input[type="file"]', validPaths);
  } catch (err) {
    console.error(`[image-gen] Warning: could not attach reference images — ${err.message}. Proceeding without them.`);
    return;
  }

  // Wait for attachment thumbnails to appear (blob: previews rendered by ChatGPT's JS).
  const deadline = Date.now() + 10_000;
  let confirmed = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    const afterCount = await page.evaluate(() =>
      document.querySelectorAll('img[src^="blob:"]').length
    );
    if (afterCount > beforeCount) {
      confirmed = true;
      break;
    }
  }

  if (confirmed) {
    console.error("[image-gen] Reference images attached and previewing in composer.");
  } else {
    console.error("[image-gen] Warning: attachment previews did not appear — proceeding anyway.");
  }
}

/**
 * Polls for a NEW <img alt="Generated image…"> (one whose src was not in
 * existingImageSrcs before the prompt was sent) and returns its src once it
 * has remained unchanged for SRC_STABLE_MS (defeats the preview→final swap).
 * Calls onTick each poll so callers can bail on refusal.
 */
async function waitForStableGeneratedImage(page, deadline, existingImageSrcs, onTick) {
  let lastSrc = null;
  let stableSince = 0;
  const existingArr = [...existingImageSrcs]; // serialisable for page.evaluate

  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    if (onTick) onTick();

    const src = await page.evaluate((existingSrcs) => {
      const imgs = [...document.querySelectorAll('img[alt^="Generated image"]')];
      // Only consider images that weren't present before the prompt was sent.
      const newImgs = imgs.filter(el => {
        const s = el.currentSrc || el.src;
        return s && !existingSrcs.includes(s);
      });
      if (!newImgs.length) return null;
      const el = newImgs[newImgs.length - 1];
      return el.currentSrc || el.src || null;
    }, existingArr);

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
