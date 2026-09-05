-- Email becomes optional again. The name stays required.
--
-- 008 made both mandatory on the reasoning that an organiser cannot run a door
-- off a list of wallet addresses and cannot reach an attendee afterwards. The
-- first half still holds and `display_name` is untouched. The second was a
-- product decision, and the client has made a different one: an address is a
-- nice-to-have, and demanding it costs registrations at the door.
--
-- NOTHING IS LOST BY RELAXING IT. Rows written while it was mandatory keep
-- their email; the constraint only ever governed new writes.
--
-- THE CHECK STAYS, and it needs no change to tolerate NULL: a CHECK whose
-- expression evaluates to NULL passes, so `position('@' in email) > 1` is
-- satisfied by a NULL email and still rejects a non-empty string with no '@'.
-- It is rewritten below anyway, spelled out, because relying on three-valued
-- logic that a reader has to remember is how a constraint quietly stops
-- constraining.
--
-- Idempotent: safe to re-run.

ALTER TABLE registrations ALTER COLUMN email DROP NOT NULL;

ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_email_present;
ALTER TABLE registrations ADD  CONSTRAINT registrations_email_present
  CHECK (email IS NULL OR position('@' in email) > 1);
