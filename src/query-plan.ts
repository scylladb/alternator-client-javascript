import type { AlternatorNode } from "./types.js";
import { SeededRandom } from "./seeded-random.js";

export class AlternatorQueryPlan {
  private activeNodes: AlternatorNode[];
  private quarantinedNodes: AlternatorNode[];
  private readonly random: SeededRandom | undefined;

  constructor(
    activeNodes: readonly AlternatorNode[],
    quarantinedNodes: readonly AlternatorNode[] = [],
    private readonly preferredNode?: AlternatorNode,
    private readonly deterministicOrder = false,
    random?: SeededRandom,
    sortBeforeSelection = deterministicOrder || random !== undefined,
  ) {
    this.random = random;
    this.activeNodes = sortBeforeSelection
      ? sortNodes(activeNodes)
      : [...activeNodes];
    this.quarantinedNodes = sortBeforeSelection
      ? sortNodes(quarantinedNodes)
      : [...quarantinedNodes];
  }

  static withSeed(
    activeNodes: readonly AlternatorNode[],
    seed: bigint,
    quarantinedNodes: readonly AlternatorNode[] = [],
  ): AlternatorQueryPlan {
    return new AlternatorQueryPlan(activeNodes, quarantinedNodes, undefined, false, new SeededRandom(seed));
  }

  next(): AlternatorNode | undefined {
    if (this.preferredNode) {
      const preferred = popNode(this.activeNodes, this.preferredNode);
      if (preferred) {
        return preferred;
      }
    }

    if (this.activeNodes.length > 0) {
      return this.pickAndRemove(this.activeNodes);
    }

    if (this.quarantinedNodes.length > 0) {
      return this.pickAndRemove(this.quarantinedNodes);
    }

    return undefined;
  }

  private pickAndRemove(nodes: AlternatorNode[]): AlternatorNode {
    if (this.deterministicOrder) {
      const node = nodes.shift();
      if (!node) {
        throw new Error("Alternator query plan selected an empty node slot");
      }
      return node;
    }

    const index = this.random?.intn(nodes.length) ?? Math.floor(Math.random() * nodes.length);
    const node = nodes[index];
    if (!node) {
      throw new Error("Alternator query plan selected an empty node slot");
    }
    nodes[index] = nodes[nodes.length - 1] ?? node;
    nodes.pop();
    return node;
  }
}

export function sortNodes(nodes: readonly AlternatorNode[]): AlternatorNode[] {
  return [...nodes].sort((left, right) => left.url.localeCompare(right.url));
}

export function firstNodeWithSeed(nodes: readonly AlternatorNode[], seed: bigint): AlternatorNode | undefined {
  const sortedNodes = sortNodes(nodes);
  if (sortedNodes.length === 0) {
    return undefined;
  }
  return sortedNodes[new SeededRandom(seed).intn(sortedNodes.length)];
}

function popNode(nodes: AlternatorNode[], preferredNode: AlternatorNode): AlternatorNode | undefined {
  const index = nodes.findIndex((node) => node.url === preferredNode.url);
  if (index < 0) {
    return undefined;
  }
  const [node] = nodes.splice(index, 1);
  return node;
}
