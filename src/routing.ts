import { LocalizedError, message } from './i18n';
export interface Point { x: number; y: number }
export interface Box extends Point { width: number; height: number }
export interface Terminal { point: Point; side: 'left' | 'right' }
export interface Route { segments: [Point, Point][]; joints: Point[] }

const key = (point: Point) => point.x + ',' + point.y;

// Only marked junctions split a through segment. Bare crossings stay independent.
function connections(route: Route) {
  const adjacent = new Map<string, Point[]>();
  const add = (a: Point, b: Point) => {
    const id = key(a);
    if (!adjacent.has(id)) adjacent.set(id, []);
    adjacent.get(id)!.push(b);
  };
  for (const [a, b] of route.segments) {
    if (a.x === b.x && a.y === b.y) continue;
    const axis = a.x === b.x ? 'y' : 'x';
    const fixed = axis === 'y' ? 'x' : 'y';
    const low = Math.min(a[axis], b[axis]), high = Math.max(a[axis], b[axis]);
    const joints = route.joints.filter(p => p[fixed] === a[fixed] && p[axis] > low && p[axis] < high);
    const points = [a, ...joints, b].sort((u, v) => u[axis] - v[axis]);
    for (let i = 1; i < points.length; i++) {
      add(points[i - 1], points[i]); add(points[i], points[i - 1]);
    }
  }
  return adjacent;
}

// Draw each uninterrupted wire as a single stroke, including all its elbows.
export function routePaths(route: Route): Point[][] {
  const adjacent = connections(route);
  const paths: Point[][] = [];
  const used = new Set<string>();
  for (const [id, neighbours] of adjacent) {
    if (neighbours.length === 2) continue;
    for (const next of neighbours) {
      if (used.has(id + '/' + key(next))) continue;
      const [x, y] = id.split(',').map(Number);
      const path = [{ x, y }, next];
      let prev = id;
      let at = key(next);
      while (adjacent.get(at)!.length === 2) {
        const other = adjacent.get(at)!.find(p => key(p) !== prev)!;
        path.push(other);
        prev = at;
        at = key(other);
      }
      used.add(at + '/' + prev);
      paths.push(path.filter((p, i) => !i || i === path.length - 1 ||
        !(path[i-1].x === p.x && p.x === path[i+1].x || path[i-1].y === p.y && p.y === path[i+1].y)));
    }
  }
  return paths;
}

export function routeBranch(route: Route, from: Point, to: Point): Point[] {
  const adjacent = connections(route);
  const previous = new Map<string, Point | undefined>([[key(from), undefined]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    if (at.x === to.x && at.y === to.y) {
      const path: Point[] = [];
      for (let p: Point | undefined = at; p; p = previous.get(key(p))) path.push(p);
      return path.reverse();
    }
    for (const next of adjacent.get(key(at)) ?? []) if (!previous.has(key(next))) {
      previous.set(key(next), at); queue.push(next);
    }
  }
  return [];
}

interface Search { id: number; cost: number; priority: number; previous?: Search }
const directions = [1, 2, 4, 8]; // east, south, west, north
const horizontal = 5;
const vertical = 10;

class Queue {
  private items: Search[] = [];

  push(item: Search) {
    let position = this.items.length;
    this.items.push(item);
    while (position > 0) {
      const parent = (position - 1) >>> 1;
      if (this.items[parent].priority <= item.priority) break;
      this.items[position] = this.items[parent];
      position = parent;
    }
    this.items[position] = item;
  }

  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (!last || this.items.length === 0) return first;
    let position = 0;
    while (position * 2 + 1 < this.items.length) {
      let child = position * 2 + 1;
      if (this.items[child + 1]?.priority < this.items[child].priority) child++;
      if (last.priority <= this.items[child].priority) break;
      this.items[position] = this.items[child];
      position = child;
    }
    this.items[position] = last;
    return first;
  }
}

interface Reroute { routes: Route[]; order: number[] }

