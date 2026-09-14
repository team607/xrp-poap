/**
 * Every event's treasury: making one, finding one, and opening one to pay.
 *
 * A deployment without TREASURY_MASTER_KEY still has this service — it can say
 * which address an event's treasury is at, if one was made — but it cannot make
 * or open one, so `configured` is false and nobody is paid. The badge flow does
 * not depend on it.
 */
import type { Wallet } from "xrpl";
import type { EventId, EventRepository, TreasuryRecord, TreasuryRepository } from "../types.js";
import type { TreasuryVault } from "./vault.js";

/** One treasury, ready to sign. */
export interface TreasuryHandle {
  eventId: EventId;
  address: string;
  /**
   * Decrypts the seed. Call it at the moment of signing and let the wallet go
   * out of scope straight after: the fewer places a live wallet sits, the fewer
   * places it can be logged from.
   */
  open(): Wallet;
}

export interface BackfillReport {
  created: number;
  existing: number;
  failed: number;
}

/** Events are read in pages this size when backfilling. */
const BACKFILL_PAGE = 200;

export class TreasuryService {
  readonly #vault: TreasuryVault | undefined;

  constructor(
    private readonly repo: TreasuryRepository,
    vault?: TreasuryVault,
  ) {
    this.#vault = vault;
  }

  /** True when this server can create and open treasuries. */
  get configured(): boolean {
    return this.#vault !== undefined;
  }

  /** Which master key this server holds, as a short non-reversible label. */
  get keyId(): string | undefined {
    return this.#vault?.keyId;
  }

  find(eventId: EventId): Promise<TreasuryRecord | null> {
    return this.repo.find(eventId);
  }

  /** The event's treasury, making one first if it has none and this server can. */
  async ensure(eventId: EventId): Promise<TreasuryRecord | null> {
    const existing = await this.repo.find(eventId);
    if (existing || !this.#vault) return existing;
    const { record } = await this.repo.insertIfAbsent({ eventId, ...this.#vault.create(eventId) });
    return record;
  }

  /** Null when there is no treasury, or no key to open it with. */
  async handle(eventId: EventId): Promise<TreasuryHandle | null> {
    const vault = this.#vault;
    if (!vault) return null;
    const record = await this.repo.find(eventId);
    if (!record) return null;
    return { eventId, address: record.address, open: () => vault.open(record) };
  }

  /**
   * Give every event that has no treasury one. Run at boot.
   *
   * Idempotent, and safe on two instances at once: insertIfAbsent lets the
   * first writer win. One event failing does not stop the rest — it is
   * reported, and `ensure()` makes the treasury on first use instead.
   */
  async backfill(
    events: Pick<EventRepository, "list">,
    onError?: (eventId: EventId, err: unknown) => void,
  ): Promise<BackfillReport> {
    const report: BackfillReport = { created: 0, existing: 0, failed: 0 };
    const vault = this.#vault;
    if (!vault) return report;

    for (let offset = 0; ; offset += BACKFILL_PAGE) {
      const page = await events.list({ limit: BACKFILL_PAGE, offset });
      for (const event of page) {
        try {
          if (await this.repo.find(event.eventId)) {
            report.existing += 1;
            continue;
          }
          const { created } = await this.repo.insertIfAbsent({
            eventId: event.eventId,
            ...vault.create(event.eventId),
          });
          if (created) report.created += 1;
          else report.existing += 1;
        } catch (err) {
          report.failed += 1;
          onError?.(event.eventId, err);
        }
      }
      if (page.length < BACKFILL_PAGE) break;
    }

    return report;
  }

  toJSON(): { configured: boolean; keyId?: string } {
    return { configured: this.configured, ...(this.keyId ? { keyId: this.keyId } : {}) };
  }
}
