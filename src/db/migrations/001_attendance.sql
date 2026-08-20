-- 001_attendance.sql — the attendance index (brief section 6.5).
--
-- The ledger is the source of truth. This table is only an index over it.
-- Never read attendance from the chain on a page load; read this table. The
-- separate verify path re-derives (address, eventId, txHash) from the chain on
-- demand, and that path — not this table — is what settles a dispute.
--
-- Every row here is a claim we watched succeed. tx_hash is the attendance
-- record: it is the hash of the attendee's NFTokenAcceptOffer, and it is the
-- one column a verifier can hand back to the ledger.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS attendance (
  id            bigserial   PRIMARY KEY,
  event_id      integer     NOT NULL,
  address       text        NOT NULL,
  nftoken_id    text        NOT NULL,
  offer_id      text,
  tx_hash       text        NOT NULL,
  ledger_index  bigint      NOT NULL,
  claimed_at    timestamptz NOT NULL DEFAULT now(),

  -- One badge per wallet per event. A second claim attempt is an expected
  -- condition, not a server error: the repository maps 23505 on this
  -- constraint to DUPLICATE_CLAIM.
  CONSTRAINT attendance_event_address_key UNIQUE (event_id, address)
);

-- Implied by 6.5 but not spelled out there: one NFTokenAcceptOffer cannot be
-- two attendances. Without this, a replayed webhook or a double-submitted
-- claim for two different addresses could both cite the same on-chain tx.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_tx_hash_key
  ON attendance (tx_hash);

-- "Which events did this wallet attend?" — the attendee-facing query.
-- Addresses are stored verbatim (see the repository module: XRPL classic
-- addresses are case-sensitive base58), so this is a plain b-tree, never a
-- lower(address) expression index.
CREATE INDEX IF NOT EXISTS attendance_address_idx
  ON attendance (address);

-- "Who attended this event?" — the roster query. attendance_event_address_key
-- already leads with event_id, so this is belt-and-braces for planners that
-- prefer the narrower index on a large table.
CREATE INDEX IF NOT EXISTS attendance_event_id_idx
  ON attendance (event_id);
