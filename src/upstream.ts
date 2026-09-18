// The MCP servers this one fronts.
//
// Each upstream is an ordinary MCP client connection, held open for the life of
// the process: stdio upstreams are child processes, and starting one per request
// would cost more than the tool call. Tool names are namespaced on the way out
// (`<upstream>__<tool>`) and stripped on the way back in, because two upstreams
// may well both export `search`.
//
// Nothing here knows about payment. The pool is what a proxied call lands on
// once `gate.ts` and `verify.ts` have agreed it is paid for.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Separator between an upstream's name and a tool's own. */
export const NAMESPACE_SEPARATOR = "__";

/**
 * How an upstream is paid.
 *
 * `credential` is the operator's own API key or subscription, carried in
 * `headers` or the child process's `env` — the upstream never learns that a
 * payment happened at all. `transparent` settles its 402s from this proxy's
 * transparent EVM balance; see `settle.ts`.
 */
export type UpstreamPayment = "credential" | "transparent";

export type UpstreamSpec =
    | {
          name: string;
          transport: "stdio";
          command: string;
          args?: string[];
          env?: Record<string, string>;
          /** Only `credential`: a child process has no 402 to answer. */
          payment?: "credential";
      }
    | {
          name: string;
          transport: "http";
          url: string;
          headers?: Record<string, string>;
          payment?: UpstreamPayment;
      };

/** A tool as its own server describes it. `inputSchema` is JSON Schema, passed through untouched. */
export interface RemoteTool {
    name: string;
    description?: string;
    inputSchema: unknown;
}

/** What the pool needs of a connection. An interface so tests can supply their own. */
export interface Upstream {
    listTools(): Promise<RemoteTool[]>;
    callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
    close(): Promise<void>;
}

/**
 * @param pay A `fetch` that settles 402s, for upstreams marked `transparent`.
 * Absent when no transparent account is configured, which makes such an upstream
 * a configuration error rather than a silently unpaid one.
 */
export async function connectUpstream(
    spec: UpstreamSpec,
    pay?: typeof fetch | undefined,
): Promise<Upstream> {
    const client = new Client({ name: "lelantos-mcp-proxy", version: "0.1.0" });

    if (spec.transport === "stdio") {
        await client.connect(
            new StdioClientTransport({
                command: spec.command,
                ...(spec.args ? { args: spec.args } : {}),
                // Inherited env is deliberately not merged in: an upstream should
                // see the credentials its spec grants it and nothing else of ours.
                ...(spec.env ? { env: spec.env } : {}),
            }),
        );
    } else {
        const transparent = spec.payment === "transparent";
        if (transparent && !pay) {
            throw new Error(
                `upstream "${spec.name}" is marked \`transparent\` but no transparent ` +
                    "account is configured (set MCP_EVM_PRIVATE_KEY)",
            );
        }
        await client.connect(
            new StreamableHTTPClientTransport(new URL(spec.url), {
                ...(spec.headers ? { requestInit: { headers: spec.headers } } : {}),
                ...(transparent && pay ? { fetch: pay } : {}),
            }),
        );
    }

    return {
        async listTools() {
            const { tools } = await client.listTools();
            return tools.map((tool) => ({
                name: tool.name,
                ...(tool.description ? { description: tool.description } : {}),
                inputSchema: tool.inputSchema,
            }));
        },
        async callTool(name, args) {
            return client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
        },
        close: () => client.close(),
    };
}

/** Every upstream, addressed by name. */
export class UpstreamPool {
    private constructor(private readonly upstreams: Map<string, Upstream>) {}

    static from(upstreams: Map<string, Upstream>): UpstreamPool {
        for (const name of upstreams.keys()) assertUsableName(name);
        return new UpstreamPool(upstreams);
    }

    static async connect(
        specs: readonly UpstreamSpec[],
        pay?: typeof fetch | undefined,
    ): Promise<UpstreamPool> {
        const upstreams = new Map<string, Upstream>();
        for (const spec of specs) {
            assertUsableName(spec.name);
            if (upstreams.has(spec.name)) {
                throw new Error(`upstream "${spec.name}" is declared twice`);
            }
            upstreams.set(spec.name, await connectUpstream(spec, pay));
        }
        return UpstreamPool.from(upstreams);
    }

    /** Every upstream's tools, under their namespaced names. */
    async tools(): Promise<{ qualified: string; upstream: string; remote: RemoteTool }[]> {
        const all: { qualified: string; upstream: string; remote: RemoteTool }[] = [];
        for (const [name, upstream] of this.upstreams) {
            for (const remote of await upstream.listTools()) {
                all.push({ qualified: qualify(name, remote.name), upstream: name, remote });
            }
        }
        return all;
    }

    /** Forward a call, given the upstream and the tool's own name. */
    async call(
        upstream: string,
        remoteName: string,
        args: Record<string, unknown>,
    ): Promise<CallToolResult> {
        const target = this.upstreams.get(upstream);
        if (!target) throw new Error(`no upstream named "${upstream}"`);
        return target.callTool(remoteName, args);
    }

    async close(): Promise<void> {
        // Settled, not raced: one upstream refusing to shut down cleanly must not
        // leave the others running.
        await Promise.allSettled([...this.upstreams.values()].map((u) => u.close()));
    }
}

export function qualify(upstream: string, tool: string): string {
    return `${upstream}${NAMESPACE_SEPARATOR}${tool}`;
}

/**
 * An upstream name containing the separator would make `a__b__c` ambiguous, and
 * the ambiguity would show up as a call silently routed to the wrong server.
 */
function assertUsableName(name: string): void {
    if (!name || name.includes(NAMESPACE_SEPARATOR)) {
        throw new Error(
            `upstream name "${name}" must be non-empty and contain no "${NAMESPACE_SEPARATOR}"`,
        );
    }
}
