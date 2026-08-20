# XRPL NFT Layer: Implementation Brief

Scope: **only** the NFT minting, claiming, and verification layer for a POAP-style
attendance app on XRP Ledger mainnet. No UI, no auth, no event management, no
payments. Those are separate concerns and are explicitly out of scope for this
document.

Target: a working library plus a thin API surface that can mint a badge, hand it
to an attendee's wallet, and prove after the fact that they received it.

---

## 0. The one thing to understand before starting

**There is no smart contract. There is nothing to deploy.**

If you are coming from Ethereum, unlearn this first. NFTs on XRPL are native
protocol transaction types, not user-deployed code. `NFTokenMint` is a
transaction type in the same way `Payment` is. There is no Solidity, no
compilation step, no contract address, no ABI, no gas estimation.

"Deploying to mainnet" here means exactly two things:

1. Point your WebSocket client at a mainnet endpoint instead of a testnet one.
2. Use an account funded with real XRP instead of one funded from a faucet.

That is the entire cutover. The transaction code is byte-for-byte identical
between testnet and mainnet.

---

## 1. Prerequisites

### Tooling

| Item | Notes |
|---|---|
| Node.js 20+ | LTS |
| `xrpl` (npm) | The official JS client. Handles signing, autofill, submit-and-wait |
| Xaman SDK (`xumm-sdk`) | Only needed when attendees sign from their phone. Optional for the core library |
| Pinata / web3.storage account | Free tier. IPFS hosting for badge metadata |
| A funded mainnet XRPL account | See funding below |

### Accounts you need

- **Issuer account (mainnet).** Owns the badges before they are claimed. Its
  secret seed lives in a server-side environment variable and never touches the
  client. Generate offline, fund by sending XRP to the address.
- **Test attendee account (mainnet).** A second real account you control, used
  to rehearse a full claim on mainnet before demo day.
- **Two testnet accounts.** Free via `client.fundWallet()`. Do all development
  here.

### Funding the issuer

You need to actually buy XRP and send it to the issuer address. Any exchange
that supports XRP withdrawals works. Note the amount, but more importantly note
that **XRPL requires the destination account to be activated by an initial
payment of at least the base reserve before it exists on the ledger at all.**
Sending less than the base reserve to a brand new address fails.

Recommended issuer float: **10 XRP.** See section 7 for the math. This is more
than enough and leaves headroom for mistakes.

---

## 2. Network endpoints

```
Testnet   wss://s.altnet.rippletest.net:51233
Mainnet   wss://xrplcluster.com
```

`xrplcluster.com` is a public cluster that also serves Clio methods, which you
need for `nft_info`, `nft_history`, and `nfts_by_issuer`. Public Clio servers
carry no SLA. Fine for a hackathon, not fine for production. Do not hardcode the
endpoint; read it from `XRPL_ENDPOINT`.

---

## 3. Environment variables

```
XRPL_ENDPOINT=wss://s.altnet.rippletest.net:51233
XRPL_NETWORK=testnet              # testnet | mainnet, used as a guard rail
ISSUER_SEED=s...                  # NEVER expose to the client
ISSUER_ADDRESS=r...
SPONSOR_ENABLED=true              # whether to fund unactivated attendee wallets
SPONSOR_AMOUNT_XRP=1.5
PINATA_JWT=...
```

Add a startup assertion: if `XRPL_NETWORK=mainnet` and the endpoint string
contains `altnet` or `devnet`, throw. Cheap insurance against demoing on the
wrong chain.

---

## 4. Design decisions already made

These are settled. Do not re-litigate them during implementation.

**Badges are soulbound.** Mint with `tfTransferable` unset. A non-transferable
NFT can only move to or from the issuer, so nobody can sell their attendance
proof. Flags are immutable and can only be set at mint time, so this cannot be
changed later.

**Badges are burnable by the issuer.** Set `tfBurnable` (value `1`). This lets
you revoke a badge issued in error. The holder can always burn their own NFT
regardless of this flag.

**Flags value: `1`.** That is `tfBurnable` alone. Not `9`, not `11`.

**`TransferFee` must be omitted or `0`.** The field is invalid when
`tfTransferable` is not set and the transaction will fail if you include it.

**`NFTokenTaxon` is the event ID.** All badges for one event share a taxon. This
is what makes `nfts_by_issuer?taxon=N` return the attendee roster for that event.
Use a stable integer per event. Values at or above `2147483648` are reserved, so
keep event IDs well below that.

