// The proxy path: discovery, namespacing, pricing, forwarding, and what happens
// to the payment when an upstream fails.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CallToolRequestSchema,
    type CallToolResult,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { buildCatalogue } from "../src/catalogue.js";
import { ConsumedLedger } from "../src/ledger.js";
import { chargesOf, type PricingPolicy } from "../src/pricing.js";
import { buildProxyServer } from "../src/proxy.js";
import { type RemoteTool, type Upstream, UpstreamPool } from "../src/upstream.js";

const SCHEMA = { type: "object", properties: { q: { type: "string" } } } as const;

function fakeUpstream(tools: RemoteTool[], onCall?: (name: string) => CallToolResult): Upstream {
    return {
        listTools: async () => tools,
        callTool: async (name) =>
            onCall?.(name) ?? { content: [{ type: "text", text: `called ${name}` }] },
        close: async () => {},
    };
}

function pool(upstreams: Record<string, Upstream>): UpstreamPool {
    return UpstreamPool.from(new Map(Object.entries(upstreams)));
}

/** Drive a handler the way the transport would. */
function handlerOf(server: ReturnType<typeof buildProxyServer>, schema: unknown) {
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the SDK's handler map for a unit test
    return (server as any)._requestHandlers.get((schema as any).shape.method.value);
}

const SEARCH = [
    {
        qualified: "web__search",
        upstream: "web",
        remote: { name: "search", description: "find", inputSchema: SCHEMA },
    },
];

/** What `tools/list` publishes for `SEARCH` under one pricing policy. */
async function listedTools(policy: PricingPolicy) {
    const server = buildProxyServer({
        catalogue: buildCatalogue(SEARCH, policy),
        pool: pool({ web: fakeUpstream([]) }),
        serviceName: "test",
    });
    const result = await handlerOf(server, ListToolsRequestSchema)(
        { method: "tools/list", params: {} },
        {},
    );
    return result.tools;
}

describe("UpstreamPool", () => {
    it("namespaces tools so two upstreams can both export `search`", async () => {
        const discovered = await pool({
            web: fakeUpstream([{ name: "search", inputSchema: SCHEMA }]),
            docs: fakeUpstream([{ name: "search", inputSchema: SCHEMA }]),
        }).tools();

        expect(discovered.map((t) => t.qualified)).toEqual(["web__search", "docs__search"]);
    });

    it("refuses an upstream name that would make routing ambiguous", () => {
        expect(() => pool({ a__b: fakeUpstream([]) })).toThrow(/must be non-empty/);
    });

    it("routes a call to the named upstream, under the tool's own name", async () => {
        const seen: string[] = [];
        const p = pool({
            web: fakeUpstream([{ name: "search", inputSchema: SCHEMA }], (name) => {
                seen.push(name);
                return { content: [] };
            }),
        });
        await p.call("web", "search", { q: "hi" });
        // The upstream must never see the namespace this server added.
        expect(seen).toEqual(["search"]);
    });
});

describe("buildCatalogue", () => {
    const discovered = [
        {
            qualified: "web__search",
            upstream: "web",
            remote: { name: "search", description: "find", inputSchema: SCHEMA },
        },
        { qualified: "web__ping", upstream: "web", remote: { name: "ping", inputSchema: SCHEMA } },
    ];

    it("applies the default price, and per-tool and free overrides", () => {
        const catalogue = buildCatalogue(discovered, {
            default: [{ asset: 1n, amount: 1000n }],
            tools: { web__search: [{ asset: 1n, amount: 50n }] },
            free: ["web__ping"],
        });

        expect(catalogue.get("web__search")?.quotes[0]?.total).toBe(50n);
        expect(catalogue.get("web__ping")?.quotes).toEqual([]);
    });

    it("leaves everything free when no default is set", () => {
        const catalogue = buildCatalogue(discovered, {});
        expect([...catalogue.values()].every((tool) => tool.quotes.length === 0)).toBe(true);
    });

    it("prefers `free` over a per-tool price", () => {
        const policy = { tools: { web__ping: [{ asset: 1n, amount: 5n }] }, free: ["web__ping"] };
        expect(chargesOf("web__ping", policy)).toEqual([]);
    });

    it("keeps the upstream's schema untouched", () => {
        const catalogue = buildCatalogue(discovered, {});
        expect(catalogue.get("web__search")?.inputSchema).toBe(SCHEMA);
    });
});

