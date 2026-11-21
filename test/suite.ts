import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hdlJob } from '../src/backend';
import { compile, formatValue, parseValue } from '../src/design';
import { Simulation } from '../src/simulation';
import { makeCell } from '../src/cells';
import type { Scope, Vector } from '../src/design';
import { diagramConnections } from '../src/schematic-nets';
import { routeChannels, routeNets, routePaths } from '../src/routing';
import { optimizeLayout, refineLayout } from '../src/optimize-layout';
import type { Route, Terminal } from '../src/routing';
import { defaultDelay } from '../src/simulation';
import { criticalPath } from '../src/critical-path';
import { routeBranch } from '../src/routing';
import type { BuildOptions, Source } from '../src/protocol';

const options: BuildOptions = {
  standard: '1800-2023', top: 'top', mode: 'rtl', optimize: true,
  hierarchy: true, abc: false, observe: true, includes: [], defines: [], parameters: [],
};
function source(text: string): Source { return { id: 'test', name: 'test design.sv', text }; }

async function test(name: string, fn: () => unknown | Promise<unknown>) {
  await fn();
  console.log('OK', name);
}

await test('radices and four-state vector input', () => {
  assert.deepEqual(parseValue('-2', 4, 'int'), ['0', '1', '1', '1']);
  assert.equal(formatValue(parseValue('0xf', 8, 'hex'), 'uint'), '15');
  assert.equal(formatValue(parseValue('z', 5, 'bin'), 'hex'), 'ZZ');
  assert.equal(formatValue(parseValue('0x5', 3, 'hex'), 'bin'), '101');
  assert.throws(() => parseValue('0x8', 3, 'hex'));
});

await test('bus adapters retain pin order, fanout, repeated bits and literal lanes', () => {
  const scope: Scope = { id: '["top"]', label: 'top', signalIds: [], parts: [
    { id: 'src', name: 'src', signal: 'src', type: 'input', pins: [{ name: 'src', direction: 'output', bits: [0, 1, 2, 3] }] },
    { id: 'and', name: 'and', type: '$and', pins: [
      { name: 'A', direction: 'input', bits: [0, 1, 2, 3] },
      { name: 'B', direction: 'input', bits: [2, 2, '0', 1] }] },
    { id: 'reverse', name: 'reverse', type: 'output', pins: [{ name: 'v', direction: 'input', bits: [3, 2, 1, 0] }] },
  ] };
  const before = JSON.stringify(scope);
  const { parts, nets } = diagramConnections(scope, []);
  const wireAt = (part: number, pin: number) => nets.filter(n => n.endpoints.some(e => e.part === part && e.pin === pin));
  for (const [i, part] of scope.parts.entries()) for (const [j, p] of part.pins.entries()) {
    const wires = wireAt(i, j);
    assert.equal(wires.length, 1);
    assert.deepEqual(wires[0].signal.bits, p.bits);
  }
  assert.equal(wireAt(0, 0)[0], wireAt(1, 0)[0]);
  const join = parts[wireAt(1, 1)[0].endpoints.find(e => e.part >= scope.parts.length)!.part];
  assert.equal(join.type, '@join');
  assert(join.pins.some(p => p.name === "1'b0" && p.mapping === "and.B[2] = 1'b0" && p.bits[0] === '0'));
  assert(join.pins.some(p => p.name === '{src[1], 2×src[2]}' && p.mapping?.startsWith('{and.B[3], and.B[1:0]} = ')));
  assert.equal(JSON.stringify(scope), before);
});

await test('adapter labels use declared indices, repeated sources and sized four-state constants', () => {
  const bits = [10, 11, 12, 13];
  const scope: Scope = { id: '["top"]', label: 'top', signalIds: [], parts: [
    { id: 'bus', name: 'bus', type: 'input', pins: [{ name: 'bus', direction: 'output', bits }] },
    { id: 'cell', name: 'cell', type: '$mux', pins: [
      { name: 'A', direction: 'input', bits: [...Array(32).fill('0'), 10, 'x', 'z', '0'] },
      { name: 'B', direction: 'input', bits: Array(32).fill(11) },
      { name: 'C', direction: 'input', bits: [12, 13] },
    ] },
  ] };
  const { parts } = diagramConnections(scope, [{ id: '["top","bus"]', name: 'bus', bits, width: 4, offset: 4,
    upto: true, direction: 'input', editable: true, clock: false, signed: false }]);
  const labels = parts.slice(2).flatMap(part => part.pins.map(pin => pin.name));
  for (const name of ['bus[4:7]', 'bus[4:5]', '32×bus[6]', '32\'b0', '3\'b0zx', 'cell.B[31:0]']) assert(labels.includes(name), name);
});

