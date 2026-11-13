interface ForceLayoutPoint {
  readonly x: number;
  readonly y: number;
}

export interface ForceLayout {
  readonly positions: ReadonlyMap<string, ForceLayoutPoint>;
  readonly bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** The distance linked nodes settle near. */
const SPACING = 80;
const GRAVITY = 1.5;
/** Repulsion steps per layout; large graphs settle in fewer rounds to stay within it. */
const PAIR_STEP_BUDGET = 20_000_000;

/** Linked nodes in breadth-first order, biggest component first, so they seed side by side. */
function seedOrder(count: number, neighbors: ReadonlyArray<ReadonlyArray<number>>): number[] {
  const visited = new Uint8Array(count);
  const components: number[][] = [];
  for (let start = 0; start < count; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    const component = [start];
    for (let head = 0; head < component.length; head++) {
      for (const next of neighbors[component[head]!]!) {
        if (visited[next]) continue;
        visited[next] = 1;
        component.push(next);
      }
    }
    components.push(component);
  }
  return components.toSorted((left, right) => right.length - left.length).flat();
}

/**
 * A Fruchterman-Reingold layout with a pull toward the centre, so unlinked nodes gather in a
 * disc instead of drifting off. Deterministic: the result depends only on the set of nodes and
 * edges, never on their order.
 */
export function forceLayout(input: {
  readonly nodes: ReadonlyArray<string>;
  readonly edges: ReadonlyArray<readonly [string, string]>;
}): ForceLayout {
  const spacing = SPACING;
  const keys = [...new Set(input.nodes)].toSorted();
  const count = keys.length;
  const indexOf = new Map(keys.map((key, index) => [key, index]));

  const neighbors: number[][] = keys.map(() => []);
  const links: Array<readonly [number, number]> = [];
  const seen = new Set<number>();
  for (const [from, to] of input.edges) {
    const a = indexOf.get(from);
    const b = indexOf.get(to);
    if (a === undefined || b === undefined || a === b) continue;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    if (seen.has(low * count + high)) continue;
    seen.add(low * count + high);
    links.push([low, high]);
    neighbors[low]!.push(high);
    neighbors[high]!.push(low);
  }
  for (const list of neighbors) list.sort((left, right) => left - right);
  // Float sums depend on their order, and the layout amplifies the difference.
  links.sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  const x = new Float64Array(count);
  const y = new Float64Array(count);
  seedOrder(count, neighbors).forEach((node, rank) => {
    const radius = spacing * 0.6 * Math.sqrt(rank + 0.5);
    x[node] = radius * Math.cos(rank * GOLDEN_ANGLE);
    y[node] = radius * Math.sin(rank * GOLDEN_ANGLE);
  });

  const k2 = spacing * spacing;
  const iterations = Math.round(Math.min(300, Math.max(15, PAIR_STEP_BUDGET / (count * count))));
  const startTemperature = spacing * Math.max(1, Math.sqrt(count) / 2);
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  for (let step = 0; step < iterations; step++) {
    for (let i = 0; i < count; i++) {
      dx[i] = -x[i]! * GRAVITY;
      dy[i] = -y[i]! * GRAVITY;
    }
    for (let i = 0; i < count; i++) {
      const xi = x[i]!;
      const yi = y[i]!;
      let pushX = 0;
      let pushY = 0;
      for (let j = i + 1; j < count; j++) {
        let offsetX = xi - x[j]!;
        let offsetY = yi - y[j]!;
        let distance2 = offsetX * offsetX + offsetY * offsetY;
        if (distance2 < 1e-6) {
          // Two nodes on one spot part along a direction fixed by their indices.
          offsetX = Math.cos(i + j);
          offsetY = Math.sin(i + j);
          distance2 = 1;
        }
        const force = k2 / distance2;
        pushX += offsetX * force;
        pushY += offsetY * force;
        dx[j] = dx[j]! - offsetX * force;
        dy[j] = dy[j]! - offsetY * force;
      }
      dx[i] = dx[i]! + pushX;
      dy[i] = dy[i]! + pushY;
    }
    for (const [i, j] of links) {
      const offsetX = x[i]! - x[j]!;
      const offsetY = y[i]! - y[j]!;
      const force = Math.sqrt(offsetX * offsetX + offsetY * offsetY) / spacing;
      dx[i] = dx[i]! - offsetX * force;
      dy[i] = dy[i]! - offsetY * force;
      dx[j] = dx[j]! + offsetX * force;
      dy[j] = dy[j]! + offsetY * force;
    }
    const temperature = startTemperature * (1 - step / iterations);
    for (let i = 0; i < count; i++) {
      const length = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!);
      if (length === 0) continue;
      const scale = Math.min(length, temperature) / length;
      x[i] = x[i]! + dx[i]! * scale;
      y[i] = y[i]! + dy[i]! * scale;
    }
  }

  const positions = new Map<string, ForceLayoutPoint>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  keys.forEach((key, index) => {
    const point = { x: x[index]!, y: y[index]! };
    positions.set(key, point);
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  });
  return {
    positions,
    bounds: count === 0 ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : { minX, minY, maxX, maxY },
  };
}
