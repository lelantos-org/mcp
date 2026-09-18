import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../src/catalogue.js";
import { decide } from "../src/gate.js";
import { encodeBase64Json } from "../src/payment.js";
import type { Charge } from "../src/pricing.js";

const CHARGE: Charge = { asset: 2n, base: 1000n, fee: 0n, total: 1000n };

/** The same tool, also payable in asset 5 at a different price. */
const IN_ASSET_5: Charge = { asset: 5n, base: 40n, fee: 0n, total: 40n };

const TOOLS = new Map<string, ToolSpec>([
    ["ping", { name: "ping", description: "free", quotes: [] }],
    ["echo", { name: "echo", description: "paid", quotes: [CHARGE] }],
    ["dual", { name: "dual", description: "paid in either", quotes: [CHARGE, IN_ASSET_5] }],
]);

function call(name: string, args: Record<string, unknown> = {}): unknown {
    return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

/** A payment header shaped like the one the SDK's payer sends. */
function paymentHeader(overrides: Record<string, unknown> = {}): string {
    return encodeBase64Json({
        x402Version: 2,
        accepted: {
            scheme: "exact",
            network: "shielded:31337",
            amount: CHARGE.total.toString(),
            asset: CHARGE.asset.toString(),
            payTo: "lelantos1example",
            maxTimeoutSeconds: 60,
            ...overrides,
        },
        payload: { pool: "lelantos", txHash: "0xabc", commitment: `0x${"11".repeat(32)}` },
    });
}

/** The reason `decide` challenges, failing the test if it does anything else. */
function challengeReason(name: string, header?: string): string {
    const decision = decide(call(name), header, TOOLS);
    if (decision.kind !== "challenge")
        throw new Error(`expected a challenge, got ${decision.kind}`);
    return decision.reason;
}

describe("decide", () => {
    it("lets discovery through unpaid", () => {
        expect(decide({ jsonrpc: "2.0", id: 1, method: "initialize" }, undefined, TOOLS).kind).toBe(
            "free",
        );
        expect(decide({ jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined, TOOLS).kind).toBe(
            "free",
        );
    });

    it("lets a free tool through unpaid", () => {
        expect(decide(call("ping"), undefined, TOOLS).kind).toBe("free");
    });

    it("challenges a priced tool with no payment", () => {
        expect(challengeReason("echo")).toContain("no payment");
    });

    it("accepts a payment naming the right terms", () => {
        const decision = decide(call("echo", { text: "hi" }), paymentHeader(), TOOLS);
        expect(decision.kind).toBe("payment");
    });

    it("challenges a payment that underpays", () => {
        expect(challengeReason("echo", paymentHeader({ amount: "999" }))).toContain("999");
    });

    it("challenges a payment in the wrong asset", () => {
        expect(challengeReason("echo", paymentHeader({ asset: "7" }))).toContain("asset 7");
    });

    it("accepts either asset a tool is priced in, at that asset's own price", () => {
        for (const charge of [CHARGE, IN_ASSET_5]) {
            const header = paymentHeader({
                asset: charge.asset.toString(),
                amount: charge.total.toString(),
            });
            const decision = decide(call("dual"), header, TOOLS);
            expect(decision.kind).toBe("payment");
            // The quote carried forward decides what `verify` holds the note to.
            if (decision.kind === "payment") expect(decision.quote).toEqual(charge);
        }
    });

    it("refuses one asset's price paid in another", () => {
        // 1000 units of asset 5 is not 40 units of asset 5, whatever it is worth:
        // the asset picks the quote, and the amount is checked against that one.
        const header = paymentHeader({ asset: "5", amount: CHARGE.total.toString() });
        expect(challengeReason("dual", header)).toContain("costs 40 in asset 5");
    });

    it("names every asset it would take when the payment matches none", () => {
        expect(challengeReason("dual", paymentHeader({ asset: "9" }))).toContain("priced in 2, 5");
    });

    it("challenges a payment naming a scheme no shielded wallet uses", () => {
        expect(challengeReason("echo", paymentHeader({ scheme: "permit" }))).toContain("permit");
    });

    it("challenges an unreadable payment header", () => {
        expect(challengeReason("echo", "not base64 json")).toContain("readable receipt");
    });

    it("refuses a batch that hides a priced call", () => {
        const decision = decide([call("ping"), call("echo")], undefined, TOOLS);
        expect(decision.kind).toBe("reject");
    });

    it("lets a batch of free calls through", () => {
        expect(decide([call("ping"), call("ping")], undefined, TOOLS).kind).toBe("free");
    });

    it("ignores a call naming a tool that does not exist", () => {
        expect(decide(call("nope"), undefined, TOOLS).kind).toBe("free");
    });
});
