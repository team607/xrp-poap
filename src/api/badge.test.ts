/**
 * Badge metadata and artwork — `/badge/:eventId/:address.json` and `.png`.
 *
 * THE BUG THESE ARE FOR, measured on production. The name printed on a badge
 * and recorded as its `event_name` trait came from `EVENT_NAME`: one string for
 * the whole process. A server hosting two events stamped both with the same
 * one, so badges for "REDTAPE 10K RUN DELHI" came back named after a different
 * event entirely — and in self-hosted mode the document is generated per
 * request, so it was wrong for every badge already minted, not just new ones.
 *
 * The events table has known the name per taxon since events became rows.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import type { ApiDeps } from "./deps.js";
import { registerErrorHandler } from "./http-errors.js";
import { registerBadgeRoutes } from "./routes/badge.js";
import type { EventId, EventRecord, EventRepository } from "../types.js";

const BASE_URL = "https://badges.example.test";
const ATTENDEE = "rwPy1pJd3RcHrEaqKk1yUiEGCqz8wewJZm";
const RUN = 700_012;
const MEETUP = 70_011;

function eventRow(eventId: EventId, name: string): EventRecord {
  return {
    eventId,
    name,
    status: "live",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  } as EventRecord;
}

/** Only `find` is reachable from these routes; the rest must never be called. */
function events(rows: EventRecord[]): EventRepository {
  const refuse = (name: string) => () => {
    throw new Error(`badge routes must not call events.${name}()`);
  };
  return {
    find: vi.fn(async (eventId: EventId) => rows.find((r) => r.eventId === eventId) ?? null),
    create: refuse("create"),
    update: refuse("update"),
    list: refuse("list"),
    hasBadges: refuse("hasBadges"),
  } as unknown as EventRepository;
}

function harness(opts: { eventName?: string; events?: EventRepository } = {}): FastifyInstance {
  const deps = {
    config: {
      badgeBaseUrl: BASE_URL,
      ...(opts.eventName === undefined ? {} : { eventName: opts.eventName }),
    },
    ...(opts.events ? { events: opts.events } : {}),
  } as unknown as ApiDeps;

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });
  registerErrorHandler(app);
  registerBadgeRoutes(app, deps);
  return app;
}

const json = (app: FastifyInstance, eventId: number) =>
  app.inject({ method: "GET", url: `/badge/${eventId}/${ATTENDEE}.json` });

const traitOf = (body: any, name: string): unknown =>
  body.attributes?.find((a: any) => a.trait_type === name)?.value;

describe("the name on a badge", () => {
  it("is the event's own name, not the server-wide EVENT_NAME", async () => {
    // Both events on one server, one EVENT_NAME. This is the production case.
    const app = harness({
      eventName: "FEOOH",
      events: events([eventRow(RUN, "REDTAPE 10K RUN DELHI"), eventRow(MEETUP, "Dev Meet")]),
    });

    const run = (await json(app, RUN)).json();
    expect(run.name).toBe(`REDTAPE 10K RUN DELHI · ${ATTENDEE.slice(0, 6)}…${ATTENDEE.slice(-4)}`);
    expect(run.description).toContain("REDTAPE 10K RUN DELHI");
    expect(traitOf(run, "event_name")).toBe("REDTAPE 10K RUN DELHI");

    // The second event on the same server gets its own name, not the first's.
    const meetup = (await json(app, MEETUP)).json();
    expect(traitOf(meetup, "event_name")).toBe("Dev Meet");
    expect(meetup.name).not.toContain("REDTAPE");
    expect(meetup.name).not.toContain("FEOOH");
  });

  it("falls back to EVENT_NAME for a taxon with no row", async () => {
    // A badge minted before the event became a row still has to render.
    const app = harness({ eventName: "FEOOH", events: events([]) });
    const body = (await json(app, RUN)).json();
    expect(traitOf(body, "event_name")).toBe("FEOOH");
  });

  it("falls back to EVENT_NAME when there is no events table at all", async () => {
    const app = harness({ eventName: "FEOOH" });
    const body = (await json(app, RUN)).json();
    expect(traitOf(body, "event_name")).toBe("FEOOH");
  });

  it("says 'Event <id>' and omits the trait when nothing names it", async () => {
    const app = harness({ events: events([]) });
    const body = (await json(app, RUN)).json();
    expect(body.name).toBe(`Event ${RUN} · ${ATTENDEE.slice(0, 6)}…${ATTENDEE.slice(-4)}`);
    // Omitted, not empty: an `event_name` of "" would read as a name we know.
    expect(traitOf(body, "event_name")).toBeUndefined();
  });

  it("does not turn a database problem into a broken badge", async () => {
    // The metadata URI is immutable and a wallet may cache what it gets, so a
    // momentarily unreachable database must not become a 500 in an NFT.
    const broken = {
      find: vi.fn(async () => {
        throw new Error("events table is unavailable");
      }),
    } as unknown as EventRepository;

    const app = harness({ eventName: "FEOOH", events: broken });
    const res = await json(app, RUN);

    expect(res.statusCode).toBe(200);
    expect(traitOf(res.json(), "event_name")).toBe("FEOOH");
  });

  it("renders the artwork for either source of the name", async () => {
    const app = harness({ eventName: "FEOOH", events: events([eventRow(RUN, "REDTAPE 10K")]) });
    const png = await app.inject({ method: "GET", url: `/badge/${RUN}/${ATTENDEE}.png` });
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
  });

  it("still points the image at this origin", async () => {
    const app = harness({ events: events([eventRow(RUN, "REDTAPE 10K")]) });
    const body = (await json(app, RUN)).json();
    expect(body.image).toBe(`${BASE_URL}/badge/${RUN}/${ATTENDEE}.png`);
    expect(traitOf(body, "event_id")).toBe(RUN);
    expect(traitOf(body, "attendee")).toBe(ATTENDEE);
  });
});
