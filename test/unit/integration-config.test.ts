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

import { describe, expect, it } from "vitest";
import vitestIntegrationConfig from "../../vitest.integration.config.js";
import {
  integrationResourcePrefix,
  optionalNonemptyEnvironmentValue,
} from "../integration-test/config.js";

describe("integration environment configuration", () => {
  it("keeps runner deadlines outside bounded CCM cleanup", () => {
    const test = vitestIntegrationConfig.test;
    expect(test?.testTimeout).toBeGreaterThan(3 * 10 * 60_000);
    expect(test?.hookTimeout).toBeGreaterThan(10 * 60_000);
    expect(test?.teardownTimeout).toBeGreaterThan(10 * 60_000 + 2 * 60_000);
  });

  it("treats an empty optional value as absent", () => {
    expect(optionalNonemptyEnvironmentValue(undefined)).toBeUndefined();
    expect(optionalNonemptyEnvironmentValue("")).toBeUndefined();
    expect(optionalNonemptyEnvironmentValue(" \t")).toBeUndefined();
    expect(optionalNonemptyEnvironmentValue("/tmp/ca.crt")).toBe("/tmp/ca.crt");
  });

  it("validates external resource prefixes before table creation", () => {
    expect(integrationResourcePrefix(undefined)).toBe("js_it_external_");
    expect(integrationResourcePrefix("External.prefix-1_")).toBe("External.prefix-1_");
    expect(() => integrationResourcePrefix("invalid/prefix")).toThrow(/ASCII letters/u);
    expect(() => integrationResourcePrefix("a".repeat(223))).toThrow(/cannot exceed 222/u);
    expect(integrationResourcePrefix("a".repeat(222))).toHaveLength(222);
  });
});
