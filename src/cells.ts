import type { Logic, Part, Vector } from './design';

export interface CellMemory { clock?: Logic; state?: Vector; }
type Read = (name: string) => Vector;
type Evaluation = (read: Read, memory: CellMemory) => Record<string, Vector>;

const unknown = (width: number): Vector => Array<Logic>(width).fill('x');
const logic = (bit?: Logic): Logic => bit === '0' || bit === '1' ? bit : 'x';
const inv = (bit: Logic): Logic => bit === '0' ? '1' : bit === '1' ? '0' : 'x';
const and = (a: Logic, b: Logic): Logic => a === '0' || b === '0' ? '0' : a === '1' && b === '1' ? '1' : 'x';
const or = (a: Logic, b: Logic): Logic => a === '1' || b === '1' ? '1' : a === '0' && b === '0' ? '0' : 'x';
const xor = (a: Logic, b: Logic): Logic => [a, b].some(bit => logic(bit) === 'x') ? 'x' : a === b ? '0' : '1';
const truth = (a: Vector): Logic => a.reduce(or, '0');
const choose = (a: Logic, b: Logic, s: Logic): Logic => s === '0' ? a : s === '1' ? b : a === b ? a : 'x';
const mux = (a: Vector, b: Vector, s: Logic) => a.map((bit, index) => choose(bit, b[index] ?? 'x', s));
const extend = (bits: Vector, width: number, signed = false) => Array.from({ length: width }, (_, index) => bits[index] ?? (signed ? bits.at(-1) ?? '0' : '0'));
const fromBig = (value: bigint, width: number): Vector =>
  [...BigInt.asUintN(width, value).toString(2).padStart(width, '0')].reverse() as Vector;
function toBig(bits: Vector, signed: boolean) {
  if (bits.some(bit => logic(bit) === 'x')) return undefined;
  const value = BigInt('0b' + (bits.toReversed().join('') || '0'));
  return signed ? BigInt.asIntN(bits.length, value) : value;
}
function edge(before: Logic, after: Logic, positive: boolean) {
  const start = positive ? '0' : '1';
  const end = positive ? '1' : '0';
  return before !== after && (before === start || after === end);
}

function selectBinary(data: Vector, select: Vector, width: number): Vector {
  function branch(bit: number, offset: number): Vector {
    if (offset >= data.length) return unknown(width);
    if (bit < 0) return Array.from({ length: width }, (_, index) => data[offset + index] ?? 'x');
    const upper = offset + width * 2 ** bit;
    if (select[bit] === '0') return branch(bit - 1, offset);
    if (select[bit] === '1') return branch(bit - 1, upper);
    return mux(branch(bit - 1, offset), branch(bit - 1, upper), select[bit]);
  }
  return branch(select.length - 1, 0);
}

