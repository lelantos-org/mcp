// Paying an upstream from the transparent balance.
//
// The account here is a throwaway test key — it signs EIP-712 typed data and
// holds nothing. What is asserted is which offers this proxy will settle and
// which it refuses, because every refusal is a call that fails *before* money
// moves, and a failed upstream call releases the agent's payment rather than
// consuming it.

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
    encodeBase64Json,
    HEADER_PAYMENT_REQUIRED,
    HEADER_PAYMENT_SIGNATURE,
} from "../src/payment.js";
import { transparentPayer, UpstreamPaymentError } from "../src/settle.js";

const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const PAY_TO = "0x1111111111111111111111111111111111111111";

function offer(overrides: Record<string, unknown> = {}) {
    return {
        x402Version: 2,
        accepts: [
            {
                scheme: "exact",
                network: "eip155:8453",
                amount: "1000",
                asset: TOKEN,
                payTo: PAY_TO,
                maxTimeoutSeconds: 60,
                extra: { name: "USD Coin", version: "2" },
                ...overrides,
            },
        ],
    };
}

/** A server that answers 402 once, then 200 — capturing what it was paid. */
function upstream(body: unknown = offer()) {
    const seen: { payment?: unknown } = {};
    const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const header = request.headers.get(HEADER_PAYMENT_SIGNATURE);
        if (!header) {
            return new Response("payment required", {
                status: 402,
                headers: { [HEADER_PAYMENT_REQUIRED]: encodeBase64Json(body) },
            });
        }
        seen.payment = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, seen };
}

function payer(over: Partial<Parameters<typeof transparentPayer>[0]> = {}, http?: typeof fetch) {
    return transparentPayer({
        account: ACCOUNT,
        chainId: 8453n,
        maxPerCall: new Map([[TOKEN.toLowerCase(), 10_000n]]),
        ...over,
        ...(http ? { http: { fetch: http } } : {}),
    });
}

describe("transparentPayer", () => {
    it("passes a non-402 response straight through", async () => {
        const untouched = (async () => new Response("hi", { status: 200 })) as typeof fetch;
        const response = await payer({}, untouched)("https://up.example/mcp");
        expect(response.status).toBe(200);
    });

    it("signs an authorization and retries once", async () => {
        const { fetchImpl, seen } = upstream();
        const response = await payer({}, fetchImpl)("https://up.example/mcp", { method: "POST" });

        expect(response.status).toBe(200);
        const payment = seen.payment as {
            payload: { signature: string; authorization: Record<string, string> };
        };
        expect(payment.payload.signature).toMatch(/^0x[0-9a-f]+$/i);
        expect(payment.payload.authorization.from).toBe(ACCOUNT.address);
        expect(payment.payload.authorization.to).toBe(PAY_TO);
        expect(payment.payload.authorization.value).toBe("1000");
    });

    it("echoes back the offer it satisfied", async () => {
        const { fetchImpl, seen } = upstream();
        await payer({}, fetchImpl)("https://up.example/mcp");
        const payment = seen.payment as { accepted: { asset: string } };
        expect(payment.accepted.asset).toBe(TOKEN);
    });

    it("refuses an amount over the per-call ceiling", async () => {
        const { fetchImpl } = upstream();
        await expect(
            payer(
                { maxPerCall: new Map([[TOKEN.toLowerCase(), 999n]]) },
                fetchImpl,
            )("https://up.example/mcp"),
        ).rejects.toThrow(/exceeds the 999 per-call ceiling/);
    });

    it("refuses another chain, because the float sits on one", async () => {
        const { fetchImpl } = upstream(offer({ network: "eip155:1" }));
        await expect(payer({}, fetchImpl)("https://up.example/mcp")).rejects.toThrow(
            /settles on chain 1/,
        );
    });

    it("refuses a shielded offer it has no key to pay", async () => {
        const { fetchImpl } = upstream(offer({ network: "shielded:8453" }));
        await expect(payer({}, fetchImpl)("https://up.example/mcp")).rejects.toThrow(
            /not an EVM network/,
        );
    });

    it("refuses a token it has no ceiling for", async () => {
        // The ceilings are the allowlist: an unpriced token has no figure to be
        // held to, so it is not paid at all.
        const { fetchImpl } = upstream();
        await expect(
            payer(
                { maxPerCall: new Map([["0xdead000000000000000000000000000000000000", 10_000n]]) },
                fetchImpl,
            )("https://up.example/mcp"),
        ).rejects.toThrow(/is not one this proxy pays in/);
    });

    it("holds each token to its own ceiling", async () => {
        // 500_000 base units is 0.5 USDC at six decimals and 5e-13 WETH at
        // eighteen; one figure cannot bound both.
        const { fetchImpl } = upstream();
        const other = "0xdead000000000000000000000000000000000000";
        await expect(
            payer(
                {
                    maxPerCall: new Map([
                        [TOKEN.toLowerCase(), 999n],
                        [other, 10n ** 18n],
                    ]),
                },
                fetchImpl,
            )("https://up.example/mcp"),
        ).rejects.toThrow(new RegExp(`exceeds the 999 per-call ceiling for ${TOKEN}`, "i"));
    });

    it("refuses an offer with no EIP-712 domain to sign against", async () => {
        // Without it the signature uses the wrong domain separator and the
        // facilitator rejects it — after the authorization has been handed over.
        const { fetchImpl } = upstream(offer({ extra: {} }));
        await expect(payer({}, fetchImpl)("https://up.example/mcp")).rejects.toThrow();
    });

    it("refuses a 402 carrying no offer at all", async () => {
        const bare = (async () => new Response("nope", { status: 402 })) as typeof fetch;
        await expect(payer({}, bare)("https://up.example/mcp")).rejects.toThrow(
            UpstreamPaymentError,
        );
    });

    it("does not sign a second authorization when the upstream 402s again", async () => {
        let attempts = 0;
        const greedy = (async () => {
            attempts += 1;
            return new Response("still", {
                status: 402,
                headers: { [HEADER_PAYMENT_REQUIRED]: encodeBase64Json(offer()) },
            });
        }) as typeof fetch;

        await expect(payer({}, greedy)("https://up.example/mcp")).rejects.toThrow(
            /still answered 402/,
        );
        // The original request and exactly one paid retry.
        expect(attempts).toBe(2);
    });
});