export function routeNets(width: number, height: number, boxes: Box[], nets: Terminal[][], deadline = Infinity, reroute?: Reroute): Route[] {
  const stride = width + 1;
  const key = ({ x, y }: Point) => y * stride + x;
  const point = (key: number) => ({ x: key % stride, y: Math.floor(key / stride) });
  const offsets = [1, stride, -1, -stride];
  const occupied = new Map<number, number>();
  const blocked = new Set<number>();
  const reservations = new Map<number, number>();
  let searches = 0;
  const checkTime = () => {
    if ((++searches & 511) === 0 && performance.now() > deadline) throw new LocalizedError(message('routingTimeout'));
  };
  for (const box of boxes) {
    for (let y = box.y; y <= box.y + box.height; y++) {
      for (let x = box.x; x <= box.x + box.width; x++) blocked.add(y * stride + x);
    }
  }
  if (reroute) {
    const selected = new Set(reroute.order);
    reroute.routes.forEach((route, index) => {
      if (selected.has(index)) return;
      const mark = (at: number, mask: number) => occupied.set(at, (occupied.get(at) ?? 0) | mask);
      for (const [a, b] of route.segments) {
        const direction = a.x === b.x ? (a.y < b.y ? 1 : 3) : (a.x < b.x ? 0 : 2);
        const step = offsets[direction];
        const end = key(b);
        if (key(a) === end) continue;
        for (let at = key(a); at !== end; at += step) {
          checkTime();
          mark(at, directions[direction]);
          mark(at + step, directions[(direction + 2) % 4]);
        }
      }
    });
  }
  const starts = nets.map((terminals, index) => terminals.map(terminal => {
    const direction = terminal.side === 'right' ? 0 : 2;
    const anchor = key(terminal.point);
    const start = anchor + offsets[direction];
    reservations.set(start, index);
    return { anchor, start, direction };
  }));

  function route(terminals: typeof starts[number], index: number): Route {
    if (reroute && terminals.length > 1 && terminals.some(({ start }) =>
      blocked.has(start) || occupied.has(start) || reservations.get(start) !== index)) {
      throw new LocalizedError(message('pinClearance'));
    }
    const tree = new Map<number, number>();
    const added: number[] = [];
    const put = (at: number, mask: number) => {
      if (!tree.has(at)) added.push(at);
      tree.set(at, (tree.get(at) ?? 0) | mask);
    };
    const link = (from: number, to: number, direction: number) => {
      put(from, directions[direction]);
      put(to, directions[(direction + 2) % 4]);
    };
    const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    function nearest(start: number, previous?: { result?: Point; best: number }) {
      const origin = point(start);
      let result = previous?.result;
      let best = previous?.best ?? Infinity;
      for (const value of added) {
        if (blocked.has(value) || occupied.has(value)) continue;
        const at = point(value);
        const length = distance(origin, at);
        if (length >= best) continue;
        result = at;
        best = length;
      }
      return { result, best };
    }
    function connect(start: number, direction: number, target: Point) {
      const estimate = (at: Point) => distance(at, target);
      const origin = start * 4 + direction;
      const queue = new Queue();
      const visited = new Map<number, number>([[origin, 0]]);
      queue.push({ id: origin, cost: 0, priority: estimate(point(start)) });
      for (let next = queue.pop(); next; next = queue.pop()) {
        checkTime();
        if (visited.get(next.id) !== next.cost) continue;
        const at = Math.floor(next.id / 4);
        const arrival = next.id % 4;
        const foreign = occupied.get(at) ?? 0;
        if (!foreign && tree.has(at)) {
          for (let current = next; current.previous; current = current.previous) {
            link(Math.floor(current.previous.id / 4), Math.floor(current.id / 4), current.id % 4);
          }
          return true;
        }
        const { x, y } = point(at);
        for (let step = 0; step < 4; step++) {
          if (step === (arrival + 2) % 4 || (foreign && step !== arrival)) continue;
          if ((step === 0 && x >= width - 1) || (step === 1 && y >= height - 1)
            || (step === 2 && x <= 1) || (step === 3 && y <= 1)) continue;
          const target = at + offsets[step];
          if (blocked.has(target)) continue;
          const reserved = reservations.get(target);
          if (reserved !== undefined && (reserved !== index || !tree.has(target))) continue;
          const mask = occupied.get(target) ?? 0;
          if (mask && mask !== (step % 2 === 0 ? vertical : horizontal)) continue;
          if (mask && tree.has(target)) continue;
          const state = target * 4 + step;
          const cost = next.cost + 1 + (step === arrival ? 0 : 3) + (mask ? 2 : 0);
          if (cost >= (visited.get(state) ?? Infinity)) continue;
          visited.set(state, cost);
          queue.push({ id: state, cost, priority: cost + 1.7 * estimate(point(target)), previous: next });
        }
      }
      return false;
    }

    if (terminals.length < 2) return { segments: [], joints: [] };
    const [first, ...rest] = terminals;
    link(first.anchor, first.start, first.direction);
    const pending = new Set(rest);
    const estimates = new Map<number, ReturnType<typeof nearest>>();
    while (pending.size) {
      let connected = false;
      const candidates = [...pending].map(terminal => {
        const estimate = nearest(terminal.start, estimates.get(terminal.start));
        estimates.set(terminal.start, estimate);
        return { ...estimate, terminal };
      }).sort((a, b) => a.best - b.best);
      added.length = 0;
      for (const { terminal, result } of candidates) {
        if (!result || !connect(terminal.start, terminal.direction, result)) continue;
        link(terminal.anchor, terminal.start, terminal.direction);
        pending.delete(terminal);
        connected = true;
        break;
      }
      if (!connected) throw new LocalizedError(message('routingChannels'));
    }

    const segments: Route['segments'] = [];
    const joints: Point[] = [];
    for (const [at, mask] of tree) {
      occupied.set(at, (occupied.get(at) ?? 0) | mask);
      if (directions.filter(direction => mask & direction).length >= 3) joints.push(point(at));
      for (const [direction, group] of [[0, horizontal], [1, vertical]] as const) {
        if (!(mask & directions[direction]) || mask === group) continue;
        let end = at + offsets[direction];
        while (tree.get(end) === group) end += offsets[direction];
        segments.push([point(at), point(end)]);
      }
    }
    return { segments, joints };
  }

  if (reroute) {
    const result = [...reroute.routes];
    for (const index of reroute.order) result[index] = route(starts[index], index);
    return result;
  }
  const result: Route[] = [];
  // Route constrained, short nets before long trunks, preserving input order in output.
  const ordered = starts.map((terminals, index) => ({ terminals, index })).sort((a, b) => a.terminals.length - b.terminals.length);
  for (const { terminals, index } of ordered) result[index] = route(terminals, index);
  return result;
}

