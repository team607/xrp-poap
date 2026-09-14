/**
 * The only object that holds TREASURY_MASTER_KEY, and the only code that turns
 * a treasury row back into a wallet.
 *
 * The key is a `#private` field. It cannot be spread, enumerated or
 * JSON.stringify'd off the vault, so a vault that ends up in a log line — as a
 * property of deps, inside an error — carries its key id and nothing else.
 */
import { Wallet } from "xrpl";
import { ConfigError } from "../errors.js";
import type { EventId, TreasuryRecord } from "../types.js";
import { decodeMasterKey, keyIdOf, openSecret, sealSecret } from "./seal.js";

/** What a seal is bound to. Moving a sealed seed to another row breaks it. */
function sealContext(eventId: EventId, address: string): string {
  return `poap-treasury:v1:${eventId}:${address}`;
}

export class TreasuryVault {
  readonly #key: Buffer;
  readonly keyId: string;

  constructor(masterKey: string) {
    this.#key = decodeMasterKey(masterKey);
    this.keyId = keyIdOf(this.#key);
  }

  /**
   * A new treasury: the address to publish, and the seed sealed for storage.
   * The plaintext seed exists only inside this call.
   */
  create(eventId: EventId): { address: string; sealedSeed: string } {
    const wallet = Wallet.generate();
    const seed = wallet.seed;
    if (!seed) {
      throw new ConfigError("xrpl generated a treasury wallet without a seed.", { eventId });
    }
    return {
      address: wallet.classicAddress,
      sealedSeed: sealSecret(seed, this.#key, sealContext(eventId, wallet.classicAddress)),
    };
  }

  /**
   * Open a treasury to sign with. Refuses a seed that does not derive the
   * address stored beside it: paying from a wallet the organiser never funded
   * would fail anyway, and the mismatch means the row was tampered with.
   */
  open(record: TreasuryRecord): Wallet {
    const seed = openSecret(record.sealedSeed, this.#key, sealContext(record.eventId, record.address));
    const wallet = Wallet.fromSeed(seed);
    if (wallet.classicAddress !== record.address) {
      throw new ConfigError(
        `The sealed seed for event ${record.eventId} does not derive its treasury address.`,
        { eventId: record.eventId, address: record.address },
      );
    }
    return wallet;
  }

  toJSON(): { keyId: string } {
    return { keyId: this.keyId };
  }
}
