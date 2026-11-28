import { message } from './i18n';
import type { Message } from './i18n';
import type { Design, Part, Scope } from './design';
import type { Bit } from './protocol';
import { defaultDelay } from './simulation';
import { symbolKind } from './symbols';

interface Contact { part: Part; pin: string }
export interface PathLink { bit: number; from: Contact; to: Contact }
export interface CriticalPath {
  ticks: number;
  links: PathLink[];
  steps: string[];
  parts: Set<string>;
}
type Analysis = { path: CriticalPath } | { message: Message };
interface Edge { to: number; cost: number; contact: Contact }

// A shared input group avoids building a quadratic graph for wide RTL operators.
// Each input pin enters a group at zero cost; leaving it incurs the cell delay.
export function criticalPath(design: Design, scope: Scope, delays: Map<string, number>): Analysis {
  const scopes = new Map(design.scopes.map(s => [s.id, s]));
  const owner = new Map<Part, Part>();
  const graph: Edge[][] = Array.from({ length: design.bitCount }, () => []);
  const pending: number[] = graph.map(() => 0);
  const arrival: number[] = graph.map(() => -Infinity);
  const prev: ({ node: number; contact: Contact } | undefined)[] = [];
  const sinks: { bit: number; contact: Contact }[] = [];
  function connect(from: number, to: number, cost: number, contact: Contact) {
    graph[from].push({ to, cost, contact });
    pending[to]++;
  }
  function launch(bit: Bit, cost: number, contact: Contact) {
    if (typeof bit === 'number' && cost > arrival[bit]) {
      arrival[bit] = cost;
      prev[bit] = { node: -1, contact };
    }
  }
  function capture(bit: Bit, contact: Contact) {
    if (typeof bit === 'number') sinks.push({ bit, contact });
  }
  function visit(part: Part, visible: Part) {
    owner.set(part, visible);
    if (part.child) {
      for (const child of scopes.get(part.child)!.parts) if (!child.signal) visit(child, visible);
      return;
    }
    if (part.signal) {
      for (const pin of part.pins) for (const bit of pin.bits) {
        const contact = { part, pin: pin.name };
        if (pin.direction !== 'input') launch(bit, 0, contact);
        if (pin.direction !== 'output') capture(bit, contact);
      }
      return;
    }
    const cost = delays.get(part.type) ?? defaultDelay(part.type);
    if (symbolKind(part) === 'register') {
      for (const pin of part.pins) for (const bit of pin.bits) {
        const contact = { part, pin: pin.name };
        if (pin.direction === 'output') launch(bit, cost, contact);
        else if (['D', 'EN', 'E', 'SRST'].includes(pin.name) || (pin.name === 'R' && part.type.startsWith('$_SDFF'))) capture(bit, contact);
      }
      return;
    }
    const inputs = part.pins.filter(p => p.direction !== 'output');
    const outputs = part.pins.filter(p => p.direction !== 'input');
    type Operand = { name: string; bits: (Bit | undefined)[] };
    function group(operands: Operand[], name: string, bits: Bit[]) {
      const targets = [...new Set(bits.filter(b => typeof b === 'number'))];
      if (!targets.length) return;
      const index = graph.length;
      graph.push([]); pending.push(0); arrival.push(-Infinity);
      for (const pin of operands) {
        const contact = { part, pin: pin.name };
        for (const bit of new Set(pin.bits)) if (typeof bit === 'number') connect(bit, index, 0, contact);
      }
      for (const bit of targets) connect(index, bit, cost, { part, pin: name });
    }
    const type = part.type;
    const params = part.parameters ?? {};
    const laneWise = /^\$(?:buf|pos|not|and|or|xor|xnor|mux|pmux|bmux|bwmux|tribuf|slice|concat)$/.test(type);
    for (const output of outputs) {
      // Higher operand bits cannot affect a lower sum/product bit. Share
      // the lower-bit dependency prefix without adding another cell delay.
      if (['$add', '$sub', '$neg', '$mul'].includes(type)) {
        let lower: number | undefined;
        for (const [i, bit] of output.bits.entries()) {
          const prefix = graph.length;
          graph.push([]); pending.push(0); arrival.push(-Infinity);
          if (lower !== undefined) connect(lower, prefix, 0, { part, pin: '' });
          for (const pin of inputs) {
            const operand = pin.bits[i];
            if (typeof operand === 'number') connect(operand, prefix, 0, { part, pin: pin.name });
          }
          if (typeof bit === 'number') connect(prefix, bit, cost, { part, pin: output.name });
          lower = prefix;
        }
        continue;
      }
      if (/^\$(reduce_|logic_|(?:eq|ne|eqx|nex|lt|le|gt|ge)$)/.test(type)) {
        group(inputs, output.name, output.bits.slice(0, 1));
        continue;
      }
      if (!laneWise) { group(inputs, output.name, output.bits); continue; }
      const width = output.bits.length;
      const aWidth = inputs.find(p => p.name === 'A')?.bits.length ?? 0;
      for (const [i, target] of output.bits.entries()) {
        const operands = inputs.map(({ name, bits }): Operand => {
          if ((name === 'S' && type !== '$bwmux') || name === 'EN') return { name, bits };
          if ((type === '$bmux' && name === 'A') || (type === '$pmux' && name === 'B')) {
            const lanes: Bit[] = [];
            for (let j = i; j < bits.length; j += width) lanes.push(bits[j]);
            return { name, bits: lanes };
          }
          let index = i;
          if (type === '$slice') index += parseInt(params.OFFSET ?? '0', 2);
          if (type === '$concat' && name === 'B') index -= aWidth;
          const signExtend = /^(\$pos|\$not)$/.test(type) ? parseInt(params.A_SIGNED, 2)
            : /^\$(and|or|xor|xnor)$/.test(type) && parseInt(params.A_SIGNED, 2) && parseInt(params.B_SIGNED, 2);
          return { name, bits: [bits[index] ?? (signExtend && index >= bits.length ? bits.at(-1) : undefined)] };
        });
        group(operands, output.name, [target]);
      }
    }
  }
  for (const part of scope.parts) visit(part, part);
  const queue = pending.flatMap((count, i) => count === 0 ? [i] : []);
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (const edge of graph[node]) {
      const time = arrival[node] + edge.cost;
      if (time > arrival[edge.to]) {
        arrival[edge.to] = time;
        prev[edge.to] = { node, contact: edge.contact };
      }
      if (--pending[edge.to] === 0) queue.push(edge.to);
    }
  }
  if (sinks.some(s => pending[s.bit])) return { message: message('feedbackPath') };
  let best: typeof sinks[number] | undefined;
  for (const sink of sinks) {
    if (!prev[sink.bit] || prev[sink.bit]?.contact.part === sink.contact.part && sink.contact.part.type === 'inout') continue;
    if (!best || arrival[sink.bit] > arrival[best.bit]) best = sink;
  }
  if (!best) return { message: message('noPath') };
  const links: PathLink[] = [];
  const label = (contact: Contact) => {
    const names = JSON.parse(contact.part.id) as string[];
    names[names.length - 1] = contact.part.name;
    return names.slice(1).join('.') + (contact.part.signal ? '' : '.' + contact.pin);
  };
  const steps = [label(best.contact)];
  const parts = new Set<string>();
  let bit = best.bit;
  let to = best.contact;
  while (true) {
    const driver = prev[bit]!;
    const from = driver.contact;
    const visibleFrom = owner.get(from.part)!;
    const visibleTo = owner.get(to.part)!;
    parts.add(visibleFrom.id); parts.add(visibleTo.id);
    if (visibleFrom !== visibleTo || !visibleFrom.child) {
      links.push({ bit, from: { part: visibleFrom, pin: visibleFrom === from.part ? from.pin : '' },
        to: { part: visibleTo, pin: visibleTo === to.part ? to.pin : '' } });
    }
    steps.push(label(from));
    if (driver.node < 0) break;
    let input = prev[driver.node]!;
    while (input.node >= design.bitCount) input = prev[input.node]!;
    bit = input.node;
    to = input.contact;
  }
  return { path: { ticks: arrival[best.bit], links: links.reverse(), parts, steps: steps.reverse() } };
}
