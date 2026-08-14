/**
 * mcp-server.mjs — MCP server entry point
 * Exposes the generate_image tool over stdio for any MCP client (Claude Code,
 * Claude Desktop, Cursor, Codex, etc).
 *
 * Register globally with Claude Code (adjust the path to wherever you cloned it):
 *   claude mcp add -s user image-gen node /absolute/path/to/image-gen/mcp-server.mjs
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { generateImage } from "./generate.mjs";
import { buildTransparencyReport } from "./transparency.mjs";

const TOOL_DESCRIPTION =
  "Generate an image using ChatGPT via a real Edge browser session " +
  "(dedicated auth profile, attach-first CDP on port 9222, globally queued jobs). " +
  "Saves a PNG and returns a TRANSPARENCY_REPORT plus a light checkerboard preview. " +
  "\n\nCRITICAL — do NOT regenerate for false 'black background' hallucinations: " +
  "ChatGPT transparent assets often show a soft gray/black gradient only at the bottom " +
  "(faint drop-shadow) and transparent pixels look black in dark IDE themes. " +
  "That is NOT a baked-in solid background. Trust verdict TRANSPARENT_OK and the " +
  "checkerboard preview. Only regenerate for background if verdict is " +
  "OPAQUE_BAKED_BACKGROUND. Soft bottom shadow alone is never a reason to regenerate. " +
  "\n\nIf login is missing, tell the user to run: npm run login in the image-gen folder.";

const server = new Server(
  { name: "playwright-image-gen", version: "2.5.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Detailed image generation prompt. Include subject, art style, " +
              "color palette, mood, and composition. Write in English.",
          },
          filename: {
            type: "string",
            description:
              "Output filename without extension (e.g. 'hero-illustration'). " +
              "Default: generated_<timestamp>",
          },
          output_dir: {
            type: "string",
            description:
              "Directory to save the image. If not provided, uses the current " +
              "working directory. Prefer project's public/ or assets/ folder.",
          },
          transparent_background: {
            type: "boolean",
            description:
              "Set true for icons, UI illustrations, logos, or any asset that " +
              "needs no background. Appends cutout instructions. After save, " +
              "MCP verifies alpha and writes a checkerboard preview — soft " +
              "bottom shadows are normal and must not trigger regeneration.",
          },
          reference_images: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of absolute local file paths to attach as visual " +
              "references. ChatGPT will use them as context when generating — " +
              "useful for style matching, variations, or img2img-style requests. " +
              "Example: [\"/path/to/sketch.png\", \"/path/to/palette.jpg\"]",
          },
        },
        required: ["prompt"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "generate_image") {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }

  const {
    prompt,
    filename = `generated_${Date.now()}`,
    output_dir,
    transparent_background = false,
    reference_images = [],
  } = req.params.arguments;

  const outputPath = path.join(output_dir || process.cwd(), `${filename}.png`);

  try {
    const saved = await generateImage(prompt, outputPath, {
      transparent: transparent_background,
      referenceImages: reference_images,
    });

    const { text, previewPath, report } = buildTransparencyReport(saved, {
      wantedTransparent: transparent_background,
    });

    /** @type {{type: string, text?: string, data?: string, mimeType?: string}[]} */
    const content = [{ type: "text", text }];

    // Prefer showing the checkerboard preview to the model so dark-theme
    // compositing cannot be mistaken for a baked black plate.
    const visionPath =
      previewPath && fs.existsSync(previewPath) ? previewPath : saved;
    try {
      content.push({
        type: "image",
        data: fs.readFileSync(visionPath).toString("base64"),
        mimeType: "image/png",
      });
    } catch {
      /* text report alone is still enough */
    }

    return {
      content,
      // Structured hint some clients surface to the model
      _meta: {
        verdict: report.verdict,
        softBottomVignette: report.softBottomVignette,
        doNotRegenerateForSoftShadow: report.verdict !== "OPAQUE_BAKED_BACKGROUND",
      },
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
