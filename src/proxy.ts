// The MCP server this process presents: a view of every upstream's tools.
//
// Built on the low-level `Server` rather than `McpServer` because a proxy should
// forward an upstream's JSON Schema exactly as given. `registerTool` takes a Zod
// shape, so using it would mean converting each upstream schema into Zod and
// back, and every tool whose schema survived that round trip imperfectly would
// become a tool clients call wrongly.
//
// A fresh server per request, which is also what keeps the paywall honest: this
// object does not exist until payment has been verified, so no upstream call can
// happen as a side effect of a failed one.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    type CallToolResult,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isPriced, type ProxiedTool } from "./catalogue.js";
import { priceMeta, renderCharge } from "./display.js";
import type { Reservation } from "./ledger.js";
import type { UpstreamPool } from "./upstream.js";

export interface ProxyDeps {
    catalogue: Map<string, ProxiedTool>;
    pool: UpstreamPool;
    serviceName: string;
    /**
     * The payment backing this request, when it is a paid one.
     *
     * Committed only once the upstream has answered. An upstream that fails
     * releases it instead, so the payer keeps a receipt it can present again
     * rather than paying for an error.
     */
    reservation?: Reservation | undefined;
}

export function buildProxyServer(deps: ProxyDeps): Server {
    const server = new Server(
        { name: deps.serviceName, version: "0.1.0" },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [...deps.catalogue.values()].map((tool) => ({
            name: tool.name,
            description: describe(tool),
            inputSchema: tool.inputSchema as { type: "object" },
            // Structured alongside the prose, so an agent can decide whether to
            // pay without parsing a description written for humans. Always a
            // list, in the order the 402 offers them: a tool priced in one asset
            // is the one-entry case, not a different shape.
            _meta: isPriced(tool) ? { "x402/prices": tool.quotes.map(priceMeta) } : {},
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const tool = deps.catalogue.get(request.params.name);
        if (!tool) throw new Error(`no tool named "${request.params.name}"`);

        try {
            const result: CallToolResult = await deps.pool.call(
                tool.upstream,
                tool.remoteName,
                request.params.arguments ?? {},
            );
            await deps.reservation?.commit();
            return result;
        } catch (err) {
            deps.reservation?.release();
            throw err;
        }
    });

    return server;
}

/**
 * The upstream's own description, plus what it costs here and why.
 *
 * Human units when the asset resolved, raw circuit units otherwise. This string
 * is what a model reads when it decides whether a call is worth making, so it is
 * the one place where being readable matters more than being exact.
 *
 * Several quotes are alternatives — "or", never "and": a payer settles one of
 * them, and a reader who took the list for a sum would think the call cost the
 * lot.
 */
function describe(tool: ProxiedTool): string {
    if (!isPriced(tool)) return `${tool.description} (free)`;

    const priced = tool.quotes.map((quote) => {
        const { base, fee, total } = renderCharge(quote);
        return quote.fee === 0n ? total : `${total} (${base} upstream + ${fee} proxy fee)`;
    });
    return `${tool.description} (costs ${priced.join(" or ")})`;
}
