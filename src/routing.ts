export type RoutingKind = "cluster" | "datacenter" | "rack";

export interface RoutingFallbackOptions {
  fallback?: RoutingRule;
}

export interface ClusterRoutingOptions {
  datacenters?: readonly string[];
}

export interface ClusterRoutingRule {
  readonly kind: "cluster";
  readonly datacenters?: readonly string[];
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

function assertName(name: unknown, label: string): asserts name is string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function normalizeNames(names: readonly string[] | undefined, label: string): string[] | undefined {
  if (names === undefined) {
    return undefined;
  }
  const values: unknown = names;
  if (!Array.isArray(values)) {
    throw new TypeError(`${label}s must be an array`);
  }

  const rawNames: readonly unknown[] = values;
  const normalized = [...new Set(rawNames.map((name) => {
    assertName(name, label);
    return name.trim();
  }))];
  if (normalized.length === 0) {
    throw new TypeError(`${label}s must contain at least one ${label}`);
  }
  return normalized;
}

function cluster(options: ClusterRoutingOptions = {}): ClusterRoutingRule {
  const datacenters = normalizeNames(options.datacenters, "datacenter");
  return {
    kind: "cluster",
    ...(datacenters ? { datacenters } : {}),
  };
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
  const queries = queriesForRule(rule);
  const fallback = "fallback" in rule ? rule.fallback : undefined;
  return fallback ? [...queries, ...routingQueries(fallback)] : queries;
}

export function routingChain(rule: RoutingRule): RoutingRule[] {
  const fallback = "fallback" in rule ? rule.fallback : undefined;
  return fallback ? [rule, ...routingChain(fallback)] : [rule];
}

function queriesForRule(rule: RoutingRule): LocalNodesQuery[] {
  switch (rule.kind) {
    case "cluster":
      return rule.datacenters?.map((dc) => ({ dc })) ?? [{}];
    case "datacenter":
      return [{ dc: rule.datacenter }];
    case "rack":
      return [{ dc: rule.datacenter, rack: rule.rack }];
  }
}
