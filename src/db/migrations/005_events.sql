-- 005_events.sql — events become rows.
--
-- WHY THIS EXISTS
--
-- Until now an event was a bare integer passed around as the NFTokenTaxon:
-- there was one event, it was configured in the environment, and the demo knew
-- its name. A product has several, they are created and edited by an operator,
-- and something has to hold the name, the date and the venue that the badge
-- metadata and the desk UI both read.
--
-- event_id IS THE NFTokenTaxon. There is deliberately no surrogate key. A badge
-- on the ledger carries the taxon and nothing else, so any mapping layer
-- between "our id" and "the taxon" would be a place for the two to drift, and
-- the drift would only ever be discovered by an attendee whose badge verifies
-- against the wrong event.
--
-- Two consequences the CHECK below encodes:
--
--   * taxon values >= 2147483648 are reserved by the protocol, so the id is a
--     signed integer bounded at 2147483647. `integer` already tops out there;
--     the bound is restated so the intent survives a future column-type change.
--   * negative ids cannot be minted at all. That is the half of the CHECK that
--     is actually load-bearing.
--
-- The id is also immutable in practice: once a badge exists on chain pointing
-- at this taxon, renumbering the row orphans it. EventRepository.update()
-- refuses an event_id change and hasBadges() is what an admin UI asks before
-- offering a destructive edit. Nothing here can enforce that — the ledger is
-- outside the database — so it is enforced in the repository and stated here.
--
-- No foreign key is added from attendance(event_id) or claims(event_id). Those
-- tables predate this one and carry rows for events that were never registered
-- here; a retroactive FK would make 001-004 unloadable against real data. The
-- ledger, not this table, is what makes an attendance row meaningful.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS events (
  -- The NFTokenTaxon. Not a serial: the operator picks it, and it is the same
  -- number that goes on chain.
  event_id      integer     PRIMARY KEY
                            CHECK (event_id >= 0 AND event_id <= 2147483647),

  name          text        NOT NULL,
  description   text,

  -- The day the event happens, not the day the row was written. A bare `date`
  -- with no zone: "1 May" is 1 May at the venue regardless of where the server
  -- is. The repository reads it back with to_char() so a client in a positive
  -- UTC offset cannot receive it shifted a day earlier — see event-repo.ts.
  event_date    date,
  venue         text,

  -- Event-wide fallback for NFTokenMint.URI, used when per-attendee art is
  -- unavailable. Points at metadata JSON, not at an image.
  metadata_uri  text,

  -- draft  — being set up, invisible to attendees
  -- open   — registration is accepting sign-ups
  -- live   — the desk is checking people in and badges are being claimed
  -- closed — over; nothing further is minted
  status        text        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'open', 'live', 'closed')),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The admin list is filtered by status ("show me what is open"). Small table,
-- so this is a convenience for the planner rather than a necessity.
CREATE INDEX IF NOT EXISTS events_status_idx
  ON events (status);
