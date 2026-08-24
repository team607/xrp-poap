-- 007_sessions.sql — admin sessions, revocable and hashed.
--
-- WHY THIS EXISTS
--
-- There is one operator account and its credentials come from the environment
-- (see AdminIdentity in src/types.ts); there is no users table. What there has
-- to be is server-side session state, because a JWT cannot be revoked and
-- "log out everywhere after a leaked cookie" is the one thing an admin session
-- must be able to do. A row here IS the session; deleting it ends it.
--
-- THE ID COLUMN IS A HASH, NOT THE COOKIE VALUE.
--
-- The raw session id lives in the user's cookie and is a bearer token: whoever
-- holds it is the admin. If it were stored verbatim, a leaked backup, a stray
-- `SELECT * FROM sessions` in a log, or SQL injection anywhere in the app would
-- hand over live, working sessions — an authentication bypass with no password
-- involved. So the caller passes the raw id to the store, the store hashes it
-- with sha256 and only the digest is written here. A leak of this table yields
-- 64 hex characters that cannot be turned back into a cookie.
--
-- The digest, not the raw value, is therefore what `id` means everywhere below,
-- and it is why this is text rather than uuid. A session id has ~256 bits of
-- entropy and is random, so an unsalted, uniterated sha256 is the right choice:
-- there is no dictionary to attack and no reason to pay bcrypt's cost on every
-- request. That reasoning does NOT transfer to passwords.
--
-- See PgSessionStore / MemorySessionStore in src/db — the hashing lives there
-- and is the same function for both, so a session created against one store is
-- stored identically by the other.
--
-- EXPIRY IS EVALUATED BY THE DATABASE.
--
-- Every read compares expires_at against the server's now(). Never against a
-- timestamp a caller supplied: a client with a wrong clock — or one that lies
-- on purpose — must not be able to extend a session past its end.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS sessions (
  -- sha256(raw cookie value), lower-case hex. NOT the value in the cookie.
  id           text        PRIMARY KEY,

  -- The operator this session authenticates. Stored exactly as the auth layer
  -- supplied it; normalising an address is that layer's job, done once at the
  -- edge, so that revoke-all matches what create wrote.
  email        text        NOT NULL,

  created_at   timestamptz NOT NULL DEFAULT now(),
  -- No default: a session with no end is not a session. The store computes
  -- this as now() + ttl in SQL, so the lifetime is measured by the server.
  expires_at   timestamptz NOT NULL,
  -- Touched on every successful get(). Informational: "this cookie was last
  -- used on Tuesday" is what makes an unexpected session recognisable.
  last_seen_at timestamptz
);

-- The purge: DELETE FROM sessions WHERE expires_at <= now(). Safe to run on a
-- timer, and this index is what keeps it from scanning the table each time.
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
  ON sessions (expires_at);

-- Revoke-all, the remedy after a leaked cookie. It must be instant and it must
-- not miss a row, so it gets its own index rather than a sequential scan.
CREATE INDEX IF NOT EXISTS sessions_email_idx
  ON sessions (email);
