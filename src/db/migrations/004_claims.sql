-- 004_claims.sql — the claim slot, taken before anything is minted.
--
-- WHY THIS EXISTS
--
-- The attendance table (001) is only written after the attendee signs the
-- NFTokenAcceptOffer, so it cannot dedupe the mint that precedes the signature.
-- Measured: six unconfirmed claims for one (event, address) produced six mints,
-- six open offers and zero attendance rows, and every caller got HTTP 201. Each
-- open NFTokenOffer locks 0.2 XRP of the issuer's reserve (brief section 7), so
-- a 10 XRP float is exhausted by fifty unfinished claims.
--
-- This table takes the slot first. UNIQUE (event_id, address) IS the mint
-- guard: whoever wins the insert mints, everyone else is handed the offer that
-- already exists and mints nothing.
--
-- Unlike attendance, this is not an index over the ledger — it is our own
-- workflow state, and it is the only place an abandoned offer's id survives so
-- the sweeper can cancel it and get the 0.2 XRP back.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS claims (
  id          bigserial   PRIMARY KEY,
  event_id    integer     NOT NULL,
  address     text        NOT NULL,

  -- Both NULL until the mint and the offer come back from the ledger. They
  -- only ever exist in transaction metadata, so they are written by attach()
  -- after the fact, never predicted.
  nftoken_id  text,
  offer_id    text,

  status      text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'claimed', 'abandoned')),

  created_at  timestamptz NOT NULL DEFAULT now(),
  -- NULL means "no sweep deadline". A pending claim past this time whose offer
  -- is still open is 0.2 XRP the issuer is not getting back on its own.
  expires_at  timestamptz,

  -- The mint guard. One claim slot per wallet per event; a second attempt is
  -- an expected condition, so the repository maps 23505 to a null return
  -- rather than an error.
  CONSTRAINT claims_event_address_key UNIQUE (event_id, address)
);

-- The expiry sweep: pending, past expires_at, and still holding an offer.
-- Partial, because that predicate is the whole query and the rows it matches
-- are a small minority of the table.
CREATE INDEX IF NOT EXISTS claims_expiry_idx
  ON claims (expires_at)
  WHERE status = 'pending' AND offer_id IS NOT NULL;

-- "What is this wallet's claim state?" — the read every claim request starts
-- with. claims_event_address_key already serves (event_id, address); this one
-- serves the attendee-facing lookup across events.
CREATE INDEX IF NOT EXISTS claims_address_idx
  ON claims (address);