interface Span { lo: number; hi: number; lane: number }

// Disjoint spans reuse a lane. A shared endpoint still requires separate lanes.
function assignLanes(spans: Span[]) {
  const ends: number[] = [];
  for (const span of spans.sort((a, b) => a.lo - b.lo || b.hi - a.hi)) {
    let lane = ends.findIndex(end => end < span.lo);
    if (lane < 0) lane = ends.length;
    span.lane = lane;
    ends[lane] = span.hi;
  }
  return ends.length;
}

type Endpoint = { part: number; at: Terminal };
export function routeChannels(boxes: Box[], groups: Endpoint[][], kinds: string[] = []) {
  const margin = 4;
  // Recover the layered order from ELK. Overwide ranks are folded locally
  // into adjacent columns. External ports each keep their own outside column.
  const ranks: number[][] = [];
  let rankRight = -Infinity;
  const byX = boxes.map((_, i) => i).sort((a, b) => boxes[a].x - boxes[b].x);
  for (const i of byX) {
    const box = boxes[i];
    if (box.x >= rankRight) ranks.push([]);
    ranks[ranks.length - 1].push(i);
    rankRight = Math.max(rankRight, box.x + box.width);
  }
  const columns: number[][] = [];
  const targetHeight = Math.max(10, Math.ceil(Math.sqrt(boxes.length) * 1.5));
  for (const rank of ranks) {
    rank.sort((a, b) => boxes[a].y - boxes[b].y);
    const external = ['input', 'output', 'clock', 'inout'].includes(kinds[rank[0]]);
    const count = external ? 1 : Math.ceil(rank.length / targetHeight);
    for (let i = 0; i < count; i++) columns.push(rank.filter((_, index) => index % count === i));
  }

  // Folding a wide logic layer can separate a gate from its consumers.
  // Sweep in both directions and keep the order with the shortest net spans.
  const neighbours = boxes.map(() => [] as { part: number; weight: number }[]);
  for (const group of groups) {
    const source = group.find(end => end.at.side === 'right') ?? group[0];
    if (!source) continue;
    for (const end of group) if (end.part !== source.part) {
      const weight = 1 / Math.sqrt(group.length - 1);
      neighbours[source.part].push({ part: end.part, weight });
      neighbours[end.part].push({ part: source.part, weight });
    }
  }
  const rowOf: number[] = [];
  const updateRows = (parts: number[]) => parts.forEach((id, i) => { rowOf[id] = i - (parts.length - 1) / 2; });
  columns.forEach(updateRows);
  const cost = () => groups.reduce((sum, group) => {
    if (group.length < 2) return sum;
    const ys = group.map(e => rowOf[e.part]);
    return sum + Math.max(...ys) - Math.min(...ys);
  }, 0);
  let best = columns.map(parts => [...parts]);
  let bestCost = cost();
  for (let pass = 0; pass < 6; pass++) {
    const order = pass % 2 ? [...columns].reverse() : columns;
    for (const parts of order) {
      if (parts.length < 2 || ['input', 'output', 'clock', 'inout'].includes(kinds[parts[0]])) continue;
      const score = new Map(parts.map(id => {
        let sum = rowOf[id] * .4;
        let total = .4;
        for (const { part, weight } of neighbours[id]) { sum += rowOf[part] * weight; total += weight; }
        return [id, sum / total];
      }));
      parts.sort((a, b) => score.get(a)! - score.get(b)!);
      updateRows(parts);
    }
    const length = cost();
    if (length < bestCost) { bestCost = length; best = columns.map(parts => [...parts]); }
  }
  columns.splice(0, columns.length, ...best);
  const location: { column: number; row: number }[] = [];
  const rows = Math.max(0, ...columns.map(parts => parts.length));
  columns.forEach((parts, column) => parts.forEach((part, row) => {
    location[part] = { column, row: row + Math.floor((rows - parts.length) / 2) };
  }));
  const placed = boxes.map(box => ({ ...box }));
  const rowHeights = Array<number>(rows).fill(0);
  type PinRow = { y: number; net: number };
  const pins = boxes.map(() => ({ left: [] as PinRow[], right: [] as PinRow[] }));
  groups.forEach((group, net) => {
    if (group.length > 1) for (const { part, at } of group) pins[part][at.side].push({ y: at.point.y, net });
  });

  // Adjacent pin stubs must never share a row within the same channel.
  let previous = new Map<number, Map<number, number>>();
  for (const parts of columns) {
    const next = new Map<number, Map<number, number>>();
    for (const i of parts) {
      const row = location[i].row;
      const blocked = previous.get(row);
      let shift = 0;
      const conflicts = (offset: number) => pins[i].left.some(({ y, net }) => {
        const other = blocked?.get(y + offset);
        return other !== undefined && (other !== net || groups[net].length !== 2);
      });
      while (conflicts(shift)) shift++;
      // Keep facing terminals of a point-to-point net on one horizontal line.
      if (blocked) {
        const aligned = (offset: number) => pins[i].left.filter(p => blocked.get(p.y + offset) === p.net).length;
        const limit = shift + 2;
        for (let offset = shift + 1; offset <= limit; offset++)
          if (!conflicts(offset) && aligned(offset) > aligned(shift)) shift = offset;
      }
      placed[i].y = shift;
      rowHeights[row] = Math.max(rowHeights[row], shift + placed[i].height);
      next.set(row, new Map(pins[i].right.map(({ y, net }) => [y + shift, net])));
    }
    previous = next;
  }

  // A net confined to one gap needs only a local vertical trunk. Longer
  // nets bridge between trunks in the row gutter nearest their median pin.
  const bridges = Array.from({ length: rows }, () => [] as Span[]);
  const channels = Array.from({ length: columns.length + 1 }, () => [] as Span[]);
  const plans = groups.map(group => {
    const byGap = new Map<number, Endpoint[]>();
    if (group.length > 1) for (const end of group) {
      const gap = location[end.part].column + (end.at.side === 'right' ? 1 : 0);
      if (!byGap.has(gap)) byGap.set(gap, []);
      byGap.get(gap)!.push(end);
    }
    const gaps = [...byGap.keys()].sort((a, b) => a - b);
    const trunks = gaps.map(gap => ({ gap, ends: byGap.get(gap)!, lo: 0, hi: 0, lane: 0 }));
    const rowOrder = group.map(e => location[e.part].row).sort((a, b) => a - b);
    const row = rowOrder[Math.floor(rowOrder.length / 2)];
    const bridge = gaps.length > 1 ? { lo: gaps[0], hi: gaps[gaps.length - 1], lane: 0 } : undefined;
    if (bridge) bridges[row].push(bridge);
    return { trunks, row, bridge };
  });
  const rowTop: number[] = [];
  const gutterY: number[] = [];
  let height = margin;
  for (let row = 0; row < rows; row++) {
    rowTop.push(height);
    height += rowHeights[row] + 2;
    gutterY.push(height);
    height += assignLanes(bridges[row]) + 3;
  }
  placed.forEach((box, i) => { box.y += rowTop[location[i].row]; });
  for (const { trunks, bridge, row } of plans) for (const trunk of trunks) {
    const ys = trunk.ends.map(e => placed[e.part].y + e.at.point.y);
    if (bridge) ys.push(gutterY[row] + bridge.lane);
    trunk.lo = Math.min(...ys);
    trunk.hi = Math.max(...ys);
    channels[trunk.gap].push(trunk);
  }
  let width = margin;
  const gapX: number[] = [];
  channels.forEach((channel, gap) => {
    gapX.push(width);
    width += assignLanes(channel) + 2;
    const parts = columns[gap];
    if (parts) {
      for (const i of parts) placed[i].x = width;
      width += Math.max(...parts.map(i => placed[i].width)) + 2;
    }
  });
  const routes = plans.map(({ trunks, bridge, row }): Route => {
    const segments: Route['segments'] = [];
    const joints: Point[] = [];
    const bridgeY = bridge ? gutterY[row] + bridge.lane : undefined;
    const xs = trunks.map(t => gapX[t.gap] + t.lane);
    if (bridgeY !== undefined) segments.push([{ x: xs[0], y: bridgeY }, { x: xs[xs.length - 1], y: bridgeY }]);
    trunks.forEach(({ ends, lo, hi }, i) => {
      const x = xs[i];
      if (lo < hi) segments.push([{ x, y: lo }, { x, y: hi }]);
      if (bridgeY !== undefined && ((i > 0 && i < xs.length - 1) || (lo < bridgeY && bridgeY < hi))) {
        joints.push({ x, y: bridgeY });
      }
      for (const { part, at } of ends) {
        const y = placed[part].y + at.point.y;
        const pinX = placed[part].x + at.point.x;
        segments.push([{ x: Math.min(x, pinX), y }, { x: Math.max(x, pinX), y }]);
        if (lo < y && y < hi) joints.push({ x, y });
      }
    });
    return { segments, joints };
  });
  return { boxes: placed, routes, width: width + margin, height: height + margin };
}