describe("buildProxyServer", () => {
    const catalogue = buildCatalogue(SEARCH, { default: [{ asset: 1n, amount: 1000n }] });

    async function freshReservation() {
        const path = join(await mkdtemp(join(tmpdir(), "mcp-proxy-")), "consumed.log");
        const ledger = await ConsumedLedger.open(path);
        return { ledger, reservation: ledger.reserve(`0x${"ab".repeat(32)}`) };
    }

    it("lists the namespaced tool with its price attached", async () => {
        const [tool] = await listedTools({ default: [{ asset: 1n, amount: 1000n }] });

        expect(tool.name).toBe("web__search");
        expect(tool.description).toContain("1000 units");
        expect(tool.inputSchema).toBe(SCHEMA);
        expect(tool._meta["x402/prices"]).toEqual([
            { asset: "1", amount: "1000", base: "1000", proxyFee: "0" },
        ]);
    });

    it("lists every asset a tool may be paid in, as alternatives", async () => {
        const [tool] = await listedTools({
            default: [
                { asset: 1n, amount: 1000n },
                { asset: 2n, amount: 4n },
            ],
        });

        expect(tool._meta["x402/prices"]).toEqual([
            { asset: "1", amount: "1000", base: "1000", proxyFee: "0" },
            { asset: "2", amount: "4", base: "4", proxyFee: "0" },
        ]);
        // "or", never "and": a reader who took them for a sum would think the
        // call cost both.
        expect(tool.description).toContain("1000 units of asset 1 or 4 units of asset 2");
    });

    it("forwards a call and commits the payment", async () => {
        const { ledger, reservation } = await freshReservation();
        const server = buildProxyServer({
            catalogue,
            pool: pool({
                web: fakeUpstream([], () => ({ content: [{ type: "text", text: "ok" }] })),
            }),
            serviceName: "test",
            reservation,
        });

        const result = await handlerOf(server, CallToolRequestSchema)(
            { method: "tools/call", params: { name: "web__search", arguments: { q: "hi" } } },
            {},
        );

        expect(result.content[0].text).toBe("ok");
        expect(ledger.size).toBe(1);
    });

    it("releases the payment when the upstream fails", async () => {
        const { ledger, reservation } = await freshReservation();
        const server = buildProxyServer({
            catalogue,
            pool: pool({
                web: fakeUpstream([], () => {
                    throw new Error("upstream exploded");
                }),
            }),
            serviceName: "test",
            reservation,
        });

        await expect(
            handlerOf(server, CallToolRequestSchema)(
                { method: "tools/call", params: { name: "web__search", arguments: {} } },
                {},
            ),
        ).rejects.toThrow("upstream exploded");

        // Nothing committed: the payer did not buy an error.
        expect(ledger.size).toBe(0);
        expect(ledger.has(`0x${"ab".repeat(32)}`)).toBe(false);
    });
});

describe("the proxy's fee, as an agent sees it", () => {
    // The arithmetic is `pricing.test.ts`'s; this is only what reaches the wire.
    const policy = {
        default: [{ asset: 1n, amount: 1000n }],
        fee: { bps: 250n, flat: new Map([[1n, 5n]]) },
    };

    it("publishes the split, not just the total", async () => {
        const [tool] = await listedTools(policy);

        expect(tool._meta["x402/prices"]).toEqual([
            { asset: "1", amount: "1030", base: "1000", proxyFee: "30" },
        ]);
        expect(tool.description).toContain("1000 upstream + 30 proxy fee");
    });
});
