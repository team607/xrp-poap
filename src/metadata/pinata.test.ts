import { describe, expect, it } from "vitest";
import { XrplLayerError } from "../errors.js";
import {
  DEFAULT_PINATA_GATEWAY,
  PINATA_API_BASE,
  PinataPinner,
  checkGatewayResolves,
} from "./pinata.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.super-secret-pinata-jwt.signature";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fetch stand-in. Injected rather than mocked, so a test can never reach the
 * network even by accident.
 */
function stubFetch(handler: (call: Call) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

const OK_BODY = {
  IpfsHash: "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsei6aduc4tqrfqa",
  PinSize: 4242,
  Timestamp: "2026-08-20T10:00:00.000Z",
};

describe("PinataPinner.pinFile", () => {
  it("posts multipart to pinFileToIPFS and maps IpfsHash onto a PinResult", async () => {
    const { fetchImpl, calls } = stubFetch(() => json(OK_BODY));
    const pinner = new PinataPinner({ jwt: JWT, fetchImpl });

    const result = await pinner.pinFile({
      data: new Uint8Array([1, 2, 3, 4]),
      filename: "badge.png",
      contentType: "image/png",
    });

    expect(result).toEqual({
      cid: OK_BODY.IpfsHash,
      uri: `ipfs://${OK_BODY.IpfsHash}`,
      gatewayUrl: `${DEFAULT_PINATA_GATEWAY}/ipfs/${OK_BODY.IpfsHash}`,
      size: 4242,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${PINATA_API_BASE}/pinning/pinFileToIPFS`);
    expect(call.method).toBe("POST");
    expect(call.body).toBeInstanceOf(FormData);
    const form = call.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("badge.png");
    expect(file.type).toBe("image/png");
    expect(await file.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3, 4]).buffer);
    // Content-Type is left to fetch so the multipart boundary is correct.
    expect(call.headers["content-type"]).toBeUndefined();
  });

  it("sends Authorization: Bearer <jwt>", async () => {
    const { fetchImpl, calls } = stubFetch(() => json(OK_BODY));
    await new PinataPinner({ jwt: JWT, fetchImpl }).pinFile({
      data: Buffer.from("png-bytes"),
      filename: "badge.png",
    });
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${JWT}`);
  });

  it("accepts a Buffer and falls back to the byte length when PinSize is absent", async () => {
    const { fetchImpl } = stubFetch(() => json({ IpfsHash: "bafkcid" }));
    const result = await new PinataPinner({ jwt: JWT, fetchImpl }).pinFile({
      data: Buffer.from("nine-byte"),
      filename: "badge.png",
    });
    expect(result.size).toBe(9);
    expect(result.uri).toBe("ipfs://bafkcid");
  });

  it("honours a custom gateway and strips its trailing slash", async () => {
    const { fetchImpl } = stubFetch(() => json(OK_BODY));
    const pinner = new PinataPinner({
      jwt: JWT,
      fetchImpl,
      gateway: "https://feooh.mypinata.cloud/",
    });
    const result = await pinner.pinFile({ data: new Uint8Array([1]), filename: "b.png" });
    expect(result.gatewayUrl).toBe(`https://feooh.mypinata.cloud/ipfs/${OK_BODY.IpfsHash}`);
  });

  it("honours a custom baseUrl", async () => {
    const { fetchImpl, calls } = stubFetch(() => json(OK_BODY));
    await new PinataPinner({
      jwt: JWT,
      fetchImpl,
      baseUrl: "https://pinata.internal/",
    }).pinFile({ data: new Uint8Array([1]), filename: "b.png" });
    expect(calls[0]?.url).toBe("https://pinata.internal/pinning/pinFileToIPFS");
  });
});

describe("PinataPinner.pinJson", () => {
  it("posts the document wrapped in pinataContent", async () => {
    const { fetchImpl, calls } = stubFetch(() => json(OK_BODY));
    const pinner = new PinataPinner({ jwt: JWT, fetchImpl });
    const doc = { name: "Badge", attributes: [{ trait_type: "event_id", value: 7 }] };

    const result = await pinner.pinJson({ json: doc, name: "badge-7-metadata.json" });

    expect(result.uri).toBe(`ipfs://${OK_BODY.IpfsHash}`);
    const call = calls[0]!;
    expect(call.url).toBe(`${PINATA_API_BASE}/pinning/pinJSONToIPFS`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.body as string)).toEqual({
      pinataContent: doc,
      pinataMetadata: { name: "badge-7-metadata.json" },
    });
  });
});

describe("PinataPinner error handling", () => {
  it("throws PIN_FAILED carrying the status on a 401", async () => {
    const { fetchImpl } = stubFetch(() =>
      json({ error: "Invalid credentials" }, 401, "Unauthorized"),
    );
    const pinner = new PinataPinner({ jwt: JWT, fetchImpl });

    await expect(
      pinner.pinFile({ data: new Uint8Array([1]), filename: "badge.png" }),
    ).rejects.toBeInstanceOf(XrplLayerError);

    const error = await pinner
      .pinFile({ data: new Uint8Array([1]), filename: "badge.png" })
      .then(() => null)
      .catch((e: unknown) => e as XrplLayerError);

    expect(error?.code).toBe("PIN_FAILED");
    expect(error?.details?.["status"]).toBe(401);
    expect(error?.details?.["statusText"]).toBe("Unauthorized");
    expect(error?.details?.["body"]).toContain("Invalid credentials");
    expect(error?.message).toContain("401");
  });

  it("never leaks the JWT into the message or the serialised details", async () => {
    // The gnarly case: a proxy echoes the Authorization header back at us.
    const { fetchImpl } = stubFetch(() =>
      json({ error: `bad token: Bearer ${JWT}` }, 403, "Forbidden"),
    );
    const pinner = new PinataPinner({ jwt: JWT, fetchImpl });

    const error = await pinner
      .pinJson({ json: { a: 1 }, name: "doc.json" })
      .then(() => null)
      .catch((e: unknown) => e as XrplLayerError);

    expect(error).toBeInstanceOf(XrplLayerError);
    expect(error?.message).not.toContain(JWT);
    expect(JSON.stringify(error?.details)).not.toContain(JWT);
    expect(JSON.stringify(error)).not.toContain(JWT);
    expect(String(error?.stack)).not.toContain(JWT);
    expect(error?.details?.["body"]).toContain("[redacted]");
    // Nor off the instance itself.
    expect(JSON.stringify(pinner)).not.toContain(JWT);
    expect(Object.values(pinner as unknown as Record<string, unknown>)).not.toContain(JWT);
  });

  it("wraps a raw fetch rejection instead of letting it escape untyped", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const error = await new PinataPinner({ jwt: JWT, fetchImpl })
      .pinFile({ data: new Uint8Array([1]), filename: "badge.png" })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(XrplLayerError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as XrplLayerError).code).toBe("PIN_FAILED");
    expect((error as XrplLayerError).message).toContain("fetch failed");
  });

  it("throws PIN_FAILED when a 200 carries no CID or is not JSON", async () => {
    const noCid = stubFetch(() => json({ PinSize: 1 }));
    await expect(
      new PinataPinner({ jwt: JWT, fetchImpl: noCid.fetchImpl }).pinJson({
        json: {},
        name: "d.json",
      }),
    ).rejects.toMatchObject({ code: "PIN_FAILED" });

    const notJson = stubFetch(() => new Response("<html>502</html>", { status: 200 }));
    await expect(
      new PinataPinner({ jwt: JWT, fetchImpl: notJson.fetchImpl }).pinJson({
        json: {},
        name: "d.json",
      }),
    ).rejects.toMatchObject({ code: "PIN_FAILED" });
  });

  it("refuses to construct without a JWT", () => {
    expect(() => new PinataPinner({ jwt: "" })).toThrow(XrplLayerError);
    expect(() => new PinataPinner({ jwt: "   " })).toThrow(/PINATA_JWT/);
  });
});