**Attendance is an event, not a state.** Verification must never be "does this
wallet currently hold the NFT". It must be "did this wallet ever accept an NFT
issued by us with this taxon". Burned badges still count as attendance. This is
the core architectural constraint of the whole system.

---

## 5. The transaction flows

### 5.1 Mint

```js
import { Client, Wallet, convertStringToHex } from "xrpl";

const client = new Client(process.env.XRPL_ENDPOINT);
await client.connect();
const issuer = Wallet.fromSeed(process.env.ISSUER_SEED);

const tx = {
  TransactionType: "NFTokenMint",
  Account: issuer.address,
  URI: convertStringToHex("ipfs://<CID>/metadata.json"),
  Flags: 1,                    // tfBurnable, soulbound
  NFTokenTaxon: eventId,
};

const result = await client.submitAndWait(await client.autofill(tx), {
  wallet: issuer,
});

const nftokenId = result.result.meta.nftoken_id;
```

Notes:
- `URI` is capped at **256 bytes** and must be hex-encoded. Point it at the
  metadata JSON, not the image.
- `nftoken_id` comes from transaction metadata, not from the top level of the
  result. It is not returned anywhere else, so persist it immediately.
- Check `result.result.meta.TransactionResult === "tesSUCCESS"` before trusting
  anything downstream.

### 5.2 Create the claim offer

```js
const tx = {
  TransactionType: "NFTokenCreateOffer",
  Account: issuer.address,
  NFTokenID: nftokenId,
  Amount: "0",
  Flags: 1,                    // tfSellNFToken
  Destination: attendeeAddress,
};

const result = await client.submitAndWait(await client.autofill(tx), {
  wallet: issuer,
});

const offerId = result.result.meta.offer_id;
```

`Destination` is not optional in this design. Without it, **anyone** can accept
the offer and steal the badge. With it, only that specific address can.

`Flags: 1` here means `tfSellNFToken`. Note that the same numeric value means
`tfBurnable` on `NFTokenMint`. Flag values are per-transaction-type. Use the
named enums from the library rather than magic numbers to avoid this trap.

### 5.3 Accept (attendee side)

```js
const tx = {
  TransactionType: "NFTokenAcceptOffer",
  Account: attendeeAddress,
  NFTokenSellOffer: offerId,
};
```

This is signed by the attendee, not you. Via Xaman SDK you construct this
payload, render it as a QR code or deeplink, and the attendee approves in their
wallet app. You never see their key.

**Persist the resulting transaction hash. This hash is the attendance record.**

### 5.4 Sponsor an unactivated wallet

A brand new address cannot receive an NFT. It does not exist on the ledger until
funded. Before creating the offer, check:

```js
try {
  await client.request({ command: "account_info", account: attendeeAddress });
  // exists
} catch (e) {
  if (e.data?.error === "actNotFound") {
    // send SPONSOR_AMOUNT_XRP via a Payment transaction first
  }
}
```

Guard this endpoint. Anyone who can hit it with an arbitrary address can drain
the issuer wallet 1.5 XRP at a time. At minimum: one sponsorship per event code
per address, plus a hard daily cap on total sponsored XRP.

---

## 6. Verification

### 6.1 The roster query

```js
await client.request({
  command: "nfts_by_issuer",
  issuer: process.env.ISSUER_ADDRESS,
  nft_taxon: eventId,
});
```

Returns every badge for the event with `owner` and `is_burned` on each entry.
This is the single most useful query in the system.

### 6.2 Single badge status

```js
await client.request({ command: "nft_info", nft_id: nftokenId });
```

Returns `is_burned`, `owner`, `issuer`, `nft_taxon`, `nft_serial`. Works on
burned tokens.

### 6.3 Full chain of custody

```js
await client.request({ command: "nft_history", nft_id: nftokenId });
```

Mint through transfers through burn. Returns successful transactions only.

### 6.4 Verification logic

Given a claimed attendance record `(address, eventId, txHash)`:

1. Fetch the transaction by hash from the ledger.
2. Assert it is an `NFTokenAcceptOffer` submitted by `address`.
3. Assert it succeeded.
4. Extract the `NFTokenID` from its metadata.
5. Assert the NFT's issuer is your issuer address and its taxon is `eventId`.

If all five pass, they attended. The current existence of the NFT is
**irrelevant** to this check. A burned badge yields "attended, badge burned",
not "did not attend".

### 6.5 Local index

Keep a table. This is not cheating, it is how every chain application works. The
ledger is the source of truth; the table is the index.

