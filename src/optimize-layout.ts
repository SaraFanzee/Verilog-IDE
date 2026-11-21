import { routePaths } from './routing';
import type { Box, Point, Route } from './routing';

type Segment = [Point, Point];
interface Extent { left: number; right: number; top: number; bottom: number; part?: boolean }
interface Layout { boxes: Box[]; routes: Route[]; width: number; height: number }

const bounds = (a: Point, b: Point): Extent => ({
  left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y),
});
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const pathLength = (path: Point[]) => path.reduce((n, p, i) => i ? n + distance(path[i - 1], p) : n, 0);
const cornerAt = (p: Point, e: Extent) => (p.x === e.left || p.x === e.right) && (p.y === e.top || p.y === e.bottom);

// Index line spans rather than expanding a long wire into individual grid cells.
class Obstacles {
  private tiles = new Map<string, Set<Extent>>();

  private *keys(e: Extent) {
    for (let y = Math.floor(e.top / 32); y <= Math.floor(e.bottom / 32); y++)
      for (let x = Math.floor(e.left / 32); x <= Math.floor(e.right / 32); x++) yield x + ',' + y;
  }

  add(e: Extent) {
    for (const key of this.keys(e)) {
      const tile = this.tiles.get(key) ?? new Set<Extent>();
      if (!this.tiles.has(key)) this.tiles.set(key, tile);
      tile.add(e);
    }
  }

  remove(e: Extent) {
    for (const key of this.keys(e)) this.tiles.get(key)!.delete(e);
  }

  clear(a: Point, b: Point, start: Point, end: Point) {
    const span = bounds(a, b);
    for (const key of this.keys(span)) for (const e of this.tiles.get(key) ?? []) {
      const x = Math.max(e.left, span.left), y = Math.max(e.top, span.top);
      const right = Math.min(e.right, span.right), bottom = Math.min(e.bottom, span.bottom);
      if (x > right || y > bottom) continue;
      if (x !== right || y !== bottom) return false; // shared track or component interior
      const p = { x, y };
      const endpoint = same(p, start) || same(p, end);
      if (endpoint && (e.part || cornerAt(p, e))) continue;
      // Both wires must pass straight through an unconnected crossing.
      if (e.part || cornerAt(p, e) || same(p, a) || same(p, b)) return false;
    }
    return true;
  }
}

// First try a direct connection, then both one-elbow paths, then doglegs
// using existing tracks. Detours are kept when a shorter path is obstructed.
function* shortcuts(path: Point[]): Generator<Point[]> {
  const a = path[0], b = path.at(-1)!;
  if (a.x === b.x || a.y === b.y) yield [a, b];
  else {
    yield [a, { x: a.x, y: b.y }, b];
    yield [a, { x: b.x, y: a.y }, b];
  }
  if (path.length <= 3) return;
  for (const axis of ['x', 'y'] as const) {
    const other = axis === 'x' ? 'y' : 'x';
    if (a[other] === b[other]) continue;
    const positions = new Set(path.map(p => p[axis]));
    positions.add(Math.round((a[axis] + b[axis]) / 2));
    for (const p of [a, b]) { positions.add(p[axis] - 1); positions.add(p[axis] + 1); }
    for (const pos of positions) if (pos !== a[axis] && pos !== b[axis])
      yield [a, { ...a, [axis]: pos }, { ...b, [axis]: pos }, b];
  }
}

