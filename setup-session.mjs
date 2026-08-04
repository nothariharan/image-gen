/**
 * setup-session.mjs — verifies the auth-profile browser is reachable via CDP.
 *
 * Usage: node setup-session.mjs
 */

import { chromium } from "playwright-core";
import {
  AUTH_PROFILE_DIR,
  STORAGE_STATE_PATH,
  CDP_PORT,
  CDP_URL,
  cdpReady,
  ensureEdgeWithCdp,
} from "./generate.mjs";
import fs from "fs";

console.log(`Auth profile: ${AUTH_PROFILE_DIR}`);
console.log(`Storage file: ${STORAGE_STATE_PATH} (${fs.existsSync(STORAGE_STATE_PATH) ? "present" : "missing — run login-once.mjs"})`);
console.log(`Testing CDP on port ${CDP_PORT}...\n`);

if (!(await cdpReady())) {
  console.log("No browser on CDP — launching dedicated auth profile...");
  try {
    await ensureEdgeWithCdp();
  } catch (err) {
    console.error(`FAILED — ${err.message}\n`);
    process.exit(1);
  }
}

let browser;
try {
  browser = await chromium.connectOverCDP(CDP_URL);
} catch {
  console.error(`FAILED — could not connect to ${CDP_URL}\n`);
  process.exit(1);
}

const contexts = browser.contexts();
console.log(`Connected! The browser has ${contexts.length} open context(s).`);
console.log("If ChatGPT asks you to log in, run: node login-once.mjs");
console.log("The image-gen MCP is ready to use.\n");
process.exit(0);