await test('anonymous adapter labels identify the driving and receiving instances', () => {
  const bus = Array.from({length: 15}, (_, i) => i + 1);
  const scope: Scope = { id: '["top"]', label: 'top', signalIds: [], parts: [
    { id: 'consumer', name: 'consumer', type: '$not', pins: [{name: 'A', direction: 'input', bits: bus}] },
    { id: 'source', name: 'Y', type: '$add', pins: [{name: 'Y', direction: 'output', bits: bus}] },
    ...['$procmux$50', '$procmux$51'].map((name, i) => ({ id: name, name, type: '$mux',
      pins: [{name: 'B', direction: 'input' as const, bits: Array(15).fill(bus[i])}] })),
  ] };
  const { parts } = diagramConnections(scope, []);
  const split = parts.find(p => p.type === '@split')!;
  assert.equal(split.pins[0].name, 'Y.Y[14:0]');
  assert(split.pins.some(p => p.name === 'Y.Y[1]'));
  const joins = parts.filter(p => p.type === '@join');
  assert.deepEqual(joins.map(p => p.pins[0].name), ['$procmux$50.B[14:0]', '$procmux$51.B[14:0]']);
  assert.equal(joins[0].pins[1].mapping, '$procmux$50.B[14:0] = 15×Y.Y[0]');
});

await test('$bmux selects in Yosys bit order and merges X/Z alternatives bit by bit', () => {
  const evaluate = makeCell({ id: 'bmux', name: 'bmux', type: '$bmux', pins: [
    { name: 'A', direction: 'input', bits: [0, 1, 2, 3, 4, 5, 6, 7] },
    { name: 'S', direction: 'input', bits: [8, 9] },
    { name: 'Y', direction: 'output', bits: [10, 11] },
  ] });
  const a: Vector = ['0', '1', '1', '1', 'z', '0', 'z', '0'];
  const result = (s: Vector) => evaluate(name => name === 'A' ? a : s, {}).Y;
  assert.deepEqual(result(['1', '0']), ['1', '1']);
  assert.deepEqual(result(['x', '0']), ['x', '1']);
  assert.deepEqual(result(['z', '1']), ['z', '0']);
  assert.deepEqual(result(['0', 'x']), ['x', 'x']);
});

await test('orthogonal wiring distinguishes crossings and fanout and never shares a segment', () => {
  const terminal = (x: number, y: number, side: Terminal['side']): Terminal => ({ point: { x, y }, side });
  const terminals = [
    [terminal(2, 13, 'right'), terminal(31, 13, 'left')],
    [terminal(15, 3, 'right'), terminal(15, 23, 'right')],
    [terminal(6, 8, 'right'), terminal(23, 8, 'left'), terminal(22, 20, 'left')],
  ];
  const routes = routeNets(35, 28, [], terminals);
  const check = (routes: Route[], expectCrossings = true) => {
    const edges = new Set<string>();
    const owners = new Map<string, Map<number, number>>();
    routes.forEach((route, owner) => {
      for (const [a, b] of route.segments) {
        assert(a.x === b.x || a.y === b.y);
        const dx = Math.sign(b.x - a.x); const dy = Math.sign(b.y - a.y);
        const axis = dx ? 1 : 2;
        const direction = dx ? 1 : 2;
        const nextDirection = direction << 2;
        for (let x = a.x, y = a.y; x !== b.x || y !== b.y; x += dx, y += dy) {
          const edge = `${x},${y}:${axis}`;
          assert(!edges.has(edge), 'shared wire segment at ' + edge);
          edges.add(edge);
          for (const [at, mask] of [[`${x},${y}`, direction], [`${x + dx},${y + dy}`, nextDirection]] as const) {
            if (!owners.has(at)) owners.set(at, new Map());
            const map = owners.get(at)!;
            map.set(owner, (map.get(owner) ?? 0) | mask);
          }
        }
      }
    });
    let crossings = 0;
    for (const masks of owners.values()) if (masks.size > 1) {
      crossings++;
      assert.deepEqual([...masks.values()].sort((a, b) => a - b), [5, 10]);
    }
    if (expectCrossings) assert(crossings > 0);
  };
  check(routes);
  assert.equal(routes[0].joints.length, 0);
  assert.equal(routes[1].joints.length, 0);
  assert.equal(routes[2].joints.length, 1);
  // Force the fallback's long bridge and crossing cases as well.
  const boxed = Array.from({ length: 6 }, (_, i) => ({ x: 0, y: i * 6, width: 5, height: 5 }));
  const channel = routeChannels(boxed, [
    [{ part: 0, at: terminal(5, 2, 'right') }, { part: 3, at: terminal(0, 2, 'left') }],
    [{ part: 1, at: terminal(5, 2, 'right') }, { part: 4, at: terminal(0, 2, 'left') }],
    [{ part: 2, at: terminal(5, 2, 'right') }, { part: 4, at: terminal(5, 2, 'right') }, { part: 5, at: terminal(0, 2, 'left') }],
  ]);
  check(channel.routes);
  check(optimizeLayout(channel).routes, false);
  assert.equal(channel.routes[2].joints.length, 1);
});

