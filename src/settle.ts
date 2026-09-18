// Paying an upstream from a transparent balance.
//
// The two legs of this proxy are deliberately asymmetric. An agent pays it with
// a shielded transfer, which it can only *see*: it holds a viewing key and no
// spending key, so the revenue is unspendable here by construction. Upstreams
// are paid from a separate, ordinary EVM account holding ordinary tokens.
//
// What that buys is a bounded blast radius. A compromised proxy leaks the tool
// calls passing through it and drains whatever float the operator funded — not
// the shielded balance, which no key on this machine can move.
//
// What it costs is that the two legs do not reconcile themselves. Shielded
// revenue accrues as notes; the float drains. Closing the loop means sweeping
// with a spending key held somewhere else, which is exactly where it belongs.
//
// The payment itself is standard x402 `exact` on `eip155:*`: an EIP-3009
// authorization the resource server's facilitator submits, so this account never
// needs gas. Signing is the SDK's, not ours — `unshieldedExact` cannot be used
// because it derives its payer from `nsk` and unshields to fund it, which is the
// spending key this design is built to avoid holding.

import { evmAddress, tokenAmount } from "@lelantos-org/sdk";
import {
    type PaymentPayload,
    type PaymentRequired,
    type PaymentRequirements,
    parseCaip2,
    requireEip712Domain,
    signTransferAuthorization,
    timeoutSeconds,
    X402_VERSION,
} from "@lelantos-org/sdk/x402";
import type { PrivateKeyAccount } from "viem/accounts";
import {
    decodeBase64Json,
    encodeBase64Json,
    HEADER_PAYMENT_REQUIRED,
    HEADER_PAYMENT_SIGNATURE,
} from "./payment.js";

/** CAIP-2 namespace for public EVM chains. */
const EVM_NAMESPACE = "eip155";

export interface TransparentPayerOptions {
    account: PrivateKeyAccount;
    /** The chain whose offers this account can settle. */
    chainId: bigint;
    /**
     * Ceiling on a single upstream payment, in that token's base units, keyed by
     * lowercased token contract.
     *
     * Required, and per token, because base units mean nothing on their own:
     * 500_000 is 0.5 USDC at six decimals and 5e-13 WETH at eighteen. A single
     * figure spanning both would be a ceiling in one and no ceiling at all in
     * the other, and this is the guard standing between a hot float and an
     * upstream that quotes its own price.
     *
     * The keys are also the allowlist: a token with no ceiling is not paid.
     * There is deliberately no "any token" — it admits no ceiling.
     */
    maxPerCall: ReadonlyMap<string, bigint>;
    /** Transport for the wrapped requests. Named as `connect`'s `http` option. */
    http?: { fetch?: typeof fetch | undefined } | undefined;
}

export class UpstreamPaymentError extends Error {}

/**
 * A `fetch` that settles an upstream's 402 and retries once.
 *
 * Deliberately narrower than the SDK's `x402()`: one mechanism, no wallet, and a
 * per-call ceiling instead of a lifetime budget, because each call here is
 * already bounded by a payment the agent made for it.
 */
export function transparentPayer(opts: TransparentPayerOptions): typeof fetch {
    const send = opts.http?.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

    return async (input, init) => {
        const request = new Request(input as Parameters<typeof fetch>[0], init);
        const response = await send(request.clone());
        if (response.status !== 402) return response;

        const offer = readOffer(response);
        const requirements = select(offer, opts);
        const payload = await authorize(requirements, opts);

        const headers = new Headers(request.headers);
        headers.set(HEADER_PAYMENT_SIGNATURE, encodeBase64Json(payload));
        const paid = await send(new Request(request, { headers }));

        if (paid.status === 402) {
            // The authorization is signed and in the upstream's hands. Retrying
            // would sign a second one against the same float.
            throw new UpstreamPaymentError(
                `upstream still answered 402 after payment (${requirements.amount} of ${requirements.asset})`,
            );
        }
        return paid;
    };
}

function readOffer(response: Response): PaymentRequired {
    const header = response.headers.get(HEADER_PAYMENT_REQUIRED);
    const offer = header ? decodeBase64Json<PaymentRequired>(header) : undefined;
    if (!offer || !Array.isArray(offer.accepts)) {
        throw new UpstreamPaymentError("upstream answered 402 without a usable offer");
    }
    if (offer.x402Version !== X402_VERSION) {
        throw new UpstreamPaymentError(`upstream speaks x402 v${offer.x402Version}`);
    }
    return offer;
}

/** The first offer this account can settle, or a refusal naming why none fit. */
function select(offer: PaymentRequired, opts: TransparentPayerOptions): PaymentRequirements {
    const refusals: string[] = [];

    for (const requirements of offer.accepts) {
        const problem = unsuitable(requirements, opts);
        if (problem) refusals.push(`${requirements.network}/${requirements.scheme}: ${problem}`);
        else return requirements;
    }
    throw new UpstreamPaymentError(
        `no offer this proxy can settle — ${refusals.join("; ") || "the upstream offered none"}`,
    );
}

function unsuitable(
    requirements: PaymentRequirements,
    opts: TransparentPayerOptions,
): string | undefined {
    if (requirements.scheme !== "exact") return `scheme is not "exact"`;

    const { namespace, reference } = parseCaip2(requirements.network);
    if (namespace !== EVM_NAMESPACE) return "not an EVM network";
    // No bridging: the float sits on one chain.
    if (reference !== opts.chainId.toString()) return `settles on chain ${reference}`;

    if (!/^\d+$/.test(requirements.amount))
        return `amount "${requirements.amount}" is not an integer`;
    const value = BigInt(requirements.amount);
    if (value <= 0n) return "amount is not positive";

    // The ceiling is looked up before it is applied: a token nobody set one for
    // is refused rather than paid under some other token's figure.
    const ceiling = opts.maxPerCall.get(requirements.asset.toLowerCase());
    if (ceiling === undefined) {
        return `token ${requirements.asset} is not one this proxy pays in`;
    }
    if (value > ceiling) {
        return `${value} exceeds the ${ceiling} per-call ceiling for ${requirements.asset}`;
    }
    return undefined;
}

async function authorize(
    requirements: PaymentRequirements,
    opts: TransparentPayerOptions,
): Promise<PaymentPayload> {
    const payload = await signTransferAuthorization(opts.account, {
        // Both throw `X402PaymentError` on a malformed offer; the caller turns
        // any failure here into a failed upstream call, which releases the
        // agent's payment rather than consuming it.
        domain: requireEip712Domain(requirements),
        chainId: opts.chainId,
        token: evmAddress(requirements.asset),
        payTo: evmAddress(requirements.payTo),
        value: tokenAmount(BigInt(requirements.amount)),
        validForSeconds: timeoutSeconds(requirements),
    });

    return { x402Version: X402_VERSION, accepted: requirements, payload };
}
