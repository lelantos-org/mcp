// Configuration: deployment in the environment, topology in a file.
//
// Which upstreams exist and what their tools cost is structured data that
// changes with the product, so it lives in JSON. Where to listen, which wallet
// to verify with and where the ledger goes are per-deployment, so they stay in
// the environment next to the secrets.
//
// The verification mode is a union rather than a `dev` flag beside optional
// fields, because the two modes need different things and "dev implies payTo" is
// a rule worth having the type enforce: the alternative is a runtime check here
// and a cast at the use site, which is the same rule written twice.
//
// `MCP_CHAIN_ID` is required rather than read from a chain adapter: a watch
// wallet built without a `reader` never contacts an RPC, and an offer naming the
// wrong chain is one every payer silently skips.

import { readFileSync } from "node:fs";
import { DEFAULT_TIMEOUT_SECONDS } from "./offer.js";
import { type PricingPolicy, parsePricing, type RawPricing } from "./pricing.js";
import type { UpstreamSpec } from "./upstream.js";

export type Mode =
    | {
          kind: "chain";
          viewingKey: string;
          network: string;
          rpcUrl: string | undefined;
          /** Overrides the watch wallet's own address. */
          payTo: string | undefined;
      }
    /** See `devVerifier`. There is no wallet to take an address from, so one is required. */
    | { kind: "dev"; payTo: string };

export interface Config {
    bind: { host: string; port: number };
    /** Advertised in `resource.url` on the 402. */
    publicUrl: string;
    serviceName: string;
    chainId: bigint;
    timeoutSeconds: number;
    ledgerPath: string;
    verifyTimeoutMs: number;
    maxBodyBytes: number;
    mode: Mode;
    upstreams: UpstreamSpec[];
    pricing: PricingPolicy;
    /**
     * The transparent account upstreams are paid from, when one is configured.
     *
     * Separate from `mode` on purpose: the shielded leg receives and the
     * transparent leg spends, and they share no key. A proxy can verify shielded
     * payments without being able to pay anyone, which is the default.
     */
    upstreamPayment: UpstreamPaymentConfig | undefined;
}

export interface UpstreamPaymentConfig {
    privateKey: string;
    chainId: bigint;
    /**
     * Ceiling on one upstream payment, in that token's base units, keyed by
     * lowercased token contract. The keys are also the allowlist.
     */
    maxPerCall: ReadonlyMap<string, bigint>;
}

/** The JSON half. Prices are strings there; bigints everywhere after. */
interface ProxyFile {
    upstreams?: UpstreamSpec[];
    pricing?: RawPricing;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const port = integer(env.MCP_PORT ?? "8402", "MCP_PORT");
    const file = readProxyFile(env.MCP_CONFIG ?? "mcp.config.json");

    return {
        bind: { host: env.MCP_HOST ?? "127.0.0.1", port },
        publicUrl: env.MCP_PUBLIC_URL ?? `http://127.0.0.1:${port}/mcp`,
        serviceName: env.MCP_SERVICE_NAME ?? "lelantos-mcp",
        chainId: BigInt(required(env, "MCP_CHAIN_ID")),
        timeoutSeconds: integer(
            env.MCP_TIMEOUT_SECONDS ?? String(DEFAULT_TIMEOUT_SECONDS),
            "MCP_TIMEOUT_SECONDS",
        ),
        ledgerPath: env.MCP_LEDGER ?? "consumed.log",
        verifyTimeoutMs: integer(env.MCP_VERIFY_TIMEOUT_MS ?? "30000", "MCP_VERIFY_TIMEOUT_MS"),
        // A tools/call body is small; the cap is here to stop an unpaying client
        // making us buffer megabytes before we can tell it that it owes us money.
        maxBodyBytes: integer(env.MCP_MAX_BODY_BYTES ?? "1048576", "MCP_MAX_BODY_BYTES"),
        mode: mode(env),
        upstreams: file.upstreams ?? [],
        pricing: parsePricing(file.pricing),
        upstreamPayment: upstreamPayment(env),
    };
}

function readProxyFile(path: string): ProxyFile {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as ProxyFile;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw new Error(`could not read ${path}: ${(err as Error).message}`);
    }
}