await test('route cleanup straightens clear corridors, keeps pins fixed on their components and respects obstacles', () => {
  const points = [[4,4], [10,4], [10,10], [34,10], [34,4], [40,4]].map(([x,y]) => ({x,y}));
  const route: Route = { segments: points.slice(1).map((p,i) => [points[i],p]), joints: [] };
  const boxes = [{x:0, y:2, width:4, height:4}, {x:40, y:2, width:4, height:4}];
  const run = (blocked: boolean) => optimizeLayout({
    boxes: blocked ? [...boxes, {x:18,y:1,width:9,height:6}] : boxes, routes:[route], width:64, height:40,
  });
  for (const blocked of [false, true]) {
    const result = run(blocked);
    const [left, right, obstacle] = result.boxes;
    const start = {x:left.x + left.width, y:left.y + 2}, end = {x:right.x,y:right.y + 2};
    const path = routeBranch(result.routes[0], start, end);
    assert.deepEqual(path[0], start);
    assert.deepEqual(path.at(-1), end);
    assert.equal(routePaths(result.routes[0])[0].length, blocked ? 6 : 2);
    assert(result.width < 64 && result.height < 40);
    if (obstacle) for (const [a,b] of result.routes[0].segments) {
      assert(b.x < obstacle.x || a.x > obstacle.x + obstacle.width || b.y < obstacle.y || a.y > obstacle.y + obstacle.height);
    }
  }
});

await test('a three-elbow branch becomes a single joined elbow at the same electrical junction', () => {
  const points = [[4,4],[10,4],[10,8],[28,8],[28,14]].map(([x,y])=>({x,y}));
  const joint = points.at(-1)!;
  const segments: Route['segments'] = points.slice(1).map((p,i)=>[points[i],p]);
  segments.push([joint,{x:36,y:14}],[joint,{x:28,y:20}]);
  const {boxes,routes} = optimizeLayout({boxes:[{x:0,y:2,width:4,height:4}],routes:[{segments,joints:[joint]}],width:40,height:32});
  const start = {x:boxes[0].x+4,y:boxes[0].y+2};
  const branch = routeBranch(routes[0],start,routes[0].joints[0]);
  assert.equal(branch.length,3);
  assert.equal(branch[1].y,start.y);
  assert.equal(branch[1].x,routes[0].joints[0].x);
  assert.deepEqual(routePaths(routes[0]).map(p=>p.length).sort(),[2,2,3]);
});

