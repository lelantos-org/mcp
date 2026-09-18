// The offer is only useful if a shielded payer will accept it, and the payer
// rejects silently: an offer it cannot satisfy is skipped, not reported. So
// every assertion here is pinned to a constant the SDK exports rather than to a
// literal, which is what makes this test fail if the payer's contract moves.

import {
    DEFAULT_MIN_TIMEOUT_SECONDS,
    LELANTOS_POOL,
    parseCaip2,
    SHIELDED_NAMESPACE,
    X402_VERSION,
} from "@lelantos-org/sdk/x402";
import { describe, expect, it } from "vitest";
import type { PricedTool } from "../src/catalogue.js";
import { type OfferContext, offerFor } from "../src/offer.js";

const TOOL: PricedTool = {
    name: "echo",
    description: "paid",
    quotes: [{ asset: 2n, base: 1000n, fee: 0n, total: 1000n }],
};
const CTX: OfferContext = {
    chainId: 31337n,
    payTo: "lelantos1example",
    timeoutSeconds: 60,
    resourceUrl: "http://127.0.0.1:8402/mcp",
    serviceName: "lelantos-mcp",
};

describe("offerFor", () => {
    const offer = offerFor(TOOL, CTX, "payment required");
    const requirements = offer.accepts[0];

    it("speaks the protocol version the payer requires", () => {
        expect(offer.x402Version).toBe(X402_VERSION);
    });

    it("offers exactly one way to pay", () => {
        expect(offer.accepts).toHaveLength(1);
    });

    it("uses the scheme the shielded mechanism matches on", () => {
        // `select()` skips an offer whose scheme differs from the mechanism's.
        expect(requirements?.scheme).toBe("exact");
    });

    it("names the shielded network for this chain", () => {
        const { namespace, reference } = parseCaip2(requirements?.network ?? "");
        expect(namespace).toBe(SHIELDED_NAMESPACE);
        expect(reference).toBe(CTX.chainId.toString());
    });

    it("identifies the pool", () => {
        expect(requirements?.extra?.pool).toBe(LELANTOS_POOL);
    });

    it("leaves room to generate a proof", () => {
        expect(requirements?.maxTimeoutSeconds).toBeGreaterThanOrEqual(DEFAULT_MIN_TIMEOUT_SECONDS);
    });

    it("quotes amount and asset as decimal integer strings", () => {
        // `requirePositiveInteger` rejects anything else, including hex and
        // scientific notation, as another network's convention.
        expect(requirements?.amount).toMatch(/^\d+$/);
        expect(requirements?.asset).toMatch(/^\d+$/);
        expect(requirements?.amount).toBe("1000");
        expect(requirements?.asset).toBe("2");
    });

    it("pays to the configured shielded address", () => {
        expect(requirements?.payTo).toBe(CTX.payTo);
    });

    it("describes the resource for a human deciding whether to pay", () => {
        expect(offer.resource?.url).toBe(CTX.resourceUrl);
        expect(offer.resource?.description).toBe(TOOL.description);
    });
});

describe("offerFor, on a tool priced in several assets", () => {
    const DUAL: PricedTool = {
        name: "echo",
        description: "paid in either",
        quotes: [
            { asset: 2n, base: 1000n, fee: 0n, total: 1000n },
            { asset: 5n, base: 40n, fee: 2n, total: 42n },
        ],
    };
    const offer = offerFor(DUAL, CTX, "payment required");

    it("offers one way to pay per asset, in the price list's order", () => {
        // `select()` walks `accepts[]` in order and settles the first entry the
        // payer's balance covers, so this order is the proxy's preference.
        expect(offer.accepts.map((a) => [a.asset, a.amount])).toEqual([
            ["2", "1000"],
            ["5", "42"],
        ]);
    });

    it("gives each entry the breakdown for its own asset", () => {
        expect(offer.accepts[1]?.extra?.priceBreakdown).toEqual({
            asset: "5",
            amount: "42",
            base: "40",
            proxyFee: "2",
        });
    });

    it("names the same tool and pool on every entry", () => {
        for (const entry of offer.accepts) {
            expect(entry.extra?.tool).toBe(DUAL.name);
            expect(entry.extra?.pool).toBe(LELANTOS_POOL);
            expect(entry.payTo).toBe(CTX.payTo);
        }
    });
});