describe("checkGatewayResolves", () => {
  const url = "https://gateway.pinata.cloud/ipfs/bafkcid";

  it("reports ok on a 200", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ nftType: "art.v0" }));
    await expect(checkGatewayResolves(url, { fetchImpl })).resolves.toEqual({
      ok: true,
      status: 200,
    });
    expect(calls[0]?.url).toBe(url);
  });

  it("reports ok:false with the status on a 404", async () => {
    const { fetchImpl } = stubFetch(() => new Response("not found", { status: 404, statusText: "Not Found" }));
    const result = await checkGatewayResolves(url, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain("404");
  });

  it("returns ok:false rather than throwing on a network error", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError("fetch failed: ENOTFOUND");
    });
    const result = await checkGatewayResolves(url, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.error).toContain("ENOTFOUND");
  });

  it("returns ok:false rather than throwing when the request times out", async () => {
    const { fetchImpl } = stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (call as unknown as { signal?: AbortSignal }).signal;
          void signal;
          setTimeout(() => reject(new DOMException("The operation was aborted", "TimeoutError")), 5);
        }),
    );
    const result = await checkGatewayResolves(url, { fetchImpl, timeoutMs: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort/i);
  });

  it("passes an abort signal so a hung gateway cannot wedge the checklist", async () => {
    let seen: AbortSignal | undefined;
    const impl = (async (_input: unknown, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return json({});
    }) as unknown as typeof fetch;
    await checkGatewayResolves(url, { fetchImpl: impl, timeoutMs: 50 });
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
