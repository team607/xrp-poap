/**
 * Shared contracts for the XRPL NFT layer.
 *
 * Every module in src/ depends on this file and nothing in this file depends
 * on any other module. Change it deliberately.
 */
import type { SubmittableTransaction, Wallet } from "xrpl";

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export type NetworkName = "testnet" | "devnet" | "mainnet";

/**
 * An event id doubles as the NFTokenTaxon. Values >= 2147483648 are reserved
 * by the protocol, so event ids must stay below that.
 */
export type EventId = number;

export const MAX_TAXON = 2_147_483_647;

/** URI field on NFTokenMint is capped at 256 bytes, pre-hex-encoding. */
export const MAX_URI_BYTES = 256;

// ---------------------------------------------------------------------------
// Gateway — the single seam between our code and the ledger.
// ---------------------------------------------------------------------------

/**
 * Outcome of a validated submit. `meta` matters: nftoken_id and offer_id are
 * only ever returned inside transaction metadata.
 */
export interface SubmitOutcome {
  hash: string;
  ledgerIndex: number;
  /** Engine result, e.g. "tesSUCCESS". */
  engineResult: string;
  validated: boolean;
  /** Raw transaction metadata. */
  meta: Record<string, unknown>;
  /** Fee actually burned, in drops. */
  fee: string;
}

export interface SubmitOptions {
  /** Override the default signer (the issuer). */
  wallet?: Wallet;
  /**
   * When false, a non-tesSUCCESS result is returned rather than thrown.
   * Defaults to true.
   */
  throwOnFailure?: boolean;
}

/**
 * Narrow interface every XRPL module accepts. Unit tests pass a fake; runtime
 * passes an XrplConnection. Nothing below the gateway is mocked.
 */
