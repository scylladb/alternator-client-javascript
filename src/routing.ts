export type AlternatorRoutingScopeKind = "cluster" | "datacenter" | "rack";

export interface AlternatorRoutingFallbackOptions {
  fallback?: AlternatorRoutingScope;
}

export interface AlternatorClusterRoutingScope {
  readonly kind: "cluster";
}

export interface AlternatorDatacenterRoutingScope {
  readonly kind: "datacenter";
  readonly datacenter: string;
  readonly fallback?: AlternatorRoutingScope;
}

export interface AlternatorRackRoutingScope {
  readonly kind: "rack";
  readonly datacenter: string;
  readonly rack: string;
  readonly fallback?: AlternatorRoutingScope;
}

export type AlternatorRoutingScope =
  | AlternatorClusterRoutingScope
  | AlternatorDatacenterRoutingScope
  | AlternatorRackRoutingScope;

export interface AlternatorDatacenterRoutingScopeOptions extends AlternatorRoutingFallbackOptions {
  readonly datacenter: string;
}

export interface AlternatorRackRoutingScopeOptions extends AlternatorRoutingFallbackOptions {
  readonly datacenter: string;
  readonly rack: string;
}

export interface LocalNodesQuery {
  readonly dc?: string;
  readonly rack?: string;
}

function assertName(name: string, label: string): void {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function cluster(): AlternatorClusterRoutingScope {
  return { kind: "cluster" };
}

function datacenter(options: AlternatorDatacenterRoutingScopeOptions): AlternatorDatacenterRoutingScope {
  assertName(options.datacenter, "datacenter");
  return {
    kind: "datacenter",
    datacenter: options.datacenter,
    ...(options.fallback ? { fallback: options.fallback } : {}),
  };
}

function rack(options: AlternatorRackRoutingScopeOptions): AlternatorRackRoutingScope {
  assertName(options.datacenter, "datacenter");
  assertName(options.rack, "rack");
  return {
    kind: "rack",
    datacenter: options.datacenter,
    rack: options.rack,
    ...(options.fallback ? { fallback: options.fallback } : {}),
  };
}

export const routing = {
  cluster,
  datacenter,
  rack,
};

export function routingQueries(scope: AlternatorRoutingScope): LocalNodesQuery[] {
  const query = queryForScope(scope);
  const fallback = "fallback" in scope ? scope.fallback : undefined;
  return fallback ? [query, ...routingQueries(fallback)] : [query];
}

export function routingChain(scope: AlternatorRoutingScope): AlternatorRoutingScope[] {
  const fallback = "fallback" in scope ? scope.fallback : undefined;
  return fallback ? [scope, ...routingChain(fallback)] : [scope];
}

function queryForScope(scope: AlternatorRoutingScope): LocalNodesQuery {
  switch (scope.kind) {
    case "cluster":
      return {};
    case "datacenter":
      return { dc: scope.datacenter };
    case "rack":
      return { dc: scope.datacenter, rack: scope.rack };
  }
}
