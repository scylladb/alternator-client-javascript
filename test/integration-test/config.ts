import { describe } from "vitest";
import type { AlternatorScheme } from "../../src/index.js";

export interface IntegrationEndpoint {
  readonly name: string;
  readonly host: string;
  readonly scheme: AlternatorScheme;
  readonly port: number;
}

export const integrationConfig = {
  enabled: truthy(process.env.INTEGRATION_TESTS),
  host: process.env.ALTERNATOR_HOST ?? "172.39.0.2",
  httpPort: intEnv("ALTERNATOR_PORT", 9998),
  httpsPort: intEnv("ALTERNATOR_HTTPS_PORT", 9999),
  datacenter: process.env.ALTERNATOR_DATACENTER ?? "datacenter1",
  rack: process.env.ALTERNATOR_RACK ?? "rack1",
  caCertPath: process.env.ALTERNATOR_CA_CERT_PATH,
  credentials: {
    accessKeyId: process.env.ALTERNATOR_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.ALTERNATOR_SECRET_ACCESS_KEY ?? "test",
  },
} as const;

export const describeIntegration = (
  integrationConfig.enabled ? describe : describe.skip
) as unknown as typeof describe;

export function integrationEndpoints(): IntegrationEndpoint[] {
  return [
    {
      name: "http",
      host: integrationConfig.host,
      scheme: "http",
      port: integrationConfig.httpPort,
    },
    {
      name: "https",
      host: integrationConfig.host,
      scheme: "https",
      port: integrationConfig.httpsPort,
    },
  ];
}

export function httpsIntegrationEndpoints(): IntegrationEndpoint[] {
  return integrationEndpoints().filter((endpoint) => endpoint.scheme === "https");
}

function truthy(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes";
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer port between 1 and 65535`);
  }
  return value;
}
