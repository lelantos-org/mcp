// The tools this proxy offers, priced, built once at boot.
//
// A tool is free or it is not, and `quotes` is the only thing that says which:
// there is no second field holding the same totals for the two to drift apart.
// See `pricing.ts` for what a list of quotes means. `PricedTool` is the narrowed
// form, so a function that takes one cannot be handed a free tool by mistake.

import { type AmountFormatter, displayOf, NO_DISPLAY, type Quote } from "./display.js";
import { chargesOf, type PricingPolicy } from "./pricing.js";
import type { RemoteTool } from "./upstream.js";

export interface ToolSpec {
    name: string;
    description: string;
    /** Every asset this call can be paid in. Empty when it is free. */
    quotes: readonly Quote[];
}

/** A tool known to cost something: at least one quote. */
export interface PricedTool extends ToolSpec {
    quotes: readonly [Quote, ...Quote[]];
}

/** A tool this server exposes on behalf of an upstream. */
export interface ProxiedTool extends ToolSpec {
    upstream: string;
    /** The name the upstream knows it by, without the namespace. */
    remoteName: string;
    /** The upstream's own JSON Schema, forwarded to clients verbatim. */
    inputSchema: unknown;
}

export function isPriced(tool: ToolSpec | undefined): tool is PricedTool {
    return tool !== undefined && tool.quotes.length > 0;
}

/** One upstream's tool, under the name this server gives it. */
export interface Discovered {
    qualified: string;
    upstream: string;
    remote: RemoteTool;
}

/** Name-indexed catalogue over the upstreams' tools. */
export function buildCatalogue(
    discovered: readonly Discovered[],
    policy: PricingPolicy,
    format: AmountFormatter = NO_DISPLAY,
): Map<string, ProxiedTool> {
    const catalogue = new Map<string, ProxiedTool>();

    for (const { qualified, upstream, remote } of discovered) {
        // Namespacing makes this unreachable for two upstreams, so a collision
        // means one upstream listed the same tool twice.
        if (catalogue.has(qualified)) {
            throw new Error(`upstream "${upstream}" lists "${remote.name}" more than once`);
        }

        catalogue.set(qualified, {
            name: qualified,
            description: remote.description ?? `${remote.name}, proxied from ${upstream}`,
            upstream,
            remoteName: remote.name,
            inputSchema: remote.inputSchema,
            quotes: quotesFor(qualified, policy, format),
        });
    }

    return catalogue;
}

function quotesFor(
    qualified: string,
    policy: PricingPolicy,
    format: AmountFormatter,
): readonly Quote[] {
    return chargesOf(qualified, policy).map((charge) => {
        const display = displayOf(charge, format);
        return { ...charge, ...(display ? { display } : {}) };
    });
}
