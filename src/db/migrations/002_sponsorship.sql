-- 002_sponsorship.sql — backing store for the section 5.4 sponsorship guards.
--
-- "Anyone who can hit it with an arbitrary address can drain the issuer wallet
-- 1.5 XRP at a time." The two guards are one sponsorship per (event, address)
-- and a hard daily cap on total sponsored XRP. Both are enforced against this
-- table, so both constraints below are load-bearing, not hygiene.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS sponsorship (
  id            bigserial   PRIMARY KEY,
  event_id      integer     NOT NULL,
  address       text        NOT NULL,

  -- Drops, as an exact integer. Never a float, never numeric-with-scale:
  -- this column is summed against a spend cap and 1.5 + 1.5 must be 3.
  amount_drops  bigint      NOT NULL CHECK (amount_drops >= 0),

  -- Hash of the funding Payment. One payment is one sponsorship.
  tx_hash       text        NOT NULL,
  sponsored_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sponsorship_tx_hash_key UNIQUE (tx_hash),
  -- Guard one: one sponsorship per event code per address.
  CONSTRAINT sponsorship_event_address_key UNIQUE (event_id, address)
);

-- Guard two: the daily-cap SUM scans by time. The cap query bounds
-- sponsored_at at the start of the current UTC day.
CREATE INDEX IF NOT EXISTS sponsorship_sponsored_at_idx
  ON sponsorship (sponsored_at);
