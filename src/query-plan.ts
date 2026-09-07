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

import type { AlternatorNode } from "./types.js";
import { SeededRandom } from "./seeded-random.js";

const UTF8_ENCODER = new TextEncoder();

export class AlternatorQueryPlan {
  private activeNodes: AlternatorNode[];
  private quarantinedNodes: AlternatorNode[];
  private readonly preferredNodes: AlternatorNode[];
  private readonly random: SeededRandom | undefined;

  constructor(
    activeNodes: readonly AlternatorNode[],
    quarantinedNodes: readonly AlternatorNode[] = [],
    preferredNodes?: AlternatorNode | readonly AlternatorNode[],
    private readonly deterministicOrder = false,
    random?: SeededRandom,
    sortBeforeSelection = deterministicOrder || random !== undefined,
  ) {
    this.random = random;
    this.preferredNodes = normalizePreferredNodes(preferredNodes);
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
    while (this.preferredNodes.length > 0) {
      const preferredNode = this.preferredNodes.shift();
      if (!preferredNode) {
        continue;
      }
      const preferred = popNode(this.activeNodes, preferredNode);
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
  return [...nodes].sort((left, right) => compareNodeAddresses(left.url, right.url));
}

export function compareNodeAddresses(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return leftBytes.length - rightBytes.length;
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

function normalizePreferredNodes(
  preferredNodes: AlternatorNode | readonly AlternatorNode[] | undefined,
): AlternatorNode[] {
  if (!preferredNodes) {
    return [];
  }
  if (isNodeList(preferredNodes)) {
    return [...preferredNodes];
  }
  return [preferredNodes];
}

function isNodeList(
  preferredNodes: AlternatorNode | readonly AlternatorNode[],
): preferredNodes is readonly AlternatorNode[] {
  return Array.isArray(preferredNodes);
}
