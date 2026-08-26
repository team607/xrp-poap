-- Name and email become required.
--
-- Both columns were nullable because the original design took the view that a
-- badge needs a wallet, not an inbox. That is still true of the BADGE — nothing
-- about minting, claiming or verifying reads either column. It stopped being
-- true of the EVENT: an organiser with a list of wallet addresses and no names
-- cannot run a door, and cannot tell an attendee their badge is waiting.
--
-- Enforced here as well as in the API schema on purpose. The API is where a bad
-- request is refused with a sentence a person can read; this is what makes the
-- guarantee true of every row however it got written — a backfill, a fixture, a
-- future admin route that forgets.
--
-- SAFE ON AN EMPTY TABLE ONLY. A deployment holding registrations that predate
-- this will fail the ALTER, which is the correct outcome: those rows need a
-- decision (contact them, or delete them), not a default invented by a
-- migration. `email = ''` would satisfy the constraint and mean nothing.
--
-- Idempotent: safe to re-run.

DO $$
DECLARE
  incomplete bigint;
BEGIN
  SELECT count(*) INTO incomplete
  FROM registrations
  WHERE display_name IS NULL OR btrim(display_name) = ''
     OR email IS NULL OR btrim(email) = '';

  IF incomplete > 0 THEN
    RAISE EXCEPTION
      'Cannot require name and email: % existing registration(s) have neither. '
      'Fill them in or delete those rows, then re-run. This migration will not '
      'invent a value for a person.', incomplete;
  END IF;
END $$;

ALTER TABLE registrations ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE registrations ALTER COLUMN email        SET NOT NULL;

-- Empty strings would pass NOT NULL and carry no information.
ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_display_name_present;
ALTER TABLE registrations ADD  CONSTRAINT registrations_display_name_present
  CHECK (btrim(display_name) <> '');

ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_email_present;
ALTER TABLE registrations ADD  CONSTRAINT registrations_email_present
  CHECK (position('@' in email) > 1);
