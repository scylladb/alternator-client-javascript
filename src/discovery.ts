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

import { HttpRequest } from "@smithy/protocol-http";
import type { HttpHandlerOptions } from "@smithy/types";
import { bodyToString } from "./body.js";
import { hostForUrl, nodeUrl, normalizeSeed } from "./config.js";
import { routingChain, type AlternatorRoutingScope, type LocalNodesQuery } from "./routing.js";
import { AlternatorQueryPlan } from "./query-plan.js";
import type { AlternatorNode, NormalizedAlternatorConfig } from "./types.js";

const MAX_DISCOVERY_RESPONSE_BYTES = 1024 * 1024;
const MAX_DISCOVERY_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_DISCOVERY_SNAPSHOT_NODES = 16_384;

interface DiscoveryRequestHandler {
  handle(request: HttpRequest, options?: HttpHandlerOptions): Promise<{ response: { statusCode: number; body?: unknown } }>;
  readonly discoveryAddressFallback?: {
    resolve(hostname: string, options?: { timeoutMs?: number; priority?: boolean }): Promise<readonly string[]>;
    handle(
      request: HttpRequest,
      address: string,
      options?: HttpHandlerOptions,
    ): Promise<{ response: { statusCode: number; body?: unknown } }>;
  };
}

type RackDatacenterSupport = "supported" | "unsupported" | "unknown";
type RackDatacenterProbeKind = "datacenter" | "rack";
type DiscoveryDeadline = number;

interface ClusterDiscoveryResult {
  readonly nodes: string[];
  readonly complete: boolean;
}

class DiscoverySnapshotLimitError extends Error {}

export class AlternatorDiscovery {
  private liveHosts: string[];
  private readonly seedHosts: ReadonlySet<string>;
  private publishedScope: AlternatorRoutingScope | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private lastRefreshAttempt = 0;
  private inFlightRefresh: Promise<AlternatorNode[]> | undefined;
  private readonly lifecycle = new AbortController();