await test('a junction slides along a trunk but stays clear of another net crossing it', () => {
  const joint = { x: 12, y: 12 };
  const route: Route = { joints: [joint], segments: [
    [{ x: 4, y: 12 }, { x: 30, y: 12 }],
    [joint, { x: 12, y: 22 }],
    [{ x: 12, y: 22 }, { x: 20, y: 22 }],
  ] };
  const foreign: Route = { joints: [], segments: [[{ x: 20, y: 7 }, { x: 20, y: 17 }]] };
  const run = (routes: Route[]) => optimizeLayout({ boxes: [], routes, width: 36, height: 30 }).routes;
  const [straight] = run([route]);
  assert.deepEqual(routePaths(straight).map(path => path.length), [2, 2, 2]);
  assert.equal(straight.joints.length, 1);
  const [blocked, crossing] = run([route, foreign]);
  assert(routePaths(blocked).some(path => path.length > 2));
  assert.notEqual(blocked.joints[0].x, crossing.segments[0][0].x);
  assert.equal(crossing.joints.length, 0);
});

await test('placing a junction on an existing elbow removes the separate bend', () => {
  const joint = { x: 12, y: 12 }, elbow = { x: 22, y: 12 };
  const route: Route = { joints: [joint], segments: [
    [{ x: 4, y: 12 }, elbow], [elbow, { x: 22, y: 26 }],
    [joint, { x: 12, y: 4 }], [{ x: 12, y: 4 }, { x: 22, y: 4 }],
  ] };
  const layout = optimizeLayout({ boxes: [], routes: [route], width: 30, height: 34 });
  const [result] = layout.routes;
  assert.deepEqual(routePaths(result).map(path => path.length), [2, 2, 2]);
  assert.equal(result.joints.length, 1);
  assert.equal(result.segments.filter(([a, b]) => a.x === b.x && a.x === result.joints[0].x).length, 2);
  assert.deepEqual(optimizeLayout(layout), layout);
});

await test('local rerouting moves an obstructing component and keeps every pin connected', () => {
  const boxes = [{ x: 4, y: 10, width: 4, height: 4 }, { x: 36, y: 10, width: 4, height: 4 },
    { x: 18, y: 10, width: 5, height: 4 }, { x: 28, y: 19, width: 4, height: 4 }];
  const groups = [
    [{ part: 0, at: { side: 'right', point: { x: 4, y: 2 } } }, { part: 1, at: { side: 'left', point: { x: 0, y: 2 } } }],
    [{ part: 2, at: { side: 'right', point: { x: 5, y: 3 } } }, { part: 3, at: { side: 'left', point: { x: 0, y: 2 } } }],
  ] satisfies Parameters<typeof refineLayout>[1];
  const points = [[8,12], [10,12], [10,8], [34,8], [34,12], [36,12]].map(([x, y]) => ({ x, y }));
  const routes: Route[] = [
    { joints: [], segments: points.slice(1).map((p, i) => [points[i], p]) },
    { joints: [], segments: [[{ x: 23, y: 13 }, { x: 25, y: 13 }], [{ x: 25, y: 13 }, { x: 25, y: 21 }],
      [{ x: 25, y: 21 }, { x: 28, y: 21 }]] },
  ];
  const result = refineLayout({ boxes, routes, width: 48, height: 30 }, groups, ['input', 'output', 'cell', 'output'], 1000);
  assert.notEqual(result.boxes[2].y, boxes[2].y);
  assert.deepEqual(result.boxes.slice(0, 2), boxes.slice(0, 2));
  assert.equal(routePaths(result.routes[0])[0].length, 2);
  groups.forEach((group, i) => {
    const [start, end] = group.map(({ part, at }) => ({
      x: result.boxes[part].x + at.point.x, y: result.boxes[part].y + at.point.y,
    }));
    assert.deepEqual(routeBranch(result.routes[i], start, end).at(-1), end);
  });
});

