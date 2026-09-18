// What a call costs: the policy, the proxy's cut, and the arithmetic between.
//
// Prices are in circuit units and MASP asset ids, which is what the
// `shielded:*` network quotes in. Pricing in human decimals would mean resolving
// asset metadata before every offer, and an offer must be cheap: it is the
// answer an unpaying client can make us produce over and over.
//
// A tool may carry several prices, one per asset it can be paid in. **They are
// alternatives, not a sum**: the payer picks one `accepts[]` entry and settles
// it whole. Everything downstream — the 402's `accepts[]`, the listing's
// `_meta`, the description an agent reads — is that one rule applied, so this
// comment is the only place it is stated. A list may not name the same asset
// twice: two quotes in one asset would be two answers to "what does this cost",
// and `gate.ts` matches a presented payment by asset.
//
// Nothing here knows about tools or upstreams. It takes a namespaced name and a
// policy and returns numbers, which is what makes the fee rules testable on
// their own.

import { unitFee } from "@lelantos-org/sdk/protocol";

export interface Price {
    /** Circuit units. Decimal string on the wire; a bigint here. */
    amount: bigint;
    /** MASP asset id. */
    asset: bigint;
}

/**
 * What this proxy adds on top of a tool's base price.
 *
 * `bps` is a share of the base and so carries across assets unchanged. `flat`
 * and `minimum` are amounts, and an amount is meaningless without the asset it
 * is denominated in — 5 circuit units of one asset is not 5 of another — so they
 * are stated per asset and are absent for an asset nobody set them for.
 */
export interface FeePolicy {
    /** Share of the base price, in basis points. 250 is 2.5%. */
    bps?: bigint;
    /** Added regardless of the base, in circuit units, keyed by asset. */
    flat?: ReadonlyMap<bigint, bigint>;
    /** Floor, so a cheap call still covers the cost of proxying it. */
    minimum?: ReadonlyMap<bigint, bigint>;
}

/**
 * A price, broken out so the caller can see what the proxy is taking.
 *
 * The single source of truth for what a tool costs in one asset: `total` is what
 * that `accepts[]` entry asks for, and there is no second field holding the same
 * number to drift from it.
 */
export interface Charge {
    asset: bigint;
    /** What the tool itself costs. */
    base: bigint;
    /** This proxy's cut. */
    fee: bigint;
    /** `base + fee`; what the 402 asks for, and what a note must cover. */
    total: bigint;
}

/** How to price the tools discovered at boot. */
export interface PricingPolicy {
    /** Base prices for any tool not named below. Omit to make everything free. */
    default?: readonly Price[];
    /** Per-tool base overrides, keyed by namespaced name. */
    tools?: Record<string, readonly Price[]>;
    /** Namespaced names that cost nothing at all, fee included. */
    free?: readonly string[];
    /** This proxy's cut, added to every tool that is not free. */
    fee?: FeePolicy;
}

/**
 * Apply the proxy's fee to a base price.
 *
 * The proportional part is the protocol's own `unitFee`, not a copy of it: this
 * fee sits alongside the pool's, and two implementations of the same rounding
 * would be free to drift. It rounds **up**, so a fee that would otherwise round
 * to zero on every cheap call — exactly the traffic a proxy most needs to cover
 * — is still charged.
 */
export function applyFee(base: Price, policy: FeePolicy): Charge {
    let fee = unitFee(base.amount, policy.bps ?? 0n) + (policy.flat?.get(base.asset) ?? 0n);
    const minimum = policy.minimum?.get(base.asset);
    if (minimum !== undefined && fee < minimum) fee = minimum;

    return { asset: base.asset, base: base.amount, fee, total: base.amount + fee };
}

/** The base prices of one tool, before this proxy's fee. */
export function basesOf(qualified: string, policy: PricingPolicy): readonly Price[] {
    if (policy.free?.includes(qualified)) return [];
    return policy.tools?.[qualified] ?? policy.default ?? [];
}

/**
 * Every way one tool may be paid for, fee included. Empty when it is free.
 *
 * A total of zero is dropped rather than quoted: `requireAmount` rejects a
 * non-positive `amount`, so such an entry is one every payer skips — an offer
 * that looks priced and can never be bought. A tool left with no quotes at all
 * is therefore free, which is what a base of zero and no fee means.
 */
export function chargesOf(qualified: string, policy: PricingPolicy): Charge[] {
    // No base means no charge at all: a tool nobody priced is free, and the fee
    // is a cut of a sale rather than a toll on the door. To charge only the fee,
    // give the tool a base of zero.
    return basesOf(qualified, policy)
        .map((base) => applyFee(base, policy.fee ?? {}))
        .filter((charge) => charge.total > 0n);
}

/** Every asset a price list names, for resolving registry entries at boot. */
export function assetsIn(policy: PricingPolicy): bigint[] {
    const prices = [...(policy.default ?? []), ...Object.values(policy.tools ?? {}).flat()];
    return [...new Set(prices.map((price) => price.asset))];
}

