/**
 * setup-session.mjs — verifies the browser is reachable via CDP.
 * Run this once to confirm everything is wired up before using the MCP.
 *
 * Usage: node setup-session.mjs
 */

import { chromium } from "playwright-core";

const CDP_PORT = process.env.IMAGE_GEN_CDP_PORT || "9222";
const CDP_URL = `http://localhost:${CDP_PORT}`;

console.log(`Testing connection to the browser on port ${CDP_PORT}...\n`);

let browser;
try {
  browser = await chromium.connectOverCDP(CDP_URL);
} catch {
  console.error(`FAILED — no browser is listening on --remote-debugging-port=${CDP_PORT}.\n`);
  console.error("Fix options:\n");
  console.error("  Quick:     close Edge, then double-click launch-edge.bat in this folder");
  console.error("  Permanent: add  --remote-debugging-port=" + CDP_PORT + "  to your Edge");
  console.error("             shortcut's Target, then relaunch Edge.\n");
  process.exit(1);
}

const contexts = browser.contexts();
console.log(`Connected! The browser has ${contexts.length} open context(s).`);
console.log("Make sure you are logged in to chatgpt.com in that browser.");
console.log("The image-gen MCP is ready to use.\n");
process.exit(0);
