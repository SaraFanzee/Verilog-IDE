import { Simulation } from './simulation';
import type { Design, Signal, Vector } from './design';
import type { Change, Duration, Timing } from './simulation';

export interface View {
  cursor: number;
  start: number;
  end: number;
  watched: Pick<Signal, 'id' | 'bits'>[];
}
type Mutation =
  | { type: 'load'; design: Design; timing: Timing }
  | { type: 'edit'; id: string; time: number; value: Vector; duration: Duration }
  | { type: 'delay'; cell: string; delay: number }
  | { type: 'delays'; values: Record<string, number> }
  | { type: 'clock'; id: string; period?: number }
  | { type: 'timing'; timing: Timing; resetInputs: boolean };
export type Request = { version: number; view: View; mutation?: Mutation };
export interface Frame {
  version: number;
  computed: number;
  cursor: number;
  values: Vector;
  waves: Record<string, Change<Vector>[]>;
  error?: string;
}

let simulation: Simulation | undefined;
let latest: Request | undefined;
let running = false;
let lastPost = -Infinity;
let postedVersion = -1;
let postedCursor = false;
const worker = self as unknown as DedicatedWorkerGlobalScope;

function frame(request: Request, error?: string): Frame {
  const { version, view } = request;
  if (!simulation) return { version, cursor: view.cursor, computed: -1, values: [], waves: {}, error };
  const cursor = view.cursor;
  const computed = simulation.computed;
  const values = cursor > computed ? [] : simulation.value(Array.from({ length: simulation.design.bitCount }, (_, bit) => bit), cursor);
  const waves: Frame['waves'] = {};
  for (const signal of view.watched) {
    if (signal.bits) waves[signal.id] = simulation.wave(signal.bits, view.start, Math.min(computed, view.end));
  }
  return { version, computed, cursor, values, waves, error };
}

function calculate() {
  running = false;
  const request = latest;
  if (!request || !simulation) return;
  try {
    const target = Math.max(request.view.cursor, request.view.end);
    // Resolve the cursor first so the schematic can respond while the preview fills.
    const limit = Math.min(256, Math.max(1, Math.floor(80_000 / Math.max(1, simulation.design.bitCount))));
    if (simulation.computed < request.view.cursor) simulation.advance(request.view.cursor, limit);
    else if (simulation.computed < target) simulation.advance(target, limit);
    const cursorReady = simulation.computed >= request.view.cursor;
    if (postedVersion !== request.version || (cursorReady && !postedCursor) || simulation.computed >= target || performance.now() - lastPost > 110) {
      worker.postMessage(frame(request));
      lastPost = performance.now();
      postedVersion = request.version;
      postedCursor = cursorReady;
    }
    if (simulation.computed < target) schedule();
  } catch (error) {
    worker.postMessage(frame(request, error instanceof Error ? error.message : String(error)));
  }
}

function schedule() {
  if (running) return;
  running = true;
  setTimeout(calculate, 0);
}

worker.onmessage = ({ data }: MessageEvent<Request>) => {
  latest = data;
  const command = data.mutation;
  try {
    switch (command?.type) {
      case 'load': {
        const previous = simulation;
        simulation = undefined;
        simulation = new Simulation(command.design, command.timing);
        if (previous?.design.root === command.design.root) simulation.reuseInputs(previous);
        break;
      }
      case 'edit': simulation?.edit(command.id, command.time, command.value, command.duration); break;
      case 'delay': simulation?.setDelay(command.cell, command.delay); break;
      case 'delays': simulation?.setDelays(command.values); break;
      case 'clock': simulation?.setClock(command.id, command.period); break;
      case 'timing': simulation?.setTiming(command.timing, command.resetInputs); break;
    }
    schedule();
  } catch (error) {
    worker.postMessage(frame(data, error instanceof Error ? error.message : String(error)));
  }
};
