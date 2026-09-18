// Verification against a stub wallet: the real one needs a pool, an indexer and
// an RPC endpoint, and none of those change what is being asserted here — that
// the note, not the payer's claim about it, decides whether a call is paid for.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConsumedLedger } from "../src/ledger.js";
import type { Receipt } from "../src/payment.js";
import type { Charge } from "../src/pricing.js";
import { chainVerifier, devVerifier } from "../src/verify.js";

const CM = `0x${"ab".repeat(32)}`;
const CHARGE: Charge = { asset: 2n, base: 1000n, fee: 0n, total: 1000n };
const RECEIPT: Receipt = { pool: "lelantos", txHash: "0xdead", commitment: CM };

interface FakeNote {
    cm: string;
    asset: bigint;
    value: bigint;
}

/** Just the two members `chainVerifier` touches. */
function fakeWatch(notes: FakeNote[], status: "seen" | "timeout" = "seen") {
    return {
        awaitCommitments: async () => ({ status, missing: [], attempts: 1 }),
        notes: async () => notes,
    } as never;
}

async function freshLedger(): Promise<ConsumedLedger> {
    return ConsumedLedger.open(join(await mkdtemp(join(tmpdir(), "mcp-verify-")), "consumed.log"));
}

async function verifierOver(notes: FakeNote[], status: "seen" | "timeout" = "seen") {
    const ledger = await freshLedger();
    return {
        ledger,
        verifier: chainVerifier(fakeWatch(notes, status), ledger, { network: "shielded:31337" }),
    };
}

describe("chainVerifier", () => {
    it("accepts a note of the right asset and value", async () => {
        const { verifier } = await verifierOver([{ cm: CM, asset: 2n, value: 1000n }]);
        const result = await verifier.verify(RECEIPT, CHARGE);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.settlement.transaction).toBe("0xdead");
            // Reported from the note, so it is what actually arrived.
            expect(result.settlement.amount).toBe("1000");
        }
    });

    it("accepts an overpayment, and reports what was really paid", async () => {
        const { verifier } = await verifierOver([{ cm: CM, asset: 2n, value: 5000n }]);
        const result = await verifier.verify(RECEIPT, CHARGE);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.settlement.amount).toBe("5000");
    });

    it("refuses the same receipt twice", async () => {
        const { verifier } = await verifierOver([{ cm: CM, asset: 2n, value: 1000n }]);
        const first = await verifier.verify(RECEIPT, CHARGE);
        expect(first.ok).toBe(true);
        if (first.ok) await first.reservation.commit();

        const replay = await verifier.verify(RECEIPT, CHARGE);
        expect(replay.ok).toBe(false);
        if (!replay.ok) expect(replay.reason).toContain("already been spent");
    });

    it("hands the receipt back when the reservation is released", async () => {
        // What happens when the upstream fails: the payer can present it again.
        const { verifier } = await verifierOver([{ cm: CM, asset: 2n, value: 1000n }]);
        const first = await verifier.verify(RECEIPT, CHARGE);
        if (first.ok) first.reservation.release();

        expect((await verifier.verify(RECEIPT, CHARGE)).ok).toBe(true);
    });

    it("refuses a note worth less than the price", async () => {
        const { verifier } = await verifierOver([{ cm: CM, asset: 2n, value: 999n }]);
        const result = await verifier.verify(RECEIPT, CHARGE);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain("999");
    });

    it("refuses a note in another asset", async () => {
        const { verifier } = await verifierOver([{ cm: CM, asset: 7n, value: 1000n }]);
        expect((await verifier.verify(RECEIPT, CHARGE)).ok).toBe(false);
    });

    it("refuses a commitment the wallet never saw", async () => {
        const { verifier } = await verifierOver([], "timeout");
        const result = await verifier.verify(RECEIPT, CHARGE);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain("not observed");
    });

    it("refuses a receipt for another pool", async () => {
        const { verifier } = await verifierOver([{ cm: CM, asset: 2n, value: 1000n }]);
        const other = { ...RECEIPT, pool: "other" };
        expect((await verifier.verify(other, CHARGE)).ok).toBe(false);
    });

    it("leaves a receipt unspent when the call is refused, so it can be retried", async () => {
        const { verifier, ledger } = await verifierOver([{ cm: CM, asset: 2n, value: 999n }]);
        await verifier.verify(RECEIPT, CHARGE);
        expect(ledger.has(CM)).toBe(false);
    });
});

describe("devVerifier", () => {
    it("accepts without a chain, but still spends the receipt", async () => {
        const ledger = await freshLedger();
        const verifier = devVerifier(ledger, "shielded:31337");

        const first = await verifier.verify(RECEIPT, CHARGE);
        expect(first.ok).toBe(true);
        if (first.ok) await first.reservation.commit();
        expect((await verifier.verify(RECEIPT, CHARGE)).ok).toBe(false);
    });

    it("still refuses another pool", async () => {
        const verifier = devVerifier(await freshLedger(), "shielded:31337");
        expect((await verifier.verify({ ...RECEIPT, pool: "other" }, CHARGE)).ok).toBe(false);
    });
});
