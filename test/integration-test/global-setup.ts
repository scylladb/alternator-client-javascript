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

import {
  AlternatorTransport,
  defaultClusterSpec,
  TestClusters,
} from "../testinfra/ccm/index.js";

export default async function setupIntegrationCluster(): Promise<() => Promise<void>> {
  if (
    !truthy(process.env.INTEGRATION_TESTS) ||
    truthy(process.env.CCM_PROVISIONING_CONTRACTS) ||
    truthy(process.env.ALTERNATOR_USE_EXISTING)
  ) {
    return () => Promise.resolve();
  }

  const lease = await TestClusters.acquireReusable(defaultClusterSpec());
  const http = lease.cluster.connection(AlternatorTransport.HTTP);
  const https = lease.cluster.connection(AlternatorTransport.HTTPS);
  const firstNode = lease.cluster.nodes[0];
  if (firstNode === undefined || https.caCertificatePath === undefined) {
    await lease.close();
    await TestClusters.closeAll();
    throw new Error("Default CCM cluster did not provide required node and HTTPS CA metadata");
  }

  process.env.ALTERNATOR_HOST = http.seedEndpoint.hostname;
  process.env.ALTERNATOR_PORT = http.seedEndpoint.port;
  process.env.ALTERNATOR_HTTPS_PORT = https.seedEndpoint.port;
  process.env.ALTERNATOR_DATACENTER = firstNode.datacenter;
  process.env.ALTERNATOR_RACK = firstNode.rack;
  process.env.ALTERNATOR_CA_CERT_PATH = https.caCertificatePath;
  process.env.ALTERNATOR_RESOURCE_PREFIX = lease.resources.prefix;
  process.env.ALTERNATOR_ACCESS_KEY_ID = http.credentials?.accessKeyId ?? "test";
  process.env.ALTERNATOR_SECRET_ACCESS_KEY = http.credentials?.secretAccessKey ?? "test";

  return async () => {
    try {
      await lease.close();
    } finally {
      await TestClusters.closeAll();
    }
  };
}

function truthy(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes";
}
