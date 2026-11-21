import type { Part, Scope, Signal } from './design';
import type { Bit } from './protocol';

export interface Endpoint { part: number; pin: number; key: string }
export interface WireNet {
  endpoints: Endpoint[];
  signal: Signal;
  aliases: { label: string; signal: Signal }[];
}

function title(signal: Signal) {
  return (JSON.parse(signal.id) as string[]).at(-1) ?? signal.name;
}

interface BusName { name: string; width: number; offset?: number; upto?: boolean }
interface Lane { bus: BusName; index: number }

function portName(part: Part, pin: Part['pins'][number]) {
  return part.signal ? pin.name : `${part.name}.${pin.name}`;
}

// Callers supply lanes from most to least significant, as written in Verilog.
function selection(bus: BusName, high: number, low = high) {
  const index = (i: number) => (bus.offset ?? 0) + (bus.upto ? bus.width - 1 - i : i);
  if (bus.width === 1 && !bus.offset) return bus.name;
  return bus.name + '[' + index(high) + (high === low ? '' : ':' + index(low)) + ']';
}

function laneExpression(lanes: Lane[]) {
  const terms: string[] = [];
  for (let i = 0; i < lanes.length;) {
    const { bus, index } = lanes[i++];
    let repeats = 1;
    while (lanes[i]?.bus === bus && lanes[i].index === index) { repeats++; i++; }
    let low = index;
    if (repeats === 1) {
      while (lanes[i]?.bus === bus && lanes[i].index === low - 1) low = lanes[i++].index;
    }
    terms.push((repeats > 1 ? repeats + '×' : '') + selection(bus, index, low));
  }
  return terms.length === 1 ? terms[0] : '{' + terms.join(', ') + '}';
}

function sourceLanes(scope: Scope, signals: Signal[]) {
  const lanes = new Map<Bit, Lane>();
  const add = (bus: BusName, bits?: Bit[]) => bits?.forEach((bit, index) => {
    if (typeof bit === 'number' && !lanes.has(bit)) lanes.set(bit, { bus, index });
  });
  // Prefer input names over aliases created by assignments to output ports.
  for (const s of [...signals].sort((a, b) => Number(b.direction === 'input') - Number(a.direction === 'input'))) {
    add({ ...s, name: title(s) }, s.bits);
  }
  for (const direction of ['output', 'inout', 'input']) for (const part of scope.parts) for (const pin of part.pins) {
    if (pin.direction === direction) add({ name: portName(part, pin), width: pin.bits.length }, pin.bits);
  }
  return lanes;
}

function alias(signal: Signal, bits: Bit[]) {
  if (signal.bits?.length === bits.length && signal.bits.every((bit, index) => bit === bits[index])) return title(signal);
  const members = new Set(bits);
  const indices = signal.bits!.flatMap((bit, i) => members.has(bit) ? [i] : []).reverse();
  const numbers = indices.map(index => (signal.offset ?? 0) + (signal.upto ? signal.width - 1 - index : index));
  if (numbers.length === 1 && signal.width === 1) return title(signal);
  const range = indices.every((index, i) => !i || index === indices[i - 1] - 1);
  return title(signal) + '[' + (range && numbers.length > 1 ? `${numbers[0]}:${numbers.at(-1)}` : numbers.join(',')) + ']';
}

// A bus groups bits with the same terminal set. Different slices route
// independently, so a concat or partial consumer never creates a false join.
export function netsForScope(scope: Scope, signals: Signal[]): WireNet[] {
  const terminalsByBit = new Map<number, Endpoint[]>();
  const namesByBit = new Map<number, Signal[]>();
  const pins = scope.parts.flatMap((part, index) => part.pins.map((pin, p) => ({ pin, endpoint: { part: index, pin: p, key: `${index}:${p}` } })));
  for (const { pin, endpoint } of pins) for (const bit of new Set(pin.bits)) {
    if (typeof bit !== 'number') continue;
    if (!terminalsByBit.has(bit)) terminalsByBit.set(bit, []);
    terminalsByBit.get(bit)!.push(endpoint);
  }
  for (const signal of signals) for (const bit of new Set(signal.bits)) {
    if (typeof bit !== 'number') continue;
    if (!namesByBit.has(bit)) namesByBit.set(bit, []);
    namesByBit.get(bit)!.push(signal);
  }
  const groups = new Map<string, { endpoints: Endpoint[]; bits: number[] }>();
  for (const [bit, endpoints] of terminalsByBit) {
    const key = endpoints.map(endpoint => endpoint.key).join('/');
    if (!groups.has(key)) groups.set(key, { endpoints, bits: [] });
    groups.get(key)!.bits.push(bit);
  }
  return [...groups.values()].map(({ endpoints, bits }) => {
    const names = [...new Set(bits.flatMap(bit => namesByBit.get(bit) ?? []))];
    const members = new Set<Bit>(bits);
    const exact = names.find(signal => signal.bits?.length === bits.length && new Set(signal.bits).size === bits.length
      && signal.bits.every(bit => members.has(bit)));
    if (exact) bits = exact.bits as number[];
    const aliases = names.map(signal => ({ label: alias(signal, bits), signal }));
    const netName = aliases[0]?.label ?? `net ${bits[0]}`;
    const id = JSON.stringify(['@wire', scope.id, bits]);
    const signal = exact ?? {
      id, name: scope.id === JSON.stringify([scope.label]) ? netName : `${scope.label} / ${netName}`,
      bits, width: bits.length, clock: false, editable: false, signed: false,
    };
    return { endpoints, signal, aliases };
  });
}

