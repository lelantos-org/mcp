// Parsing the `PAYMENT-SIGNATURE` header.
//
// These cases used to live in `verify.test.ts`. They belong here now: a
// `Receipt` that is not shaped like one cannot be constructed, so the only place
// a malformed payload can be rejected is where bytes become a `Payment`.

import { describe, expect, it } from "vitest";
import { encodeBase64Json, parsePayment } from "../src/payment.js";

const CM = `0x${"ab".repeat(32)}`;

function header(overrides: { accepted?: unknown; payload?: unknown } = {}): string {
    return encodeBase64Json({
        x402Version: 2,
        accepted: { scheme: "exact", amount: "1000", asset: "2" },
        payload: { pool: "lelantos", txHash: "0xdead", commitment: CM },
        ...overrides,
    });
}

describe("parsePayment", () => {
    it("reads a payment the SDK's payer would send", () => {
        const payment = parsePayment(header());
        expect(payment?.receipt).toEqual({ pool: "lelantos", txHash: "0xdead", commitment: CM });
        expect(payment?.accepted.scheme).toBe("exact");
    });

    it("keeps the payer's claimed amount out of the receipt", () => {
        // `asset` and `amount` are in the payload, but the note is the authority
        // on both, so they are deliberately unreachable from a `Receipt`.
        const payment = parsePayment(
            header({
                payload: { pool: "lelantos", txHash: "0x1", commitment: CM, amount: "999999" },
            }),
        );
        expect(payment?.receipt).not.toHaveProperty("amount");
    });

    it("rejects a header that is not base64 JSON", () => {
        expect(parsePayment("not base64 json")).toBeUndefined();
    });

    it("rejects a payment naming no offer", () => {
        expect(parsePayment(encodeBase64Json({ x402Version: 2, payload: {} }))).toBeUndefined();
    });

    it("rejects a commitment that is not 32 bytes", () => {
        const bad = header({ payload: { pool: "lelantos", txHash: "0x1", commitment: "0x12" } });
        expect(parsePayment(bad)).toBeUndefined();
    });

    it("rejects a payload with no commitment at all", () => {
        expect(
            parsePayment(header({ payload: { pool: "lelantos", txHash: "0x1" } })),
        ).toBeUndefined();
    });

    it("rejects a payload that is not an object", () => {
        expect(parsePayment(header({ payload: "nope" }))).toBeUndefined();
    });
});
