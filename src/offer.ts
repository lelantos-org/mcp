// The 402 document: what we will accept, in the form the payer checks.
//
// Every field here is load-bearing, and a wrong one fails silently: the payer
// skips an offer it cannot satisfy and moves to the next `accepts[]` entry,
// reporting nothing. `test/offer.test.ts` pins each one to the constant the SDK
// exports rather than to a literal, so a change on the payer's side breaks a
// test instead of quietly ending sales.

import {
    LELANTOS_POOL,
    type PaymentRequired,
    type PaymentRequirements,
    shieldedNetwork,
    X402_VERSION,
} from "@lelantos-org/sdk/x402";
import type { PricedTool } from "./catalogue.js";
import { priceMeta, type Quote } from "./display.js";

/**
 * Lower bound the shielded mechanism enforces on `maxTimeoutSeconds`: a shielded
 * payment includes a Groth16 proof that takes seconds, and the payer refuses an
 * offer whose window it cannot prove inside. The default sits well clear of it.
 */
export const DEFAULT_TIMEOUT_SECONDS = 60;

export interface OfferContext {
    chainId: bigint;
    /** The server's shielded address; where payment lands. */
    payTo: string;
    timeoutSeconds: number;
    resourceUrl: string;
    serviceName: string;
}

/**
 * The `accepts[]` entry for one quote.
 *
 * `scheme` must be `"exact"`: the payer matches an offer's scheme against its
 * mechanism's and skips on a mismatch, so a typo here is an offer no shielded
 * wallet will ever pay.
 */
function requirementsFor(tool: PricedTool, quote: Quote, ctx: OfferContext): PaymentRequirements {
    return {
        scheme: "exact",
        network: shieldedNetwork(ctx.chainId),
        amount: quote.total.toString(),
        asset: quote.asset.toString(),
        payTo: ctx.payTo,
        maxTimeoutSeconds: ctx.timeoutSeconds,
        extra: {
            pool: LELANTOS_POOL,
            // The same shape the tool listing publishes, so a payer that came
            // straight to the 402 without listing sees exactly the same fields.
            priceBreakdown: priceMeta(quote),
            // Declared for spec fidelity. The payer does not check it: upfront is
            // the only flow this network supports, because the `authorization`
            // flow would need a facilitator able to relay a Lelantos bundle.
            paymentFlow: "upfront",
            tool: tool.name,
        },
    };
}

/**
 * The whole `PAYMENT-REQUIRED` document, `reason` explaining why it is owed.
 *
 * One `accepts[]` entry per quote, in the order the price list named them. The
 * payer walks them in that order and settles the first it can cover, so the
 * order is this proxy's preference and the payer's balance decides between them.
 */
export function offerFor(tool: PricedTool, ctx: OfferContext, reason: string): PaymentRequired {
    return {
        x402Version: X402_VERSION,
        error: reason,
        resource: {
            url: ctx.resourceUrl,
            description: tool.description,
            serviceName: ctx.serviceName,
            mimeType: "application/json",
        },
        accepts: tool.quotes.map((quote) => requirementsFor(tool, quote, ctx)),
    };
}