export function makeCell(part: Part): Evaluation {
  const width = (name: string) => part.pins.find(pin => pin.name === name)?.bits.length ?? 0;
  const params = part.parameters ?? {};
  const flag = (name: string) => Number.parseInt(params[name] ?? '0', 2) === 1;
  const signed = flag('A_SIGNED') && flag('B_SIGNED');
  const type = part.type;
  const w = width('Y');
  const y = (evaluate: (read: Read) => Vector): Evaluation => read => ({ Y: evaluate(read) });
  const unary = (op: (a: Logic) => Logic) => y(read => extend(read('A'), w, flag('A_SIGNED')).map(op));
  const binary = (op: (a: Logic, b: Logic) => Logic) => y(read => {
    const a = extend(read('A'), w, signed);
    const b = extend(read('B'), w, signed);
    return a.map((bit, index) => op(bit, b[index]));
  });
  const reduce = (op: (a: Logic, b: Logic) => Logic, start: Logic, negate = false) =>
    y(read => extend([negate ? inv(read('A').reduce(op, start)) : read('A').reduce(op, start)], w));
  switch (type) {
    case '$pos': case '$_BUF_': return unary(bit => bit);
    case '$not': case '$_NOT_': return unary(inv);
    case '$and': case '$_AND_': return binary(and);
    case '$or': case '$_OR_': return binary(or);
    case '$xor': case '$_XOR_': return binary(xor);
    case '$xnor': case '$_XNOR_': return binary((a, b) => inv(xor(a, b)));
    case '$_NAND_': return binary((a, b) => inv(and(a, b)));
    case '$_NOR_': return binary((a, b) => inv(or(a, b)));
    case '$_ANDNOT_': return binary((a, b) => and(a, inv(b)));
    case '$_ORNOT_': return binary((a, b) => or(a, inv(b)));
    case '$_AOI3_': return y(r => [inv(or(and(r('A')[0], r('B')[0]), r('C')[0]))]);
    case '$_OAI3_': return y(r => [inv(and(or(r('A')[0], r('B')[0]), r('C')[0]))]);
    case '$_AOI4_': return y(r => [inv(or(and(r('A')[0], r('B')[0]), and(r('C')[0], r('D')[0])))]);
    case '$_OAI4_': return y(r => [inv(and(or(r('A')[0], r('B')[0]), or(r('C')[0], r('D')[0])))]);
    case '$mux': case '$_MUX_': return y(r => mux(r('A'), r('B'), r('S')[0]));
    case '$_NMUX_': return y(r => mux(r('A'), r('B'), r('S')[0]).map(inv));
    case '$pmux': return y(r => {
      const selects = r('S');
      const branches = r('B');
      const active = selects.flatMap((bit, index) => bit === '1' ? [index] : []);
      if (active.length > 1 || selects.some(bit => logic(bit) === 'x')) return unknown(w);
      return active.length ? branches.slice(active[0] * w, (active[0] + 1) * w) : r('A');
    });
    case '$bmux': return y(r => selectBinary(r('A'), r('S'), w));
    case '$tribuf': case '$_TBUF_': return y(r => r('A').map(bit => choose('z', bit, r(type === '$tribuf' ? 'EN' : 'E')[0])));
    case '$reduce_and': return reduce(and, '1');
    case '$reduce_or': case '$reduce_bool': return reduce(or, '0');
    case '$reduce_xor': return reduce(xor, '0');
    case '$reduce_xnor': return reduce(xor, '0', true);
    case '$logic_not': return reduce(or, '0', true);
    case '$logic_and': return y(r => extend([and(truth(r('A')), truth(r('B')))], w));
    case '$logic_or': return y(r => extend([or(truth(r('A')), truth(r('B')))], w));
    case '$eq': case '$ne': case '$eqx': case '$nex': return y(r => {
      const size = Math.max(width('A'), width('B'));
      const a = extend(r('A'), size, signed);
      const b = extend(r('B'), size, signed);
      const exact = type.endsWith('x');
      const equal = a.reduce<Logic>((current, bit, i) =>
        and(current, exact ? (bit === b[i] ? '1' : '0') : inv(xor(bit, b[i]))), '1');
      return extend([type.startsWith('$n') ? inv(equal) : equal], w);
    });
    case '$concat': return y(r => [...r('A'), ...r('B')]);
    case '$slice': return y(r => {
      const offset = parseInt(params.OFFSET, 2);
      return r('A').slice(offset, offset + w);
    });
    case '$shift': case '$shiftx': case '$shl': case '$sshl': case '$shr': case '$sshr': return y(r => {
      const offset = toBig(r('B'), (type === '$shift' || type === '$shiftx') && flag('B_SIGNED'));
      if (offset === undefined) return unknown(w);
      const a = r('A');
      const amount = Number(type === '$shl' || type === '$sshl' ? -offset : offset);
      const padding = type === '$shiftx' ? 'x' : '0';
      const most = type === '$sshr' && flag('A_SIGNED') ? a.at(-1) ?? '0' : padding;
      return Array.from({ length: w }, (_, i) => i + amount < 0 ? padding : a[i + amount] ?? most);
    });
  }
  if (['$add', '$sub', '$mul', '$div', '$mod', '$divfloor', '$modfloor', '$neg', '$pow', '$lt', '$le', '$gt', '$ge'].includes(type)) {
    return y(r => {
      const a = toBig(r('A'), type === '$neg' || type === '$pow' ? flag('A_SIGNED') : signed);
      const b = toBig(r('B'), type === '$pow' ? flag('B_SIGNED') : signed);
      if (a === undefined || b === undefined) return unknown(w);
      let result: bigint;
      switch (type) {
        case '$add': result = a + b; break;
        case '$sub': result = a - b; break;
        case '$mul': result = a * b; break;
        case '$neg': result = -a; break;
        case '$div': case '$mod': case '$divfloor': case '$modfloor': {
          if (!b) return unknown(w);
          const adjust = a % b !== 0n && (a < 0n) !== (b < 0n);
          const floor = a / b - (adjust ? 1n : 0n);
          result = type === '$div' ? a / b : type === '$mod' ? a % b : type === '$divfloor' ? floor : a - b * floor;
          break;
        }
        case '$pow': {
          if (b < 0n) return a === 0n ? unknown(w) : fromBig(a === 1n ? 1n : a === -1n ? (b & 1n ? -1n : 1n) : 0n, w);
          result = 1n;
          let base = BigInt.asUintN(w, a);
          for (let power = b; power; power >>= 1n) {
            if (power & 1n) result = BigInt.asUintN(w, result * base);
            base = BigInt.asUintN(w, base * base);
          }
          break;
        }
        case '$lt': result = a < b ? 1n : 0n; break;
        case '$le': result = a <= b ? 1n : 0n; break;
        case '$gt': result = a > b ? 1n : 0n; break;
        default: result = a >= b ? 1n : 0n;
      }
      return fromBig(result, w);
    });
  }
  const seq = makeSequential(part, width('Q'), flag);
  if (seq) return seq;
  throw new Error(`仿真尚不支持元件 ${type}（${part.name}）。`);
}

