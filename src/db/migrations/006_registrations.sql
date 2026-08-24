-- 006_registrations.sql — who said they were coming, and who actually turned up.
--
-- WHY THIS EXISTS
--
-- The demo had one flow: walk up, claim, done. The product has two halves that
-- happen hours or weeks apart —
--
--   before the event, an attendee registers and hands over a wallet address,
--   verified by a Xaman SignIn (address_proof = 'xaman_signin');
--   at the door, a volunteer checks them in (checked_in_at), and that is what
--   authorises the mint.
--
-- This table is neither the claim slot (004) nor the attendance index (001).
-- Registering is an intention, checking in is an observation by a human, and
-- attendance is a transaction on the ledger. Collapsing any two of them loses
-- the ability to answer "who registered but never showed up", which is the one
-- question an organiser always asks afterwards.
--
-- ADDRESS HANDLING — DO NOT NORMALISE.
--
-- address is stored exactly as it arrived. XRPL classic addresses are base58
-- and case-SENSITIVE: rHb9CJ... and rhb9cj... are different strings and at
-- most one of them is a real account. Lowercasing is the reflex you bring from
-- Ethereum's hex addresses, and here it silently breaks every lookup — the
-- registration would be written under a key nothing can find, and the desk
-- would tell a registered attendee they are not on the list. No lower(),
-- no citext, no trim beyond what the caller passed. The index below is a plain
-- b-tree over the verbatim value for the same reason.
--
-- PII.
--
-- email is the only personal data anywhere in this schema. It is optional,
-- collected solely so an organiser can contact an attendee, and it is
-- deliberately NOT uniquely indexed: one person may legitimately register two
-- wallets for two badges, and a unique constraint would reject the second with
-- a database error. Treat this column as the thing to redact in logs, exclude
-- from exports, and delete first when an attendee asks. Deleting an event's
-- registrations deletes every trace of a person from this system.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS registrations (
  id                  bigserial   PRIMARY KEY,

  -- No ON DELETE clause on purpose: the default (NO ACTION) refuses to delete
  -- an event that still has registrations. Losing a sign-up list to a stray
  -- DELETE should be hard.
  event_id            integer     NOT NULL REFERENCES events (event_id),

  -- Verbatim base58. See the note above.
  address             text        NOT NULL,

  -- How much the address can be trusted:
  --   xaman_signin  — the wallet signed a SignIn payload; the holder proved it
  --   self_declared — somebody typed it into a form; it may be a typo, or
  --                   somebody else's wallet
  -- Only the repository writes this, and it can never be widened by accident
  -- because a value outside the pair fails this CHECK.
  address_proof       text        NOT NULL
                                  CHECK (address_proof IN ('xaman_signin', 'self_declared')),

  display_name        text,
  -- PII. Optional, never uniquely indexed. See the note above.
  email               text,

  -- The Xaman payload uuid that proved the address, when there was one. Kept
  -- so a disputed registration can be traced back to the signature.
  signin_payload_uuid text,

  registered_at       timestamptz NOT NULL DEFAULT now(),
  -- NULL means "expected but not yet through the door". Set once, by a
  -- volunteer at the desk; markCheckedIn() never overwrites an existing value,
  -- because a second scan is a double-tap and not a second arrival.
  checked_in_at       timestamptz,

  -- One registration per wallet per event. A second attempt is an expected
  -- condition (a refreshed form, a double-submitted button), so the repository
  -- maps 23505 on this constraint to a typed duplicate rather than a 500.
  CONSTRAINT registrations_event_address_key UNIQUE (event_id, address)
);

-- The desk's query, both directions: "who is still expected" (checked_in_at IS
-- NULL) and "who is already in" (IS NOT NULL). Leading with event_id makes it
-- serve the unfiltered roster too, so it covers listByEvent in all three
-- shapes.
CREATE INDEX IF NOT EXISTS registrations_event_checkin_idx
  ON registrations (event_id, checked_in_at);

-- "Which events is this wallet registered for?" — the attendee-facing lookup
-- across events. Plain b-tree over the verbatim address, never lower(address).
CREATE INDEX IF NOT EXISTS registrations_address_idx
  ON registrations (address);