  constructor(
    private readonly config: NormalizedAlternatorConfig,
    private readonly requestHandler: DiscoveryRequestHandler,
  ) {
    this.seedHosts = new Set(config.seeds);
    const clusterScope = routingChain(config.routing).find((scope) => scope.kind === "cluster");
    // Rack/datacenter-only seeds are discovery entrypoints, not validated
    // application routes. A chain with an explicit cluster fallback may route
    // through seeds because that fallback deliberately permits cluster scope.
    this.liveHosts = clusterScope ? [...config.seeds] : [];
    this.publishedScope = clusterScope;
    if (config.runtime === "node" && config.discovery.background && config.discovery.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => {
        this.refreshLiveNodes().catch(() => undefined);
      }, config.discovery.refreshIntervalMs);
      this.refreshTimer.unref?.();
    }
  }

  getLiveNodes(): AlternatorNode[] {
    return this.liveHosts.map((host) => this.toNode(host));
  }

  createQueryPlan(preferredNode?: AlternatorNode): AlternatorQueryPlan {
    return new AlternatorQueryPlan(this.getLiveNodes(), [], preferredNode);
  }

  async refreshLiveNodes(): Promise<AlternatorNode[]> {
    if (this.lifecycle.signal.aborted) {
      return this.getLiveNodes();
    }
    if (this.inFlightRefresh) {
      return this.inFlightRefresh;
    }

    this.lastRefreshAttempt = Date.now();
    this.inFlightRefresh = this.refreshLiveNodesOnce().finally(() => {
      this.inFlightRefresh = undefined;
    });
    return this.inFlightRefresh;
  }

  async refreshIfDue(): Promise<void> {
    if (this.config.runtime !== "edge") {
      return;
    }
    const interval = this.config.discovery.requestRefreshIntervalMs;
    if (interval <= 0 || Date.now() - this.lastRefreshAttempt < interval) {
      return;
    }
    await this.refreshLiveNodes();
  }

  async checkRackDatacenterSupport(): Promise<boolean> {
    this.assertActive("routing support check");
    const deadline = makeDeadline(this.config.discovery.timeoutMs);
    const datacenterSupport = await this.probeRackDatacenterSupport(
      "datacenter",
      fairDeadline(deadline, 2),
    );
    const rackSupport = await this.probeRackDatacenterSupport("rack", deadline);
    return datacenterSupport === "supported" && rackSupport === "supported";
  }

  private async probeRackDatacenterSupport(
    kind: RackDatacenterProbeKind,
    deadline: DiscoveryDeadline,
  ): Promise<RackDatacenterSupport> {
    const probe = missingScopeProbe(kind);
    const candidates = this.candidateHosts();
    const groups = this.candidateGroups(candidates);

    for (const [groupIndex, group] of groups.entries()) {
      this.assertActive("routing support check");
      const groupDeadline = fairDeadline(deadline, groups.length - groupIndex);
      for (const [index, host] of group.entries()) {
        this.assertActive("routing support check");
        if (deadlineExpired(groupDeadline)) {
          break;
        }
        try {
          const nodes = await this.fetchLocalNodes(
            host,
            probe,
            fairDeadline(groupDeadline, group.length - index),
          );
          return nodes.length === 0 ? "supported" : "unsupported";
        } catch (error) {
          if (this.lifecycle.signal.aborted) {
            throw error;
          }
          continue;
        }
      }
    }
    return "unknown";
  }

  async checkIfRackAndDatacenterSetCorrectly(): Promise<void> {
    this.assertActive("routing validation");
    const errors: string[] = [];
    let datacenterSupport: RackDatacenterSupport | undefined;
    let rackSupport: RackDatacenterSupport | undefined;
    const deadline = makeDeadline(this.config.discovery.timeoutMs);
    const scopes = routingChain(this.config.routing);

    for (const [scopeIndex, scope] of scopes.entries()) {
      this.assertActive("routing validation");
      if (scope.kind === "cluster") {
        return;
      }
      assertBeforeDeadline(deadline, "routing validation");
      const scopeDeadline = fairDeadline(deadline, scopes.length - scopeIndex);
      let operationsRemaining = 1;
      if (datacenterSupport === undefined) {
        operationsRemaining += 1;
      }
      if (scope.kind === "rack" && rackSupport === undefined) {
        operationsRemaining += 1;
      }

      if (datacenterSupport === undefined) {
        datacenterSupport = await this.probeRackDatacenterSupport(
          "datacenter",
          fairDeadline(scopeDeadline, operationsRemaining),
        );
        operationsRemaining -= 1;
      }
      if (datacenterSupport === "unsupported") {
        throw new Error("Alternator /localnodes does not support datacenter query parameters");
      }
      if (scope.kind === "rack" && rackSupport === undefined) {
        rackSupport = await this.probeRackDatacenterSupport(
          "rack",
          fairDeadline(scopeDeadline, operationsRemaining),
        );
        operationsRemaining -= 1;
      }
      if (scope.kind === "rack") {
        if (rackSupport === "unsupported") {
          throw new Error("Alternator /localnodes does not support rack query parameters");
        }
      }

      const query = queryForRoutingScope(scope);
      try {
        const nodes = await this.fetchFirstAvailableLocalNodes(
          query,
          this.candidateHosts(),
          scopeDeadline,
        );
        if (nodes.length > 0) {
          return;
        }
        errors.push(`scope ${routingScopeLabel(scope)} has no nodes`);
      } catch (error) {
        throw new Error(`failed to read list of nodes: ${errorMessage(error)}`);
      }
    }

    const message = errors.length > 0
      ? errors.join("; ")
      : "configured rack/datacenter routing has no matching nodes";
    throw new Error(message);
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.lifecycle.abort();
  }

  private async refreshLiveNodesOnce(): Promise<AlternatorNode[]> {
    const candidates = this.candidateHosts();
    let datacenterSupport: RackDatacenterSupport | undefined;
    let rackSupport: RackDatacenterSupport | undefined;
    const deadline = makeDeadline(this.config.discovery.timeoutMs);
    const scopes = routingChain(this.config.routing);

    for (const [scopeIndex, scope] of scopes.entries()) {
      if (this.lifecycle.signal.aborted) {
        return this.getLiveNodes();
      }
      try {
        assertBeforeDeadline(deadline, "discovery refresh");
        const scopeDeadline = fairDeadline(deadline, scopes.length - scopeIndex);
        let nodes: string[];
        if (scope.kind === "cluster") {
          const clusterResult = await this.fetchClusterLocalNodes(candidates, scopeDeadline);
          if (clusterResult.nodes.length === 0) {
            // Cluster-scope empty results are not authoritative. Incomplete
            // empty passes likewise retain the last-known-good snapshot.
            continue;
          }
          nodes = clusterResult.complete
            ? clusterResult.nodes
            : mergePartialClusterHosts(clusterResult.nodes, this.liveHosts);
        } else {
          let operationsRemaining = 1;
          if (datacenterSupport === undefined) {
            operationsRemaining += 1;
          }
          if (scope.kind === "rack" && rackSupport === undefined) {
            operationsRemaining += 1;
          }
          if (datacenterSupport === undefined) {
            datacenterSupport = await this.probeRackDatacenterSupport(
              "datacenter",
              fairDeadline(scopeDeadline, operationsRemaining),
            );
            operationsRemaining -= 1;
          }
          if (datacenterSupport === "unsupported") {
            this.config.logger.debug?.("alternator discovery: datacenter query parameters are unsupported", {
              scope: routingScopeLabel(scope),
            });
            continue;
          }
          if (scope.kind === "rack" && rackSupport === undefined) {
            rackSupport = await this.probeRackDatacenterSupport(
              "rack",
              fairDeadline(scopeDeadline, operationsRemaining),
            );
            operationsRemaining -= 1;
          }
          if (scope.kind === "rack") {
            if (rackSupport === "unsupported") {
              this.config.logger.debug?.("alternator discovery: rack query parameters are unsupported", {
                scope: routingScopeLabel(scope),
              });
              continue;
            }
          }
          nodes = await this.fetchFirstAvailableLocalNodes(
            queryForRoutingScope(scope),
            candidates,
            scopeDeadline,
          );
        }
        if (this.lifecycle.signal.aborted) {
          return this.getLiveNodes();
        }
        if (nodes.length > 0) {
          this.liveHosts = normalizeDiscoveredHosts(nodes);
          this.publishedScope = scope;
          return this.getLiveNodes();
        }
        if (scope.kind !== "cluster" && this.publishedScope === scope) {
          // A valid strict-scope empty response only invalidates a snapshot
          // published by this exact scope object. A wider fallback may still
          // publish replacement nodes later in this refresh.
          this.liveHosts = [];
          this.publishedScope = undefined;
        }
      } catch (error) {
        if (this.lifecycle.signal.aborted) {
          return this.getLiveNodes();
        }
        this.config.logger.debug?.("alternator discovery: localnodes request failed", {
          scope: routingScopeLabel(scope),
          error,
        });
      }
    }

    return this.getLiveNodes();
  }

  private candidateHosts(): string[] {
    return [...new Set([...this.liveHosts, ...this.config.seeds])];
  }

  private candidateGroups(candidates: readonly string[]): string[][] {
    const learnedCandidates = candidates.filter((host) => !this.seedHosts.has(host));
    const seedCandidates = candidates.filter((host) => this.seedHosts.has(host));
    return [learnedCandidates, seedCandidates].filter((group) => group.length > 0);
  }

  private async fetchClusterLocalNodes(
    candidates: readonly string[],
    deadline: DiscoveryDeadline,
  ): Promise<ClusterDiscoveryResult> {
    const nodes: string[] = [];
    const seen = new Set<string>();
    const encoder = new TextEncoder();
    let snapshotBytes = 0;
    let complete = true;
    const query: LocalNodesQuery = {};

    const groups = this.candidateGroups(candidates);
    for (const [groupIndex, group] of groups.entries()) {
      const groupDeadline = fairDeadline(deadline, groups.length - groupIndex);
      for (const [index, host] of group.entries()) {
        this.assertActive("cluster discovery");
        if (deadlineExpired(groupDeadline)) {
          complete = false;
          break;
        }
        let discovered: string[];
        try {
          discovered = await this.fetchLocalNodes(
            host,
            query,
            fairDeadline(groupDeadline, group.length - index),
          );
        } catch (error) {
          if (this.lifecycle.signal.aborted) {
            throw error;
          }
          if (error instanceof DiscoverySnapshotLimitError) {
            throw error;
          }
          complete = false;
          this.config.logger.debug?.("alternator discovery: localnodes request failed", {
            host,
            query,
            error,
          });
          continue;
        }
        if (discovered.length === 0) {
          // A Cluster endpoint that reports no nodes cannot prove that the
          // partitions returned by other candidates are a complete snapshot.
          // Preserve eligible last-known-good nodes when this pass also
          // contains fresh results.
          complete = false;
          this.config.logger.debug?.("alternator discovery: localnodes returned no nodes", { host, query });
          continue;
        }
        for (const node of discovered) {
          if (seen.has(node)) {
            continue;
          }
          snapshotBytes += encoder.encode(node).byteLength + 3;
          if (snapshotBytes > MAX_DISCOVERY_SNAPSHOT_BYTES) {
            throw new DiscoverySnapshotLimitError(
              `discovered node snapshot exceeds ${MAX_DISCOVERY_SNAPSHOT_BYTES} bytes`,
            );
          }
          if (nodes.length >= MAX_DISCOVERY_SNAPSHOT_NODES) {
            throw new DiscoverySnapshotLimitError(
              `discovered node snapshot exceeds ${MAX_DISCOVERY_SNAPSHOT_NODES} nodes`,
            );
          }
          seen.add(node);
          nodes.push(node);
        }
      }
    }

    return { nodes, complete };
  }

  private async fetchFirstAvailableLocalNodes(
    query: LocalNodesQuery,
    candidates: readonly string[],
    deadline: DiscoveryDeadline,
  ): Promise<string[]> {
    let lastError: unknown;
    let sawEmptyResponse = false;
    const groups = this.candidateGroups(candidates);
    for (const [groupIndex, group] of groups.entries()) {
      this.assertActive("scoped discovery");
      const groupDeadline = fairDeadline(deadline, groups.length - groupIndex);
      for (const [index, host] of group.entries()) {
        this.assertActive("scoped discovery");
        if (deadlineExpired(groupDeadline)) {
          break;
        }
        try {
          const nodes = await this.fetchLocalNodes(
            host,
            query,
            fairDeadline(groupDeadline, group.length - index),
          );
          if (nodes.length > 0) {
            return nodes;
          }
          sawEmptyResponse = true;
          this.config.logger.debug?.("alternator discovery: localnodes returned no nodes", { host, query });
        } catch (error) {
          if (this.lifecycle.signal.aborted) {
            throw error;
          }
          if (error instanceof DiscoverySnapshotLimitError) {
            throw error;
          }
          lastError = error;
          this.config.logger.debug?.("alternator discovery: localnodes request failed", {
            host,
            query,
            error,
          });
        }
      }
    }
    if (sawEmptyResponse) {
      return [];
    }
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error(lastError === undefined ? "no Alternator seed hosts are available" : errorMessage(lastError));
  }

  private async fetchLocalNodes(
    host: string,
    query: LocalNodesQuery,
    deadline: DiscoveryDeadline,
  ): Promise<string[]> {
    this.assertActive(`discovery request to ${host}`);
    assertBeforeDeadline(deadline, `discovery request to ${host}`);
    const fallback = this.requestHandler.discoveryAddressFallback;
    if (!fallback) {
      return this.fetchLocalNodesOnce(host, query, deadline);
    }

    const dnsDeadline = fairDeadline(deadline, 2);
    const dnsTimeoutMs = remainingTimeoutMs(dnsDeadline);
    const addresses = [...new Set(await withTimeout(
      fallback.resolve(host, {
        timeoutMs: dnsTimeoutMs,
        priority: this.seedHosts.has(host),
      }),
      dnsTimeoutMs,
      `DNS lookup for ${host}`,
      { signal: this.lifecycle.signal },
    ))];
    if (addresses.length === 0) {
      throw new Error(`DNS entrypoint ${host} resolved to no addresses`);
    }

    let lastError: unknown;
    let sawEmptyResponse = false;
    for (const [index, address] of addresses.entries()) {
      this.assertActive(`DNS address fallback for ${host}`);
      assertBeforeDeadline(deadline, `DNS address fallback for ${host}`);
      try {
        const nodes = await this.fetchLocalNodesOnce(
          host,
          query,
          fairDeadline(deadline, addresses.length - index),
          address,
        );
        if (nodes.length > 0) {
          return nodes;
        }
        sawEmptyResponse = true;
      } catch (error) {
        if (this.lifecycle.signal.aborted) {
          throw error;
        }
        lastError = error;
        this.config.logger.debug?.("alternator discovery: resolved address failed", {
          host,
          address,
          query,
          error,
        });
      }
    }
    if (sawEmptyResponse) {
      return [];
    }
    throw new Error(lastError === undefined
      ? `no resolved addresses are available for ${host}`
      : errorMessage(lastError));
  }

  private async fetchLocalNodesOnce(
    host: string,
    query: LocalNodesQuery,
    deadline: DiscoveryDeadline,
    resolvedAddress?: string,
  ): Promise<string[]> {
    assertBeforeDeadline(deadline, `/localnodes request to ${host}`);
    const request = new HttpRequest({
      protocol: `${this.config.scheme}:`,
      method: "GET",
      hostname: hostForUrl(host),
      port: this.config.port,
      path: "/localnodes",
      query: queryToRequestQuery(query),
      headers: {
        host: hostHeader(host, this.config.port),
      },
    });
    const requestController = new AbortController();
    let responseBody: unknown;
    const requestTimeoutMs = remainingTimeoutMs(deadline);
    const operation = async (): Promise<string[]> => {
      const options = {
        requestTimeout: requestTimeoutMs,
        abortSignal: requestController.signal,
      };
      const response = resolvedAddress === undefined
        ? await this.requestHandler.handle(request, options)
        : await this.requestHandler.discoveryAddressFallback!.handle(request, resolvedAddress, options);
      responseBody = response.response.body;
      if (requestController.signal.aborted) {
        destroyResponseBody(responseBody);
        throw new Error(`/localnodes request to ${host} was cancelled`);
      }

      if (response.response.statusCode < 200 || response.response.statusCode >= 300) {
        await drainResponseBody(responseBody, requestController.signal);
        throw new Error(`/localnodes returned HTTP ${response.response.statusCode}`);
      }

      let body: string;
      try {
        body = await bodyToString(responseBody, MAX_DISCOVERY_RESPONSE_BYTES, requestController.signal);
      } catch (error) {
        destroyResponseBody(responseBody);
        throw error;
      }
      const parsed: unknown = JSON.parse(body);
      if (!Array.isArray(parsed)) {
        throw new Error("/localnodes returned an invalid node list");
      }
      if (parsed.length > MAX_DISCOVERY_SNAPSHOT_NODES) {
        throw new DiscoverySnapshotLimitError(
          `/localnodes returned more than ${MAX_DISCOVERY_SNAPSHOT_NODES} node entries`,
        );
      }
      if (!parsed.every((node) => typeof node === "string")) {
        throw new Error("/localnodes returned an invalid node list");
      }
      const nodes = normalizeDiscoveredHosts(parsed);
      if (parsed.length > 0 && nodes.length === 0) {
        throw new Error("/localnodes returned no usable nodes");
      }
      return nodes;
    };

    try {
      return await withTimeout(
        operation(),
        requestTimeoutMs,
        `/localnodes request to ${host}`,
        {
          signal: this.lifecycle.signal,
          onCancel: () => {
            requestController.abort();
            destroyResponseBody(responseBody);
          },
        },
      );
    } catch (error) {
      requestController.abort();
      destroyResponseBody(responseBody);
      throw error;
    }
  }

  private toNode(host: string): AlternatorNode {
    return {
      host,
      scheme: this.config.scheme,
      port: this.config.port,
      url: nodeUrl(host, this.config),
    };
  }

  private assertActive(operation: string): void {
    if (this.lifecycle.signal.aborted) {
      throw new Error(`${operation} was cancelled`);
    }
  }
}

