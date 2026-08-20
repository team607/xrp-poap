# Conventions for this repo

XRPL NFT layer for a POAP-style attendance app. Spec: `xrpl-nft-layer-brief.md`.
Read section 4 of the brief before changing any transaction builder — those
decisions are settled.

## Non-negotiables

- **There is no smart contract.** NFTs are native transaction types.
- **Badges are soulbound.** Mint with `tfTransferable` unset. Flags on
  `NFTokenMint` are `1` (`tfBurnable` alone) — never `9`, never `11`.
- **Never include `TransferFee`** when `tfTransferable` is unset.
- **Every claim offer sets `Destination`.** Without it, anyone can take the badge.
- **Never verify attendance by current NFT ownership.** Attendance is an event.
  A burned badge is still attendance.
- **`nftoken_id` / `offer_id` only exist in transaction metadata.** Use
  `requireMetaString(outcome, "nftoken_id")` from `src/xrpl/client.ts`.
- **Use named flag enums from `xrpl`**, not magic numbers. `1` means
  `tfBurnable` on mint and `tfSellNFToken` on create-offer.
- **The issuer seed never leaves the server.** Not in logs, not in responses,
  not in errors.

## Code conventions

- TypeScript, ESM, `"module": "NodeNext"`. **Relative imports need a `.js`
  extension** (`import { x } from "./foo.js"`) even though the file is `.ts`.
- Shared contracts live in `src/types.ts`. Do not redefine them locally, do not
  edit them without a reason that affects more than one module.
- Errors: throw the typed classes in `src/errors.ts`. No bare `throw new Error`
  in `src/`.
- Every module that touches the ledger takes an `XrplGateway` as its first
  argument. Never construct a `Client` outside `src/xrpl/client.ts`.
- `strict` plus `noUncheckedIndexedAccess` are on. Index access yields
  `T | undefined`; handle it.
- Amounts: XRP as decimal strings, drops as strings. Use `xrpToDrops` /
  `dropsToXrp` from `xrpl`, never float arithmetic.

## Tests

- `npm test` (vitest). Unit tests are colocated: `src/xrpl/mint.test.ts`.
- **Unit tests never touch the network.** Use `MockGateway` from
  `test/helpers/mock-gateway.ts`.
- Network-touching work lives in `scripts/` and is run by hand.

## Commands

```
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run e2e:testnet   # scripts/01-testnet-e2e.ts, needs network
```
