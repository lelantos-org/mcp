// The float's ceilings, as an operator writes them in the environment.
//
// `MCP_EVM_MAX_PER_CALL` is the guard between a hot balance and an upstream that
// quotes its own price, so what it refuses at boot matters as much as what it
// accepts.

import { describe, expect, it } from "vitest";
import { ceilings } from "../src/config.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

describe("ceilings", () => {
    it("reads one ceiling per token, lowercasing the keys it matches on", () => {
        expect(ceilings(`${USDC}=500000,${WETH}=2000000`, undefined)).toEqual(
            new Map([
                [USDC.toLowerCase(), 500_000n],
                [WETH.toLowerCase(), 2_000_000n],
            ]),
        );
    });

    it("takes a bare amount when exactly one token is allowed", () => {
        expect(ceilings("500000", USDC)).toEqual(new Map([[USDC.toLowerCase(), 500_000n]]));
    });

    it("refuses a bare amount across several tokens", () => {
        // 500_000 is 0.5 USDC and 5e-13 WETH: a ceiling in one and none in the
        // other.
        expect(() => ceilings("500000", `${USDC},${WETH}`)).toThrow(
            /bare amount but MCP_EVM_TOKENS names 2 token\(s\)/,
        );
    });

    it("refuses a bare amount with no token named at all", () => {
        // "any token" admits no ceiling, so it is not a configuration.
        expect(() => ceilings("500000", undefined)).toThrow(/names 0 token\(s\)/);
    });

    it("refuses an allowlist alongside per-token ceilings, which already are one", () => {
        expect(() => ceilings(`${USDC}=500000`, USDC)).toThrow(/cannot be combined/);
    });

    it("refuses a malformed entry rather than guessing", () => {
        expect(() => ceilings(`${USDC}=500000=7`, undefined)).toThrow(
            /is not <token>=<base units>/,
        );
        expect(() => ceilings("notatoken=500000", undefined)).toThrow(
            /is not an EVM token address/,
        );
    });

    it("refuses a ceiling of zero, which would pay nothing", () => {
        expect(() => ceilings(`${USDC}=0`, undefined)).toThrow(/must be a positive integer/);
    });
});
