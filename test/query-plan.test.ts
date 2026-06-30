import { describe, expect, it, vi } from "vitest";
import { SeededRandom } from "../src/seeded-random.js";
import { AlternatorQueryPlan, firstNodeWithSeed } from "../src/query-plan.js";
import type { AlternatorNode } from "../src/types.js";

describe("AlternatorQueryPlan", () => {
  it("returns active nodes before exhausting the plan using swap removal", () => {
    const nodes = testNodes(["node-a", "node-b", "node-c"]);
    vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      const plan = new AlternatorQueryPlan(nodes);
      expect(plan.next()?.host).toBe("node-a");
      expect(plan.next()?.host).toBe("node-c");
      expect(plan.next()?.host).toBe("node-b");
      expect(plan.next()).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("tries a preferred node first, then remaining nodes in sorted order", () => {
    const nodes = testNodes(["node-c", "node-a", "node-b"]);
    const preferred = nodes.find((node) => node.host === "node-b");
    const plan = new AlternatorQueryPlan(nodes, [], preferred, true);

    expect(plan.next()?.host).toBe("node-b");
    expect(plan.next()?.host).toBe("node-a");
    expect(plan.next()?.host).toBe("node-c");
    expect(plan.next()).toBeUndefined();
  });

  it("tries preferred nodes in order, then remaining nodes in sorted order", () => {
    const nodes = testNodes(["node-c", "node-a", "node-d", "node-b"]);
    const preferred = [
      nodes.find((node) => node.host === "node-d"),
      nodes.find((node) => node.host === "node-b"),
    ].filter((node): node is AlternatorNode => node !== undefined);
    const plan = new AlternatorQueryPlan(nodes, [], preferred, true);

    expect(takeHosts(plan, nodes.length)).toEqual(["node-d", "node-b", "node-a", "node-c"]);
    expect(plan.next()).toBeUndefined();
  });

  it("matches seeded raw query plan vectors", () => {
    const hosts = Array.from({ length: 10 }, (_, index) => `node${index + 1}.example.com:8043`);

    expect(rawSeededOrder(hosts, 42n).slice(0, 6)).toEqual([
      "node6.example.com:8043",
      "node9.example.com:8043",
      "node5.example.com:8043",
      "node2.example.com:8043",
      "node7.example.com:8043",
      "node1.example.com:8043",
    ]);
    expect(rawSeededOrder(hosts, 123n).slice(0, 6)).toEqual([
      "node6.example.com:8043",
      "node1.example.com:8043",
      "node4.example.com:8043",
      "node3.example.com:8043",
      "node10.example.com:8043",
      "node5.example.com:8043",
    ]);
    expect(rawSeededOrder(hosts, -1n).slice(0, 6)).toEqual([
      "node2.example.com:8043",
      "node5.example.com:8043",
      "node1.example.com:8043",
      "node3.example.com:8043",
      "node6.example.com:8043",
      "node10.example.com:8043",
    ]);
    expect(rawSeededOrder(hosts, 9_223_372_036_854_775_807n).slice(0, 6)).toEqual([
      "node2.example.com:8043",
      "node7.example.com:8043",
      "node8.example.com:8043",
      "node1.example.com:8043",
      "node10.example.com:8043",
      "node4.example.com:8043",
    ]);
  });

  it("uses sorted-seed ordering for affinity query plans", () => {
    const nodes = testNodes(
      Array.from({ length: 10 }, (_, index) => `node${index + 1}.example.com`),
      8043,
    );

    expect(takeHosts(AlternatorQueryPlan.withSeed(nodes, 42n), 6)).toEqual([
      "node5.example.com",
      "node8.example.com",
      "node4.example.com",
      "node10.example.com",
      "node6.example.com",
      "node1.example.com",
    ]);
    expect(takeHosts(AlternatorQueryPlan.withSeed(nodes, -1n), 6)).toEqual([
      "node10.example.com",
      "node4.example.com",
      "node1.example.com",
      "node2.example.com",
      "node5.example.com",
      "node9.example.com",
    ]);
    expect(takeHosts(AlternatorQueryPlan.withSeed(nodes, 12_345n), 6)).toEqual([
      "node3.example.com",
      "node4.example.com",
      "node1.example.com",
      "node6.example.com",
      "node5.example.com",
      "node7.example.com",
    ]);
  });

  it("selects the first sorted node with seeded random", () => {
    const nodes = testNodes(["node2.example.com", "node10.example.com", "node1.example.com", "node3.example.com"]);

    expect(firstNodeWithSeed(nodes, 42n)?.host).toBe("node10.example.com");
    expect(firstNodeWithSeed(nodes, 123n)?.host).toBe("node3.example.com");
    expect(firstNodeWithSeed(nodes, -1n)?.host).toBe("node3.example.com");
  });
});

function testNodes(hosts: readonly string[], port = 8080): AlternatorNode[] {
  return hosts.map((host) => ({
    host,
    scheme: "http",
    port,
    url: `http://${host}:${port}`,
  }));
}

function takeHosts(plan: AlternatorQueryPlan, count: number): string[] {
  const hosts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const node = plan.next();
    if (!node) {
      break;
    }
    hosts.push(node.host);
  }
  return hosts;
}

function rawSeededOrder(hosts: readonly string[], seed: bigint): string[] {
  const random = new SeededRandom(seed);
  const remaining = [...hosts];
  const ordered: string[] = [];

  while (remaining.length > 0) {
    const index = random.intn(remaining.length);
    const host = remaining[index];
    if (!host) {
      throw new Error("test selected an empty host slot");
    }
    ordered.push(host);
    remaining[index] = remaining[remaining.length - 1] ?? host;
    remaining.pop();
  }

  return ordered;
}