await test('crossing nets can swap adjacent components while leaving unrelated wires in place', () => {
  const boxes = [{ x: 4, y: 9, width: 4, height: 4 }, { x: 4, y: 39, width: 4, height: 4 },
    { x: 30, y: 2, width: 4, height: 18 }, { x: 30, y: 32, width: 4, height: 18 },
    { x: 4, y: 53, width: 4, height: 4 }, { x: 30, y: 53, width: 4, height: 4 }];
  const groups = [[0, 3], [1, 2], [4, 5]].map(([from, to]) => [
    { part: from, at: { side: 'right' as const, point: { x: 4, y: 2 } } },
    { part: to, at: { side: 'left' as const, point: { x: 0, y: to === 5 ? 2 : 9 } } },
  ]);
  const routes: Route[] = [
    [[8,11], [14,11], [14,26], [26,26], [26,41], [30,41]],
    [[8,41], [20,41], [20,11], [30,11]],
    [[8,55], [30,55]],
  ].map(points => {
    const path = points.map(([x, y]) => ({ x, y }));
    return { segments: path.slice(1).map((point, i) => [path[i], point]), joints: [] };
  });
  const result = refineLayout({ boxes, routes, width: 42, height: 64 }, groups,
    ['input', 'input', 'cell', 'cell', 'input', 'output'], 1000);
  assert.equal(result.boxes[2].y, boxes[3].y);
  assert.equal(result.boxes[3].y, boxes[2].y);
  assert.equal(routePaths(result.routes[0])[0].length, 2);
  assert.equal(routePaths(result.routes[1])[0].length, 2);
  assert.equal(result.routes[2], routes[2]);
});

await test('compacted tracks are rechecked until a chain of blocked shortcuts is straight', () => {
  // Each detour occupies the middle of the previous wire's direct path.
  const routes = Array.from({ length: 6 }, (_, i): Route => {
    const y = 14 + 10 * i;
    const points = [[4,y],[7+i,y],[7+i,y-10],[36-i,y-10],[36-i,y],[40,y]].map(([x,y]) => ({x,y}));
    return { joints: [], segments: points.slice(1).map((p,j) => [points[j],p]) };
  });
  const boxes = [0,40].map(x => ({x, y:0, width:4, height:70}));
  boxes.push(...routes.map((_, i) => ({x:15, y:5 + i * 10, width:14, height:8})));
  const result = optimizeLayout({boxes, routes, width:50, height:80});
  assert.deepEqual(result.routes.map(r => routePaths(r)[0].length), [2,2,2,2,2,2]);
  assert.deepEqual(optimizeLayout(result), result);
});

await test('relative defaults increase with logic depth', () => {
  assert(defaultDelay('$_NAND_') < defaultDelay('$_AND_'));
  assert(defaultDelay('$_AND_') < defaultDelay('$_XOR_'));
  assert(defaultDelay('$_MUX_') < defaultDelay('$bmux'));
  assert(defaultDelay('$add') < defaultDelay('$mul'));
  assert(defaultDelay('$mul') < defaultDelay('$div'));
});

await test('critical path traverses hierarchy, stops at storage and follows delay edits', async () => {
  const fixture = source(`module leaf(input q, b, output y);
    wire nq = ~q; assign y = nq & b; endmodule
    module top(input clk, a, b, output y, fast);
    reg q; always @(posedge clk) q <= fast;
    leaf u(q, b, y); assign fast = a ^ b; endmodule`);
  const result = await hdlJob([fixture], options, false);
  assert(result.ok && result.netlist && result.top, result.log);
  const design = compile(result.netlist, result.top);
  const root = design.scopes[0];
  const analyse = (delays: Map<string, number>, scope = root) => {
    const analysis = criticalPath(design, scope, delays);
    assert('path' in analysis);
    return analysis.path;
  };
  const path = analyse(new Map());
  assert.equal(path.ticks, 5, JSON.stringify({ steps: path.steps, types: design.cells.map(c => [c.name, c.type]) }));
  assert(path.parts.has(root.parts.find(p => p.child)!.id));
  assert.equal(analyse(new Map(), design.scopes[1]).ticks, 3);
  assert.equal(analyse(new Map([['$xor', 9]])).ticks, 9);
  assert.equal(analyse(new Map(design.cells.map(c => [c.type, 0]))).ticks, 0);
  // Inject combinational feedback into the XOR driving a capture input.
  const xor = design.cells.find(c => c.type === '$xor')!;
  xor.pins.find(p => p.name === 'A')!.bits = xor.pins.find(p => p.name === 'Y')!.bits;
  assert('message' in criticalPath(design, root, new Map()));
});

