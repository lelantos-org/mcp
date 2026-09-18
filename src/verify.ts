// Checking that a presented receipt is a real, unspent payment to us.
//
// Ownership comes for free from the viewing key: `notes()` returns exactly the
// notes this key could decrypt, so a commitment appearing there is already a
// note addressed to us. There is no separate "is it mine" check to make.
//
// Both verifiers share [`verifier`], which owns everything that is true of any
// payment — the pool must be ours, a receipt spends once, a success settles.
// That leaves each one supplying only what it actually differs on, which is why
// `devVerifier` reads as "no chain check" rather than as a second copy of the
// procedure with the checks deleted.
//
// What this cannot establish: that the payment was made *for this request*. An
// upfront shielded transfer carries no reference to the HTTP call it pays for,
// so any unspent receipt of the right size redeems any call at that price. The
// ledger stops a receipt being used twice, and `gate.ts` stops a cheap receipt
// buying an expensive tool; binding a payment to one request would need a memo
// field the network does not have.

import type { Hex32, ReadOnlyWalletApi } from "@lelantos-org/sdk";
import { LELANTOS_POOL, type SettleResponse } from "@lelantos-org/sdk/x402";
import type { ConsumedLedger, Reservation } from "./ledger.js";
import type { Receipt } from "./payment.js";
import type { Charge } from "./pricing.js";

export type Verification =
    /**
     * `reservation` is the caller's obligation: commit it once the work the
     * payment bought has been done, or release it if that work failed. Until one
     * of the two happens the receipt counts as spent, so it cannot fund a
     * concurrent call.
     */
    | { ok: true; settlement: SettleResponse; reservation: Reservation }
    | { ok: false; reason: string };

export interface Verifier {
    verify(receipt: Receipt, charge: Charge): Promise<Verification>;
}

/** What one verifier contributes: everything chain-specific, and nothing else. */
type Check = (
    receipt: Receipt,
    charge: Charge,
) => Promise<{ ok: false; reason: string } | { ok: true; paid?: string }>;

export interface ChainVerifierOptions {
    network: string;
    /** How long to wait for the indexer to show the commitment. Default 30 s. */
    timeoutMs?: number;
}

/**
 * Verify against the pool through a watch-only wallet.
 *
 * The wallet must already be connected; syncing happens inside
 * `awaitCommitments`, which drives it until the commitment lands or the wait
 * expires.
 */
export function chainVerifier(
    watch: ReadOnlyWalletApi,
    ledger: ConsumedLedger,
    opts: ChainVerifierOptions,
): Verifier {
    const timeoutMs = opts.timeoutMs ?? 30_000;

    return verifier(ledger, opts.network, async (receipt, charge) => {
        const seen = await watch.awaitCommitments([receipt.commitment as Hex32], {
            timeoutMs,
            throwOnTimeout: false,
        });
        if (seen.status !== "seen") {
            return {
                ok: false,
                reason: `commitment not observed within ${timeoutMs} ms (${seen.status})`,
            };
        }

        const note = (await watch.notes()).find(
            (candidate) => candidate.cm.toLowerCase() === receipt.commitment.toLowerCase(),
        );
        if (!note) {
            // `awaitCommitments` saw it, so this is a race with a concurrent
            // sync rather than a bad payment; the payer may retry.
            return { ok: false, reason: "commitment is not in this wallet's notes" };
        }
        if (BigInt(note.asset) !== charge.asset) {
            return { ok: false, reason: `paid in asset ${note.asset}, tool wants ${charge.asset}` };
        }
        if (BigInt(note.value) < charge.total) {
            return { ok: false, reason: `paid ${note.value} units, tool costs ${charge.total}` };
        }
        return { ok: true, paid: note.value.toString() };
    });
}

/**
 * Accept any well-formed receipt without consulting the chain.
 *
 * For running with no pool, indexer or RPC in reach. Replay protection still
 * applies, so the paywall behaves as it does in production; it simply cannot
 * tell a real payment from an invented one. Never enable it anywhere a real
 * payer can reach.
 */
export function devVerifier(ledger: ConsumedLedger, network: string): Verifier {
    return verifier(ledger, network, async () => ({ ok: true }));
}

/** The part that is the same whatever `check` does. */
function verifier(ledger: ConsumedLedger, network: string, check: Check): Verifier {
    return {
        async verify(receipt, charge) {
            if (receipt.pool !== LELANTOS_POOL) {
                return { ok: false, reason: `payload names pool "${receipt.pool}"` };
            }
            // Checked before `check`, so a replayed receipt is refused in
            // milliseconds instead of holding a connection open for the timeout.
            if (ledger.has(receipt.commitment)) return spent();

            const checked = await check(receipt, charge);
            if (!checked.ok) return checked;

            // Reserved last: every refusal above leaves the receipt usable, so a
            // payer whose call failed for our reasons can present it again.
            const reservation = ledger.reserve(receipt.commitment);
            if (!reservation) return spent();

            return {
                ok: true,
                reservation,
                settlement: {
                    success: true,
                    transaction: receipt.txHash,
                    network,
                    ...(checked.paid ? { amount: checked.paid } : {}),
                },
            };
        },
    };
}

function spent(): Verification {
    return { ok: false, reason: "this payment has already been spent on a call" };
}
