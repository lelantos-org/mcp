// Rendering prices in units a reader can judge.
//
// The scale below is the one that makes `250` mean `0.25 USDC`: a 6-decimal
// token at scale 10^3, so one circuit unit is a thousandth of a USDC.

import type { AssetInfo } from "@lelantos-org/sdk";
import { describe, expect, it } from "vitest";
import { buildCatalogue } from "../src/catalogue.js";
import { displayOf, formatterFor, NO_DISPLAY, resolveAssets } from "../src/display.js";
import type { Charge } from "../src/pricing.js";

const USDC = { id: 1n, decimals: 6, scale: 10n ** 3n, symbol: "USDC" } as AssetInfo;
/** A registry entry whose chain adapter exposed no `tokenMeta`. */
const NO_META = { id: 2n, scale: 10n ** 3n } as AssetInfo;

const CHARGE: Charge = { asset: 1n, base: 250n, fee: 12n, total: 262n };
const SCHEMA = { type: "object" } as const;

describe("formatterFor", () => {
    const format = formatterFor(new Map([[1n, USDC]]));

    it("renders circuit units as a human amount with its symbol", () => {
        expect(format(1n, 250n)).toBe("0.25 USDC");
        expect(format(1n, 1000n)).toBe("1 USDC");
    });

    it("gives up on an asset it has no entry for", () => {
        expect(format(99n, 250n)).toBeUndefined();
    });

    it("gives up when the asset carries no decimals", () => {
        // Without `tokenMeta` there is no human unit to convert into, so raw
        // units are the only honest answer.
        expect(formatterFor(new Map([[2n, NO_META]]))(2n, 250n)).toBeUndefined();
    });
});

describe("displayOf", () => {
    it("renders all three figures of a charge", () => {
        expect(displayOf(CHARGE, formatterFor(new Map([[1n, USDC]])))).toEqual({
            base: "0.25 USDC",
            fee: "0.012 USDC",
            total: "0.262 USDC",
        });
    });

    it("renders nothing at all when the asset is unknown", () => {
        // All three or none: showing the total but not the fee would read as
        // though the fee were free.
        expect(displayOf(CHARGE, NO_DISPLAY)).toBeUndefined();
    });
});

describe("resolveAssets", () => {
    it("reads each distinct asset once", async () => {
        const seen: bigint[] = [];
        await resolveAssets([1n, 1n, 2n], async (id) => {
            seen.push(id);
            return USDC;
        });
        expect(seen).toEqual([1n, 2n]);
    });

    it("skips an asset the registry does not know, rather than failing to start", async () => {
        const assets = await resolveAssets([1n, 9n], async (id) => {
            if (id === 9n) throw new Error("no such asset");
            return USDC;
        });
        expect([...assets.keys()]).toEqual([1n]);
    });
});

describe("a priced catalogue with a formatter", () => {
    const discovered = [
        {
            qualified: "web__search",
            upstream: "web",
            remote: { name: "search", inputSchema: SCHEMA },
        },
    ];

    it("carries the human amounts alongside the raw ones", () => {
        const catalogue = buildCatalogue(
            discovered,
            {
                default: [{ asset: 1n, amount: 250n }],
                fee: { bps: 250n, flat: new Map([[1n, 5n]]) },
            },
            formatterFor(new Map([[1n, USDC]])),
        );
        const tool = catalogue.get("web__search");

        // Raw units stay authoritative: they are what the payer must match.
        expect(tool?.quotes[0]?.total).toBe(262n);
        expect(tool?.quotes[0]?.display?.total).toBe("0.262 USDC");
    });

    it("leaves display absent when nothing can be resolved", () => {
        const catalogue = buildCatalogue(discovered, { default: [{ asset: 1n, amount: 250n }] });
        expect(catalogue.get("web__search")?.quotes[0]?.display).toBeUndefined();
        expect(catalogue.get("web__search")?.quotes[0]?.total).toBe(250n);
    });
});