await test('critical wire follows the selected fanout branch', () => {
  const a = { x: 1, y: 2 }, b = { x: 9, y: 2 };
  const joint = { x: 4, y: 2 }, c = { x: 4, y: 8 };
  const route: Route = { segments: [[a, b], [joint, c]], joints: [joint] };
  assert.deepEqual(routeBranch(route, a, c), [a, joint, c]);
  assert.deepEqual(routeBranch(route, a, b), [a, joint, b]);
});

await test('real-time lint on an unsaved source with a space in its name', async () => {
  const result = await hdlJob([source('module top;\nwire =;\nendmodule')], options, true);
  assert.equal(result.ok, false, result.log);
  assert(result.diagnostics.some(diagnostic => diagnostic.id === 'test' && diagnostic.line === 2), result.log);
});

const counter = source(`
module leaf (input logic a, b, output wire y);
  assign y = a & b;
endmodule
module top #(parameter W=4) (input logic clk, reset, go, drive, input logic [W-1:0] data,
  output logic [W-1:0] count, output wire [W-1:0] bus, output wire both);
  logic [W-1:0] next_count;
  leaf child(.a(go), .b(drive), .y(both));
  assign next_count = count + 1'b1;
  always_ff @(posedge clk or posedge reset) begin
    if (reset) count <= '0;
    else if (go) count <= next_count;
  end
  assign bus = drive ? data : 'z;
endmodule
`);
const get = (mode: BuildOptions['mode']) => hdlJob([counter], { ...options, mode, parameters: ['W=5'] }, false);

for (const mode of ['rtl', 'gate'] as const) await test(`${mode}: synthesize hierarchy and run counter, three-state bus, clock, delay and rewind`, async () => {
  const result = await get(mode);
  assert(result.ok && result.netlist && result.top, result.log);
  const design = compile(result.netlist, result.top, result.sourceNetlist);
  assert(design.scopes.length > 1, 'hierarchical instance missing');
  const sim = new Simulation(design, { end: 150, period: 10 });
  sim.setDelays(Object.fromEntries(design.cells.map(cell => [cell.type, 1])));
  const signal = (name: string) => {
    const signal = design.signals.find(item => item.name === name);
    assert(signal?.bits, name + ' is not observable');
    return signal;
  };
  const set = (name: string, time: number, value: string, duration: 'step' | 'period' | 'end' = 'end') => {
    const input = signal(name);
    return sim.edit(input.id, time, parseValue(value, input.width, 'bin'), duration);
  };
  const value = (name: string, time: number, radix: 'bin' | 'uint' = 'bin') => formatValue(sim.value(signal(name).bits!, time), radix);
  assert.equal(signal('count').width, 5);
  assert.equal(signal('clk').clock, true);
  assert.equal(set('clk', 0, '1'), undefined);
  assert.equal(set('count', 0, '1'), undefined);
  set('reset', 0, '1');
  set('reset', 2, '0');
  set('go', 2, '1');
  set('data', 2, '10101');
  set('drive', 30, '1');
  sim.advance(150);
  assert.equal(value('clk', 4), '0');
  assert.equal(value('clk', 5), '1');
  const triState = value('bus', 20);
  assert.equal(triState, 'ZZZZZ');
  assert.equal(value('bus', 45), '10101');
  assert.equal(value('both', 50), '1');
  assert.notEqual(value('count', 50), 'XXXXX');
  const oldPrefix = sim.wave(signal('count').bits!, 0, 70);
  assert.equal(set('go', 76, '0', 'period'), 70);
  assert.equal(sim.computed, 69);
  assert.deepEqual(sim.wave(signal('count').bits!, 0, 69), oldPrefix.filter(change => change.time <= 69));
  sim.advance(150);
  assert.equal(value('go', 69), '1');
  assert.equal(value('go', 70), '0');
  assert.equal(value('go', 79), '0');
  assert.equal(value('go', 80), '1');
  set('drive', 86, '0', 'step');
  sim.advance(150);
  assert.equal(value('drive', 85), '1');
  assert.equal(value('drive', 86), '0');
  assert.equal(value('drive', 87), '1');
  set('drive', 120, '0');
  set('drive', 110, '1');
  sim.advance(150);
  assert.equal(value('drive', 150), '1');
  assert.equal(value('bus', 149), '10101');
  sim.setClock(signal('clk').id, 20);
  sim.advance(150);
  assert.equal(value('clk', 5), '0');
  assert.equal(value('clk', 10), '1');
});

