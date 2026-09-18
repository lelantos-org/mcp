// Deciding, from one MCP request, whether payment is owed.
//
// Pure: it reads a parsed JSON-RPC body and a header and returns what should
// happen. Everything with a side effect — chain reads, the replay ledger, the
// MCP transport — acts on that answer elsewhere. The split is what lets the
// paywall be tested without a pool, an indexer or a network.
//
// Only `tools/call` is ever charged. `initialize` and `tools/list` stay free on
// purpose: a client that cannot discover the tools cannot learn what they cost,
// and an unpriced discovery step is what lets an agent decide whether to pay.

import { isPriced, type PricedTool, type ToolSpec } from "./catalogue.js";
import type { Quote } from "./display.js";
import { type Payment, parsePayment } from "./payment.js";

export type Decision =
    /** Not a priced call. Hand it to the transport untouched. */
    | { kind: "free" }
    /** Priced, and unpaid or unusably paid: answer 402 with the offer. */
    | { kind: "challenge"; tool: PricedTool; reason: string }
    /**
     * Priced and carrying a structurally sound payment. Verify it.
     *
     * `quote` is the one of the tool's quotes this payment answers — the asset
     * it names — so verification checks the note against the price actually
     * being paid rather than against whichever quote happens to be first.
     */
    | { kind: "payment"; tool: PricedTool; payment: Payment; quote: Quote }
    /** Malformed in a way no offer would fix. */
    | { kind: "reject"; message: string };

export function decide(
    body: unknown,
    paymentHeader: string | undefined,
    tools: Map<string, ToolSpec>,
): Decision {
    // A JSON-RPC batch could mix a free call and a priced one, and HTTP has a
    // single status code for the pair. Rather than charge for the batch or serve
    // the priced call free, refuse it and say why.
    if (Array.isArray(body)) {
        const priced = body.some((message) => pricedToolOf(message, tools));
        return priced
            ? {
                  kind: "reject",
                  message:
                      "batched requests cannot contain a priced tools/call; send it on its own",
              }
            : { kind: "free" };
    }

    const tool = pricedToolOf(body, tools);
    if (!tool) return { kind: "free" };

    if (!paymentHeader) {
        return { kind: "challenge", tool, reason: "no payment presented" };
    }

    const payment = parsePayment(paymentHeader);
    if (!payment) {
        return { kind: "challenge", tool, reason: "payment header is not a readable receipt" };
    }

    return matchQuote(payment, tool);
}

/** The tool a message would charge for, if any. */
function pricedToolOf(message: unknown, tools: Map<string, ToolSpec>): PricedTool | undefined {
    if (typeof message !== "object" || message === null) return undefined;
    const { method, params } = message as { method?: unknown; params?: unknown };
    if (method !== "tools/call") return undefined;
    if (typeof params !== "object" || params === null) return undefined;

    const { name } = params as { name?: unknown };
    if (typeof name !== "string") return undefined;

    const tool = tools.get(name);
    return isPriced(tool) ? tool : undefined;
}

/**
 * The decision a presented payment leads to: which quote it satisfied, or why none.
 *
 * `accepted` is echoed by the payer from our own 402, so it is client-supplied
 * and re-derived here rather than trusted. This does not establish that the
 * payment landed — only that the payer claims to have paid the right price for
 * one of the assets we offered. The note itself is checked in `verify.ts`.
 *
 * The asset picks the quote and the amount is then checked against that one
 * quote: paying the WETH price in USDC buys nothing, however large the figure.
 */
function matchQuote(payment: Payment, tool: PricedTool): Decision {
    const { scheme, asset, amount } = payment.accepted;
    const challenge = (reason: string): Decision => ({ kind: "challenge", tool, reason });

    if (scheme !== "exact") return challenge(`offer scheme "${scheme}" is not "exact"`);

    const quote = tool.quotes.find((candidate) => integerEquals(asset, candidate.asset));
    if (!quote) {
        const offered = tool.quotes.map((candidate) => candidate.asset).join(", ");
        return challenge(`payment names asset ${asset}, this tool is priced in ${offered}`);
    }
    if (!integerEquals(amount, quote.total)) {
        return challenge(
            `payment names ${amount} units, this tool costs ${quote.total} in asset ${quote.asset}`,
        );
    }
    return { kind: "payment", tool, payment, quote };
}

function integerEquals(value: unknown, expected: bigint): boolean {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
    return BigInt(value) === expected;
}
