import { routeNets, routePaths } from './routing';
import type { Box, Point, Route, Terminal } from './routing';

type Segment = [Point, Point];
interface Extent { left: number; right: number; top: number; bottom: number; part?: boolean }
export interface Layout { boxes: Box[]; routes: Route[]; width: number; height: number }
interface Branch { path: Point[]; spans: Extent[] }

const bounds = (a: Point, b: Point): Extent => ({
  left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y),
});
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const pathLength = (path: Point[]) => path.reduce((n, p, i) => i ? n + distance(path[i - 1], p) : n, 0);
const cornerAt = (p: Point, e: Extent) => (p.x === e.left || p.x === e.right) && (p.y === e.top || p.y === e.bottom);
const pointKey = (p: Point) => p.x + ',' + p.y;
const spansFor = (path: Point[]) => path.slice(1).map((p, i) => bounds(path[i], p));

function onlyMeetsAt(a: Extent, b: Extent, joint?: Point) {
  const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right);
  const top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
  return left > right || top > bottom || (left === right && top === bottom && left === joint?.x && top === joint.y);
}

function mergeStraight(path: Point[]) {
  return path.filter((p, i) => {
    if (!i || i === path.length - 1) return true;
    return distance(path[i - 1], path[i + 1]) !== distance(path[i - 1], p) + distance(p, path[i + 1])
      || !(path[i - 1].x === p.x && p.x === path[i + 1].x || path[i - 1].y === p.y && p.y === path[i + 1].y);
  });
}

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

