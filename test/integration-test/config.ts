/*
 * Copyright ScyllaDB, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
  host: process.env.ALTERNATOR_HOST ?? "127.0.0.1",
  httpPort: intEnv("ALTERNATOR_PORT", 8080),
  httpsPort: intEnv("ALTERNATOR_HTTPS_PORT", 8043),
  datacenter: process.env.ALTERNATOR_DATACENTER ?? "dc1",
  rack: process.env.ALTERNATOR_RACK ?? "RAC1",
  caCertPath: optionalNonemptyEnvironmentValue(process.env.ALTERNATOR_CA_CERT_PATH),
  resourcePrefix: integrationResourcePrefix(process.env.ALTERNATOR_RESOURCE_PREFIX),
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

export function optionalNonemptyEnvironmentValue(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function integrationResourcePrefix(value: string | undefined): string {
  const prefix = value ?? "js_it_external_";
  const maximumLength = 255 - 33;
  if (!/^[A-Za-z0-9_.-]*$/u.test(prefix)) {
    throw new Error(
      "ALTERNATOR_RESOURCE_PREFIX may contain only ASCII letters, digits, underscore, hyphen, and period",
    );
  }
  if (prefix.length > maximumLength) {
    throw new Error(`ALTERNATOR_RESOURCE_PREFIX cannot exceed ${maximumLength} characters`);
  }
  return prefix;
}
