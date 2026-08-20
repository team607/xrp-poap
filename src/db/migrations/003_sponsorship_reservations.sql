-- 003_sponsorship_reservations.sql — turn `sponsorship` into a two-phase book.
--
-- WHY THIS EXISTS
--
-- 002 shaped this table for check-then-pay-then-record: a row only appeared
-- *after* a Payment validated. Under concurrency that orders the money before
-- the bookkeeping, and the guards in brief section 5.4 stop guarding anything.
-- Measured: five simultaneous claims for one new address sent five Payments
-- (7.5 XRP) and wrote one row — four callers were told "already sponsored"
-- while 6 XRP left the issuer invisible to the daily cap. With distinct
-- addresses, 20 simultaneous requests against a 3 XRP cap sent 30 XRP.
--
-- The fix is to book the spend BEFORE the money moves, so a row exists — and
-- counts against the cap — from the instant the decision is made:
--
--   reserve()  INSERT status='reserved', tx_hash NULL   (before the Payment)
--   confirm()  UPDATE status='confirmed', tx_hash=<hash> (Payment validated)
--   release()  DELETE the reservation                    (Payment never landed)
--
-- Consequences for the schema, all of them load-bearing:
--
--   * tx_hash must be NULLABLE. A reserved row has no hash yet. It stays
--     UNIQUE: Postgres treats NULLs as distinct in a unique index, so many
--     reservations coexist while a confirmed hash still cannot repeat.
--   * status tells a reservation from a settled spend. The daily-cap SUM
--     counts BOTH — money in flight is money spent.
--   * UNIQUE (event_id, address) from 002 is unchanged and is now doing more
--     work than before: it is the atomic per-address guard. A 23505 on it is
--     the expected outcome of a lost race, not an error.
--   * id (bigserial PRIMARY KEY, from 002) is the reservation handle that
--     confirm()/release() address.
--
-- Migrations are append-only; 002 is left exactly as it was applied.
-- Idempotent: safe to re-run.

-- A reserved row has no Payment hash yet.
ALTER TABLE sponsorship ALTER COLUMN tx_hash DROP NOT NULL;

ALTER TABLE sponsorship
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'reserved';

DO $$
BEGIN
  ALTER TABLE sponsorship
    ADD CONSTRAINT sponsorship_status_check
    CHECK (status IN ('reserved', 'confirmed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Backfill. Every pre-003 row was written only after its Payment validated, so
-- it is confirmed by construction. A post-003 reserved row has a NULL hash, so
-- this cannot touch one and re-running it is a no-op.
UPDATE sponsorship SET status = 'confirmed'
 WHERE tx_hash IS NOT NULL AND status = 'reserved';

-- The daily-cap SUM still scans by time and still counts every row regardless
-- of status, so 002's sponsorship_sponsored_at_idx remains the right index.
-- Restated here only so a reader of this file does not go looking for it.
CREATE INDEX IF NOT EXISTS sponsorship_sponsored_at_idx
  ON sponsorship (sponsored_at);
