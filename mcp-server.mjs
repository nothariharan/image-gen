/**
 * mcp-server.mjs — MCP server entry point
 * Exposes the generate_image tool over stdio for any MCP client (Claude Code,
 * Claude Desktop, Cursor, etc).
 *
 * Register globally with Claude Code (adjust the path to wherever you cloned it):
 *   claude mcp add -s user image-gen node /absolute/path/to/image-gen/mcp-server.mjs
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import { generateImage } from "./generate.mjs";

const server = new Server(
  { name: "playwright-image-gen", version: "2.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description:
        "Generate an image using ChatGPT DALL-E via a real Edge browser session. " +
        "Uses a dedicated Edge auth profile (attach-first on port 9222, never kills your daily browser). " +
        "Auto-clicks Welcome-back account picker, restores chatgpt-storage.json cookies if needed, " +
        "types the prompt, waits for generation, downloads the PNG, and saves it. " +
        "If login is missing, tell the user to run: node login-once.mjs in the image-gen folder. " +
        "Use for any image, illustration, icon, banner, hero image, or visual asset.",
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
              "needs no background (used on colored/dark website sections). " +
              "Automatically appends no-background instructions to the prompt.",
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
    return {
      content: [{ type: "text", text: `Image saved to: ${saved}` }],
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
