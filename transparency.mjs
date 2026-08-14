/**
 * transparency.mjs — analyze PNG alpha and build a checkerboard preview.
 *
 * Agents often hallucinate a "baked-in black background" when:
 *   1. ChatGPT adds a faint soft drop-shadow / bottom vignette on transparent art
 *   2. Cursor/IDE dark theme composites transparent pixels as black
 *   3. ChatGPT's image card UI casts a gray gradient under the preview
 *
 * This module measures real alpha and writes a light checkerboard preview so
 * vision models can confirm transparency without that trap.
 */

import fs from "fs";
import path from "path";
import { PNG } from "pngjs";

const CHECKER = 12;

/**
 * @param {string|Buffer} bufOrPath
 * @returns {{
 *   width: number,
 *   height: number,
 *   hasAlpha: boolean,
 *   totalPixels: number,
 *   transparentPixels: number,
 *   transparentRatio: number,
 *   fullyTransparentRatio: number,
 *   opaqueDarkRatio: number,
 *   softBottomVignette: boolean,
 *   bakedOpaqueDarkBackground: boolean,
 *   verdict: 'TRANSPARENT_OK' | 'OPAQUE_BAKED_BACKGROUND' | 'OPAQUE_OR_NO_ALPHA' | 'MIXED',
 * }}
 */
export function inspectPngTransparency(bufOrPath) {
  const buf = Buffer.isBuffer(bufOrPath) ? bufOrPath : fs.readFileSync(bufOrPath);
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  const total = width * height;

  let transparent = 0;
  let fullyTransparent = 0;
  let opaqueDark = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (a < 250) transparent++;
    if (a < 16) fullyTransparent++;
    if (a >= 250 && r < 28 && g < 28 && b < 28) opaqueDark++;
  }

  const transparentRatio = transparent / total;
  const fullyTransparentRatio = fullyTransparent / total;
  const opaqueDarkRatio = opaqueDark / total;
  const softBottomVignette = detectSoftBottomVignette(data, width, height);
  const hasAlphaChannel = png.colorType === 4 || png.colorType === 6;
  const usesTransparency = transparentRatio >= 0.05 || fullyTransparentRatio >= 0.03;
  const hasAlpha = hasAlphaChannel && usesTransparency;

  // Real baked black plate: most of the canvas is opaque near-black (not just a soft edge).
  const bakedOpaqueDarkBackground =
    opaqueDarkRatio >= 0.35 && fullyTransparentRatio < 0.08 && transparentRatio < 0.2;

  let verdict = "MIXED";
  if (bakedOpaqueDarkBackground) {
    verdict = "OPAQUE_BAKED_BACKGROUND";
  } else if (usesTransparency) {
    verdict = "TRANSPARENT_OK";
  } else if (softBottomVignette && opaqueDarkRatio < 0.15) {
    // Soft bottom band only — treat as OK even if alpha decode is conservative.
    verdict = "TRANSPARENT_OK";
  } else if (!usesTransparency) {
    verdict = "OPAQUE_OR_NO_ALPHA";
  }

  return {
    width,
    height,
    hasAlpha,
    totalPixels: total,
    transparentPixels: transparent,
    transparentRatio,
    fullyTransparentRatio,
    opaqueDarkRatio,
    softBottomVignette,
    bakedOpaqueDarkBackground,
    verdict,
  };
}

/** Soft semi-transparent dark band only near the bottom — normal ChatGPT drop shadow, not a fill. */
function detectSoftBottomVignette(data, width, height) {
  const band = Math.max(4, Math.floor(height * 0.08));
  let soft = 0;
  let samples = 0;
  for (let y = height - band; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      samples++;
      if (a > 8 && a < 220 && lum < 90) soft++;
    }
  }
  // Top band should be much clearer if this is only a bottom vignette.
  let topSoft = 0;
  for (let y = 0; y < band; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (a > 8 && a < 220 && lum < 90) topSoft++;
    }
  }
  return soft / samples >= 0.04 && soft > topSoft * 2;
}

/**
 * Composite RGBA PNG onto a light gray/white checkerboard so vision models
 * can see true transparency (won't look like a black plate in dark IDEs).
 * @returns {string} preview path
 */
export function writeCheckerboardPreview(srcPath, destPath = null) {
  const src = PNG.sync.read(fs.readFileSync(srcPath));
  const out = new PNG({ width: src.width, height: src.height, colorType: 6 });

  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      const a = src.data[i + 3] / 255;
      const cell = ((Math.floor(x / CHECKER) + Math.floor(y / CHECKER)) % 2 === 0) ? 235 : 255;
      out.data[i] = Math.round(src.data[i] * a + cell * (1 - a));
      out.data[i + 1] = Math.round(src.data[i + 1] * a + cell * (1 - a));
      out.data[i + 2] = Math.round(src.data[i + 2] * a + cell * (1 - a));
      out.data[i + 3] = 255;
    }
  }

  const previewPath =
    destPath ||
    (() => {
      const ext = path.extname(srcPath);
      const base = srcPath.slice(0, -ext.length);
      return `${base}.preview.png`;
    })();

  fs.writeFileSync(previewPath, PNG.sync.write(out));
  return previewPath;
}

/**
 * Human + agent-facing report. Call after every successful generate_image.
 */
export function buildTransparencyReport(assetPath, { wantedTransparent = false } = {}) {
  const report = inspectPngTransparency(assetPath);
  let previewPath = null;
  if (report.hasAlpha || wantedTransparent || report.verdict === "TRANSPARENT_OK") {
    try {
      previewPath = writeCheckerboardPreview(assetPath);
    } catch (err) {
      console.error(`[image-gen] Preview write failed: ${err.message}`);
    }
  }

  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `Image saved to: ${assetPath}`,
    previewPath ? `Checkerboard preview (USE THIS to verify transparency): ${previewPath}` : null,
    "",
    "TRANSPARENCY_REPORT:",
    `- verdict: ${report.verdict}`,
    `- size: ${report.width}x${report.height}`,
    `- has_alpha: ${report.hasAlpha}`,
    `- transparent_pixels: ${pct(report.transparentRatio)}`,
    `- fully_transparent_pixels: ${pct(report.fullyTransparentRatio)}`,
    `- opaque_near_black_pixels: ${pct(report.opaqueDarkRatio)}`,
    `- soft_bottom_vignette_detected: ${report.softBottomVignette}`,
    "",
    "ANTI-HALLUCINATION (read before regenerating):",
    "- A soft gray/black gradient ONLY at the bottom edge is normal (ChatGPT drop-shadow / card chrome).",
    "  It does NOT mean the asset has a baked-in solid black background.",
    "- Transparent pixels often look black in a dark IDE theme. That is the viewer, not the file.",
    "- Checkerboard in the preview = real transparency. Trust the verdict + preview, not a dark plate illusion.",
    "- DO NOT call generate_image again for soft bottom shadow alone.",
    report.verdict === "OPAQUE_BAKED_BACKGROUND"
      ? "- Verdict is OPAQUE_BAKED_BACKGROUND — a real opaque dark fill was measured; regenerate with transparent_background=true if you need cutout."
      : "- Verdict is NOT a baked black background — keep this asset unless the subject itself is wrong.",
  ].filter((x) => x !== null);

  return { assetPath, previewPath, report, text: lines.join("\n") };
}
