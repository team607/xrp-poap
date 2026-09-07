/**
 * Photographs of an event, stored as links.
 *
 * See 010_event_photos.sql for why these are URLs and not files, and for what
 * that trade costs. The short version: the badges are generated on demand and
 * nothing else in the product is a stored asset, so holding bytes would bring
 * an upload path, a writable directory and a deployment step for the sake of a
 * gallery. A link brings none of that, and rots.
 *
 * THE URL ENDS UP IN AN <img src>, so the scheme is the whole security story.
 * It is checked here AND by a CHECK constraint. Both, deliberately: the
 * constraint is the one a future code path cannot forget, and the check here
 * is the one that produces a message an operator can act on instead of a
 * Postgres error code.
 */
import { ValidationError, XrplLayerError } from "../errors.js";
import type { EventId, EventPhoto, EventPhotoRepository } from "../types.js";
import { assertValidEventId } from "./event-repo.js";
import type { Queryable } from "./pool.js";

const COLUMNS = "id, event_id, url, caption, position, created_at";

/** Postgres unique_violation / foreign_key_violation. */
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/** Long enough for a signed CDN link, short enough not to be a payload. */
const MAX_URL_LENGTH = 2000;
const MAX_CAPTION_LENGTH = 200;

interface PhotoRow {
  id: string | number;
  event_id: number;
  url: string;
  caption: string | null;
  position: number;
  created_at: Date | string;
}

function rowToPhoto(row: PhotoRow): EventPhoto {
  return {
    id: String(row.id),
    eventId: Number(row.event_id),
    url: row.url,
    caption: row.caption,
    position: Number(row.position),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

/**
 * An absolute http(s) URL, and nothing else.
 *
 * `javascript:` is the one that matters — an operator who can set it could run
 * script in the browser of everyone who opens the event page. `data:` is
 * refused too: it is not a link to a photograph, it is a photograph smuggled
 * into a column sized for a link.
 */
export function assertUsablePhotoUrl(raw: unknown): string {
  const url = typeof raw === "string" ? raw.trim() : "";
  if (url === "") {
    throw new ValidationError("INVALID_INPUT", "A photo needs a URL.", { url: raw });
  }
  if (url.length > MAX_URL_LENGTH) {
    throw new ValidationError(
      "INVALID_INPUT",
      `A photo URL must be at most ${MAX_URL_LENGTH} characters.`,
      { length: url.length },
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(
      "INVALID_INPUT",
      `"${url}" is not a URL. Paste the full address of the image, starting with https://`,
      { url },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError(
      "INVALID_INPUT",
      `A photo URL must start with http:// or https://, not ${parsed.protocol}`,
      { url, protocol: parsed.protocol },
    );
  }
  return url;
}

/** Trimmed, or null. An empty caption and no caption are the same thing. */
export function normalizeCaption(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const caption = String(raw).trim();
  if (caption === "") return null;
  if (caption.length > MAX_CAPTION_LENGTH) {
    throw new ValidationError(
      "INVALID_INPUT",
      `A caption must be at most ${MAX_CAPTION_LENGTH} characters.`,
      { length: caption.length },
    );
  }
  return caption;
}

export class PgEventPhotoRepository implements EventPhotoRepository {
  constructor(private readonly db: Queryable) {}

  async listByEvent(eventId: EventId): Promise<EventPhoto[]> {
    assertValidEventId(eventId);
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM event_photos WHERE event_id = $1 ORDER BY position ASC, id ASC`,
      [eventId],
    );
    return (res.rows as PhotoRow[]).map(rowToPhoto);
  }

  async add(input: {
    eventId: EventId;
    url: string;
    caption?: string | null;
    position?: number;
  }): Promise<EventPhoto> {
    assertValidEventId(input.eventId);
    const url = assertUsablePhotoUrl(input.url);
    const caption = normalizeCaption(input.caption);

    // Appended by default. An organiser adding a photo means "and then this
    // one", not "and put it first".
    const position =
      input.position === undefined || !Number.isFinite(input.position)
        ? await this.#nextPosition(input.eventId)
        : Math.trunc(input.position);

    try {
      const res = await this.db.query(
        `INSERT INTO event_photos (event_id, url, caption, position)
         VALUES ($1, $2, $3, $4)
         RETURNING ${COLUMNS}`,
        [input.eventId, url, caption, position],
      );
      return rowToPhoto(res.rows[0] as PhotoRow);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === UNIQUE_VIOLATION) {
        throw new XrplLayerError(
          "DUPLICATE_CLAIM",
          "That picture is already on this event.",
          { eventId: input.eventId, url },
        );
      }
      if (code === FOREIGN_KEY_VIOLATION) {
        throw new ValidationError(
          "INVALID_INPUT",
          `Event ${input.eventId} does not exist, so a photo cannot be attached to it.`,
          { eventId: input.eventId },
        );
      }
      throw err;
    }
  }

  async remove(eventId: EventId, id: string): Promise<boolean> {
    assertValidEventId(eventId);
    // Scoped to the event on purpose: an id from one event's list must not be
    // able to delete another's, however it was obtained.
    const res = await this.db.query(
      "DELETE FROM event_photos WHERE event_id = $1 AND id = $2",
      [eventId, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async #nextPosition(eventId: EventId): Promise<number> {
    const res = await this.db.query(
      "SELECT coalesce(max(position), -1) + 1 AS next FROM event_photos WHERE event_id = $1",
      [eventId],
    );
    const row = res.rows[0] as { next: string | number } | undefined;
    return Number(row?.next ?? 0);
  }
}

/** The in-memory twin, for a deployment with no database. */
export class MemoryEventPhotoRepository implements EventPhotoRepository {
  private readonly rows: EventPhoto[] = [];
  private seq = 0;

  async listByEvent(eventId: EventId): Promise<EventPhoto[]> {
    assertValidEventId(eventId);
    return this.rows
      .filter((r) => r.eventId === eventId)
      .sort((a, b) => a.position - b.position || Number(a.id) - Number(b.id))
      .map((r) => ({ ...r }));
  }

  async add(input: {
    eventId: EventId;
    url: string;
    caption?: string | null;
    position?: number;
  }): Promise<EventPhoto> {
    assertValidEventId(input.eventId);
    const url = assertUsablePhotoUrl(input.url);
    const caption = normalizeCaption(input.caption);

    // Mirrors the unique index. Without it the two stores disagree about the
    // one case an operator actually hits: pasting the same link twice.
    if (this.rows.some((r) => r.eventId === input.eventId && r.url === url)) {
      throw new XrplLayerError("DUPLICATE_CLAIM", "That picture is already on this event.", {
        eventId: input.eventId,
        url,
      });
    }

    const existing = this.rows.filter((r) => r.eventId === input.eventId);
    const position =
      input.position === undefined || !Number.isFinite(input.position)
        ? existing.reduce((max, r) => Math.max(max, r.position + 1), 0)
        : Math.trunc(input.position);

    this.seq += 1;
    const photo: EventPhoto = {
      id: String(this.seq),
      eventId: input.eventId,
      url,
      caption,
      position,
      createdAt: new Date(),
    };
    this.rows.push(photo);
    return { ...photo };
  }

  async remove(eventId: EventId, id: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.eventId === eventId && r.id === id);
    if (i === -1) return false;
    this.rows.splice(i, 1);
    return true;
  }
}