function upstreamPayment(env: NodeJS.ProcessEnv): UpstreamPaymentConfig | undefined {
    const privateKey = env.MCP_EVM_PRIVATE_KEY;
    if (!privateKey) return undefined;
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
        // Checked here rather than inside viem so the message names the variable
        // and never the value.
        throw new Error("MCP_EVM_PRIVATE_KEY must be 0x followed by 64 hex characters");
    }
    // Required, not defaulted: the float is a hot balance, and an upstream
    // quotes its own price. Without a ceiling one call can empty it.
    const maxPerCall = env.MCP_EVM_MAX_PER_CALL;
    if (!maxPerCall) {
        throw new Error("MCP_EVM_MAX_PER_CALL is required when MCP_EVM_PRIVATE_KEY is set");
    }

    return {
        privateKey,
        chainId: BigInt(env.MCP_EVM_CHAIN_ID ?? required(env, "MCP_CHAIN_ID")),
        maxPerCall: ceilings(maxPerCall, env.MCP_EVM_TOKENS),
    };
}

/**
 * Read `MCP_EVM_MAX_PER_CALL`, as `0xToken=500000,0xOther=2000000` or as a bare
 * amount when `MCP_EVM_TOKENS` names exactly one token.
 *
 * A bare amount across several tokens is refused rather than applied to each:
 * base units are denominated in the token, so one figure would be a real
 * ceiling in the smallest-decimal token and no ceiling in the largest. The same
 * rule `pricing.ts` applies to fee amounts, on the guard that protects the float.
 */
export function ceilings(raw: string, tokensRaw: string | undefined): Map<string, bigint> {
    const tokens = tokensRaw?.split(",").map((token) => token.trim().toLowerCase()) ?? [];
    const pairs = raw.split(",").map((entry) => entry.trim());

    if (!pairs.some((entry) => entry.includes("="))) {
        if (tokens.length !== 1 || !tokens[0]) {
            throw new Error(
                `MCP_EVM_MAX_PER_CALL is a bare amount but MCP_EVM_TOKENS names ` +
                    `${tokens.length} token(s); give one ceiling per token, as ` +
                    `MCP_EVM_MAX_PER_CALL=<token>=${raw.trim()}`,
            );
        }
        return new Map([[token(tokens[0]), units(raw, "MCP_EVM_MAX_PER_CALL")]]);
    }

    if (tokensRaw) {
        // The keys already are the allowlist; two lists could disagree.
        throw new Error(
            "MCP_EVM_TOKENS cannot be combined with a per-token MCP_EVM_MAX_PER_CALL, " +
                "which already names every token this proxy pays in",
        );
    }

    return new Map(
        pairs.map((entry) => {
            const [address, amount, ...rest] = entry.split("=");
            if (!address || !amount || rest.length > 0) {
                throw new Error(
                    `MCP_EVM_MAX_PER_CALL entry "${entry}" is not <token>=<base units>`,
                );
            }
            return [token(address.trim()), units(amount, `MCP_EVM_MAX_PER_CALL[${address}]`)];
        }),
    );
}

function token(address: string): string {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new Error(`"${address}" is not an EVM token address`);
    }
    return address.toLowerCase();
}

function units(value: string, name: string): bigint {
    const amount = BigInt(value.trim());
    // A ceiling of zero pays nothing; it is a typo, not a policy.
    if (amount <= 0n) throw new Error(`${name} must be a positive integer, got "${value}"`);
    return amount;
}

function mode(env: NodeJS.ProcessEnv): Mode {
    if (env.MCP_DEV_ACCEPT_UNVERIFIED !== "1") {
        return {
            kind: "chain",
            viewingKey: required(env, "LELANTOS_VIEWING_KEY"),
            network: env.LELANTOS_NETWORK ?? "base",
            rpcUrl: env.LELANTOS_RPC_URL,
            payTo: env.MCP_PAY_TO,
        };
    }
    const payTo = env.MCP_PAY_TO;
    if (!payTo) {
        throw new Error("MCP_PAY_TO is required in dev mode: there is no wallet to take it from");
    }
    return { kind: "dev", payTo };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function integer(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer, got "${value}"`);
    }
    return parsed;
}
