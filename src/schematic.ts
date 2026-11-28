import { t, translate } from './i18n';
import type { Message } from './i18n';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api';
import { formatValue, logicState, radixShort } from './design';
import type { Logic, Part, Radix, Scope, Signal } from './design';
import type { Bit } from './protocol';
import type { Box, Point, Route, Terminal } from './routing';
import type { LayoutRequest, LayoutResult } from './layout-worker';
import { diagramConnections } from './schematic-nets';
import type { WireNet } from './schematic-nets';
import { gateKinds, symbolKind, symbolShape } from './symbols';
import type { CriticalPath } from './critical-path';
import { routeBranch, routePaths } from './routing';

export type Palette = Record<Logic, string>;
export const defaultPalette: Palette = { '0': '#638ba4', '1': '#5ae9bd', x: '#f3b966', z: '#bd9df7' };
const ns = 'http://www.w3.org/2000/svg';
const grid = 8;
const px = (value: number) => value * grid;
// Reference artwork width of the v0.1.12 RTL buffer with A, EN and Y.
const triBufferWidth = px(11) * 2 / 3;
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}) {
  const element = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}
const short = (name: string, length: number) => name.length > length ? name.slice(0, length - 1) + '…' : name;
const isAdapter = (part: Part) => part.type === '@join' || part.type === '@split';
const partTitle = (part: Part) => part.signal || part.child || isAdapter(part) ? part.name : part.type.replace(/^\$_?/, '').replace(/_$/, '').toUpperCase();
const pinSide = (pin: Part['pins'][number]) => pin.direction === 'output' ? 'right' : 'left';
interface Slot { net?: number; pin: Part['pins'][number]; at: Terminal; stub?: SVGLineElement }
function pinCaption({ pin, net }: Pick<Slot, 'pin' | 'net'>) {
  const constant = net === undefined && pin.bits.every(bit => typeof bit !== 'number')
    ? '=' + formatValue(pin.bits as Logic[], 'hex') : '';
  return pin.name + constant;
}
interface LayoutNode { box: Box; ports: Slot[]; kind: string; part: Part; barX?: number }
interface WireShape { shapes: SVGElement[]; bits: Bit[]; title: SVGTitleElement; signal?: Signal; aliases?: Signal[] }
type WireMenu = (signal: Signal, x: number, y: number, aliases?: Signal[]) => void;
function exactAliases(net: WireNet) {
  const bits = net.signal.bits!;
  return net.aliases.map(a => a.signal).filter(s => s.bits?.length === bits.length && s.bits.every((bit, i) => bit === bits[i]));
}
interface Contact { part: Part; slot: Slot; point: Point }
interface Trace { route: Route; contacts: Contact[] }
function valueTitle(value: Logic[], radix: Radix) {
  const decimalUnknown = (radix === 'int' || radix === 'uint') && value.some(v => v === 'x' || v === 'z');
  return formatValue(value, radix) + ' (' + radixShort[radix] + (decimalUnknown ? ', ' + t('showingBinary') : '') + ')';
}

