// The payer's side of the wire: the `PAYMENT-SIGNATURE` header, parsed once.
//
// x402 carries its protocol in base64-JSON headers. The SDK has the same two
// codec functions in `src/x402/codec.ts` but does not export them —
// `@lelantos-org/sdk/x402` is the payer's surface — and they are the only piece
// a payee also needs.
//
// Parsing lives here, alone, so that `gate.ts` and `verify.ts` share one
// understanding of what a payment is. `verify` then takes a [`Receipt`] rather
// than a raw payload, which deletes a failure mode instead of handling it twice:
// there is no such thing as a `Receipt` that is not shaped like one.
//
// Note what a `Receipt` does *not* carry. The payload also holds `asset` and
// `amount`, but those are the payer's claims about its own transfer, and the
// note the commitment opens to is the authority on both. Leaving them out of the
// type is what makes it impossible to accidentally trust them.

import type { PaymentPayload, PaymentRequirements } from "@lelantos-org/sdk/x402";

export {
    HEADER_PAYMENT_REQUIRED,
    HEADER_PAYMENT_RESPONSE,
    HEADER_PAYMENT_SIGNATURE,
    X402_VERSION,
} from "@lelantos-org/sdk/x402";

/** A shielded transfer the payer says it made. */
export interface Receipt {
    pool: string;
    txHash: string;
    /** `0x` and 32 bytes. The only field verification depends on. */
    commitment: string;
}

/** A presented payment: the offer it answers, and the transfer that backs it. */
export interface Payment {
    accepted: PaymentRequirements;
    receipt: Receipt;
}

export function encodeBase64Json(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/**
 * Returns `undefined` rather than throwing: every failure here is a malformed
 * request, and the caller answers all of them the same way — with the offer
 * again, not with a 500.
 */
export function decodeBase64Json<T>(encoded: string): T | undefined {
    try {
        return JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8")) as T;
    } catch {
        return undefined;
    }
}

/** Decode and structurally validate a `PAYMENT-SIGNATURE` header. */
export function parsePayment(header: string): Payment | undefined {
    const payload = decodeBase64Json<PaymentPayload>(header);
    if (!isObject(payload)) return undefined;

    const { accepted } = payload;
    if (!isObject(accepted)) return undefined;

    const receipt = readReceipt(payload.payload);
    return receipt ? { accepted, receipt } : undefined;
}

function readReceipt(body: unknown): Receipt | undefined {
    if (!isObject(body)) return undefined;

    const { pool, txHash, commitment } = body as Record<string, unknown>;
    if (typeof pool !== "string" || typeof txHash !== "string") return undefined;
    // Checked here so a malformed value is a refusal rather than an exception
    // from deep inside the wallet.
    if (typeof commitment !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(commitment)) return undefined;

    return { pool, txHash, commitment };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
