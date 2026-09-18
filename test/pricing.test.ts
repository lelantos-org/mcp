// The JSON half of pricing: what an operator can write in `mcp.config.json`,
// and which mistakes are caught at boot rather than at the first 402.
//
// A price list is the one piece of this proxy an operator edits by hand, so the
// rules it enforces are the ones worth stating twice.

import { describe, expect, it } from "vitest";
import { applyFee, assetsIn, chargesOf, parsePricing } from "../src/pricing.js";

describe("parsePricing", () => {
    it("reads a single price as the one-asset case of a list", () => {
        const policy = parsePricing({ default: { asset: "1", amount: "1000" } });
        expect(policy.default).toEqual([{ asset: 1n, amount: 1000n }]);
    });

    it("reads a list of prices as alternatives in different assets", () => {
        const policy = parsePricing({
            tools: {
                web__search: [
                    { asset: "1", amount: "250" },
                    { asset: "2", amount: "3" },
                ],
            },
        });
        expect(policy.tools?.web__search).toEqual([
            { asset: 1n, amount: 250n },
            { asset: 2n, amount: 3n },
        ]);
    });

    it("refuses two prices in the same asset", () => {
        // Two answers to what one call costs, and `gate.ts` matches a payment to
        // a quote by asset: it would have to pick one.
        expect(() =>
            parsePricing({
                tools: {
                    web__search: [
                        { asset: "1", amount: "250" },
                        { asset: "1", amount: "300" },
                    ],
                },
            }),
        ).toThrow(/prices the same asset more than once/);
    });

    it("refuses an amount that is not a non-negative decimal integer", () => {
        expect(() => parsePricing({ default: { asset: "1", amount: "-5" } })).toThrow(
            /"default.amount" must be a non-negative decimal integer/,
        );
        expect(() => parsePricing({ default: { asset: "1", amount: "1e3" } })).toThrow(
            /"default.amount"/,
        );
    });

    it("names the offending entry in a list", () => {
        expect(() =>
            parsePricing({ tools: { web__search: [{ asset: "1", amount: "nope" }] } }),
        ).toThrow(/"web__search\[0\].amount"/);
    });

    it("refuses a bps outside [0, 10000]", () => {
        expect(() => parsePricing({ fee: { bps: 10_001 } })).toThrow(/pricing.fee.bps/);
        expect(() => parsePricing({ fee: { bps: 2.5 } })).toThrow(/pricing.fee.bps/);
    });
});

describe("a fee amount, which is meaningless without an asset", () => {
    it("takes a bare amount when the whole list names one asset", () => {
        const policy = parsePricing({
            default: { asset: "1", amount: "1000" },
            fee: { flat: "5", minimum: "10" },
        });
        expect(policy.fee?.flat).toEqual(new Map([[1n, 5n]]));
        expect(policy.fee?.minimum).toEqual(new Map([[1n, 10n]]));
    });

    it("refuses a bare amount once prices name several assets", () => {
        // 5 circuit units of one asset is not 5 of another, so spreading one
        // figure across both would overcharge in one and undercharge in the
        // other — silently, and on every call.
        expect(() =>
            parsePricing({
                default: [
                    { asset: "1", amount: "1000" },
                    { asset: "2", amount: "4" },
                ],
                fee: { flat: "5" },
            }),
        ).toThrow(/"fee.flat" is a bare amount but prices name 2 asset\(s\) \(1, 2\)/);
    });

    it("refuses an amount for an asset no price uses", () => {
        // The same typo class the bare-amount refusal catches: a fee keyed to an
        // asset nobody is charged in is charged to nobody.
        expect(() =>
            parsePricing({
                default: { asset: "1", amount: "1000" },
                fee: { flat: { "1": "5", "3": "7" } },
            }),
        ).toThrow(/"fee.flat" names asset 3, which no price uses \(priced: 1\)/);
    });

    it("refuses a bare amount when nothing is priced at all", () => {
        expect(() => parsePricing({ fee: { flat: "5" } })).toThrow(
            /"fee.flat" is a bare amount but prices name 0 asset\(s\)/,
        );
    });

    it("takes one amount per asset", () => {
        const policy = parsePricing({
            default: [
                { asset: "1", amount: "1000" },
                { asset: "2", amount: "4" },
            ],
            fee: { bps: 250, flat: { "1": "5", "2": "1" } },
        });
        expect(policy.fee?.flat).toEqual(
            new Map([
                [1n, 5n],
                [2n, 1n],
            ]),
        );
    });

    it("leaves an asset nobody set a flat fee for paying the proportional cut alone", () => {
        const policy = parsePricing({
            default: [
                { asset: "1", amount: "1000" },
                { asset: "2", amount: "1000" },
            ],
            fee: { bps: 250, flat: { "1": "5" } },
        });
        expect(chargesOf("web__search", policy)).toEqual([
            { asset: 1n, base: 1000n, fee: 30n, total: 1030n },
            { asset: 2n, base: 1000n, fee: 25n, total: 1025n },
        ]);
    });
});