function layoutNodes(parts: Part[], nets: WireNet[], portWidths: Map<string, number>) {
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = '10px ' + getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
  const byPin = new Map<string, number[]>();
  nets.forEach((net, i) => net.endpoints.forEach(endpoint => {
    if (!byPin.has(endpoint.key)) byPin.set(endpoint.key, []);
    byPin.get(endpoint.key)!.push(i);
  }));
  const typeSizes = new Map<string, { width: number; height: number }>();
  const specs = parts.map((part, index) => {
    const kind = symbolKind(part);
    const sides: Record<Terminal['side'], { net?: number; pin: Slot['pin'] }[]> = { left: [], right: [] };
    part.pins.forEach((pin, p) => {
      const list = sides[pinSide(pin)];
      const connections = byPin.get(`${index}:${p}`);
      list.push(...(connections?.length ? connections.map(net => ({ net, pin })) : [{ pin }]));
    });
    const count = Math.max(sides.left.length, sides.right.length);
    const adapter = isAdapter(part);
    const slots = count > 12 && !adapter && kind !== 'mux' ? 1 : 2;
    const header = !adapter && !part.signal && !gateKinds.has(kind) && kind !== 'tribuf';
    const titleRows = kind === 'mux' ? 3 : 0;
    const height = Math.max(header ? 8 : 6, (header ? 6 : 4) + slots * (count - 1)) + titleRows;
    const labelSpace = (side: Terminal['side']) => Math.ceil((12 + Math.max(0, ...sides[side].map(({ pin }) => measure.measureText(pin.name).width))) / grid);
    const barX = adapter ? labelSpace('left') : undefined;
    const width = barX !== undefined ? barX + labelSpace('right') : portWidths.get(part.id) ?? (kind === 'tribuf' ? Math.ceil(triBufferWidth / grid) : gateKinds.has(kind) ? 9 : kind === 'mux' ? 7
      : Math.max(7, Math.min(17, Math.ceil((partTitle(part).length * 7 + 22) / grid))));
    const cellType = part.signal || adapter ? undefined : part.type;
    if (cellType) {
      const previous = typeSizes.get(cellType);
      typeSizes.set(cellType, { width: Math.max(width, previous?.width ?? 0), height: Math.max(height, previous?.height ?? 0) });
    }
    return { part, kind, sides, slots, barX, titleRows, cellType, width, height };
  });
  const nodes = specs.map((spec): LayoutNode => {
    const { part, kind, sides, slots, barX, titleRows, cellType } = spec;
    const { width, height } = (cellType && typeSizes.get(cellType)) || spec;
    const ports = (['left', 'right'] as const).flatMap(side => sides[side].map((port, i, list): Slot => ({
      ...port, at: { side, point: { x: side === 'left' ? 0 : width, y: Math.floor((height + titleRows - slots * (list.length - 1)) / 2) + i * slots } },
    })));
    return { box: { x: 0, y: 0, width, height }, ports, kind, part, barX };
  });
  const elkNodes: ElkNode[] = nodes.map(({ box, ports }, index) => ({
    id: 'n' + index, width: box.width, height: box.height, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
    ports: ports.map(({ at }, i) => ({ id: `n${index}p${i}`, x: at.point.x, y: at.point.y, width: 0, height: 0,
      layoutOptions: { 'elk.port.side': at.side === 'left' ? 'WEST' : 'EAST' } })),
  }));
  const ends = nets.map(() => [] as { part: number; port: number; at: Terminal }[]);
  nodes.forEach(({ ports }, part) => ports.forEach(({ net, at }, port) => {
    if (net !== undefined) ends[net].push({ part, port, at });
  }));
  const edges: ElkExtendedEdge[] = [];
  for (const endpoints of ends) {
    const source = endpoints.find(end => end.at.side === 'right') ?? endpoints[0];
    for (const target of endpoints) if (source.part !== target.part) {
      edges.push({ id: 'e' + edges.length, sources: [`n${source.part}p${source.port}`], targets: [`n${target.part}p${target.port}`] });
    }
  }
  return { nodes, elkNodes, edges, ends };
}

export class Schematic {
  private layoutError?: Message | string;
  private drawing?: SVGSVGElement;
  private view = { width: 1, height: 1 };
  private layout?: Worker;
  private zoom = 1;
  private manualView = false;
  private shift = { x: 0, y: 0 };
  private lastValues: Logic[] = [];
  private palette = defaultPalette;
  private radixFor: (signal: Signal) => Radix = signal => signal.width === 1 ? 'bin' : 'hex';
  private highlights = '';
  private critical?: CriticalPath;
  private traces = new Map<number, Trace[]>();
  private overlay?: SVGGElement;
  private wires: WireShape[] = [];
  private labels: { shape: SVGTextElement; signal: Signal; title: SVGTitleElement }[] = [];
  private current?: { scope: Scope; signals: Signal[] };
  private portWidths = new Map<string, number>();
  private portRadices = new Map<string, Radix>();
  private groups: { shape: SVGGElement; part: Part }[] = [];