```sql
CREATE TABLE attendance (
  id            bigserial PRIMARY KEY,
  event_id      integer     NOT NULL,
  address       text        NOT NULL,
  nftoken_id    text        NOT NULL,
  offer_id      text,
  tx_hash       text        NOT NULL,
  ledger_index  bigint      NOT NULL,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, address)
);
```

Never read attendance from the chain on a page load. Read from this table, and
expose a separate verify endpoint that re-derives from the chain on demand.

---

## 7. Cost model

Current network parameters:

- Base reserve: **1 XRP** per account, locked while the account exists
- Owner reserve: **0.2 XRP** per ledger object owned
- Transaction fee: roughly **0.000015 XRP**, burned, not paid to anyone

Reserves are locked in your own account, not transferred. They unlock when the
object goes away.

Per-object impact:

| Object | Reserve | Who holds it |
|---|---|---|
| `NFTokenPage` (holds up to 32 NFTs, typically 16 to 24) | 0.2 XRP per page | Whoever holds the NFTs |
| `NFTokenOffer` (one per pending claim) | 0.2 XRP | The issuer, until accepted or cancelled |

Rule of thumb for NFTs: roughly **1/12 XRP per badge** in page reserve.

Worked example, 100 attendees:

- Issuer base reserve: 1 XRP
- 100 badges held by issuer pre-claim: about 0.83 XRP
- Pending offers: **0.2 XRP each, simultaneously open**

That last line is the trap. Pre-creating 100 offers locks 20 XRP at once.
**Create offers lazily, one per attendee at claim time.** With serial claims your
peak lock is a handful of offers, so a 10 XRP float is comfortable.

Actual spend (burned fees) for 100 attendees is under 0.01 XRP. The rest is
working capital that returns to you.

Sponsorship at 1.5 XRP per attendee for 100 attendees is 150 XRP and this money
is genuinely gone from the issuer's control. Budget it separately from the float.

---

## 8. Build order

Do these in order. Do not skip to the UI.

1. **Testnet script, no UI, no framework.** One file. Fund two wallets via
   `client.fundWallet()`, mint, create a destination-locked offer, accept from
   the second wallet, query `account_nfts` to confirm. Roughly 80 lines. Get
   this green before anything else.
2. **Burn test.** Burn the badge from the attendee wallet, then call `nft_info`
   and `nft_history` and inspect the raw responses. Confirm for yourself exactly
   which fields survive a burn on the endpoint you plan to use. Do not take this
   document's word for it. This is a 20 minute check that de-risks the entire
   verification story.
3. **Extract to a library.** `mint()`, `createClaimOffer()`, `verifyClaim()`,
   `getRoster()`. Network-agnostic, endpoint injected.
4. **Metadata pipeline.** Upload badge image and JSON to IPFS, return the CID.
5. **API routes.** Claim initiation, Xaman payload creation, webhook or poll for
   signature completion, persist the record.
6. **Mainnet rehearsal.** Switch endpoint, fund the real issuer, run one full
   claim with your own second account. Confirm on an explorer.

---

## 9. Mainnet cutover checklist

- [ ] Issuer account generated offline, seed stored only in server env
- [ ] Issuer funded with at least 10 XRP
- [ ] `XRPL_NETWORK=mainnet` and endpoint guard assertion passes
- [ ] One complete claim rehearsed on mainnet with a real second account
- [ ] Badge visible on an explorer (Bithomp or XRPScan) under the issuer address
- [ ] Metadata JSON resolves from a public IPFS gateway, not just your local node
- [ ] Sponsorship endpoint rate limited and daily-capped
- [ ] Offers created lazily, verified by checking issuer's pending offer count
- [ ] `verifyClaim()` returns "attended" for a badge you deliberately burned
- [ ] Issuer seed absent from the repo, from the client bundle, and from logs

---

## 10. Gotchas

- **Flag values collide across transaction types.** `1` is `tfBurnable` on mint
  and `tfSellNFToken` on create-offer. Use named enums.
- **`URI` must be hex.** A plain string will not error usefully, it will just be
  wrong. Cap 256 bytes.
- **`nftoken_id` and `offer_id` live in transaction metadata.** Easy to miss.
- **An offer without `Destination` is claimable by anyone.**
- **Unfunded addresses cannot receive NFTs.** Check `account_info` first.
- **Flags are immutable after mint.** Decide soulbound before, not after.
- **`TransferFee` with `tfTransferable` unset fails the transaction.**
- **Public Clio servers have no SLA.** Have a fallback endpoint configured.
- **Never verify attendance by checking current NFT ownership.**