// --- the JSON half ------------------------------------------------------------
// Prices arrive as decimal strings, because JSON has no integers wide enough to
// be trusted with them. Parsing lives here rather than in `config.ts` so that
// the rules a price must satisfy are stated once, next to the type they build.

/** One price, or a list of alternatives to be paid in different assets. */
export type RawPrice = { asset: string; amount: string };

export interface RawPricing {
    default?: RawPrice | RawPrice[];
    tools?: Record<string, RawPrice | RawPrice[]>;
    free?: string[];
    /** `flat` and `minimum` are per-asset; see [`parseAmountByAsset`]. */
    fee?: { bps?: number; flat?: RawAmountByAsset; minimum?: RawAmountByAsset };
}

/**
 * An amount either stated per asset, or as a bare string when the whole price
 * list names one asset and there is no ambiguity to resolve.
 */
export type RawAmountByAsset = string | Record<string, string>;

export function parsePricing(raw: RawPricing = {}): PricingPolicy {
    const tools = Object.entries(raw.tools ?? {}).map(
        ([name, price]) => [name, parsePrices(price, name)] as const,
    );
    const policy: PricingPolicy = {
        ...(raw.default ? { default: parsePrices(raw.default, "default") } : {}),
        ...(tools.length > 0 ? { tools: Object.fromEntries(tools) } : {}),
        ...(raw.free ? { free: raw.free } : {}),
    };
    // Parsed last: a bare `flat` has to know which assets are in play before it
    // can say which one it is denominated in.
    return raw.fee ? { ...policy, fee: parseFee(raw.fee, assetsIn(policy)) } : policy;
}

function parsePrices(raw: RawPrice | RawPrice[], where: string): readonly Price[] {
    const list = Array.isArray(raw) ? raw : [raw];
    const prices = list.map((price, index) =>
        parsePrice(price, Array.isArray(raw) ? `${where}[${index}]` : where),
    );

    // Two quotes in one asset are two answers to what the tool costs, and
    // `gate.ts` matches a payment to a quote by asset: it would have to pick.
    const assets = new Set(prices.map((price) => price.asset));
    if (assets.size !== prices.length) {
        throw new Error(`"${where}" prices the same asset more than once`);
    }
    return prices;
}

function parsePrice(price: RawPrice, where: string): Price {
    return {
        asset: parseUnits(price.asset, `${where}.asset`),
        amount: parseUnits(price.amount, `${where}.amount`),
    };
}

function parseFee(fee: NonNullable<RawPricing["fee"]>, assets: readonly bigint[]): FeePolicy {
    if (fee.bps !== undefined && (!Number.isInteger(fee.bps) || fee.bps < 0 || fee.bps > 10_000)) {
        // Above 100% the figure is almost always a typo. A markup that large is
        // still expressible, as a flat amount.
        throw new Error(`pricing.fee.bps must be an integer in [0, 10000], got ${fee.bps}`);
    }
    const flat = fee.flat && parseAmountByAsset(fee.flat, assets, "fee.flat");
    const minimum = fee.minimum && parseAmountByAsset(fee.minimum, assets, "fee.minimum");
    return {
        ...(fee.bps !== undefined ? { bps: BigInt(fee.bps) } : {}),
        ...(flat ? { flat } : {}),
        ...(minimum ? { minimum } : {}),
    };
}

/**
 * Read a per-asset fee amount, accepting a bare string for the single-asset case.
 *
 * A bare string is refused unless exactly one asset is priced: the same number
 * of circuit units is a different amount of value in every asset, so spreading
 * one figure across several would quietly overcharge in one and undercharge in
 * another, and with nothing priced there is no asset to denominate it in.
 *
 * Both forms are checked against the price list, because a fee in an asset
 * nothing is priced in is charged to nobody — the same typo the bare-amount
 * refusal exists to catch, and silent where that one is loud.
 */
function parseAmountByAsset(
    raw: RawAmountByAsset,
    assets: readonly bigint[],
    where: string,
): Map<bigint, bigint> {
    if (typeof raw === "string") {
        const [only] = assets;
        if (only === undefined || assets.length > 1) {
            throw new Error(
                `"${where}" is a bare amount but prices name ${assets.length} asset(s)` +
                    `${assets.length > 0 ? ` (${assets.join(", ")})` : ""}; ` +
                    `state it per asset, as {"<asset>": "${raw}"}`,
            );
        }
        return new Map([[only, parseUnits(raw, where)]]);
    }

    const priced = new Set(assets);
    return new Map(
        Object.entries(raw).map(([asset, amount]) => {
            const id = parseUnits(asset, `${where} asset`);
            if (!priced.has(id)) {
                throw new Error(
                    `"${where}" names asset ${id}, which no price uses ` +
                        `(priced: ${assets.join(", ") || "nothing"})`,
                );
            }
            return [id, parseUnits(amount, `${where}.${asset}`)];
        }),
    );
}

function parseUnits(value: string, where: string): bigint {
    try {
        const units = BigInt(value);
        if (units < 0n) throw new Error("negative");
        return units;
    } catch {
        throw new Error(`"${where}" must be a non-negative decimal integer string, got "${value}"`);
    }
}