  constructor(private host: HTMLElement, private onPart: (part: Part, alternate: boolean) => void, private onWire: WireMenu) {
    new ResizeObserver(() => this.resize()).observe(host);
    host.addEventListener('wheel', event => {
      if (!this.drawing || event.deltaY === 0) return;
      event.preventDefault();
      const { left, top } = host.getBoundingClientRect();
      this.scale(event.deltaY < 0 ? 1.15 : 1 / 1.15, { x: event.clientX - left, y: event.clientY - top });
    }, { passive: false });
    let drag: { first: Point; shift: Point; id: number; active: boolean } | undefined;
    let suppressClick = false;
    host.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !this.drawing) return;
      suppressClick = false;
      drag = { first: { x: event.clientX, y: event.clientY }, shift: { ...this.shift }, id: event.pointerId, active: false };
    });
    host.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id || !(event.buttons & 1)) return;
      const dx = event.clientX - drag.first.x;
      const dy = event.clientY - drag.first.y;
      if (!drag.active && Math.hypot(dx, dy) < 4) return;
      if (!drag.active) host.setPointerCapture(event.pointerId);
      drag.active = true;
      this.manualView = true;
      suppressClick = true;
      host.classList.add('panning');
      this.shift = { x: drag.shift.x + dx, y: drag.shift.y + dy };
      this.resize();
    });
    const stopDrag = () => { drag = undefined; host.classList.remove('panning'); };
    host.addEventListener('pointerup', stopDrag);
    host.addEventListener('pointercancel', stopDrag);
    host.addEventListener('lostpointercapture', stopDrag);
    host.addEventListener('click', event => {
      if (suppressClick) { suppressClick = false; event.stopPropagation(); }
    }, true);
  }

  private portWidth(signal: Signal, radix: Radix) {
    const width = signal.width;
    let digits = width;
    if (radix === 'hex') digits = Math.ceil(width / 4);
    if ((radix === 'int' || radix === 'uint') && signal.bits?.every(bit => {
      const value = typeof bit === 'number' ? this.lastValues[bit] : bit;
      return value === '0' || value === '1';
    })) digits = Math.ceil(width * Math.log10(2)) + (radix === 'int' ? 1 : 0);
    const name = (JSON.parse(signal.id) as string[]).at(-1)!;
    return Math.max(7, Math.ceil((digits * 8 + 28) / grid), Math.ceil((name.length * 8 + (signal.clock ? 39 : 26)) / grid));
  }

  show(scope: Scope, signals: Signal[], resizedPort?: string) {
    const keepDrawing = !!resizedPort && !!this.drawing;
    this.current = { scope, signals };
    this.portWidths.clear(); this.portRadices.clear();
    for (const signal of signals) if (signal.direction) {
      const radix = this.radixFor(signal);
      this.portWidths.set(signal.id, this.portWidth(signal, radix));
      this.portRadices.set(signal.id, radix);
    }
    this.layout?.terminate();
    const placeholder = document.createElement('div');
    placeholder.className = 'empty';
    this.layoutError = undefined;
    placeholder.textContent = t('layoutRunning');
    if (!keepDrawing) {
      this.host.replaceChildren(placeholder);
      this.drawing = undefined;
      this.wires = []; this.labels = []; this.groups = [];
      this.overlay = undefined; this.traces.clear();
    }
    const signalById = new Map(signals.map(signal => [signal.id, signal]));
    const { nets, parts } = diagramConnections(scope, signals);
    const { nodes, elkNodes, edges, ends } = layoutNodes(parts, nets, this.portWidths);
    const layout = new Worker('./layout-worker.js');
    this.layout = layout;
    const done = () => { layout.terminate(); this.layout = undefined; };
    const fail = (error: Message | string) => {
      done();
      this.layoutError = error;
      this.host.replaceChildren(placeholder);
      this.refreshLanguage();
    };
    layout.onerror = event => { if (this.layout === layout) fail(event.message); };
    layout.onmessage = ({ data }: MessageEvent<LayoutResult>) => {
      if (this.layout !== layout) return;
      if ('error' in data) { fail(data.error); return; }
      done();
      const oldPort = keepDrawing && this.manualView ? this.groups.find(g => g.part.id === resizedPort) : undefined;
      const oldPosition = oldPort?.shape.transform.baseVal.getItem(0).matrix;
      this.wires = []; this.labels = []; this.groups = [];
      this.traces.clear();
      this.view = { width: px(data.width), height: px(data.height) };
      const drawing = svg('svg', { 'aria-label': scope.label });
      const labels = svg('g', { class: 'net-labels' });
      data.routes.forEach((route, index) => {
        this.drawWire(drawing, labels, route, nets[index]);
        const contacts = ends[index].map(({ part, port, at }) => ({
          part: nodes[part].part, slot: nodes[part].ports[port],
          point: { x: data.boxes[part].x + at.point.x, y: data.boxes[part].y + at.point.y },
        }));
        const trace = { route, contacts };
        for (const bit of new Set(nets[index].signal.bits)) if (typeof bit === 'number') {
          const list = this.traces.get(bit) ?? [];
          list.push(trace); this.traces.set(bit, list);
        }
      });
      this.overlay = svg('g', { class: 'critical-wires', 'aria-hidden': 'true' });
      drawing.append(this.overlay);
      drawing.append(labels);
      nodes.forEach((node, index) => this.drawPart(drawing, { ...node, box: data.boxes[index] }, signalById, nets));
      this.drawing = drawing;
      this.host.replaceChildren(drawing);
      const newPort = oldPosition ? nodes.findIndex(n => n.part.id === resizedPort) : -1;
      if (oldPosition && newPort >= 0) {
        this.shift.x += (oldPosition.e - px(data.boxes[newPort].x)) * this.zoom;
        this.shift.y += (oldPosition.f - px(data.boxes[newPort].y)) * this.zoom;
        this.resize();
      } else this.fit();
      this.update(this.lastValues, this.palette, this.radixFor, this.highlights);
      this.setCriticalPath(this.critical);
    };
    layout.postMessage({ boxes: nodes.map(node => node.box), kinds: nodes.map(node => node.kind), nodes: elkNodes, edges, groups: ends } satisfies LayoutRequest);
  }

  private displayPartName(part: Part) {
    return isAdapter(part) ? t(part.type === '@split' ? 'splitter' : 'joiner') : part.name;
  }

  refreshLanguage() {
    if (this.current) {
      const placeholder = this.host.querySelector('.empty');
      if (placeholder) placeholder.textContent = this.layoutError
        ? t('routingFailed', { error: translate(this.layoutError) }) : t('layoutRunning');
    }
    for (const { shape, part } of this.groups) {
      if (isAdapter(part)) shape.querySelector('title')!.textContent = `${this.displayPartName(part)}\n${part.type}`;
    }
  }

  private drawWire(drawing: SVGSVGElement, labels: SVGGElement, route: Route, net: WireNet) {
    if (!route.segments.length || !net.signal.bits) return;
    const bits = net.signal.bits;
    const aliases = exactAliases(net);
    const data = routePaths(route).map(path => path.map((p, i) => `${i ? 'L' : 'M'} ${px(p.x)} ${px(p.y)}`).join(' ')).join(' ');
    const group = svg('g', { class: 'net-route', 'data-net': net.signal.id });
    const wire = svg('path', { class: bits.length > 1 ? 'schematic-wire bus-wire' : 'schematic-wire', d: data });
    const hit = svg('path', { class: 'wire-hit', d: data });
    const title = svg('title');
    hit.append(title);
    const shapes: SVGElement[] = [wire];
    if (bits.length > 1) group.append(svg('path', { class: 'bus-outline', d: data }));
    group.append(wire, hit);
    for (const joint of route.joints) {
      const dot = svg('circle', { class: bits.length > 1 ? 'junction bus-junction' : 'junction', cx: px(joint.x), cy: px(joint.y), r: bits.length > 1 ? 3.7 : 2.9 });
      shapes.push(dot);
      group.append(dot);
    }
    const context = (event: MouseEvent) => {
      event.preventDefault();
      this.onWire(net.signal, event.clientX, event.clientY, aliases);
    };
    group.addEventListener('contextmenu', context);
    if (net.aliases.length) {
      const [a, b] = route.segments.reduce((best, next) => {
        const score = ([from, to]: [Point, Point]) => from.y === to.y ? 2 * (to.x - from.x) : to.y - from.y;
        return score(next) > score(best) ? next : best;
      });
      const label = svg('text', { class: 'wire-label', x: px((a.x + b.x) / 2) + (a.x === b.x ? 5 : 0), y: px((a.y + b.y) / 2) - 4, 'text-anchor': a.x === b.x ? 'start' : 'middle' });
      label.textContent = net.aliases.map(alias => alias.label).join(', ');
      labels.append(label);
    }
    this.wires.push({ shapes, bits, title, signal: net.signal, aliases });
    drawing.append(group);
  }

  private drawPart(drawing: SVGSVGElement, node: LayoutNode, signals: Map<string, Signal>, nets: WireNet[]) {
    const { box, kind, part, ports } = node;
    const width = px(box.width);
    const height = px(box.height);
    const group = svg('g', { class: 'part', 'data-name': part.name, transform: `translate(${px(box.x)},${px(box.y)})` });
    if (isAdapter(part)) group.classList.add('bus-adapter');
    const signal = part.signal ? signals.get(part.signal) : undefined;
    const active = part.child || signal?.editable;
    if (signal && !active) group.addEventListener('contextmenu', event => {
      event.preventDefault(); this.onWire(signal, event.clientX, event.clientY);
    });
    if (active) {
      group.classList.add('action');
      group.setAttribute('tabindex', '0');
      group.setAttribute('role', 'button');
      group.setAttribute('aria-label', part.name);
      group.addEventListener('click', () => this.onPart(part, false));
      group.addEventListener('contextmenu', event => { event.preventDefault(); this.onPart(part, true); });
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.onPart(part, event.shiftKey); }
      });
    }
    const title = svg('title');
    title.textContent = signal ? `${part.name} · ${signal.width} bit` : `${this.displayPartName(part)}\n${part.type}`;
    const gate = gateKinds.has(kind);
    // Keep terminals on the integer routing grid; scale the artwork exactly.
    const sx = gate ? 1.5 : kind === 'mux' ? .75 : 1;
    const baseWidth = kind === 'tribuf' ? triBufferWidth : kind === 'mux' ? 72 : width / sx;
    const inset = (width - baseWidth * sx) / 2;
    const localX = (x: number) => inset + x * sx;
    const transform = `translate(${inset} 0) scale(${sx} 1)`;
    const shape = symbolShape(kind, baseWidth, height);
    const bodyTip = localX(shape.tip);
    const bubbleRadius = 4;
    const outputTip = bodyTip + (shape.inverted ? 2 * bubbleRadius : 0);
    const bar = node.barX === undefined ? undefined : px(node.barX);
    const pinRows = ports.map(port => px(port.at.point.y));
    const body = bar !== undefined
      ? svg('line', { class: 'schematic-node bus-bar', x1: bar, x2: bar, y1: Math.min(...pinRows) - 7, y2: Math.max(...pinRows) + 7 })
      : shape.body
      ? svg('path', { class: 'schematic-node ' + kind, d: shape.body, transform })
      : svg('rect', { class: 'schematic-node ' + kind, x: 8, width: width - 16, height, rx: 2 });
    group.append(title, body);
    if (shape.extra) group.append(svg('path', { d: shape.extra, class: 'symbol-detail gate-detail', transform }));
    if (shape.inverted) group.append(svg('circle', { class: 'inversion gate-detail', cx: bodyTip + bubbleRadius, cy: height / 2, r: bubbleRadius }));
    if (kind === 'clock') group.append(svg('path', { d: 'M 10,18 h 4 v -6 h 5 v 6 h 4', class: 'symbol-detail' }));
    const display = (text: string, at: Point, css: string, anchor = 'start') => {
      const label = svg('text', { x: at.x, y: at.y, class: css, 'text-anchor': anchor });
      label.textContent = text;
      group.append(label);
      return label;
    };
    if (kind === 'mux') {
      display(partTitle(part), { x: width / 2, y: 28 }, 'schematic-text mux-caption', 'middle');
    } else if (bar === undefined && !gate && kind !== 'tribuf') {
      const outputs = kind === 'register' ? ports.filter(port => port.at.side === 'right') : [];
      const names = [...new Set(outputs.flatMap(port => port.net === undefined ? [] : nets[port.net].aliases
        .filter(alias => !alias.signal.direction).map(alias => alias.label)))];
      display(short(partTitle(part), Math.floor((width - (kind === 'clock' ? 35 : 21)) / 7)), { x: kind === 'clock' ? 29 : 14, y: 15 }, 'schematic-text');
      if (names.length) {
        display(names.join(', '), { x: width / 2, y: -5 }, 'wire-label', 'middle');
        title.textContent += '\n' + names.join(', ');
      }
    }
    for (const slot of ports) {
      const { pin, at, net } = slot;
      const right = at.side === 'right';
      const x = px(at.point.x);
      const y = px(at.point.y);
      const available = net === undefined ? undefined : nets[net];
      const bits = available?.signal.bits ?? pin.bits;
      const end = bar ?? (right
        ? (gate || kind === 'tribuf' ? outputTip : kind === 'mux' ? localX(baseWidth - 8) : signal ? width : width - 8)
        : (gate || kind === 'tribuf' ? localX(shape.inputAt(y)) : kind === 'mux' ? localX(9) : signal ? 0 : 9));
      const clock = kind === 'register' && /^(C|CLK)$/.test(pin.name);
      const inputBubble = !right && pin.name === 'B' && ['andnot', 'ornot'].includes(kind);
      const edge = inputBubble ? end - 6 : end;
      const line = { x1: x, y1: y, x2: edge, y2: y };
      if (bits.length > 1) group.append(svg('line', { class: 'bus-outline', ...line }));
      const stub = svg('line', { class: bits.length > 1 ? 'symbol-pin bus-wire' : 'symbol-pin', ...line, 'stroke-width': 1.35 });
      group.append(stub);
      slot.stub = stub;
      if (inputBubble) group.append(svg('circle', { class: 'inversion gate-detail', cx: end - 3, cy: y, r: 3 }));
      if (clock) group.append(svg('path', { d: `M 8 ${y - 5} L 16 ${y} L 8 ${y + 5}`, class: 'symbol-detail' }));
      const pinTitle = svg('title');
      stub.append(pinTitle);
      this.wires.push({ shapes: [stub], bits, title: pinTitle, signal: available?.signal });
      if (available && edge !== x) {
        stub.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); this.onWire(available.signal, event.clientX, event.clientY); });
      }
      if (bar !== undefined) {
        const label = display(pin.name, { x: bar + (right ? 6 : -6), y: y - 3 }, 'schematic-label', right ? 'start' : 'end');
        if (pin.mapping) {
          const detail = svg('title'); detail.textContent = pin.mapping; label.append(detail);
        }
      } else if (kind === 'tribuf' || kind === 'mux') {
        const caption = pinCaption(slot);
        let label: SVGTextElement;
        if (kind === 'mux') {
          label = display(right ? pin.name : short(caption, 4), { x: right ? end - 4 : end + 4, y: y + 4 },
            'schematic-label mux-caption', right ? 'end' : 'start');
        } else {
          const left = localX(shape.inputAt(y));
          const mid = height / 2;
          // Leave clearance between the Y glyph and both edges near the apex.
          const tipClearance = (bodyTip - left) * 7.5 / (mid - 4) + 2;
          label = display(pin.name, { x: right ? bodyTip - tipClearance : left + 3, y: mid + (y - mid) * 0.7 },
            'schematic-label tribuf-label', right ? 'end' : 'start');
        }
        if (label.textContent !== caption) {
          const full = svg('title');
          full.textContent = caption;
          label.append(full);
        }
      } else if (!signal && (!gate || net === undefined)) {
        display(short(pinCaption(slot), 13), { x: right ? width - 12 : clock ? 19 : 13, y: y + 4 },
          'schematic-label', right ? 'end' : 'start');
      }
      if (bar === undefined && available?.endpoints.length === 1 && available.aliases.length && !signal) {
        display(available.aliases.map(alias => alias.label).join(', '), { x: right ? width + 4 : -4, y: y - 4 },
          'wire-label', right ? 'start' : 'end');
      }
    }
    if (bar !== undefined) group.append(body);
    if (signal) {
      const label = display('', { x: width / 2, y: height - 9 }, 'schematic-text', 'middle');
      label.addEventListener('contextmenu', event => {
        event.preventDefault(); event.stopPropagation(); this.onWire(signal, event.clientX, event.clientY);
      });
      this.labels.push({ shape: label, signal, title });
    }
    this.groups.push({ shape: group, part });
    drawing.append(group);
  }

  update(values: Logic[], palette: Palette, radixFor: (signal: Signal) => Radix, highlight: string) {
    this.lastValues = values; this.palette = palette; this.radixFor = radixFor; this.highlights = highlight;
    const resized = this.current?.signals.find(s => {
      if (!s.direction) return false;
      const radix = radixFor(s);
      const width = this.portWidth(s, radix);
      const prior = this.portWidths.get(s.id) ?? 0;
      const changed = this.portRadices.get(s.id) !== radix;
      this.portRadices.set(s.id, radix);
      return width > prior || (changed && width < prior);
    });
    if (resized && this.current) {
      this.show(this.current.scope, this.current.signals, resized.id);
    }
    const read = (bits: Bit[]) => bits.map(bit => typeof bit === 'number' ? values[bit] ?? 'x' : bit);
    for (const { shapes, bits, title, signal, aliases } of this.wires) {
      const value = read(bits);
      const color = palette[logicState(value)];
      for (const shape of shapes) {
        if (shape.classList.contains('junction')) shape.setAttribute('fill', color);
        else shape.setAttribute('stroke', color);
      }
      const radix = signal ? radixFor(signal) : bits.length > 1 ? 'hex' : 'bin';
      title.textContent = (signal ? signal.name + ' · ' : '') + bits.length + ' bit · ' + valueTitle(value, radix);
      if (aliases && aliases.length > 1) {
        title.textContent = aliases.map(s => s.name + ' · ' + bits.length + ' bit · ' + valueTitle(value, radixFor(s))).join('\n');
      }
    }
    for (const { shape, signal, title } of this.labels) {
      const value = read(signal.bits ?? []);
      shape.style.fill = palette[logicState(value)];
      shape.textContent = formatValue(value, radixFor(signal));
      title.textContent = signal.name + ' · ' + signal.width + ' bit · ' + valueTitle(value, radixFor(signal));
    }
    for (const { shape, part } of this.groups) shape.classList.toggle('highlight', part.type === highlight);
  }

  setCriticalPath(path?: CriticalPath) {
    this.critical = path;
    for (const { shape, part } of this.groups) shape.classList.toggle('critical-part', !!path?.parts.has(part.id));
    this.overlay?.replaceChildren();
    this.drawing?.querySelectorAll('.critical-pin').forEach(pin => pin.classList.remove('critical-pin'));
    if (!path || !this.overlay) return;
    for (const { bit, from, to } of path.links) {
      const traces = this.traces.get(bit) ?? [];
      const matches = (end: Contact, contact: typeof from, direction: 'input' | 'output') =>
        end.part === contact.part && (contact.pin ? end.slot.pin.name === contact.pin : end.slot.pin.direction === direction || end.slot.pin.direction === 'inout');
      const segments: { trace: Trace; start: Contact; previous?: number; exit?: Contact }[] = [];
      const seen = new Set<Trace>();
      for (const trace of traces) {
        const start = trace.contacts.find(c => matches(c, from, 'output'));
        if (start) { segments.push({ trace, start }); seen.add(trace); }
      }
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const sink = segment.trace.contacts.find(c => matches(c, to, 'input'));
        if (sink) {
          let end = sink;
          let current: typeof segment | undefined = segment;
          while (current) {
            const { start, trace } = current;
            start.slot.stub?.classList.add('critical-pin');
            end.slot.stub?.classList.add('critical-pin');
            if (isAdapter(start.part)) start.slot.stub?.parentElement?.classList.add('critical-part');
            const points = routeBranch(trace.route, start.point, end.point);
            if (points.length) this.overlay.append(svg('path', { d: points.map((p, j) => `${j ? 'L' : 'M'} ${px(p.x)} ${px(p.y)}`).join(' ') }));
            if (current.previous === undefined) break;
            end = current.exit!;
            current = segments[current.previous];
          }
          break;
        }
        for (const exit of segment.trace.contacts) if (isAdapter(exit.part)) {
          for (const trace of traces) if (!seen.has(trace)) {
            const start = trace.contacts.find(c => c.part === exit.part);
            if (start) { seen.add(trace); segments.push({ trace, start, previous: i, exit }); }
          }
        }
      }
    }
  }

  fit() {
    if (!this.drawing) return;
    this.manualView = false;
    this.zoom = Math.min(1.35, (this.host.clientWidth || 600) / this.view.width, (this.host.clientHeight || 400) / this.view.height);
    this.shift = { x: (this.host.clientWidth - this.view.width * this.zoom) / 2, y: (this.host.clientHeight - this.view.height * this.zoom) / 2 };
    this.resize();
  }

  scale(multiplier: number, anchor = { x: this.host.clientWidth / 2, y: this.host.clientHeight / 2 }) {
    if (!this.drawing) return;
    this.manualView = true;
    const next = Math.min(6, Math.max(0.005, this.zoom * multiplier));
    const ratio = next / this.zoom;
    this.shift = { x: anchor.x - (anchor.x - this.shift.x) * ratio, y: anchor.y - (anchor.y - this.shift.y) * ratio };
    this.zoom = next;
    this.resize();
  }

  private resize() {
    if (!this.drawing) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    this.drawing.setAttribute('width', String(width));
    this.drawing.setAttribute('height', String(height));
    this.drawing.setAttribute('viewBox', `${-this.shift.x / this.zoom} ${-this.shift.y / this.zoom} ${width / this.zoom} ${height / this.zoom}`);
    this.drawing.classList.toggle('overview', this.zoom < .15);
    this.drawing.style.setProperty('--wire-width', Math.max(0.27, 1.4 * this.zoom) + 'px');
    const core = Math.max(0.65, 3 * this.zoom);
    this.drawing.style.setProperty('--bus-width', core + 'px');
    this.drawing.style.setProperty('--bus-outer-width', core + 2 * Math.max(.3, 1.1 * this.zoom) + 'px');
  }
}