// The simulator keeps the original pins. Only the drawing introduces passive
// adapters between complete, ordered pin vectors and the shared slice nets.
export function diagramConnections(scope: Scope, signals: Signal[]) {
  const slices = netsForScope(scope, signals);
  const parts = [...scope.parts];
  const trunks: WireNet[] = [];
  const byPin = new Map<string, WireNet[]>();
  for (const net of slices) for (const end of net.endpoints) {
    const list = byPin.get(end.key) ?? [];
    list.push(net); byPin.set(end.key, list);
  }
  const bundles = new Map<string, Endpoint[]>();
  for (const [part, element] of scope.parts.entries()) for (const [pin, port] of element.pins.entries()) {
    const key = part + ':' + pin;
    const nets = byPin.get(key);
    if (!nets || port.bits.length < 2) continue;
    if (nets.length === 1 && nets[0].signal.bits?.length === port.bits.length
      && nets[0].signal.bits.every((bit, i) => bit === port.bits[i])) continue;
    const order = JSON.stringify(port.bits);
    const group = bundles.get(order) ?? [];
    group.push({ part, pin, key }); bundles.set(order, group);
  }
  const replaced = new Set<string>();
  const sources = sourceLanes(scope, signals);
  for (const ends of bundles.values()) {
    const driver = ends.find(end => parts[end.part].pins[end.pin].direction === 'output');
    const first = driver ?? ends[0];
    const original = parts[first.part].pins[first.pin];
    const terminalName = portName(parts[first.part], original);
    const bits = original.bits;
    const split = !!driver;
    const aliases = signals.filter(s => s.bits?.length === bits.length && s.bits.every((b, i) => b === bits[i]))
      .map(signal => ({ signal, label: title(signal) }));
    const signal = aliases[0]?.signal ?? {
      id: JSON.stringify(['@wire', scope.id, bits]), name: scope.label + ' / ' + terminalName,
      bits, width: bits.length, clock: false, editable: false, signed: false,
    };
    const index = parts.length;
    const endpoint = (pin: number) => ({ part: index, pin, key: index + ':' + pin });
    const trunk: BusName = aliases[0] ? { ...aliases[0].signal, name: aliases[0].label } : { name: terminalName, width: bits.length };
    const hub: Part = { id: JSON.stringify(['@adapter', scope.id, index]), name: split ? '分线器' : '集线器',
      type: split ? '@split' : '@join', pins: [{ name: selection(trunk, bits.length - 1, 0), bits, direction: split ? 'input' : 'output' }] };
    parts.push(hub);
    trunks.push({ signal, aliases, endpoints: [...ends, endpoint(0)] });
    ends.forEach(end => replaced.add(end.key));
    const positions = new Map<Bit, number[]>();
    bits.forEach((bit, i) => {
      const list = positions.get(bit) ?? [];
      list.push(i); positions.set(bit, list);
    });
    const branches: { lanes: number[]; values: Bit[]; net?: WireNet }[] = [];
    for (const net of byPin.get(first.key)!) {
      const values = net.signal.bits!;
      const lanes = values.flatMap(bit => positions.get(bit)!).sort((a, b) => b - a);
      branches.push({ lanes, values, net });
    }
    for (let i = bits.length - 1; i >= 0;) {
      if (typeof bits[i] === 'number') { i--; continue; }
      const lanes = [];
      while (i >= 0 && typeof bits[i] !== 'number') lanes.push(i--);
      branches.push({ lanes, values: lanes.toReversed().map(i => bits[i]) });
    }
    for (const { lanes, values, net } of branches.sort((a, b) => b.lanes[0] - a.lanes[0])) {
      const order = split && net ? values.toReversed().flatMap(bit => positions.get(bit)!.toReversed()) : lanes;
      const selected = laneExpression(order.map(index => ({ bus: trunk, index })));
      let name: string;
      if (net) {
        name = laneExpression(order.map(i => sources.get(bits[i])!));
      } else {
        const digits = values.toReversed().join('').replace(/^0+(?=[01])/, '');
        name = values.length + "'b" + digits;
      }
      hub.pins.push({ name: split && net ? selected : name, bits: values, direction: split ? 'output' : 'input', mapping: selected + ' = ' + name });
      net?.endpoints.push(endpoint(hub.pins.length - 1));
    }
  }
  const nets = slices.map(net => ({ ...net, endpoints: net.endpoints.filter(end => !replaced.has(end.key)) }));
  return { parts, nets: [...nets, ...trunks] };
}
