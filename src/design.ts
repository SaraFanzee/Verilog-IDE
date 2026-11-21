import type { Bit, Cell, Direction, Netlist } from './protocol';

export type Logic = '0' | '1' | 'x' | 'z';
export type Vector = Logic[]; // Yosys bit order, least significant first.
export interface Signal {
  id: string;
  name: string;
  bits?: Bit[];
  width: number;
  direction?: Direction;
  clock: boolean;
  editable: boolean;
  signed: boolean;
  offset?: number;
  upto?: boolean;
}
export interface Pin {
  name: string;
  bits: Bit[];
  direction: Direction;
  /** Bit assignment shown on a schematic adapter's pin. */
  mapping?: string;
}
export interface Part {
  id: string;
  name: string;
  type: string;
  pins: Pin[];
  child?: string;
  signal?: string;
  parameters?: Cell['parameters'];
}
export interface Scope {
  id: string;
  label: string;
  parts: Part[];
  signalIds: string[];
}
export interface Design {
  root: string;
  scopes: Scope[];
  signals: Signal[];
  cells: Part[];
  constants: { bit: number; value: Logic }[];
  initial: Map<number, Logic>;
  bitCount: number;
}

const signalId = (path: string[]) => JSON.stringify(path);
const clockName = /^(clk|clock)(?:$|[_0-9])|(?:^|_)(clk|clock)$/i;
const visible = (name: string, hidden?: number) => !hidden && !name.startsWith('$');

export function compile(netlist: Netlist, top: string, source?: Netlist): Design {
  const scopes: Scope[] = [];
  const signals = new Map<string, Signal>();
  const cells: Part[] = [];
  const constants: Design['constants'] = [];
  const initial = new Map<number, Logic>();
  const parents: number[] = [];
  const allocate = () => { parents.push(parents.length); return parents.length - 1; };
  function find(bit: number): number {
    while (parents[bit] !== bit) {
      parents[bit] = parents[parents[bit]];
      bit = parents[bit];
    }
    return bit;
  }
  function visit(moduleName: string, path: string[], ancestry: string[], bindings: Record<string, Bit[]> = {}) {
    if (ancestry.includes(moduleName)) throw new Error(`检测到递归模块 ${moduleName}。`);
    const mod = netlist.modules[moduleName];
    const scope: Scope = { id: signalId(path), label: path.join(' / '), parts: [], signalIds: [] };
    scopes.push(scope);
    const mapping = new Map<number, number>();
    for (const [name, port] of Object.entries(mod.ports)) {
      port.bits.forEach((local, index) => {
        const parent = bindings[name]?.[index];
        if (parent === undefined) return;
        if (typeof local === 'number' && typeof parent === 'number') {
          const old = mapping.get(local);
          if (old !== undefined) parents[find(old)] = find(parent);
          mapping.set(local, parent);
        } else if (typeof local === 'number') {
          let bit = mapping.get(local);
          if (bit === undefined) { bit = allocate(); mapping.set(local, bit); }
          constants.push({ bit, value: parent as Logic });
        } else if (typeof parent === 'number' && port.direction !== 'input') {
          constants.push({ bit: parent, value: local });
        }
      });
    }
    function mapBits(bits: Bit[]) {
      return bits.map(bit => {
        if (typeof bit !== 'number') return bit;
        let mapped = mapping.get(bit);
        if (mapped === undefined) { mapped = allocate(); mapping.set(bit, mapped); }
        return mapped;
      });
    }
    for (const [name, port] of Object.entries(mod.ports)) {
      const id = signalId([...path, name]);
      const bits = mapBits(port.bits);
      const editable = path.length === 1 && (port.direction === 'input' || port.direction === 'inout');
      const clock = editable && port.direction === 'input' && bits.length === 1 && clockName.test(name);
      signals.set(id, { id, name: [...path.slice(1), name].join('.'), bits, width: bits.length, direction: port.direction, editable, clock, signed: !!port.signed, offset: port.offset, upto: !!port.upto });
      scope.signalIds.push(id);
      scope.parts.push({
        id, name, type: clock ? 'clock' : port.direction, signal: id,
        pins: [{ name, bits, direction: port.direction === 'input' ? 'output' : port.direction === 'output' ? 'input' : 'inout' }],
      });
    }
    for (const [name, net] of Object.entries(mod.netnames)) {
      const id = signalId([...path, name]);
      const init = net.attributes?.init;
      if (init) mapBits(net.bits).forEach((bit, index) => {
        const value = init.at(-index - 1);
        if (typeof bit === 'number' && (value === '0' || value === '1')) initial.set(bit, value);
      });
      if (!visible(name, net.hide_name) || signals.has(id)) continue;
      signals.set(id, { id, name: [...path.slice(1), name].join('.'), bits: mapBits(net.bits), width: net.bits.length, editable: false, clock: false, signed: !!net.signed, offset: net.offset, upto: !!net.upto });
      scope.signalIds.push(id);
    }
    for (const [name, net] of Object.entries(source?.modules[moduleName]?.netnames ?? {})) {
      const id = signalId([...path, name]);
      if (!visible(name, net.hide_name) || signals.has(id)) continue;
      signals.set(id, { id, name: [...path.slice(1), name].join('.'), width: net.bits.length, editable: false, clock: false, signed: !!net.signed });
    }
    for (const [name, cell] of Object.entries(mod.cells)) {
      const childModule = netlist.modules[cell.type];
      const pins = Object.entries(cell.connections).map(([port, bits]) => ({
        name: port, bits: mapBits(bits), direction: cell.port_directions?.[port] ?? childModule?.ports[port]?.direction ?? 'input',
      }));
      const part: Part = { id: signalId([...path, '@' + name]), name, pins, type: cell.type, parameters: cell.parameters };
      scope.parts.push(part);
      if (childModule && !/1$/.test(childModule.attributes?.blackbox ?? '')) {
        const childPath = [...path, name];
        part.child = signalId(childPath);
        visit(cell.type, childPath, [...ancestry, moduleName], Object.fromEntries(pins.map(pin => [pin.name, pin.bits])));
      } else cells.push(part);
    }
  }
  visit(top, [top], []);
  const canonical = (bits: Bit[]) => bits.map(bit => typeof bit === 'number' ? find(bit) : bit);
  for (const scope of scopes) for (const part of scope.parts) for (const pin of part.pins) pin.bits = canonical(pin.bits);
  for (const signal of signals.values()) if (signal.bits) signal.bits = canonical(signal.bits);
  for (const constant of constants) constant.bit = find(constant.bit);
  // Initialization attributes belong to the resolved net even when it is aliased.
  return { root: scopes[0].id, scopes, signals: [...signals.values()], cells, constants, initial: new Map([...initial].map(([bit, value]) => [find(bit), value])), bitCount: parents.length };
}

