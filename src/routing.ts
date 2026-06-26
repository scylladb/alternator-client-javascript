export type RoutingKind = "cluster" | "datacenter" | "rack";

export interface RoutingFallbackOptions {
  fallback?: RoutingRule;
}

export interface ClusterRoutingRule {
  readonly kind: "cluster";
}

export interface DatacenterRoutingRule {
  readonly kind: "datacenter";
  readonly datacenter: string;
  readonly fallback?: RoutingRule;
}

export interface RackRoutingRule {
  readonly kind: "rack";
  readonly datacenter: string;
  readonly rack: string;
  readonly fallback?: RoutingRule;
}

export type RoutingRule = ClusterRoutingRule | DatacenterRoutingRule | RackRoutingRule;

export interface LocalNodesQuery {
  readonly dc?: string;
  readonly rack?: string;
}

function assertName(name: string, label: string): void {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function cluster(): ClusterRoutingRule {
  return { kind: "cluster" };
}

function datacenter(datacenterName: string, options: RoutingFallbackOptions = {}): DatacenterRoutingRule {
  assertName(datacenterName, "datacenter");
  return {
    kind: "datacenter",
    datacenter: datacenterName,
    ...(options.fallback ? { fallback: options.fallback } : {}),
  };
}

function rack(
  datacenterName: string,
  rackName: string,
  options: RoutingFallbackOptions = {},
): RackRoutingRule {
  assertName(datacenterName, "datacenter");
  assertName(rackName, "rack");
  return {
    kind: "rack",
    datacenter: datacenterName,
    rack: rackName,
    ...(options.fallback ? { fallback: options.fallback } : {}),
  };
}

export const routing = {
  cluster,
  datacenter,
  rack,
};

export function routingQueries(rule: RoutingRule): LocalNodesQuery[] {
  const query = queryForRule(rule);
  const fallback = "fallback" in rule ? rule.fallback : undefined;
  return fallback ? [query, ...routingQueries(fallback)] : [query];
}

export function routingChain(rule: RoutingRule): RoutingRule[] {
  const fallback = "fallback" in rule ? rule.fallback : undefined;
  return fallback ? [rule, ...routingChain(fallback)] : [rule];
}

function queryForRule(rule: RoutingRule): LocalNodesQuery {
  switch (rule.kind) {
    case "cluster":
      return {};
    case "datacenter":
      return { dc: rule.datacenter };
    case "rack":
      return { dc: rule.datacenter, rack: rule.rack };
  }
}
