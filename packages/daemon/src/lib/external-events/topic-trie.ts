import type { NodeExecutionStatus } from '@hyperneo/shared';

export class TopicTrie<T> {
  private root = new TrieNode<T>();

  insert(pattern: string, value: T): void {
    const segments = pattern.split('/');
    let node = this.root;

    for (const segment of segments) {
      const key = segment.toLowerCase();
      const children = key.includes('*') ? node.globChildren : node.exactChildren;
      let child = children.get(key);
      if (!child) {
        child = new TrieNode<T>();
        children.set(key, child);
      }
      node = child;
    }

    node.values ??= [];
    node.values.push(value);
  }

  lookup(topic: string): T[] {
    const segments = topic.split('/');
    const results: T[] = [];

    const walk = (node: TrieNode<T>, depth: number): void => {
      if (depth === segments.length) {
        if (node.values) {
          results.push(...node.values);
        }
        return;
      }

      const segment = segments[depth].toLowerCase();

      const exact = node.exactChildren.get(segment);
      if (exact) {
        walk(exact, depth + 1);
      }

      for (const [patternSegment, child] of node.globChildren.entries()) {
        if (segmentMatches(patternSegment, segment)) {
          walk(child, depth + 1);
        }
      }
    };

    walk(this.root, 0);
    return results;
  }

  values(): T[] {
    const out: T[] = [];
    const walk = (node: TrieNode<T>): void => {
      if (node.values) out.push(...node.values);
      for (const child of node.exactChildren.values()) walk(child);
      for (const child of node.globChildren.values()) walk(child);
    };
    walk(this.root);
    return out;
  }

  count(predicate: (value: T) => boolean): number {
    let total = 0;

    const walk = (node: TrieNode<T>): void => {
      if (node.values) {
        total += node.values.filter(predicate).length;
      }
      for (const child of node.exactChildren.values()) {
        walk(child);
      }
      for (const child of node.globChildren.values()) {
        walk(child);
      }
    };

    walk(this.root);
    return total;
  }

  remove(predicate: (value: T) => boolean): void {
    const clean = (node: TrieNode<T>): boolean => {
      if (node.values) {
        node.values = node.values.filter((value) => !predicate(value));
        if (node.values.length === 0) {
          node.values = undefined;
        }
      }

      for (const [segment, child] of node.exactChildren.entries()) {
        if (clean(child)) {
          node.exactChildren.delete(segment);
        }
      }
      for (const [segment, child] of node.globChildren.entries()) {
        if (clean(child)) {
          node.globChildren.delete(segment);
        }
      }

      return !node.values && node.exactChildren.size === 0 && node.globChildren.size === 0;
    };

    clean(this.root);
  }
}

export function segmentMatches(pattern: string, segment: string): boolean {
  if (pattern === segment) {
    return true;
  }
  if (!pattern.includes('*')) {
    return false;
  }

  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('[^/]*')}$`, 'i');
  return regex.test(segment);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class TrieNode<T> {
  exactChildren: Map<string, TrieNode<T>> = new Map();
  globChildren: Map<string, TrieNode<T>> = new Map();
  values?: T[];
}

const NON_RECEIVING_STATES: ReadonlySet<NodeExecutionStatus> = new Set(['cancelled']);

export function isReceivingStatus(status: NodeExecutionStatus): boolean {
  return !NON_RECEIVING_STATES.has(status);
}
