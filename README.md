# XRPL badges

Attendance badges as soulbound NFTs on the XRP Ledger, and the money an event
hands out around them: every event has a wallet of its own, attendees are paid
an allowance when their badge is issued, and they spend it at the event's
vendors.

Badges are minted with `tfBurnable` and never `tfTransferable`, so nobody can
move one. Attendance is the accept transaction, not current ownership — a
burned badge is still attendance.

## Run it

Node 22 or newer, and Postgres.

```bash
npm install
cp .env.example .env
```

`.env` needs, at a minimum:

| | |
|---|---|
| `XRPL_ENDPOINT`, `XRPL_NETWORK` | a Clio endpoint and the network it belongs to; the server refuses to start if they disagree |
| `ISSUER_SEED`, `ISSUER_ADDRESS` | the minting account. `npm run keygen` makes one offline |
| `XUMM_API_KEY`, `XUMM_API_SECRET` | from apps.xaman.dev — wallets are proven and transactions signed through Xaman |
| `DATABASE_URL` | Postgres |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` | the desk and console login. `npm run admin:hash` prints both lines |
| `SESSION_SECRET` | signs the session cookie. `openssl rand -hex 32` |
| `TREASURY_MASTER_KEY` | seals every event wallet's seed. `openssl rand -hex 32`. Without it no event can pay anyone; lose it and the XRP in those wallets is gone |
| `BADGE_BASE_URL` | goes inside every badge's URI, which is immutable. Use a domain you will keep |

Then:

```bash
npm run migrate
npm run dev
```

http://localhost:3000 — `PORT` moves it.

For a click-through on testnet with an issuer it remembers between runs:

```bash
npm run demo
```

## The pages

| | |
|---|---|
| `/` and `/events` | every event, public |
| `/events/:eventId` | one event, its badges read off the ledger |
| `/register/:eventId` | an attendee proves a wallet and signs up |
| `/attend/:eventId` | the attendee's pass: their badge, their allowance, the store, their orders |
| `/volunteer` | the desk: look somebody up, issue their badge. Admin login |
| `/vendor` | the counter: paid orders, handed over by scanning. Vendor wallet login |
| `/admin` | organiser console: events, the event wallet, vendors, rosters. Admin login |

## The flow

Three phases. The issuer spends only in phase 1, never sees the attendee's key
in phase 2, and trusts only the ledger in phase 3.

```mermaid
sequenceDiagram
    autonumber
    actor Desk as Volunteer desk
    actor Att as Attendee wallet
    participant API as API (issuer side)
    participant Slot as claims (slot guard)
    participant Book as allowances (the event's book)
    participant XRPL as XRP Ledger
    participant Idx as attendance index

    Note over Desk,Idx: 1 — Claim. Everything the issuer spends happens here.

    Desk->>API: POST /events/{eventId}/claims {address}
    Note right of Desk: Behind an operator session. The mint spends<br/>the issuer's XRP and the event's treasury,<br/>so nothing anonymous may start it.
    API->>Idx: findByEventAndAddress
    Idx-->>API: no record
    API->>Slot: open(eventId, address, expiresAt)
    Note right of Slot: UNIQUE(event_id, address) IS the mint guard.<br/>Taken before any spend — six retries<br/>would otherwise mint six badges.
    Slot-->>API: slot held

    opt the event pays its attendees
        API->>Book: reserve(eventId, address, amount)
        Note right of Book: Booked BEFORE the money moves, and the INSERT<br/>checks the event's budget under an advisory lock.<br/>Check-then-pay-then-record pays N times<br/>under concurrency and records one.
        API->>XRPL: Payment from the event's own treasury<br/>(allowance + whatever the wallet lacks + fee buffer)
        XRPL-->>API: tesSUCCESS
        API->>Book: confirm(txHash)
    end

    API->>XRPL: NFTokenMint (Flags=tfBurnable, NFTokenTaxon=eventId)
    XRPL-->>API: meta.nftoken_id
    API->>Slot: attach(nftokenId)
    API->>XRPL: NFTokenCreateOffer (Amount 0, Destination=address)
    XRPL-->>API: meta.offer_id
    API->>Slot: attach(offerId)
    Note right of API: One offer, created lazily at claim time.<br/>Each open offer locks 0.2 XRP.<br/>Destination is what stops anyone else taking it.
    API-->>Desk: 201 {offerId, accept payload, Xaman QR}
    Att->>API: GET /events/{eventId}/claims/for/{address}
    API-->>Att: 200 {offerId, accept payload, Xaman QR}
    Note right of Att: The attendee's own page READS the offer rather<br/>than creating one. Publishing it is safe: only<br/>the Destination can accept, with a key we never hold.

    Note over Desk,Idx: 2 — Sign. The issuer never sees the attendee's key.

    Att->>XRPL: NFTokenAcceptOffer (signed in the attendee's wallet)
    XRPL-->>Att: txHash

    Note over Desk,Idx: 3 — Record. The chain is the authority, not the caller.

    Att->>API: POST /confirm {txHash} — or the Xaman webhook
    API->>XRPL: tx(txHash), then nft_info(nftokenId)
    XRPL-->>API: tx_json, meta.nftoken_id, issuer, taxon
    Note right of API: Five checks: found · is-accept-offer ·<br/>submitted-by-address · succeeded ·<br/>issuer-and-taxon match. All five, or no row.
    API->>Idx: insert(eventId, address, nftokenId, txHash, ledgerIndex)
    API->>Slot: markClaimed
    API-->>Att: 200 attended

    opt attendee never signs — the payload expires
        API->>Slot: listExpired()
        API->>XRPL: NFTokenCancelOffer
        Note right of XRPL: npm run reap:offers — reclaims the 0.2 XRP<br/>and reopens the slot, so being slow<br/>does not cost the attendee their badge.
    end
```

### Why a burned badge still verifies

Verification replays the attendance transaction. It never asks who holds the
badge now, which is what makes a burn irrelevant.

```mermaid
sequenceDiagram
    autonumber
    actor V as Verifier
    participant API
    participant XRPL as XRP Ledger

    V->>API: GET /verify?address&eventId&txHash
    API->>XRPL: tx(txHash)
    XRPL-->>API: NFTokenAcceptOffer · tesSUCCESS · meta.nftoken_id
    API->>XRPL: nft_info(nftokenId)
    XRPL-->>API: issuer ✓ · taxon ✓ · is_burned = true
    API-->>V: attended: true — status: attended_badge_burned

    Note over API,XRPL: account_nfts would return 0 for this wallet.<br/>It is never consulted. Attendance is an event, not a state.
```

## Buying at the event

The allowance is the attendee's own XRP once it lands: they pay the vendor
directly, and nothing is handed over until the ledger says the payment
happened.

```mermaid
sequenceDiagram
    autonumber
    actor Att as Attendee pass
    actor Ven as Vendor counter
    participant API
    participant XRPL as XRP Ledger

    Att->>API: POST /api/events/{eventId}/purchases {itemId, quantity}
    Note right of API: Holds the stock for a few minutes and returns<br/>a Payment to approve. Nothing is sold yet.
    API-->>Att: 201 {purchase, Xaman payload, collect secret}
    Att->>XRPL: Payment to the vendor's wallet (signed in Xaman)
    Att->>API: POST /api/purchases/{id}/confirm {txHash}
    API->>XRPL: tx(txHash)
    XRPL-->>API: amount ✓ · destination ✓ · succeeded ✓
    Note right of API: Only now is it an order. A vendor never sees<br/>anything the ledger has not settled.
    API-->>Ven: GET /api/vendor/orders — it appears at the counter

    Att->>API: POST /api/purchases/{id}/collect {secret}
    Note right of Att: The secret came with the order and is held by<br/>that phone alone: an address is public, so it<br/>is not enough to collect somebody else's order.
    API-->>Att: 200 {code, expiresAt} — shown as a QR for three minutes
    Ven->>API: POST /api/vendor/handover {code}
    API-->>Ven: 200 handed over, on both screens
```

## Commands

| | |
|---|---|
| `npm run dev` | the server, reloading |
| `npm run demo` | testnet click-through with the demo harness |
| `npm test` | the test suite; nothing in it touches the network |
| `npm run typecheck` | |
| `npm run migrate` | apply migrations; safe to re-run |
| `npm run keygen` | an issuer, offline. Prints the address, writes the seed to a 0600 file |
| `npm run admin:hash` | the operator password hash |
| `npm run e2e:testnet` | the whole flow against testnet, 33 assertions |
| `npm run e2e:burn` | burn behaviour, 13 assertions |
| `npm run check:cutover` | pre-mainnet checks against a running server |
| `npm run reap:offers` | cancel stale claim offers. Dry run unless told otherwise |

The issuer seed and `TREASURY_MASTER_KEY` live in the server's environment and
nowhere else — not in logs, not in responses, not in this repo.