interface TimeoutOptions {
  readonly signal?: AbortSignal;
  readonly onCancel?: () => void;
}

function makeDeadline(timeoutMs: number): DiscoveryDeadline {
  return monotonicNow() + Math.max(1, timeoutMs);
}

function fairDeadline(deadline: DiscoveryDeadline, attemptsRemaining: number): DiscoveryDeadline {
  const now = monotonicNow();
  const remaining = deadline - now;
  if (attemptsRemaining <= 1 || remaining <= 1) {
    return deadline;
  }
  return Math.min(deadline, now + Math.max(1, Math.floor(remaining / attemptsRemaining)));
}

function remainingTimeoutMs(deadline: DiscoveryDeadline): number {
  return Math.max(1, deadline - monotonicNow());
}

function deadlineExpired(deadline: DiscoveryDeadline): boolean {
  return monotonicNow() >= deadline;
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function assertBeforeDeadline(deadline: DiscoveryDeadline, operation: string): void {
  if (deadlineExpired(deadline)) {
    throw new Error(`${operation} exceeded the discovery deadline`);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
  options: TimeoutOptions = {},
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${Math.max(1, timeoutMs)}ms`));
      cancelOperation(options.onCancel);
    }, Math.max(1, timeoutMs));
    timeout.unref?.();
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (!options.signal) {
      return;
    }
    abortListener = () => {
      reject(new Error(`${operation} was cancelled`));
      cancelOperation(options.onCancel);
    };
    if (options.signal.aborted) {
      abortListener();
      return;
    }
    options.signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (abortListener) {
      options.signal?.removeEventListener("abort", abortListener);
    }
  }
}

function cancelOperation(onCancel: (() => void) | undefined): void {
  try {
    onCancel?.();
  } catch (_error) {
    // Cancellation must not mask the timeout or shutdown error.
  }
}

async function drainResponseBody(body: unknown, signal: AbortSignal): Promise<void> {
  try {
    await bodyToString(body, MAX_DISCOVERY_RESPONSE_BYTES, signal);
  } catch (_error) {
    destroyResponseBody(body);
  }
}

function destroyResponseBody(body: unknown): void {
  if (typeof body !== "object" || body === null) {
    return;
  }

  if ("destroy" in body && typeof (body as { destroy?: unknown }).destroy === "function") {
    try {
      (body as { destroy(): void }).destroy();
    } catch (_error) {
      return;
    }
    return;
  }

  if ("cancel" in body && typeof (body as { cancel?: unknown }).cancel === "function") {
    try {
      const cancellation = (body as { cancel(): unknown }).cancel();
      void Promise.resolve(cancellation).catch(() => undefined);
    } catch (_error) {
      return;
    }
  }
}

function queryToRequestQuery(query: LocalNodesQuery): Record<string, string> {
  const result: Record<string, string> = {};
  if (query.dc) {
    result.dc = query.dc;
  }
  if (query.rack) {
    result.rack = query.rack;
  }
  return result;
}

function missingScopeProbe(kind: RackDatacenterProbeKind): LocalNodesQuery {
  switch (kind) {
    case "datacenter":
      return { dc: "__alternator_client_missing_dc__" };
    case "rack":
      return { rack: "__alternator_client_missing_rack__" };
  }
}

function normalizeDiscoveredHosts(hosts: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  const encoder = new TextEncoder();
  let snapshotBytes = 0;
  for (const host of hosts) {
    let node: string;
    try {
      node = normalizeSeed(host);
    } catch {
      continue;
    }
    if (seen.has(node)) {
      continue;
    }
    snapshotBytes += encoder.encode(node).byteLength + 3;
    if (snapshotBytes > MAX_DISCOVERY_SNAPSHOT_BYTES) {
      throw new DiscoverySnapshotLimitError(
        `discovered node snapshot exceeds ${MAX_DISCOVERY_SNAPSHOT_BYTES} bytes`,
      );
    }
    if (normalized.length >= MAX_DISCOVERY_SNAPSHOT_NODES) {
      throw new DiscoverySnapshotLimitError(
        `discovered node snapshot exceeds ${MAX_DISCOVERY_SNAPSHOT_NODES} nodes`,
      );
    }
    seen.add(node);
    normalized.push(node);
  }
  return normalized;
}

function mergePartialClusterHosts(freshHosts: readonly string[], lastKnownGoodHosts: readonly string[]): string[] {
  const merged = normalizeDiscoveredHosts(freshHosts);
  const seen = new Set(merged);
  const encoder = new TextEncoder();
  let snapshotBytes = merged.reduce(
    (total, host) => total + encoder.encode(host).byteLength + 3,
    0,
  );

  for (const host of lastKnownGoodHosts) {
    let normalized: string;
    try {
      normalized = normalizeSeed(host);
    } catch {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    if (merged.length >= MAX_DISCOVERY_SNAPSHOT_NODES) {
      break;
    }
    const entryBytes = encoder.encode(normalized).byteLength + 3;
    if (snapshotBytes + entryBytes > MAX_DISCOVERY_SNAPSHOT_BYTES) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
    snapshotBytes += entryBytes;
  }
  return merged;
}

function hostHeader(host: string, port: number): string {
  return `${hostForUrl(host)}:${port}`;
}

function queryForRoutingScope(scope: AlternatorRoutingScope): LocalNodesQuery {
  switch (scope.kind) {
    case "cluster":
      return {};
    case "datacenter":
      return { dc: scope.datacenter };
    case "rack":
      return { dc: scope.datacenter, rack: scope.rack };
  }
}

function routingScopeLabel(scope: AlternatorRoutingScope): string {
  switch (scope.kind) {
    case "cluster":
      return "Cluster()";
    case "datacenter":
      return `Datacenter(dc=${scope.datacenter})`;
    case "rack":
      return `Rack(dc=${scope.datacenter}, rack=${scope.rack})`;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    return JSON.stringify(error) ?? Object.prototype.toString.call(error);
  }
  switch (typeof error) {
    case "bigint":
    case "number":
      return error.toString();
    case "boolean":
      return error ? "true" : "false";
    case "function":
      return error.name ? `[function ${error.name}]` : "[function]";
    case "symbol":
      return error.description ?? error.toString();
    case "string":
      return error;
    case "undefined":
      return "undefined";
  }
  return "unknown";
}