function makeSequential(part: Part, width: number, flag: (name: string) => boolean): Evaluation | undefined {
  const type = part.type;
  const params = part.parameters ?? {};
  const gate = /^\$_(DFF|DFFE|SDFF|SDFFE|SDFFCE|DLATCH|DFFSR|DFFSRE|DLATCHSR)_([PN01]+)_$/.exec(type);
  const model = gate ? '$' + gate[1].toLowerCase() : type;
  if (!['$dff', '$dffe', '$adff', '$adffe', '$aldff', '$aldffe', '$sdff', '$sdffe', '$sdffce', '$dlatch', '$adlatch', '$dffsr', '$dffsre', '$dlatchsr', '$sr'].includes(model)) return;
  const code = gate?.[2] ?? '';
  const latch = model.includes('latch');
  const synchronous = model.startsWith('$sdff');
  const setClear = model.includes('sr');
  const loading = model.startsWith('$aldff');
  const gateAsync = !synchronous && !setClear && /[01]/.test(code);
  const resetting = synchronous || gateAsync || model.startsWith('$ad');
  const enabled = latch || model.endsWith('e');
  const clock = gate ? 'C' : 'CLK';
  const enable = gate ? 'E' : 'EN';
  const reset = gate ? 'R' : synchronous ? 'SRST' : 'ARST';
  const positive = (code.at(0) ?? (latch ? 'P' : flag('CLK_POLARITY') ? 'P' : 'N')) === 'P';
  const activeEnable = gate ? (latch ? code[0] : code.at(-1)) === 'P' : flag('EN_POLARITY');
  const activeReset = gate ? code[1] === 'P' : flag(synchronous ? 'SRST_POLARITY' : 'ARST_POLARITY');
  const resetValue = gate ? [code[2] as Logic] : [...(params[synchronous ? 'SRST_VALUE' : 'ARST_VALUE'] ?? '').padStart(width, 'x')].reverse() as Vector;
  const setPositive = gate ? code[model === '$sr' ? 0 : 1] === 'P' : flag('SET_POLARITY');
  const clearPositive = gate ? code[model === '$sr' ? 1 : 2] === 'P' : flag('CLR_POLARITY');
  const active = (bit: Logic, polarity: boolean) => polarity ? logic(bit) : inv(bit);
  return (read, memory) => {
    const state = memory.state ?? unknown(width);
    let next = state;
    const clk = read(clock)[0] ?? 'x';
    const clocked = edge(memory.clock ?? 'x', clk, positive);
    memory.clock = clk;
    const en = enabled ? active(read(enable)[0], activeEnable) : '1';
    const rst = resetting ? active(read(reset)[0], activeReset) : '0';
    if (latch || clocked) {
      next = mux(state, extend(read('D'), width), en);
      if (synchronous) {
        next = model === '$sdffce' ? mux(state, mux(read('D'), resetValue, rst), en) : mux(next, resetValue, rst);
      }
    }
    if (resetting && !synchronous) next = mux(next, resetValue, rst);
    if (loading) next = mux(next, read('AD'), active(read('ALOAD')[0], flag('ALOAD_POLARITY')));
    if (setClear) {
      const set = read(gate ? 'S' : 'SET');
      const clear = read(gate ? 'R' : 'CLR');
      next = next.map((bit, i) => choose(choose(bit, '1', active(set[i], setPositive)), '0', active(clear[i], clearPositive)));
    }
    memory.state = next;
    return { Q: next };
  };
}