await test('cell delay and recomputation match uninterrupted simulation', async () => {
  const result = await hdlJob([source('module top(input a, b, output y); assign y = a & b; endmodule')], options, false);
  assert(result.ok && result.netlist && result.top, result.log);
  const design = compile(result.netlist, result.top);
  const signal = (name: string) => design.signals.find(signal => signal.name === name)!;
  const a = signal('a'); const b = signal('b'); const y = signal('y').bits!;
  const make = () => {
    const sim = new Simulation(design, { end: 180, period: 10 });
    sim.setDelay('$and', 4);
    sim.edit(a.id, 0, ['1'], 'end');
    return sim;
  };
  const sim = make();
  sim.advance(180);
  sim.edit(b.id, 73, ['1'], 'end');
  sim.advance(180);
  assert.equal(sim.value(y, 76)[0], '0');
  assert.equal(sim.value(y, 77)[0], '1');
  const uninterrupted = make();
  uninterrupted.edit(b.id, 73, ['1'], 'end');
  uninterrupted.advance(180);
  assert.deepEqual(sim.wave(y, 0, 180), uninterrupted.wave(y, 0, 180));
  sim.setDelays({ '$and': 0 });
  sim.advance(180);
  assert.equal(sim.value(y, 72)[0], '0');
  assert.equal(sim.value(y, 73)[0], '1');
  sim.setDelays({ '$and': 4 });
  sim.advance(180);
  assert.deepEqual(sim.wave(y, 0, 180), uninterrupted.wave(y, 0, 180));
});

await test('ABC gate mapping works with the selected toolchain', async () => {
  const result = await hdlJob([source('module top(input a, b, c, output y); assign y = ~((a & b) | c); endmodule')], {
    ...options, mode: 'gate', abc: true,
  }, false);
  assert(result.ok && result.netlist && result.top, result.log);
  const design = compile(result.netlist, result.top);
  const simulator = new Simulation(design, { end: 20, period: 10 });
  simulator.advance(20);
  const y = design.signals.find(signal => signal.name === 'y')!;
  assert.equal(simulator.value(y.bits!, 20)[0], '1');
});

if (process.env.VERILOG_IDE_COMPARE_ICARUS === '1') await test('zero-delay four-state combinational output agrees with Icarus Verilog', async () => {
  const rtl = "module top(input a, b, en, output y); assign y = en ? (a & b) : 1'bz; endmodule";
  const cases = [
    ['0', 'x', '1'], ['1', 'z', '1'], ['1', '1', '1'], ['1', '1', '0'], ['1', '1', 'x'], ['x', '0', '1'],
  ] as const;
  const workspace = await mkdtemp(join(tmpdir(), 'verilog-ide-compare-'));
  try {
    const drives = cases.map(([a, b, en]) => `a=1'b${a}; b=1'b${b}; en=1'b${en}; #1 $display("%b", y);`).join('\n');
    await writeFile(join(workspace, 'reference.sv'), `${rtl}\nmodule tb; reg a,b,en; wire y; top dut(a,b,en,y); initial begin ${drives} end endmodule\n`);
    execFileSync('iverilog', ['-g2012', '-s', 'tb', '-o', 'reference.vvp', 'reference.sv'], { cwd: workspace, windowsHide: true });
    const reference = execFileSync('vvp', ['reference.vvp'], { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
    const result = await hdlJob([source(rtl)], options, false);
    assert(result.ok && result.netlist && result.top, result.log);
    const design = compile(result.netlist, result.top);
    const sim = new Simulation(design, { end: cases.length - 1, period: 2 });
    const signal = (name: string) => design.signals.find(signal => signal.name === name)!;
    for (const type of new Set(design.cells.map(cell => cell.type))) sim.setDelay(type, 0);
    for (const [time, bits] of cases.entries()) for (const [index, name] of ['a', 'b', 'en'].entries()) {
      sim.edit(signal(name).id, time, [bits[index]], 'step');
    }
    sim.advance(cases.length - 1);
    assert.deepEqual(cases.map((_, time) => sim.value(signal('y').bits!, time)[0]), reference);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
