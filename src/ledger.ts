// Which commitments have already been spent on a tool call.
//
// The shielded flow is upfront: the payer transfers first and hands over the
// receipt, so the receipt is a bearer token for one call. Nothing on chain stops
// it being presented twice — the transfer happened once and stays valid forever
// — so replay protection is entirely this file's job.
//
// Two stages rather than one, because this proxy's work can fail after payment
// is verified. A receipt is *reserved* before the upstream is called and
// *committed* only once it has answered; an upstream that errors releases it, so
// the payer is left holding a receipt it can present again instead of having
// paid for a failure. A reservation is held in memory only.
//
// Committed records are appended one per line. A single short `write` is what
// makes crash-safety cheap here: a torn tail loses at most the last record, and
// losing a record fails open — the commitment reads as unused, so the payer can
// replay it once — which is the safe direction for the party that already paid.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A claim on one receipt, held while the work it paid for is in flight.
 *
 * Both methods are idempotent and the first one called wins, so a caller may
 * release in a `finally` after committing.
 */
export interface Reservation {
    commit(): Promise<void>;
    release(): void;
}

export class ConsumedLedger {
    /** Committed: durable, and never released. */
    private readonly spent = new Set<string>();
    /** Reserved: in memory, and gone if the process dies. */
    private readonly inFlight = new Set<string>();

    private constructor(private readonly path: string) {}

    static async open(path: string): Promise<ConsumedLedger> {
        const ledger = new ConsumedLedger(path);
        await mkdir(dirname(path), { recursive: true });
        try {
            const existing = await readFile(path, "utf8");
            for (const line of existing.split("\n")) {
                const commitment = line.trim();
                if (commitment) ledger.spent.add(commitment.toLowerCase());
            }
        } catch (err) {
            // A missing file is an empty ledger. Anything else is a real failure:
            // starting from a ledger we could not read would silently re-open
            // every past payment for replay.
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        return ledger;
    }

    /** Whether this receipt is spent or currently being spent. */
    has(commitment: string): boolean {
        const key = commitment.toLowerCase();
        return this.spent.has(key) || this.inFlight.has(key);
    }

    /** Claim a receipt for one call, or `undefined` if it is already taken. */
    reserve(commitment: string): Reservation | undefined {
        const key = commitment.toLowerCase();
        if (this.has(key)) return undefined;
        this.inFlight.add(key);

        let settled = false;
        return {
            commit: async () => {
                if (settled) return;
                settled = true;
                this.spent.add(key);
                this.inFlight.delete(key);
                await appendFile(this.path, `${key}\n`, "utf8");
            },
            release: () => {
                if (settled) return;
                settled = true;
                this.inFlight.delete(key);
            },
        };
    }

    /** Receipts spent for good. In-flight ones are not counted. */
    get size(): number {
        return this.spent.size;
    }
}