export type Radix = 'bin' | 'hex' | 'uint' | 'int';
export const radixShort: Record<Radix, string> = { bin: 'BIN', hex: 'HEX', uint: 'DEC', int: 'SDEC' };
export function formatValue(bits: Vector, radix: Radix) {
  const binary = bits.toReversed().join('');
  if (!binary || radix === 'bin') return binary.toUpperCase();
  if (radix === 'hex') {
    const digits: string[] = [];
    for (let end = binary.length; end > 0; end -= 4) {
      const nibble = binary.slice(Math.max(0, end - 4), end);
      digits.unshift(/^[01]+$/.test(nibble) ? parseInt(nibble, 2).toString(16) : /^z+$/.test(nibble) ? 'z' : 'x');
    }
    return digits.join('').toUpperCase();
  }
  if (!/^[01]+$/.test(binary)) return binary.toUpperCase();
  const raw = BigInt('0b' + binary);
  return (radix === 'int' ? BigInt.asIntN(bits.length, raw) : raw).toString();
}

export function parseValue(text: string, width: number, radix: Radix): Vector {
  let value = text.trim().toLowerCase().replaceAll('_', '');
  let bits: string;
  if (/^[xz]$/.test(value)) return Array<Logic>(width).fill(value as Logic);
  if (radix === 'bin') {
    value = value.replace(/^0b/, '');
    if (!/^[01xz]+$/.test(value)) throw new Error('请输入有效的二进制值，可包含 X 或 Z。');
    bits = value;
  } else if (radix === 'hex') {
    value = value.replace(/^0x(?=.)/, '');
    if (!/^[0-9a-fxz]+$/.test(value)) throw new Error('请输入有效的十六进制值，可包含 X 或 Z。');
    bits = [...value].map(digit => /[xz]/.test(digit) ? digit.repeat(4) : parseInt(digit, 16).toString(2).padStart(4, '0')).join('');
    const excess = bits.slice(0, Math.max(0, bits.length - width));
    if (/^0*$/.test(excess) || (/^[xz]+$/.test(excess) && [...excess].every(bit => bit === bits.at(-width)))) bits = bits.slice(-width);
  } else {
    if (!/^-?\d+$/.test(value)) throw new Error('请输入十进制整数。');
    const number = BigInt(value);
    const bound = 1n << BigInt(radix === 'int' ? width - 1 : width);
    if (number < (radix === 'int' ? -bound : 0n) || number >= bound) throw new Error(`数值超出 ${width} 位范围。`);
    bits = BigInt.asUintN(width, number).toString(2);
  }
  if (bits.length > width) throw new Error(`数值超出 ${width} 位范围。`);
  return [...bits.padStart(width, '0')].reverse() as Vector;
}

export function logicState(value: Vector): Logic {
  if (value.includes('x')) return 'x';
  if (value.includes('z')) return 'z';
  return value.includes('1') ? '1' : '0';
}