function optimizePath(path: Point[], spans: Extent[], obstacles: Obstacles) {
  let changes = 0;
  for (let first = 0; first < path.length - 2; first++) {
    // Try the whole branch once, then local windows around remaining elbows.
    const stop = first ? Math.min(first + 6, path.length - 1) : path.length - 1;
    for (let last = stop; last >= first + 2; last = Math.min(last - 1, first + 6)) {
      const old = path.slice(first, last + 1);
      const start = old[0], end = old.at(-1)!;
      if (old.length === 3 && start.x !== end.x && start.y !== end.y) continue;
      const length = pathLength(old);
      const removed = spans.slice(first, last);
      removed.forEach(s => obstacles.remove(s));
      let replacement: Point[] | undefined;
      const candidates = Array.from(shortcuts(old), points => ({ points, length: pathLength(points) }))
        .filter(c => c.length <= length && (c.points.length < old.length || c.length < length))
        .sort((a, b) => a.points.length - b.points.length || a.length - b.length);
      for (const { points: candidate } of candidates) {
        if (candidate.every((p, i) => !i || obstacles.clear(candidate[i - 1], p, start, end))) {
          replacement = candidate;
          break;
        }
      }
      if (!replacement) { removed.forEach(s => obstacles.add(s)); continue; }
      path.splice(first, old.length, ...replacement);
      const inserted = replacement.slice(1).map((p, i) => bounds(replacement[i], p));
      spans.splice(first, removed.length, ...inserted);
      inserted.forEach(s => obstacles.add(s));
      changes++;
      break;
    }
  }
  return changes;
}

// Contract unused coordinate bands monotonically. Components translate rigidly,
// and every wire track, pin, crossing and junction retains its relative order.
function compactAxis(boxes: Box[], paths: Point[][][], axis: 'x' | 'y') {
  const size = axis === 'x' ? 'width' : 'height';
  const events = new Map<number, number>();
  for (const box of boxes) {
    const a = box[axis], b = a + box[size];
    events.set(a, (events.get(a) ?? 0) + 1);
    events.set(b, (events.get(b) ?? 0) - 1);
  }
  const tracks = new Set(events.keys());
  for (const net of paths) for (const path of net) for (const p of path) tracks.add(p[axis]);
  const positions = [...tracks].sort((a, b) => a - b);
  const mapped = new Map<number, number>();
  let occupied = 0, at = 4, previous = positions[0];
  for (const pos of positions) {
    const gap = pos - previous;
    at += occupied ? gap : Math.min(gap, events.has(previous) && events.has(pos) ? 4 : 2);
    mapped.set(pos, at);
    occupied += events.get(pos) ?? 0;
    previous = pos;
  }
  return { mapped, size: at + 4 };
}

function optimizeRound(layout: Layout) {
  const paths = layout.routes.map(routePaths);
  const obstacles = new Obstacles();
  for (const b of layout.boxes)
    obstacles.add({ left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height, part: true });
  const branches = paths.flatMap(net => net.map(path => {
    const spans = path.slice(1).map((p, i) => bounds(path[i], p));
    spans.forEach(s => obstacles.add(s));
    return { path, spans };
  })).sort((a, b) => b.path.length - a.path.length);
  let changes = 0;
  for (const { path, spans } of branches) changes += optimizePath(path, spans, obstacles);
  const x = compactAxis(layout.boxes, paths, 'x'), y = compactAxis(layout.boxes, paths, 'y');
  const moved = (axis: typeof x) => [...axis.mapped].some(([from, to]) => from !== to);
  if (!changes && !moved(x) && !moved(y)) return { layout: { ...layout, width: x.size, height: y.size }, stable: true };
  const move = (p: Point) => ({ x: x.mapped.get(p.x)!, y: y.mapped.get(p.y)! });
  const routes = paths.map((net, index) => ({
    joints: layout.routes[index].joints.map(move),
    segments: net.flatMap(path => path.slice(1).map((p, i): Segment => {
      const a = move(path[i]), b = move(p);
      return a.x > b.x || a.y > b.y ? [b, a] : [a, b];
    })),
  }));
  return { layout: { boxes: layout.boxes.map(b => ({ ...b, ...move(b) })), routes, width: x.size, height: y.size }, stable: false };
}

export function optimizeLayout(initial: Layout): Layout {
  // Shortcuts strictly reduce grid length or segment count. Compaction only
  // contracts gaps. Rebuild the obstacle index on each new set of coordinates.
  let layout = initial;
  for (;;) {
    const result = optimizeRound(layout);
    if (result.stable) return result.layout;
    layout = result.layout;
  }
}
