// The front door: paywall first, MCP transport second.
//
// x402 is an HTTP protocol and MCP over streamable HTTP is a POST, so the two
// compose without either knowing about the other. An unpaid `tools/call` gets a
// 402 carrying the offer; the payer's wrapped `fetch` settles and repeats the
// identical POST; the second time through, the body reaches the transport.
//
// The body is read and parsed here rather than by the transport because the
// decision needs it — which tool, at what price — and a stream can only be
// consumed once. `handleRequest` takes an already-parsed body for this reason.

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { PricedTool, ProxiedTool } from "./catalogue.js";
import type { Config } from "./config.js";
import { decide } from "./gate.js";
import type { Reservation } from "./ledger.js";
import { type OfferContext, offerFor } from "./offer.js";
import { encodeBase64Json, HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_RESPONSE } from "./payment.js";
import { buildProxyServer } from "./proxy.js";
import type { UpstreamPool } from "./upstream.js";
import type { Verifier } from "./verify.js";

export const MCP_PATH = "/mcp";

export interface Deps {
    config: Config;
    catalogue: Map<string, ProxiedTool>;
    pool: UpstreamPool;
    verifier: Verifier;
    offerContext: OfferContext;
}

/** The node `http` request listener, with its failure path attached. */
export function createHandler(deps: Deps): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
        handle(req, res, deps).catch((err: unknown) => {
            console.error("[mcp] request failed", err);
            if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        });
    };
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "GET" && path === "/health") return sendJson(res, 200, { ok: true });
    if (req.method !== "POST" || path !== MCP_PATH) {
        return sendJson(res, 404, { error: `POST ${MCP_PATH}` });
    }

    const raw = await readBody(req, deps.config.maxBodyBytes);
    if (raw === undefined) return sendJson(res, 413, { error: "request body too large" });

    let body: unknown;
    try {
        body = JSON.parse(raw);
    } catch {
        return sendJson(res, 400, jsonRpcError("parse error"));
    }

    const decision = decide(body, header(req, "payment-signature"), deps.catalogue);
    let reservation: Reservation | undefined;

    switch (decision.kind) {
        case "reject":
            return sendJson(res, 400, jsonRpcError(decision.message));

        case "challenge":
            return challenge(res, decision.tool, decision.reason, deps.offerContext);

        case "payment": {
            const verified = await deps.verifier.verify(decision.payment.receipt, decision.quote);
            if (!verified.ok) {
                // Still a 402: the request remains unpaid as far as we are
                // concerned. The payer treats a second 402 as `payment-rejected`
                // and does not retry, which is the right outcome — its funds are
                // gone and repeating the call would only spend more.
                return challenge(res, decision.tool, verified.reason, deps.offerContext);
            }
            res.setHeader(HEADER_PAYMENT_RESPONSE, encodeBase64Json(verified.settlement));
            // The reservation is settled by the proxy once the upstream answers.
            reservation = verified.reservation;
            break;
        }

        case "free":
            break;
    }

    await serve(req, res, body, deps, reservation);
}

/** Answer 402 with the offer. */
function challenge(res: ServerResponse, tool: PricedTool, reason: string, ctx: OfferContext): void {
    const offer = offerFor(tool, ctx, reason);
    res.setHeader(HEADER_PAYMENT_REQUIRED, encodeBase64Json(offer));
    sendJson(res, 402, { error: reason, accepts: offer.accepts });
}

/** Hand the already-parsed body to a one-shot proxy server. */
async function serve(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    deps: Deps,
    reservation: Reservation | undefined,
): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
        // Stateless: no session id, no server-initiated messages, and a plain
        // JSON reply rather than SSE — which is what a paying `fetch` can read.
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    const mcp = buildProxyServer({
        catalogue: deps.catalogue,
        pool: deps.pool,
        serviceName: deps.config.serviceName,
        reservation,
    });

    res.on("close", () => {
        // Idempotent, so this only bites when the request died before the proxy
        // could settle it — a dropped connection must not consume the payment.
        reservation?.release();
        void transport.close();
        void mcp.close();
    });

    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
}

function header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

/** Buffer the body, or `undefined` once it exceeds `limit`. */
async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) return undefined;
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

function jsonRpcError(message: string): unknown {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message } };
}