describe("the proxy's cut", () => {
    const base = { asset: 1n, amount: 1000n };
    /** A per-asset fee amount for asset 1, which every base here is priced in. */
    const onAsset1 = (amount: bigint) => new Map([[1n, amount]]);

    it("adds a share of the base, in basis points", () => {
        // 2.5% of 1000 is 25.
        expect(applyFee(base, { bps: 250n })).toEqual({
            asset: 1n,
            base: 1000n,
            fee: 25n,
            total: 1025n,
        });
    });

    it("adds a flat amount as well", () => {
        expect(applyFee(base, { bps: 250n, flat: onAsset1(5n) }).fee).toBe(30n);
    });

    it("rounds a partial unit up, so cheap calls still pay something", () => {
        // 1 * 250bps is 0.025 units, which would floor to nothing.
        expect(applyFee({ asset: 1n, amount: 1n }, { bps: 250n }).fee).toBe(1n);
    });

    it("never charges a fee on a zero base through bps alone", () => {
        expect(applyFee({ asset: 1n, amount: 0n }, { bps: 250n }).fee).toBe(0n);
    });

    it("lifts a small fee to the minimum", () => {
        expect(
            applyFee({ asset: 1n, amount: 10n }, { bps: 100n, minimum: onAsset1(50n) }).fee,
        ).toBe(50n);
    });

    it("leaves a fee above the minimum alone", () => {
        expect(applyFee(base, { bps: 1000n, minimum: onAsset1(50n) }).fee).toBe(100n);
    });

    it("is not charged on a free tool", () => {
        const charges = chargesOf("web__ping", {
            default: [base],
            free: ["web__ping"],
            fee: { flat: onAsset1(500n) },
        });
        expect(charges).toEqual([]);
    });

    it("prices a tool whose base is zero at the fee alone", () => {
        const charges = chargesOf("web__ping", {
            tools: { web__ping: [{ asset: 1n, amount: 0n }] },
            fee: { flat: onAsset1(25n) },
        });
        expect(charges).toEqual([{ asset: 1n, base: 0n, fee: 25n, total: 25n }]);
    });
});

describe("chargesOf, on a tool priced in several assets", () => {
    const policy = parsePricing({
        default: { asset: "1", amount: "1000" },
        tools: {
            web__search: [
                { asset: "1", amount: "250" },
                { asset: "2", amount: "3" },
            ],
            web__free: [{ asset: "1", amount: "0" }],
        },
        fee: { bps: 1000 },
    });

    it("quotes each asset with its own fee applied", () => {
        expect(chargesOf("web__search", policy)).toEqual([
            { asset: 1n, base: 250n, fee: 25n, total: 275n },
            // Rounded up, as in the protocol: 10% of 3 is 0.3.
            { asset: 2n, base: 3n, fee: 1n, total: 4n },
        ]);
    });

    it("falls back to the default list for a tool nobody priced", () => {
        expect(chargesOf("web__other", policy)).toEqual([
            { asset: 1n, base: 1000n, fee: 100n, total: 1100n },
        ]);
    });

    it("drops a quote that would total zero, leaving the tool free", () => {
        // `requireAmount` rejects a non-positive amount, so quoting 0 would make
        // an offer every payer skips.
        expect(chargesOf("web__free", policy)).toEqual([]);
    });
});

describe("assetsIn", () => {
    it("lists every asset any price names, once", () => {
        const policy = parsePricing({
            default: { asset: "1", amount: "1000" },
            tools: {
                web__search: [
                    { asset: "1", amount: "250" },
                    { asset: "2", amount: "3" },
                ],
                web__other: { asset: "7", amount: "9" },
            },
        });
        expect(assetsIn(policy)).toEqual([1n, 2n, 7n]);
    });
});
