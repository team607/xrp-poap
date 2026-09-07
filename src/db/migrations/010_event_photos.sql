-- 010_event_photos.sql — pictures of the event itself.
--
-- WHY LINKS AND NOT FILES
--
-- An organiser wants photographs of the day on the event's page, above the
-- wall of badges. The badges are generated — a pure function of (address,
-- taxon) that the server draws on demand and never stores — so this is the
-- first thing in the product that is a stored asset, and storing bytes brings
-- a writable directory, an upload path, MIME sniffing, size caps and a
-- deployment step that has to keep the directory across a redeploy.
--
-- A URL brings none of that. The image is hosted wherever the organiser
-- already hosts images, and this table holds an ordered list of links.
--
-- WHAT THAT COSTS, stated so it is not discovered later: a link can rot, and
-- when it does the page shows a broken picture that nothing here can detect.
-- That is the trade, and it was made deliberately.
--
-- THE URL IS RENDERED INTO AN <img src>, so the scheme is the whole security
-- story. `javascript:` and `data:` are refused by the CHECK below rather than
-- by whichever caller happens to remember — the constraint is the only place
-- that cannot be bypassed by a new code path.
--
-- ON DELETE CASCADE: a photo of an event that no longer exists is nothing at
-- all, and the alternative is rows that outlive their event and are found
-- years later by someone auditing orphans.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS event_photos (
  id          bigserial PRIMARY KEY,
  event_id    integer     NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  url         text        NOT NULL,
  caption     text,
  -- Display order, chosen by the organiser. Ties break on id, so a row added
  -- without a position still lands somewhere deterministic.
  position    integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The page reads every photo for one event, in order, and nothing else.
CREATE INDEX IF NOT EXISTS event_photos_event_idx
  ON event_photos (event_id, position, id);

-- The same picture twice in one gallery is always a mistake.
CREATE UNIQUE INDEX IF NOT EXISTS event_photos_event_url_key
  ON event_photos (event_id, url);

ALTER TABLE event_photos DROP CONSTRAINT IF EXISTS event_photos_url_http;
ALTER TABLE event_photos ADD  CONSTRAINT event_photos_url_http
  CHECK (url ~* '^https?://[^[:space:]]+$');

ALTER TABLE event_photos DROP CONSTRAINT IF EXISTS event_photos_caption_len;
ALTER TABLE event_photos ADD  CONSTRAINT event_photos_caption_len
  CHECK (caption IS NULL OR (btrim(caption) <> '' AND length(caption) <= 200));