export interface XrplGateway {
  readonly network: NetworkName;
  readonly issuerAddress: string;
  request<Res = any>(req: Record<string, unknown>): Promise<Res>;
  submit(tx: SubmittableTransaction, options?: SubmitOptions): Promise<SubmitOutcome>;
  disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Mint / claim
// ---------------------------------------------------------------------------

export interface MintBadgeInput {
  /** NFTokenTaxon. All badges for one event share this. */
  eventId: EventId;
  /** Points at the metadata JSON, not the image. Max 256 bytes. */
  uri: string;
}

export interface MintResult {
  nftokenId: string;
  eventId: EventId;
  uri: string;
  txHash: string;
  ledgerIndex: number;
  fee: string;
}

export interface CreateClaimOfferInput {
  nftokenId: string;
  /** Required. An offer without a Destination is claimable by anyone. */
  destination: string;
}

export interface ClaimOffer {
  offerId: string;
  nftokenId: string;
  destination: string;
  txHash: string;
  ledgerIndex: number;
  fee: string;
}

/** Unsigned payload handed to the attendee. We never see their key. */
export interface AcceptOfferPayload {
  TransactionType: "NFTokenAcceptOffer";
  Account: string;
  NFTokenSellOffer: string;
}

export interface BurnResult {
  nftokenId: string;
  txHash: string;
  ledgerIndex: number;
  fee: string;
}

// ---------------------------------------------------------------------------
// Sponsorship
// ---------------------------------------------------------------------------

export interface SponsorResult {
  sponsored: boolean;
  /** Set when sponsored === false and the account was already activated. */
  alreadyActivated: boolean;
  address: string;
  amountXrp?: string;
  txHash?: string;
  ledgerIndex?: number;
}

export interface SponsorReservation {
  id: string;
  eventId: EventId;
  address: string;
  amountXrp: string;
}

export interface SponsorReserveInput {
  eventId: EventId;
  address: string;
  amountXrp: string;
  dailyCapXrp: string;
}

/**
 * Backing store for sponsorship guards. Implemented by the db layer.
 *
 * TWO-PHASE BY DESIGN. `reserve()` books the spend BEFORE the Payment is
 * submitted, so a lost race can never put XRP on the wire that the daily cap
 * cannot see. Check-then-pay-then-record is the drain the brief warns about in
 * section 5.4: under concurrency it pays N times and records one.
 */
export interface SponsorLedger {
  /** True when this address was already sponsored for this event. */
  hasSponsored(eventId: EventId, address: string): Promise<boolean>;
  /** Total XRP sponsored in the current UTC day, as a decimal string. */
  sponsoredTodayXrp(): Promise<string>;
  /**
   * Atomically books the spend. Returns null when the address is already
   * sponsored for this event, or when the daily cap would be crossed.
   * MUST be atomic against concurrent callers, cap included.
   */
  reserve(input: SponsorReserveInput): Promise<SponsorReservation | null>;
  /** Attach the validated Payment hash once it lands. */
  confirm(reservationId: string, txHash: string): Promise<void>;
  /** Roll back a reservation whose Payment never landed. */
  release(reservationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Claim lifecycle (finding 2/3): the slot is taken before anything is minted.
// ---------------------------------------------------------------------------

export type ClaimStatus = "pending" | "claimed" | "abandoned";

export interface ClaimRecord {
  id: string;
  eventId: EventId;
  address: string;
  nftokenId?: string | null;
  /** Persisted at claim time so an abandoned offer can be found and cancelled. */
  offerId?: string | null;
  status: ClaimStatus;
  createdAt: Date;
  expiresAt?: Date | null;
}

/**
 * Guards the mint. The attendance table is only written after the attendee
 * signs, so it cannot dedupe the mint itself — six unconfirmed claims would
 * otherwise mint six badges and lock six 0.2 XRP offer reserves.
 */
export interface ClaimRepository {
  /**
   * Atomically takes the (eventId, address) slot. Returns null when a live
   * claim already exists; the caller must then reuse that offer, never mint
   * again.
   *
   * An `abandoned` row is REOPENED and returned, not refused. The reaper marks
   * a claim abandoned when the attendee did not sign in time and its offer was
   * cancelled — refusing them would permanently lock a slow attendee out of
   * the event for having been slow.
   */
  open(input: {
    eventId: EventId;
    address: string;
    expiresAt?: Date;
  }): Promise<ClaimRecord | null>;
  find(eventId: EventId, address: string): Promise<ClaimRecord | null>;
  /** Record what the mint and the offer produced. */
  attach(id: string, patch: { nftokenId?: string; offerId?: string }): Promise<void>;
  markClaimed(id: string): Promise<void>;
  markAbandoned(id: string): Promise<void>;
  /** Pending claims past expiry whose offer still locks 0.2 XRP. */
  listExpired(now: Date, limit?: number): Promise<ClaimRecord[]>;
  /** Release the slot when the mint failed, so the attendee is not locked out. */
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Attendance is an event, not a state. A burned badge is still attendance.
 */
export type VerificationStatus =
  | "attended"
  | "attended_badge_burned"
  | "not_attended";

export interface VerifyClaimInput {
  address: string;
  eventId: EventId;
  /** Hash of the attendee's NFTokenAcceptOffer. This is the attendance record. */
  txHash: string;
  /** Defaults to gateway.issuerAddress. Scripts that mint from an ad-hoc
   *  faucet wallet pass it explicitly. */
  issuerAddress?: string;
}

/** The five assertions from section 6.4, reported individually. */
export interface VerificationChecks {
  transactionFound: boolean;
  isAcceptOffer: boolean;
  submittedByAddress: boolean;
  succeeded: boolean;
  issuerAndTaxonMatch: boolean;
}

/** How the NFTokenID was recovered from the attendance transaction. */
export type NftokenIdSource = "meta.nftoken_id" | "affected_nodes" | "none";

export interface VerifyClaimResult {
  attended: boolean;
  status: VerificationStatus;
  checks: VerificationChecks;
  /**
   * True when issuer and taxon were decoded from the NFTokenID itself because
   * the endpoint could not answer nft_info. The verdict still holds, but burn
   * status and current owner are unknown rather than false.
   */
  degraded?: boolean;
  /** Provenance of nftokenId, for auditing a verdict after the fact. */
  nftokenIdSource?: NftokenIdSource;
  /**
   * NFTokenSellOffer consumed by the accept transaction, read from the chain.
   * Persist THIS rather than an offer id supplied by a caller or a webhook.
   */
  sellOfferId?: string;
  /** Populated when the first failing check is known. */
  failedCheck?: keyof VerificationChecks;
  reason?: string;
  nftokenId?: string;
  isBurned?: boolean;
  /** Current owner. Informational only — never an input to `attended`. */
  currentOwner?: string;
  ledgerIndex?: number;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export interface RosterEntry {
  nftokenId: string;
  /** Absent when the node did not report one. Unknown, not "the issuer". */
  owner?: string;
  isBurned: boolean;
  taxon: EventId;
  serial: number;
  /** Decoded from hex when present. */
  uri?: string;
  /** True once the badge has left the issuer. Undefined when owner is unknown. */
  claimed?: boolean;
}

export interface Roster {
  eventId: EventId;
  issuer: string;
  entries: RosterEntry[];
  minted: number;
  /** Known-claimed only. An entry of unknown ownership is never counted here. */
  claimed: number;
  burned: number;
  /**
   * Entries whose owner the node did not report. `minted - claimed -
   * ownerUnknown` is the number known to still be with the issuer.
   */
  ownerUnknown: number;
  /** Present when the ledger paginated the response. */
  marker?: unknown;
}

export interface NftInfo {
  nftokenId: string;
  /** Absent when the node did not report one. Never an empty string. */
  owner?: string;
  issuer: string;
  taxon: EventId;
  serial: number;
  isBurned: boolean;
  uri?: string;
  flags: number;
}

export interface NftHistoryEntry {
  txHash: string;
  ledgerIndex: number;
  changeType: string;
  owner?: string;
  seller?: string;
  buyer?: string;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Metadata (XLS-24d shaped)
// ---------------------------------------------------------------------------

export interface BadgeAttribute {
  trait_type: string;
  value: string | number;
}

export interface BadgeMetadata {
  schema: string;
  nftType: "art.v0";
  name: string;
  description: string;
  /** ipfs://CID of the badge artwork. */
  image: string;
  collection?: { name: string; family?: string };
  attributes: BadgeAttribute[];
}

export interface PinResult {
  cid: string;
  /** ipfs://CID/... form, ready for the NFTokenMint URI field. */
  uri: string;
  /** Public gateway URL for humans. */
  gatewayUrl: string;
  size?: number;
}

/** Swappable so tests and offline runs do not hit Pinata. */
export interface IpfsPinner {
  pinFile(input: {
    data: Uint8Array | Buffer;
    filename: string;
    contentType?: string;
  }): Promise<PinResult>;
  pinJson(input: { json: unknown; name: string }): Promise<PinResult>;
}

// ---------------------------------------------------------------------------
// Attendance index (section 6.5)
// ---------------------------------------------------------------------------

export interface AttendanceRecord {
  id?: string;
  eventId: EventId;
  address: string;
  nftokenId: string;
  offerId?: string | null;
  txHash: string;
  ledgerIndex: number;
  claimedAt?: Date;
}

export interface AttendanceRepository {
  insert(record: AttendanceRecord): Promise<AttendanceRecord>;
  findByEventAndAddress(
    eventId: EventId,
    address: string,
  ): Promise<AttendanceRecord | null>;
  listByEvent(
    eventId: EventId,
    opts?: { limit?: number; offset?: number },
  ): Promise<AttendanceRecord[]>;
  countByEvent(eventId: EventId): Promise<number>;
  listByAddress(address: string): Promise<AttendanceRecord[]>;
}
