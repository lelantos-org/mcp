// A minimal stdio MCP server, to prove the proxy forwards for real.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "shout",
            description: "Uppercase a string.",
            inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
            },
        },
        {
            name: "whoami",
            description: "What the upstream sees.",
            inputSchema: { type: "object", properties: {} },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "shout") {
        return {
            content: [
                { type: "text", text: String(req.params.arguments?.text ?? "").toUpperCase() },
            ],
        };
    }
    return { content: [{ type: "text", text: "upstream saw no client identity" }] };
});

await server.connect(new StdioServerTransport());
