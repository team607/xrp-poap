-- 012_vendors.sql — who sells at an event, and what.
--
-- An organiser adds vendors to an event — a pizza counter, a merchandise stand
-- — and gives each a price list in XRP. Attendees pay the vendor's OWN wallet,
-- from the pass on their phone. This server never holds a vendor's key and the
-- money never passes through anything it controls; what it keeps is the price
-- list, and (013) the record of who ordered what.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS vendors (
  id              bigserial   PRIMARY KEY,
  event_id        integer     NOT NULL REFERENCES events (event_id),
  name            text        NOT NULL,

  -- Verbatim base58, never folded. The wallet attendees pay, and the wallet a
  -- vendor proves in Xaman to open their order screen.
  wallet_address  text        NOT NULL,

  -- A hidden vendor keeps its order history and takes no new orders.
  active          boolean     NOT NULL DEFAULT true,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vendors_name_check CHECK (btrim(name) <> '' AND length(name) <= 120),
  -- One wallet is one counter at an event. Two vendors sharing a wallet would
  -- see each other's orders on their screens.
  CONSTRAINT vendors_event_wallet_key UNIQUE (event_id, wallet_address)
);

-- Signing in: every vendor this wallet is, at any event.
CREATE INDEX IF NOT EXISTS vendors_wallet_idx ON vendors (wallet_address);
CREATE INDEX IF NOT EXISTS vendors_event_idx ON vendors (event_id, id);

CREATE TABLE IF NOT EXISTS vendor_items (
  id          bigserial   PRIMARY KEY,

  -- Deleting a vendor deletes its price list. An item somebody has ordered
  -- cannot be deleted at all: 013's foreign key stops the cascade.
  vendor_id   bigint      NOT NULL REFERENCES vendors (id) ON DELETE CASCADE,

  -- Copied from the vendor when the item is added. A vendor never moves to
  -- another event, so this cannot drift, and a store page reads one event's
  -- items without a join.
  event_id    integer     NOT NULL REFERENCES events (event_id),

  name        text        NOT NULL,
  -- Per unit, in drops. Summed and multiplied, so never a float.
  price_drops bigint      NOT NULL,
  -- Units available in total. NULL means no limit.
  stock       integer,
  active      boolean     NOT NULL DEFAULT true,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vendor_items_name_check CHECK (btrim(name) <> '' AND length(name) <= 120),
  CONSTRAINT vendor_items_price_check CHECK (price_drops > 0),
  CONSTRAINT vendor_items_stock_check CHECK (stock IS NULL OR stock >= 0)
);

CREATE INDEX IF NOT EXISTS vendor_items_vendor_idx ON vendor_items (vendor_id, id);
CREATE INDEX IF NOT EXISTS vendor_items_event_idx ON vendor_items (event_id, id);