function moveJunction(joint: Point, branches: Branch[], obstacles: Obstacles): Point {
  if (branches.every(({ path }) => path.length === 2)) return joint;
  // Keep the far end of every branch fixed. Try the nearby elbows and
  // projections of adjacent branches onto the existing tracks.
  const spokes = branches.map(branch => {
    const reverse = !same(branch.path[0], joint);
    const path = reverse ? [...branch.path].reverse() : branch.path;
    return { branch, path, reverse, cut: Math.min(3, path.length - 1) };
  });
  const candidates = new Map<string, Point>();
  for (const { path } of spokes) {
    const next = path[1];
    const axis = next.x === joint.x ? 'y' : 'x';
    const length = next[axis] - joint[axis];
    for (const { path: other, cut } of spokes) for (const p of other.slice(1, cut + 1)) {
      const ratio = (p[axis] - joint[axis]) / length;
      if (ratio <= 0 || ratio > 1 || (ratio === 1 && path.length === 2)) continue;
      const candidate = { ...joint, [axis]: p[axis] };
      candidates.set(pointKey(candidate), candidate);
    }
  }
  if (!candidates.size) return joint;

  const removed = branches.flatMap(branch => branch.spans);
  removed.forEach(span => obstacles.remove(span));
  let best = { joint, corners: spokes.reduce((n, s) => n + s.path.length - 2, 0),
    length: spokes.reduce((n, s) => n + pathLength(s.path), 0), paths: [] as Point[][] };
  for (const next of candidates.values()) {
    const choices = spokes.map(({ path, cut }) => {
      const anchor = path[cut];
      if (same(next, anchor)) return [];
      const prefixes = [[next, ...path.slice(1, cut + 1).filter(p => !same(p, next))],
        ...shortcuts([next, ...path.slice(1, cut + 1)]) ];
      const distinct = new Map<string, { points: Point[]; spans: Extent[]; length: number }>();
      for (const prefix of prefixes) {
        const points = mergeStraight([...prefix, ...path.slice(cut + 1)]);
        distinct.set(points.map(pointKey).join('/'), { points, spans: spansFor(points), length: pathLength(points) });
      }
      return [...distinct.values()].filter(({ points, spans }) => {
        const end = points.at(-1)!;
        return spans.every((span, i) => !same(points[i], points[i + 1])
          && obstacles.clear(points[i], points[i + 1], end, end)
          && spans.slice(0, i).every((previous, j) => onlyMeetsAt(span, previous, j === i - 1 ? points[i] : undefined)));
      }).sort((a, b) => a.points.length - b.points.length || a.length - b.length);
    });
    const selected: typeof choices[number] = [];
    function select(index: number, corners: number, length: number) {
      if (corners > best.corners) return;
      if (index === choices.length) {
        if (corners < best.corners || (corners === best.corners && length < best.length)) {
          best = { joint: next, corners, length, paths: selected.map(choice => choice.points) };
        }
        return;
      }
      for (const choice of choices[index]) {
        if (!selected.every(other => other.spans.every(span =>
          choice.spans.every(candidate => onlyMeetsAt(span, candidate, next))))) continue;
        selected.push(choice);
        select(index + 1, corners + choice.points.length - 2, length + choice.length);
        selected.pop();
      }
    }
    select(0, 0, 0);
  }
  if (!best.paths.length) {
    removed.forEach(span => obstacles.add(span));
    return joint;
  }
  spokes.forEach(({ branch, reverse }, i) => {
    const path = reverse ? best.paths[i].reverse() : best.paths[i];
    branch.path.splice(0, branch.path.length, ...path);
    branch.spans = spansFor(path);
    branch.spans.forEach(span => obstacles.add(span));
  });
  return best.joint;
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
  const nets = paths.map(net => net.map(path => {
    const spans = spansFor(path);
    spans.forEach(s => obstacles.add(s));
    return { path, spans };
  }));
  const branches = nets.flat().sort((a, b) => b.path.length - a.path.length);
  let changes = 0;
  for (const { path, spans } of branches) changes += optimizePath(path, spans, obstacles);
  const joints = layout.routes.map(({ joints }, index) => {
    const incident = new Map<string, Branch[]>();
    for (const branch of nets[index]) for (const end of [branch.path[0], branch.path.at(-1)!]) {
      const id = pointKey(end);
      if (!incident.has(id)) incident.set(id, []);
      incident.get(id)!.push(branch);
    }
    return joints.map(joint => {
      const spokes = incident.get(pointKey(joint));
      if (!spokes || spokes.length < 3 || spokes.length > 4) return joint;
      const next = moveJunction(joint, spokes, obstacles);
      if (next !== joint) changes++;
      return next;
    });
  });
  const x = compactAxis(layout.boxes, paths, 'x'), y = compactAxis(layout.boxes, paths, 'y');
  const moved = (axis: typeof x) => [...axis.mapped].some(([from, to]) => from !== to);
  if (!changes && !moved(x) && !moved(y)) return { layout: { ...layout, width: x.size, height: y.size }, stable: true };
  const move = (p: Point) => ({ x: x.mapped.get(p.x)!, y: y.mapped.get(p.y)! });
  const routes = paths.map((net, index) => ({
    joints: joints[index].map(move),
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

interface Pin { part: number; at: Terminal }
const externalKinds = new Set(['input', 'output', 'clock', 'inout']);
const rectangle = (box: Box) => bounds(box, { x: box.x + box.width, y: box.y + box.height });

function measureRoutes(routes: Route[]) {
  const paths = routes.map(routePaths);
  const tracks = paths.flatMap((net, index) => net.flatMap(path => spansFor(path).map(span => ({ span, index }))));
  const horizontal = tracks.filter(({ span }) => span.top === span.bottom);
  const vertical = tracks.filter(({ span }) => span.left === span.right);
  const crossings = new Map<number, Set<number>>();
  let score = paths.flat().reduce((total, path) => total + pathLength(path) + 5 * (path.length - 2), 0);
  for (const h of horizontal) for (const v of vertical) {
    if (h.index === v.index || h.span.left >= v.span.left || h.span.right <= v.span.left
      || v.span.top >= h.span.top || v.span.bottom <= h.span.top) continue;
    score += 8;
    for (const [a, b] of [[h.index, v.index], [v.index, h.index]]) {
      if (!crossings.has(a)) crossings.set(a, new Set());
      crossings.get(a)!.add(b);
    }
  }
  return { paths, crossings, score };
}

function roomFor(box: Box, part: number, layout: Layout) {
  const padded = { x: box.x - 1, y: box.y - 1, width: box.width + 2, height: box.height + 2 };
  return box.x >= 2 && box.y >= 2 && box.x + box.width <= layout.width - 2 && box.y + box.height <= layout.height - 2
    && layout.boxes.every((other, i) => i === part || onlyMeetsAt(rectangle(padded), rectangle(other)));
}

// Refine the initial placement while there is still room to move components.
// Each trial preserves unaffected routes and has a shared interactive time budget.
export function refineLayout(initial: Layout, groups: Pin[][], kinds: string[], budget = 150): Layout {
  if (groups.length > 128 || initial.boxes.length > 160 || initial.width * initial.height > 400_000
    || initial.routes.reduce((n, route) => n + route.segments.length, 0) > 900) return initial;
  const deadline = performance.now() + budget;
  let layout = initial;
  let quality = measureRoutes(initial.routes);
  let attempts = 0;
  const canTry = () => attempts < 24 && performance.now() < deadline;
  const terminalsFor = (boxes: Box[]) => groups.map(group => group.map(({ part, at }) => ({
    side: at.side, point: { x: boxes[part].x + at.point.x, y: boxes[part].y + at.point.y },
  })));
  const partNets = initial.boxes.map(() => new Set<number>());
  groups.forEach((group, i) => group.forEach(({ part }) => partNets[part].add(i)));

  function trial(boxes: Box[], order: number[]) {
    if (!canTry()) return false;
    attempts++;
    let routes: Route[];
    try {
      routes = routeNets(layout.width, layout.height, boxes, terminalsFor(boxes), deadline, { routes: layout.routes, order });
    } catch {
      return false;
    }
    const candidate = measureRoutes(routes);
    if (candidate.score >= quality.score) return false;
    quality = candidate;
    layout = { ...layout, boxes, routes };
    return true;
  }

  const detours = quality.paths.flatMap((net, index) => net.filter(path => path.length > 3).map(path => ({
    index, path, excess: pathLength(path) - distance(path[0], path.at(-1)!) + 5 * (path.length - 2),
  }))).sort((a, b) => b.excess - a.excess);

  // Compare swaps in the same column when the parts participate in a crossing.
  const columns = new Map<number, number[]>();
  layout.boxes.forEach((box, part) => {
    if (externalKinds.has(kinds[part])) return;
    if (!columns.has(box.x)) columns.set(box.x, []);
    columns.get(box.x)!.push(part);
  });
  for (const parts of columns.values()) {
    parts.sort((a, b) => layout.boxes[a].y - layout.boxes[b].y);
    for (let row = 1; row < parts.length && canTry(); row++) {
      const a = parts[row - 1], b = parts[row];
      const affected = new Set([...partNets[a], ...partNets[b]]);
      if (affected.size > 8 || ![...affected].some(net => quality.crossings.has(net))) continue;
      const top = layout.boxes[a], bottom = layout.boxes[b];
      if (top.width !== bottom.width || top.height !== bottom.height) continue;
      const boxes = layout.boxes.map((box, part) => part === a ? { ...box, y: bottom.y }
        : part === b ? { ...box, y: top.y } : box);
      if (trial(boxes, [...affected])) [parts[row - 1], parts[row]] = [b, a];
    }
  }

  // Find the obstacles to a simpler path and try shifts that clear that path.
  for (const { path, index } of detours.slice(0, 10)) {
    if (!canTry()) break;
    if (layout.routes[index] !== initial.routes[index]) continue;
    let improved = false;
    for (const shortcut of [...shortcuts([path[0], path[1], path.at(-1)!])]) {
      for (const span of spansFor(shortcut)) {
        for (const [part, box] of layout.boxes.entries()) {
          if (!canTry() || improved) break;
          if (externalKinds.has(kinds[part]) || partNets[part].has(index) || onlyMeetsAt(span, rectangle(box))) continue;
          const shifts = span.top === span.bottom
            ? [{ ...box, y: span.top - box.height - 1 }, { ...box, y: span.top + 1 }]
            : [{ ...box, x: span.left - box.width - 1 }, { ...box, x: span.left + 1 }];
          shifts.sort((a, b) => distance(a, box) - distance(b, box));
          for (const moved of shifts) {
            if (distance(moved, box) > 8 || !roomFor(moved, part, layout)) continue;
            const affected = new Set([index, ...partNets[part]]);
            const area = rectangle(moved);
            layout.routes.forEach(({ segments }, net) => {
              if (segments.some(([a, b]) => !onlyMeetsAt(bounds(a, b), area))) affected.add(net);
            });
            if (affected.size > 8) continue;
            const boxes = layout.boxes.map((b, i) => i === part ? moved : b);
            if (trial(boxes, [...affected])) { improved = true; break; }
          }
        }
        if (improved) break;
      }
      if (improved) break;
    }
  }

  // Give a detouring or crossing net first choice of its track, then reconnect
  // the crossing nets or tracks occupying its short route.
  const priority = new Set([...detours.map(({ index }) => index), ...quality.crossings.keys()]);
  for (const index of priority) {
    if (!canTry()) break;
    const related = new Set(quality.crossings.get(index));
    for (const path of quality.paths[index]) {
      if (path.length < 4) continue;
      const direct = [...shortcuts([path[0], path[1], path.at(-1)!])].flatMap(spansFor);
      layout.routes.forEach(({ segments }, net) => {
        if (net === index) return;
        if (segments.some(([a, b]) => direct.some(span => !onlyMeetsAt(bounds(a, b), span)))) related.add(net);
      });
    }
    related.delete(index);
    const partners = [...related].slice(0, 4);
    for (const partner of partners) if (trial(layout.boxes, [index, partner])) break;
    if (partners.length > 1) trial(layout.boxes, [index, ...partners]);
  }
  return layout;
}
