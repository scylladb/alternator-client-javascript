import { HttpRequest } from "@smithy/protocol-http";
import type { HttpHandlerOptions } from "@smithy/types";
import { bodyToString } from "./body.js";
import { hostForUrl, nodeUrl } from "./config.js";
import { routingChain, type LocalNodesQuery, type RoutingRule } from "./routing.js";
import { AlternatorQueryPlan } from "./query-plan.js";
import type { AlternatorNode, NormalizedAlternatorConfig } from "./types.js";

interface DiscoveryRequestHandler {
  handle(request: HttpRequest, options?: HttpHandlerOptions): Promise<{ response: { statusCode: number; body?: unknown } }>;
}

type RackDatacenterSupport = "supported" | "unsupported" | "unknown";
type RackDatacenterProbeKind = "datacenter" | "rack";

export class AlternatorDiscovery {
  private liveHosts: string[];
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private lastRefreshAttempt = 0;
  private inFlightRefresh: Promise<AlternatorNode[]> | undefined;

  constructor(
    private readonly config: NormalizedAlternatorConfig,
    private readonly requestHandler: DiscoveryRequestHandler,
  ) {
    this.liveHosts = [...config.seeds];
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
    const datacenterSupport = await this.probeRackDatacenterSupport("datacenter");
    const rackSupport = await this.probeRackDatacenterSupport("rack");
    return datacenterSupport === "supported" && rackSupport === "supported";
  }

  private async probeRackDatacenterSupport(kind: RackDatacenterProbeKind): Promise<RackDatacenterSupport> {
    const probe = missingScopeProbe(kind);

    for (const host of this.candidateHosts()) {
      try {
        const nodes = await this.fetchLocalNodes(host, probe);
        return nodes.length === 0 ? "supported" : "unsupported";
      } catch {
        continue;
      }
    }
    return "unknown";
  }

  async checkIfRackAndDatacenterSetCorrectly(): Promise<void> {
    const errors: string[] = [];
    let datacenterSupport: RackDatacenterSupport | undefined;
    let rackSupport: RackDatacenterSupport | undefined;

    for (const rule of routingChain(this.config.routing)) {
      if (rule.kind === "cluster") {
        return;
      }

      datacenterSupport ??= await this.probeRackDatacenterSupport("datacenter");
      if (datacenterSupport === "unsupported") {
        throw new Error("Alternator /localnodes does not support datacenter query parameters");
      }
      if (rule.kind === "rack") {
        rackSupport ??= await this.probeRackDatacenterSupport("rack");
        if (rackSupport === "unsupported") {
          throw new Error("Alternator /localnodes does not support rack query parameters");
        }
      }

      const query = queryForRoutingRule(rule);
      try {
        const nodes = await this.fetchFirstAvailableLocalNodes(query);
        if (nodes.length > 0) {
          return;
        }
        errors.push(`scope ${routingRuleLabel(rule)} has no nodes`);
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
  }

  private async refreshLiveNodesOnce(): Promise<AlternatorNode[]> {
    const candidates = this.candidateHosts();
    let datacenterSupport: RackDatacenterSupport | undefined;
    let rackSupport: RackDatacenterSupport | undefined;

    for (const rule of routingChain(this.config.routing)) {
      try {
        let nodes: string[];
        if (rule.kind === "cluster") {
          nodes = await this.fetchClusterLocalNodes();
        } else {
          datacenterSupport ??= await this.probeRackDatacenterSupport("datacenter");
          if (datacenterSupport === "unsupported") {
            this.config.logger.debug?.("alternator discovery: datacenter query parameters are unsupported", {
              rule: routingRuleLabel(rule),
            });
            continue;
          }
          if (rule.kind === "rack") {
            rackSupport ??= await this.probeRackDatacenterSupport("rack");
            if (rackSupport === "unsupported") {
              this.config.logger.debug?.("alternator discovery: rack query parameters are unsupported", {
                rule: routingRuleLabel(rule),
              });
              continue;
            }
          }
          nodes = await this.fetchFirstAvailableLocalNodes(queryForRoutingRule(rule), candidates);
        }
        if (nodes.length > 0) {
          this.liveHosts = normalizeDiscoveredHosts(nodes);
          return this.getLiveNodes();
        }
      } catch (error) {
        this.config.logger.debug?.("alternator discovery: localnodes request failed", {
          rule: routingRuleLabel(rule),
          error,
        });
      }
    }

    return this.getLiveNodes();
  }

  private candidateHosts(): string[] {
    return [...new Set([...this.liveHosts, ...this.config.seeds])];
  }

  private async fetchClusterLocalNodes(): Promise<string[]> {
    const nodes: string[] = [];
    const query: LocalNodesQuery = {};

    for (const host of this.config.seeds) {
      try {
        const discovered = await this.fetchLocalNodes(host, query);
        if (discovered.length > 0) {
          nodes.push(...discovered);
        } else {
          this.config.logger.debug?.("alternator discovery: localnodes returned no nodes", { host, query });
        }
      } catch (error) {
        this.config.logger.debug?.("alternator discovery: localnodes request failed", {
          host,
          query,
          error,
        });
      }
    }

    return normalizeDiscoveredHosts(nodes);
  }

  private async fetchFirstAvailableLocalNodes(
    query: LocalNodesQuery,
    candidates: readonly string[] = this.candidateHosts(),
  ): Promise<string[]> {
    let lastError: unknown;
    let sawEmptyResponse = false;
    for (const host of candidates) {
      try {
        const nodes = await this.fetchLocalNodes(host, query);
        if (nodes.length > 0) {
          return nodes;
        }
        sawEmptyResponse = true;
        this.config.logger.debug?.("alternator discovery: localnodes returned no nodes", { host, query });
      } catch (error) {
        lastError = error;
        this.config.logger.debug?.("alternator discovery: localnodes request failed", {
          host,
          query,
          error,
        });
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

  private async fetchLocalNodes(host: string, query: LocalNodesQuery): Promise<string[]> {
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
    const response = await this.requestHandler.handle(request, {
      requestTimeout: this.config.discovery.timeoutMs,
    });

    if (response.response.statusCode < 200 || response.response.statusCode >= 300) {
      throw new Error(`/localnodes returned HTTP ${response.response.statusCode}`);
    }

    const body = await bodyToString(response.response.body);
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed) || !parsed.every((node) => typeof node === "string")) {
      throw new Error("/localnodes returned an invalid node list");
    }
    return parsed;
  }

  private toNode(host: string): AlternatorNode {
    return {
      host,
      scheme: this.config.scheme,
      port: this.config.port,
      url: nodeUrl(host, this.config),
    };
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
  return [...new Set(hosts.map((host) => host.trim()).filter(Boolean))];
}

function hostHeader(host: string, port: number): string {
  return `${hostForUrl(host)}:${port}`;
}

function queryForRoutingRule(rule: RoutingRule): LocalNodesQuery {
  switch (rule.kind) {
    case "cluster":
      return {};
    case "datacenter":
      return { dc: rule.datacenter };
    case "rack":
      return { dc: rule.datacenter, rack: rule.rack };
  }
}

function routingRuleLabel(rule: RoutingRule): string {
  switch (rule.kind) {
    case "cluster":
      return "Cluster()";
    case "datacenter":
      return `Datacenter(dc=${rule.datacenter})`;
    case "rack":
      return `Rack(dc=${rule.datacenter}, rack=${rule.rack})`;
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
