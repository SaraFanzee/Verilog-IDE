import { LocalizedError, message } from './i18n';
import { makeCell } from './cells';
import type { CellMemory } from './cells';
import type { Design, Logic, Signal, Vector } from './design';
import type { Bit } from './protocol';

export type Duration = 'step' | 'period' | 'end';
export interface Timing { end: number; period: number }
export interface Change<T> { time: number; value: T }
interface Event { cell: number; values: Record<string, Vector>; token: number }
interface Snapshot {
  values: Logic[];
  drivers: Map<number, Logic>[];
  memory: CellMemory[];
  pending: Map<number, Event[]>;
  requested: string[];
  tokens: number[];
}
const allX = (width: number): Vector => Array<Logic>(width).fill('x');

function upperBound<T>(changes: Change<T>[], time: number) {
  let low = 0;
  let high = changes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (changes[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

export class Simulation {
  private readonly traces: Change<Logic>[][];
  private readonly inputs: Signal[];
  private readonly timeline = new Map<string, Change<Vector>[]>();
  private readonly clockPeriods = new Map<string, number>();
  private delays: Record<string, number> = {};
  private readonly checkpoints = new Map<number, Snapshot>();
  private readonly dependents: number[][];
  private readonly models: ReturnType<typeof makeCell>[];
  private state: Snapshot;
  computed = -1;

  constructor(readonly design: Design, public timing: Timing) {
    this.traces = Array.from({ length: design.bitCount }, () => []);
    this.inputs = design.signals.filter(signal => signal.editable);
    this.models = design.cells.map(makeCell);
    this.dependents = Array.from({ length: design.bitCount }, () => []);
    for (const [index, cell] of design.cells.entries()) {
      const bits = new Set(cell.pins.filter(pin => pin.direction !== 'output').flatMap(pin => pin.bits));
      for (const bit of bits) if (typeof bit === 'number') this.dependents[bit].push(index);
    }
    this.state = this.initialState();
  }

  private initialState(): Snapshot {
    const { cells, bitCount } = this.design;
    const state: Snapshot = {
      values: Array<Logic>(bitCount).fill('z'),
      drivers: Array.from({ length: bitCount }, () => new Map()),
      memory: cells.map(cell => {
        const output = cell.pins.find(pin => pin.name === 'Q' && pin.direction === 'output');
        return output ? { state: output.bits.map(bit => typeof bit === 'number' ? this.design.initial.get(bit) ?? 'x' : bit) } : {};
      }),
      pending: new Map(), requested: cells.map(() => ''), tokens: cells.map(() => 0),
    };
    const seed = (bit: Bit, driver: number, value: Logic) => {
      if (typeof bit === 'number') state.drivers[bit].set(driver, value);
    };
    for (const [index, { bit, value }] of this.design.constants.entries()) seed(bit, -1 - this.inputs.length - index, value);
    for (const [index, cell] of cells.entries()) for (const pin of cell.pins) if (pin.direction === 'output') {
      pin.bits.forEach((bit, i) => seed(bit, index, pin.name === 'Q' ? state.memory[index].state?.[i] ?? 'x' : 'x'));
    }
    state.values = state.drivers.map(resolveDrivers);
    return state;
  }

  setTiming(timing: Timing, resetInputs: boolean) {
    if (resetInputs) { this.timeline.clear(); this.clockPeriods.clear(); }
    if (resetInputs || timing.period !== this.timing.period) this.invalidate(0);
    this.timing = timing;
  }

  setClock(id: string, period: number | undefined) {
    if (!this.inputs.find(signal => signal.id === id && signal.clock)) return;
    if (period === undefined) this.clockPeriods.delete(id);
    else this.clockPeriods.set(id, period);
    this.invalidate(0);
  }

  setDelay(type: string, delay: number) {
    this.delays[type] = delay;
    this.invalidate(0);
  }

  setDelays(delays: Record<string, number>) {
    this.delays = { ...delays };
    this.invalidate(0);
  }

  delay(type: string) { return this.delays[type] ?? defaultDelay(type); }

  reuseInputs(previous: Simulation) {
    for (const signal of this.inputs) {
      const match = previous.inputs.find(input => input.id === signal.id && input.width === signal.width && input.direction === signal.direction);
      if (!match) continue;
      const changes = previous.timeline.get(signal.id);
      if (changes) this.timeline.set(signal.id, changes);
      const clock = previous.clockPeriods.get(signal.id);
      if (clock !== undefined) this.clockPeriods.set(signal.id, clock);
    }
    for (const type of Object.keys(previous.delays)) this.delays[type] = previous.delays[type];
  }

  private inputAt(signal: Signal, time: number): Vector {
    if (signal.clock) return [Math.floor(time / ((this.clockPeriods.get(signal.id) ?? this.timing.period) / 2)) % 2 ? '1' : '0'];
    const initial = signal.direction === 'inout' ? Array<Logic>(signal.width).fill('z') : allX(signal.width).fill('0');
    const changes = this.timeline.get(signal.id);
    return changes?.[upperBound(changes, time) - 1]?.value ?? initial;
  }

  edit(id: string, time: number, value: Vector, duration: Duration) {
    const signal = this.inputs.find(input => input.id === id && !input.clock);
    if (!signal || signal.width !== value.length || time < 0 || time > this.timing.end) return undefined;
    const start = duration === 'period' ? time - time % this.timing.period : time;
    const stop = duration === 'end' ? Infinity : start + (duration === 'period' ? this.timing.period : 1);
    const restored = stop < Infinity ? this.inputAt(signal, stop) : undefined;
    const old = this.timeline.get(id) ?? [];
    const prefix = old.slice(0, upperBound(old, start - 1));
    const suffix = restored ? [{ time: stop, value: restored }, ...old.slice(upperBound(old, stop))] : [];
    this.timeline.set(id, [...prefix, { time: start, value: [...value] }, ...suffix]);
    this.invalidate(start);
    return start;
  }

  private invalidate(start: number) {
    if (start > this.computed) return;
    let checkpoint = -1;
    for (const time of this.checkpoints.keys()) if (time < start && time > checkpoint) checkpoint = time;
    const saved = this.checkpoints.get(checkpoint);
    this.state = saved ? structuredClone(saved) : this.initialState();
    for (const time of this.checkpoints.keys()) if (time > checkpoint) this.checkpoints.delete(time);
    for (const trace of this.traces) trace.length = upperBound(trace, start - 1);
    for (let time = checkpoint + 1; time < start; time++) this.tick(time, false);
    this.computed = start - 1;
  }

  advance(target: number, maxTicks = Infinity) {
    target = Math.min(target, this.timing.end, this.computed + maxTicks);
    const capacity = Math.max(3, Math.min(96, Math.floor(1_000_000 / Math.max(1, this.design.bitCount))));
    const checkpointInterval = Math.max(32, Math.ceil((this.timing.end + 1) / capacity));
    for (let time = this.computed + 1; time <= target; time++) {
      this.tick(time);
      this.computed = time;
      if ((time + 1) % checkpointInterval === 0) {
        this.checkpoints.set(time, structuredClone(this.state));
        if (this.checkpoints.size > capacity) this.checkpoints.delete(this.checkpoints.keys().next().value!);
      }
    }
    return this.computed;
  }

  private tick(time: number, record = true) {
    const state = this.state;
    const changed = new Set<number>();
    const dirty = new Set<number>();
    const touched = new Set<number>();
    const readBit = (bit: Bit) => typeof bit === 'number' ? state.values[bit] : bit;
    const drive = (bits: Bit[], values: Vector, driver: number) => bits.forEach((bit, i) => {
      if (typeof bit !== 'number') return;
      const next = values[i] ?? 'x';
      if (state.drivers[bit].get(driver) === next) return;
      state.drivers[bit].set(driver, next);
      touched.add(bit);
    });
    const settle = () => {
      for (const bit of touched) {
        const value = resolveDrivers(state.drivers[bit]);
        if (value === state.values[bit]) continue;
        state.values[bit] = value;
        changed.add(bit);
        for (const dependent of this.dependents[bit]) dirty.add(dependent);
      }
      touched.clear();
    };
    const commit = ({ cell, values, token }: Event) => {
      if (token !== state.tokens[cell]) return;
      for (const pin of this.design.cells[cell].pins) {
        if (pin.direction === 'output' && values[pin.name]) drive(pin.bits, values[pin.name], cell);
      }
    };
    for (const [index, signal] of this.inputs.entries()) drive(signal.bits!, this.inputAt(signal, time), -1 - index);
    const due = state.pending.get(time) ?? [];
    state.pending.delete(time);
    for (const event of due) commit(event);
    settle();
    if (time === 0) this.models.forEach((_, index) => dirty.add(index));
    for (let delta = 0; dirty.size; delta++) {
      if (delta === 128) throw new LocalizedError(message('unstableFeedback', { time }));
      const batch = [...dirty];
      dirty.clear();
      for (const index of batch) {
        const cell = this.design.cells[index];
        const read = (name: string) => cell.pins.find(pin => pin.name === name)?.bits.map(readBit) ?? [];
        const values = this.models[index](read, state.memory[index]);
        const encoded = Object.values(values).map(bits => bits.join('')).join('|');
        if (state.requested[index] === encoded) continue;
        state.requested[index] = encoded;
        const event = { cell: index, values, token: ++state.tokens[index] };
        const delay = this.delay(cell.type);
        if (delay === 0) commit(event);
        else {
          const events = state.pending.get(time + delay) ?? [];
          events.push(event);
          state.pending.set(time + delay, events);
        }
      }
      settle();
    }
    if (!record) return;
    if (time === 0) state.values.forEach((_, bit) => changed.add(bit));
    for (const bit of changed) {
      const trace = this.traces[bit];
      if (trace.at(-1)?.value !== state.values[bit]) trace.push({ time, value: state.values[bit] });
    }
  }

  value(bits: Bit[], time: number): Vector {
    return bits.map(bit => typeof bit === 'number' ? this.traces[bit][upperBound(this.traces[bit], time) - 1]?.value ?? 'x' : bit);
  }

  wave(bits: Bit[], start: number, end: number): Change<Vector>[] {
    if (end < start) return [];
    const times = new Set([start]);
    for (const bit of bits) {
      if (typeof bit !== 'number') continue;
      const trace = this.traces[bit];
      for (let i = upperBound(trace, start); i < trace.length && trace[i].time <= end; i++) times.add(trace[i].time);
    }
    return [...times].sort((a, b) => a - b).map(time => ({ time, value: this.value(bits, time) }));
  }
}

function resolveDrivers(drivers: Map<number, Logic>): Logic {
  let value: Logic = 'z';
  for (const driver of drivers.values()) {
    if (driver === 'z') continue;
    if (value !== 'z' && driver !== value) return 'x';
    value = driver;
  }
  return value;
}

export function defaultDelay(type: string) {
  const name = type.toLowerCase().replace(/^\$_?|_$/g, '');
  if (/^(div|mod|pow|divfloor|modfloor)$/.test(name)) return 12;
  if (/^(mul|macc)$/.test(name)) return 8;
  if (/^(bmux|pmux|bwmux|shift\w*|ss?hl|ss?hr)$/.test(name)) return 5;
  if (/^(add|sub|alu|neg|lt|le|gt|ge|eq|eqx|ne|nex)$/.test(name)) return 4;
  if (/^(reduce_|xor$|xnor$|.*mux|.*dffe|.*dffsr|.*dffse|sdff|adff)/.test(name)) return 3;
  if (/^(and|or|logic_and|logic_or|[ao][oi][ia][34]|tribuf|tbuf|dff|latch|dlatch|sr)/.test(name)) return 2;
  return 1;
}
