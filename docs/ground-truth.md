# Ground truth: what the ledger actually does

Not copied from the brief. Measured on XRPL **testnet** via
`wss://clio.altnet.rippletest.net:51233` on 2026-08-20, with a real
mint -> offer -> accept -> burn cycle against faucet wallets. Brief section 8
step 2 says not to take the document's word for it; this is that check.

Raw responses: `out/probe-part1.json`, `out/probe-part2.json` (gitignored).

## Endpoint capability — the thing that will bite you

`nft_info`, `nft_history` and `nfts_by_issuer` are **Clio** methods. Measured:

| Endpoint | Clio | `nfts_by_issuer` |
|---|---|---|
| `wss://clio.altnet.rippletest.net:51233` | yes | works |
| `wss://s.altnet.rippletest.net:51233` | no | `unknownCmd` |
| `wss://testnet.xrpl-labs.com` | no | `unknownCmd` |
| `wss://xrplcluster.com` (mainnet) | **no** | **`unknownCmd`** |
| `wss://s1.ripple.com` (mainnet) | yes, Clio 2.7.1 | works |
| `wss://s2.ripple.com` (mainnet) | yes, Clio 2.7.1 | works |

The endpoint the brief lists for testnet in section 2 is the plain rippled one,
which cannot answer any of the three verification queries. **The mainnet
endpoint it names is the same trap**: section 2 says `xrplcluster.com` "also
serves Clio methods", but measured on 2026-08-20 it served Clio on **0 of 8**
connections and answered `nfts_by_issuer` with `unknownCmd` every time. It is
load balanced, so this is not even reliably wrong — it is a source of
intermittent failure. Use `s1.ripple.com` / `s2.ripple.com` on mainnet.

Live reserve values read from `server_info` at the same time, matching brief
section 7: base reserve **1 XRP**, owner reserve **0.2 XRP**. `.env.example`
therefore defaults to the Clio server and keeps the plain one as a fallback.
`account_nfts` works on both.

## Response shape

xrpl.js v5 defaults to **API v2**. A `tx` lookup returns:

```
{ tx_json: { TransactionType, Account, ... }, hash, meta, validated,
  ledger_index, ledger_hash, close_time_iso, ctid }
```

The transaction fields live under `tx_json`, not at the top level. Code that
reads `result.TransactionType` gets `undefined` and silently fails an
`isAcceptOffer` check. `src/xrpl/verify.ts` reads both shapes.

## Metadata fields

Confirmed present, and only in metadata:

| Transaction | Field |
|---|---|
| `NFTokenMint` | `meta.nftoken_id` |
| `NFTokenCreateOffer` | `meta.offer_id` |
| `NFTokenAcceptOffer` | `meta.nftoken_id` |

`meta.nftoken_id` on the **accept** is the important one: it means verification
can go straight from the attendance tx hash to the token without walking
`AffectedNodes`. The `AffectedNodes` fallback is still implemented, because a
non-Clio node is not guaranteed to include it.

## NFTokenID decoding

`000100002FAFC427A43949996C47DCC5B5AC6D10B2C8505667ABB1140132438B`

| Bytes | Field | Value |
|---|---|---|
| 0–1 | Flags | `0001` — `tfBurnable` only, `tfTransferable` unset, i.e. soulbound |
| 2–3 | TransferFee | `0000` |
| 4–23 | Issuer AccountID | `2FAFC427…` |
| 24–27 | Scrambled taxon | `67ABB114` = 1739305236 |
| 28–31 | Sequence | `0132438B` = 20071307 |

Unscramble, verified against the taxon that was actually minted (424242):

```
taxon = scrambledTaxon XOR ((384160001 * sequence + 2459) mod 2^32)
```

This is the degraded path that lets verification recover issuer and taxon from
the token id alone when `nft_info` is unavailable.

## What survives a burn

Burned from the attendee's own wallet, then re-queried:

| Query | Before | After |
|---|---|---|
| `nft_info` | `is_burned: false` | `is_burned: true`, **owner, issuer, taxon and uri all still returned** |
| `nft_history` | 3 txs | 4 txs: `NFTokenBurn -> NFTokenAcceptOffer -> NFTokenCreateOffer -> NFTokenMint` |
| `nfts_by_issuer` | 1 entry | 1 entry, `is_burned: true`, `owner` still the attendee |
| `account_nfts` (attendee) | 1 | **0** |
| `tx` by accept hash | retrievable | **retrievable, `meta.nftoken_id` intact** |

Two consequences:

1. **Attendance remains provable after a burn.** Every input the five checks in
   brief 6.4 need is still on the ledger. Verified end to end.
2. **`account_nfts` is the trap.** It is the query that looks like it answers
   "did they attend" and it returns zero for someone who demonstrably did.

`nft_history` comes back **newest first**. Do not assume the mint is element 0.
