-- The issuer that minted this event's badges.
--
-- The chain side of the roster asks `nfts_by_issuer` for one account, and it
-- used to ask for whichever issuer the server happens to be configured with
-- today. Rotate the issuer and every past event reports zero badges: nothing
-- was lost, the question was asked of the wrong account.
--
-- Nullable on purpose. NULL means "not recorded", and the reader falls back to
-- the configured issuer, which is right for every event minted before this
-- column existed and for an event that has minted nothing yet. A backfill can
-- fill it in for older events; see the note in event-repo.ts.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS issuer_address text
    CONSTRAINT events_issuer_address_format
      CHECK (issuer_address IS NULL OR issuer_address ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$');

COMMENT ON COLUMN events.issuer_address IS
  'The account that minted this event''s badges. NULL falls back to the server''s configured issuer.';
