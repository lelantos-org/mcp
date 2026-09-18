// Presenting a price: turning circuit units into something a reader can judge,
// and publishing the result in one shape wherever a price appears.
//
// A price of `250 units of asset 1` says nothing: circuit units are the
// protocol's internal denomination and the asset id is a registry index, so the
// figure could be a thousandth of a cent or fifty dollars. An agent deciding
// whether a call is worth making — or a human reading the tool list — needs
// `0.25 USDC`.
//
// The conversion needs the asset's `scale` and ERC-20 `decimals`, which come
// from the registry, so it is only available when a wallet is connected. In dev
// mode there is none and every rendering is `undefined`, which the caller shows
// as raw units. Raw units are always published too: they are what the payer
// actually has to match, and a display string is for deciding, not for paying.

import { type AssetInfo, formatAmount } from "@lelantos-org/sdk";
import type { Charge } from "./pricing.js";

/** Human rendering of an amount, or `undefined` when the asset is unknown. */
export type AmountFormatter = (asset: bigint, amount: bigint) => string | undefined;

export interface ChargeDisplay {
    base: string;
    fee: string;
    total: string;
}

/**
 * One way to pay for a call: the charge, plus how it reads to a human.
 *
 * A `Charge` with `display` attached rather than a wrapper around one. The
 * rendering is derived from the charge at boot and never varies independently,
 * so nesting it would only add a hop — and a hop invites the reader to ask
 * whether the two totals can disagree.
 */
export interface Quote extends Charge {
    /** Absent when the asset did not resolve; raw units are then the only figure. */
    display?: ChargeDisplay;
}

/** Nothing is renderable. The dev-mode formatter. */
export const NO_DISPLAY: AmountFormatter = () => undefined;

/**
 * Render against registry entries resolved once, at boot.
 *
 * Rounded **up**, so a displayed price never understates what the 402 will ask
 * for: a caller that budgets against the rendered figure must not be surprised.
 */
export function formatterFor(assets: ReadonlyMap<bigint, AssetInfo>): AmountFormatter {
    return (asset, amount) => {
        const info = assets.get(asset);
        // `formatAmount` needs `decimals`, which the chain adapter only supplies
        // when it implements `tokenMeta`; without it there is no human unit to
        // convert into.
        if (!info || info.decimals === undefined) return undefined;
        return formatAmount(amount, info, { symbol: true, round: "up" });
    };
}

/**
 * Registry entries for every asset named in a price list.
 *
 * A lookup that fails is skipped rather than fatal: an unrenderable price still
 * sells, and refusing to start over a missing symbol would be worse than showing
 * the raw units.
 */
export async function resolveAssets(
    ids: Iterable<bigint>,
    lookup: (id: bigint) => Promise<AssetInfo>,
): Promise<Map<bigint, AssetInfo>> {
    const assets = new Map<bigint, AssetInfo>();
    for (const id of new Set(ids)) {
        try {
            assets.set(id, await lookup(id));
        } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            console.warn(`[mcp] asset ${id} did not resolve (${why}); its prices show raw units`);
        }
    }
    return assets;
}

/** The three figures of a charge, or `undefined` if any of them is unrenderable. */
export function displayOf(charge: Charge, format: AmountFormatter): ChargeDisplay | undefined {
    const base = format(charge.asset, charge.base);
    const fee = format(charge.asset, charge.fee);
    const total = format(charge.asset, charge.total);
    // All three or none: a listing that renders the total but not the fee would
    // read as though the fee were free.
    if (base === undefined || fee === undefined || total === undefined) return undefined;
    return { base, fee, total };
}

/** The three figures of a quote as strings: human units where available, raw otherwise. */
export function renderCharge(quote: Quote): ChargeDisplay {
    const { display } = quote;
    return {
        base: display?.base ?? `${quote.base}`,
        fee: display?.fee ?? `${quote.fee}`,
        total: display?.total ?? `${quote.total} units of asset ${quote.asset}`,
    };
}

/**
 * How one way of paying is published, on the tool listing and in the 402 alike.
 *
 * One shape for both, so an agent that read the listing and an agent that came
 * straight to the call are looking at the same fields. Raw units are always
 * present and authoritative — they are what the payer has to match — while
 * `display` is advisory and absent when the asset did not resolve.
 */
export function priceMeta(quote: Quote): Record<string, unknown> {
    return {
        asset: quote.asset.toString(),
        amount: quote.total.toString(),
        base: quote.base.toString(),
        proxyFee: quote.fee.toString(),
        ...(quote.display ? { display: quote.display } : {}),
    };
}
