/**
 * login-once.mjs — one-time setup for persistent ChatGPT auth.
 *
 * 1. Launches (or attaches to) the dedicated Edge auth profile on CDP 9222
 * 2. Opens chatgpt.com and waits until you finish logging in
 * 3. Saves chatgpt-storage.json + leaves the profile cookies intact
 *
 * Usage:
 *   node login-once.mjs
 *
 * After this succeeds once, generate_image should stay logged in.
 */

import { chromium } from "playwright-core";
import {
  AUTH_PROFILE_DIR,
  STORAGE_STATE_PATH,
  CDP_PORT,
  ensureEdgeWithCdp,
  ensureChatGptLoggedIn,
  saveStorageState,
} from "./generate.mjs";

console.log("=== image-gen one-time login ===\n");
console.log(`Auth profile:  ${AUTH_PROFILE_DIR}`);
console.log(`Storage file:  ${STORAGE_STATE_PATH}`);
console.log(`CDP port:      ${CDP_PORT}`);
console.log("");
console.log("A dedicated Edge window will open (your daily Edge is left alone).");
console.log("Log into ChatGPT fully there (account picker / Google / password).");
console.log("This script waits until the chat composer is ready, then saves the session.\n");

await ensureEdgeWithCdp();

const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
let page = null;
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
  const ctx = browser.contexts()[0] || (await browser.newContext());
  page = await ctx.newPage();
  await page.goto("https://chatgpt.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
}

try {
  await page.bringToFront();
} catch {
  /* ignore */
}

await ensureChatGptLoggedIn(page, { waitForManual: true });
await saveStorageState(page.context());

console.log("\nSUCCESS — session saved.");
console.log("You can close this terminal. Leave the auth-profile Edge open, or let the MCP relaunch it later.");
console.log("Do NOT delete the edge-auth-profile folder or chatgpt-storage.json.\n");
process.exit(0);
