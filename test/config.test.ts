import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { AlternatorDynamoDBClient } from "../src/index.js";
import { normalizeConfig } from "../src/config.js";
import { RecordingHandler } from "./helpers.js";

describe("AlternatorDynamoDBClient config", () => {
  it("requires seeds and rejects AWS endpoint", () => {
    expect(() => new AlternatorDynamoDBClient({ seeds: [] as never })).toThrow(/seeds/);
    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          endpoint: "http://localhost:8000",
        } as never),
    ).toThrow(/endpoint/);
  });

  it("validates seed host, scheme, and port", () => {
    expect(() => new AlternatorDynamoDBClient({ seeds: ["http://localhost"] })).toThrow(/not a URL/);
    expect(() => new AlternatorDynamoDBClient({ seeds: ["localhost:8000"] })).toThrow(/must not include a port/);
    expect(() => new AlternatorDynamoDBClient({ seeds: ["[::1]:8080"] })).toThrow(/must not include a port/);
    expect(() => new AlternatorDynamoDBClient({ seeds: ["::1]"] })).toThrow(/valid IPv6/);
    expect(() => new AlternatorDynamoDBClient({ seeds: ["localhost"], scheme: "ftp" as never })).toThrow(/scheme/);
    expect(() => new AlternatorDynamoDBClient({ seeds: ["localhost"], port: 0 })).toThrow(/port/);

    expect(new AlternatorDynamoDBClient({ seeds: ["[::1]"] }).alternator.nodes()[0]?.url).toBe("http://[::1]:8080");
  });

  it("uses Alternator defaults for URL and signing region", async () => {
    const handler = new RecordingHandler();
    const client = new AlternatorDynamoDBClient({
      seeds: ["localhost"],
      requestHandler: handler,
      discovery: { background: false },
    });

    expect(client.alternator.nodes()).toEqual([
      {
        host: "localhost",
        scheme: "http",
        port: 8080,
        url: "http://localhost:8080",
      },
    ]);
    await expect(client.config.region()).resolves.toBe("us-east-1");

    await client.send(new ListTablesCommand({}));
    expect(handler.requests.at(-1)?.hostname).toBe("localhost");
    expect(normalizeConfig({ seeds: ["localhost"] }).compression).toEqual({
      request: {
        enabled: false,
        thresholdBytes: 0,
      },
      response: {
        enabled: false,
        algorithms: [],
      },
    });
  });

  it("rejects unsupported edge-only runtime combinations", () => {
    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          runtime: "worker" as never,
        }),
    ).toThrow(/runtime/);

    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          runtime: "edge",
          tls: { ca: { file: "/tmp/ca.pem" } },
        } as never),
    ).toThrow(/edge runtime.*TLS/);

    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          runtime: "edge",
          connection: { maxSockets: 8 },
        } as never),
    ).toThrow(/socket pool/);
  });

  it("validates User-Agent options", () => {
    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          userAgent: "" as never,
        }),
    ).toThrow(/userAgent/);

    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          userAgent: {
            value: "custom/1",
            transform: (userAgent) => `${userAgent} app/1`,
          },
        }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects direct Node agent overrides in connection.node", () => {
    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          connection: {
            node: {
              httpAgent: {},
            },
          } as never,
        }),
    ).toThrow(/httpAgent or httpsAgent/);

    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          connection: {
            node: {
              httpsAgent: {},
            },
          } as never,
        }),
    ).toThrow(/httpAgent or httpsAgent/);
  });

  it("validates key route affinity partition key mappings", () => {
    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          keyRouteAffinity: {
            partitionKeys: {
              users: 123,
            },
          } as never,
        }),
    ).toThrow(/partitionKeys values/);

    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          keyRouteAffinity: {
            partitionKeys: {
              users: "",
            },
          },
        }),
    ).toThrow(/partitionKeys values/);

    const client = new AlternatorDynamoDBClient({
      seeds: ["localhost"],
      keyRouteAffinity: {
        partitionKeys: {
          users: "id",
        },
      },
    });
    expect(client.alternator.partitionKey("users")).toBe("id");
  });

  it("validates routing objects supplied from JavaScript", () => {
    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          routing: {
            kind: "rack",
            datacenter: "dc1",
          } as never,
        }),
    ).toThrow(/routing\.rack/);

    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          routing: {
            kind: "unknown",
          } as never,
        }),
    ).toThrow(/routing\.kind/);

    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          routing: {
            kind: "datacenter",
            datacenter: "dc1",
            fallback: {
              kind: "rack",
              datacenter: "dc1",
            },
          } as never,
        }),
    ).toThrow(/routing\.fallback\.rack/);
  });

  it("validates gzip compression level against zlib range", () => {
    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          compression: {
            request: {
              gzipLevel: -2,
            },
          },
        }),
    ).toThrow(/compression\.request\.gzipLevel/);

    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          compression: {
            enabled: true,
            gzipLevel: -2,
          } as never,
        }),
    ).toThrow(/compression\.enabled/);

    expect(
      normalizeConfig({
        seeds: ["localhost"],
        compression: {
          request: {
            gzipLevel: -1,
          },
        },
      }).compression.request.gzipLevel,
    ).toBe(-1);
  });

  it("normalizes and validates response compression algorithms", () => {
    expect(
      normalizeConfig({
        seeds: ["localhost"],
        compression: { response: {} },
      }).compression.response,
    ).toEqual({
      enabled: true,
      algorithms: ["gzip"],
    });

    expect(
      normalizeConfig({
        seeds: ["localhost"],
        compression: {
          response: {
            algorithms: [
              "deflate",
              "deflate",
              "gzip",
            ],
          },
        },
      }).compression.response,
    ).toEqual({
      enabled: true,
      algorithms: ["deflate", "gzip"],
    });

    expect(
      normalizeConfig({
        seeds: ["localhost"],
        compression: { response: false },
      }).compression.response.enabled,
    ).toBe(false);

    expect(
      normalizeConfig({
        seeds: ["localhost"],
        compression: {
          response: {
            algorithms: ["gzip"],
          },
        },
      }).compression.response,
    ).toEqual({
      enabled: true,
      algorithms: ["gzip"],
    });

    expect(
      () =>
        new AlternatorDynamoDBClient({
          seeds: ["localhost"],
          compression: {
            response: {
              algorithms: ["br"],
            },
          } as never,
        }),
    ).toThrow(/compression\.response/);
  });

  it("validates key route affinity mode", () => {
    for (const mode of ["bad", "", 42]) {
      expect(
        () =>
          new AlternatorDynamoDBClient({
            seeds: ["localhost"],
            keyRouteAffinity: {
              mode,
            } as never,
          }),
      ).toThrow(/keyRouteAffinity\.mode/);
    }

    expect(
      normalizeConfig({
        seeds: ["localhost"],
        keyRouteAffinity: {
          mode: "read-before-write",
        },
      }).keyRouteAffinity.mode,
    ).toBe("read-before-write");
  });
});
