import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConsumedLedger } from "../src/ledger.js";

const CM = `0x${"ab".repeat(32)}`;
const OTHER = `0x${"cd".repeat(32)}`;

async function ledgerPath(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), "mcp-ledger-")), "consumed.log");
}

describe("ConsumedLedger", () => {
    it("reserves a commitment once", async () => {
        const ledger = await ConsumedLedger.open(await ledgerPath());
        expect(ledger.reserve(CM)).toBeDefined();
        // Still in flight, so it cannot fund a second, concurrent call.
        expect(ledger.reserve(CM)).toBeUndefined();
        expect(ledger.has(CM)).toBe(true);
    });

    it("keeps a committed commitment spent", async () => {
        const ledger = await ConsumedLedger.open(await ledgerPath());
        await ledger.reserve(CM)?.commit();
        expect(ledger.reserve(CM)).toBeUndefined();
        expect(ledger.size).toBe(1);
    });

    it("hands a released commitment back", async () => {
        // The upstream failed: the payer keeps a usable receipt.
        const ledger = await ConsumedLedger.open(await ledgerPath());
        ledger.reserve(CM)?.release();
        expect(ledger.has(CM)).toBe(false);
        expect(ledger.reserve(CM)).toBeDefined();
    });

    it("ignores a release after a commit", async () => {
        const ledger = await ConsumedLedger.open(await ledgerPath());
        const reservation = ledger.reserve(CM);
        await reservation?.commit();
        reservation?.release();
        expect(ledger.has(CM)).toBe(true);
        expect(ledger.size).toBe(1);
    });

    it("ignores a commit after a release", async () => {
        const ledger = await ConsumedLedger.open(await ledgerPath());
        const reservation = ledger.reserve(CM);
        reservation?.release();
        await reservation?.commit();
        expect(ledger.has(CM)).toBe(false);
    });

    it("treats case as insignificant, so a re-cased receipt cannot replay", async () => {
        const ledger = await ConsumedLedger.open(await ledgerPath());
        await ledger.reserve(CM.toLowerCase())?.commit();
        expect(ledger.reserve(CM.toUpperCase())).toBeUndefined();
    });

    it("survives a restart", async () => {
        const path = await ledgerPath();
        await (await ConsumedLedger.open(path)).reserve(CM)?.commit();

        const second = await ConsumedLedger.open(path);
        expect(second.has(CM)).toBe(true);
        expect(second.reserve(CM)).toBeUndefined();
    });

    it("does not persist a reservation that was never committed", async () => {
        // A crash mid-call must fail open: the payer already paid.
        const path = await ledgerPath();
        (await ConsumedLedger.open(path)).reserve(CM);
        expect((await ConsumedLedger.open(path)).has(CM)).toBe(false);
    });

    it("writes one line per committed claim", async () => {
        const path = await ledgerPath();
        const ledger = await ConsumedLedger.open(path);
        await ledger.reserve(CM)?.commit();
        await ledger.reserve(OTHER)?.commit();
        expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
    });
});
