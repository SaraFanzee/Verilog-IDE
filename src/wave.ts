import { t } from './i18n';
import { formatValue, logicState, radixShort } from './design';
import type { Radix, Signal, Vector } from './design';
import type { Frame } from './sim-worker';
import type { Palette } from './schematic';

const labelWidth = 150;
const axisHeight = 28;
const laneHeight = 33;
const mono = '11px Consolas, monospace';
interface WaveData {
  signals: Signal[];
  start: number;
  end: number;
  cursor: number;
  stepPs: number;
  frame?: Frame;
  palette: Palette;
  radixFor: (signal: Signal) => Radix;
}

function gridStep(span: number, width: number) {
  const approximate = Math.max(1, span / Math.max(1, width / 90));
  const decade = 10 ** Math.floor(Math.log10(approximate));
  return ([1, 2, 5, 10].find(multiplier => multiplier * decade >= approximate) ?? 10) * decade;
}

export class Waveform {
  private data?: WaveData;
  private readonly spacer = document.createElement('div');
  private readonly heading = document.createElement('div');
  private readonly list = document.createElement('div');
  private readonly rows = new Map<string, { row: HTMLElement; value: HTMLElement; base: HTMLButtonElement; remove: HTMLButtonElement; signal: Signal }>();
  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement, onClick: (time: number, signal?: Signal, alternate?: boolean) => void,
    onZoom: (scale: number, anchor?: number) => void, private onRadix: (signal: Signal, x: number, y: number) => void,
    private remove: (signal: Signal) => void) {
    const surface = document.createElement('div');
    surface.className = 'wave-surface';
    const heading = this.heading;
    heading.className = 'watch-heading';
    heading.style.width = this.list.style.width = labelWidth + 'px';
    heading.style.height = this.list.style.top = axisHeight + 'px';
    this.list.className = 'watch-list';
    surface.append(canvas, heading, this.list);
    host.append(surface, this.spacer);
    new ResizeObserver(() => this.paint()).observe(host);
    host.addEventListener('scroll', () => this.paint(), { passive: true });
    const click = (event: MouseEvent, alternate: boolean) => {
      if (!this.data) return;
      const { offsetX, offsetY } = event;
      if (offsetX < labelWidth) return;
      const time = this.tick(offsetX);
      const signal = offsetY >= axisHeight ? this.signalAt(offsetY) : undefined;
      if (offsetY < axisHeight || signal) onClick(time, signal, alternate);
    };
    canvas.addEventListener('click', event => click(event, false));
    canvas.addEventListener('contextmenu', event => { event.preventDefault(); click(event, true); });
    canvas.addEventListener('wheel', event => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      onZoom(event.deltaY < 0 ? .67 : 1.5, this.tick(event.offsetX));
    }, { passive: false });
    canvas.addEventListener('mousemove', event => {
      if (!this.data) return;
      if (event.offsetX < labelWidth) {
        canvas.title = '';
        return;
      }
      const time = this.tick(event.offsetX);
      const signal = event.offsetY >= axisHeight ? this.signalAt(event.offsetY) : undefined;
      const changes = signal && this.data.frame?.waves[signal.id];
      const value = changes?.findLast(change => change.time <= time)?.value;
      canvas.title = `${time * this.data.stepPs / 1000} ns${value && signal ? ' · ' + formatValue(value, this.data.radixFor(signal)) : ''}${signal?.editable && !signal.clock ? ' · ' + t('rightClickInput') : ''}`;
    });
  }

  private labelRow({ base, remove, signal }: { base: HTMLButtonElement; remove: HTMLButtonElement; signal: Signal }) {
    remove.title = t('removeSignal', { name: signal.name });
    base.title = t('waveRadix', { name: signal.name });
  }

  refreshLanguage() {
    this.heading.textContent = t('signalCurrentValue');
    this.canvas.title = '';
    for (const row of this.rows.values()) this.labelRow(row);
  }

  update(data: WaveData) {
    this.data = data;
    this.paint();
  }

  private tick(x: number) {
    const { start, end } = this.data!;
    const ratio = (x - labelWidth) / Math.max(1, this.canvas.clientWidth - labelWidth - 12);
    return Math.max(start, Math.min(end, start + Math.floor(ratio * (end - start) + 1e-7)));
  }

  private signalAt(y: number) {
    return this.data?.signals[Math.floor((y - axisHeight + this.host.scrollTop) / laneHeight)];
  }

  private paintList(data: WaveData, height: number, scroll: number) {
    const visible = new Set<string>();
    const first = Math.floor(scroll / laneHeight);
    const stop = Math.min(data.signals.length, Math.ceil((scroll + height - axisHeight) / laneHeight));
    for (let i = first; i < stop; i++) {
      const signal = data.signals[i];
      visible.add(signal.id);
      let controls = this.rows.get(signal.id);
      if (!controls) {
        const row = document.createElement('div');
        row.className = 'watch-row';
        row.style.height = laneHeight + 'px';
        const remove = document.createElement('button');
        remove.className = 'watch-remove close-icon';
        const name = document.createElement('span');
        name.className = 'watch-name'; name.textContent = (signal.clock ? '◷ ' : '') + signal.name; name.title = signal.name;
        const value = document.createElement('span');
        value.className = 'watch-value';
        const base = document.createElement('button');
        base.className = 'radix-chip';
        row.append(remove, name, value, base);
        this.list.append(row);
        controls = { row, value, base, remove, signal };
        this.labelRow(controls);
        this.rows.set(signal.id, controls);
      }
      const { row, value, base } = controls;
      row.style.top = (i * laneHeight - scroll) + 'px';
      const bits = signal.bits?.map(bit => typeof bit === 'number' ? data.frame?.values[bit] ?? 'x' : bit) ?? [];
      const radix = data.radixFor(signal);
      value.textContent = value.title = formatValue(bits, radix);
      value.style.color = data.palette[logicState(bits)];
      base.textContent = radixShort[radix];
      row.onclick = event => {
        if (event.target === row.firstElementChild) this.remove(signal);
        if (event.target === base) {
          const rect = base.getBoundingClientRect();
          this.onRadix(signal, rect.left, rect.bottom);
        }
      };
    }
    for (const [id, controls] of this.rows) if (!visible.has(id)) {
      controls.row.remove(); this.rows.delete(id);
    }
  }

  private paint() {
    if (!this.data) return;
    const { start, end, signals, cursor, frame, palette, radixFor, stepPs } = this.data;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width <= labelWidth + 13 || height <= 0) return;
    const device = window.devicePixelRatio;
    this.spacer.style.height = Math.max(0, axisHeight + signals.length * laneHeight - height) + 'px';
    const verticalOffset = this.host.scrollTop;
    this.paintList(this.data, height, verticalOffset);
    this.canvas.style.height = height + 'px';
    this.canvas.width = Math.round(width * device);
    this.canvas.height = Math.round(height * device);
    const ctx = this.canvas.getContext('2d')!;
    ctx.scale(device, device);
    const graphWidth = width - labelWidth - 12;
    const x = (time: number) => labelWidth + (time - start) * graphWidth / Math.max(1, end - start);
    ctx.fillStyle = '#111821'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#1a2430'; ctx.fillRect(0, 0, labelWidth, height);
    ctx.font = mono;
    ctx.textBaseline = 'middle';
    const line = (x1: number, y1: number, x2: number, y2: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };
    const grid = gridStep(end - start, graphWidth);
    const minor = grid / 10;
    for (let index = Math.ceil(start / minor); index <= Math.floor(end / minor); index++) {
      if (index % 10 === 0) continue;
      const at = x(index * minor);
      const mid = index % 5 === 0;
      line(at, axisHeight - (mid ? 8 : 4), at, axisHeight, mid ? '#758397' : '#535f70');
      if (minor >= 1) line(at, axisHeight, at, height, mid ? '#222d3a' : '#19222e');
    }
    for (let time = Math.ceil(start / grid) * grid; time <= end; time += grid) {
      const at = x(time);
      line(at, 0, at, height, '#283340');
      const text = String(time * stepPs / 1000);
      ctx.fillStyle = '#a3afbf';
      ctx.fillText(text, Math.max(labelWidth + 3, Math.min(at + 3, width - ctx.measureText(text).width - 3)), 13);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(0, axisHeight, width, height - axisHeight); ctx.clip();
    signals.forEach((signal, index) => {
      const y = axisHeight + index * laneHeight - verticalOffset;
      if (y + laneHeight <= axisHeight || y >= height) return;
      line(0, y + laneHeight, width, y + laneHeight, '#25303e');
      const changes = frame?.waves[signal.id] ?? [];
      const radix = radixFor(signal);
      let previousY: number | undefined;
      changes.forEach((change, i) => {
        const left = x(change.time);
        const final = Math.min(end, frame?.computed ?? -1);
        const right = x(changes[i + 1]?.time ?? final);
        if (right < left) return;
        const color = palette[logicState(change.value)];
        if (signal.width === 1) {
          const bit = change.value[0];
          const level = y + (bit === '1' ? 7 : bit === '0' ? 25 : 16);
          if (previousY !== undefined) line(left, previousY, left, level, color);
          if (bit === 'x' || bit === 'z') ctx.setLineDash(bit === 'z' ? [4, 3] : [2, 2]);
          line(left, level, right, level, color);
          ctx.setLineDash([]);
          previousY = level;
        } else {
          this.drawBus(ctx, left, right, y, color, change.value, radix);
        }
      });
    });
    if (!signals.length) {
      ctx.fillStyle = '#a3afbf';
      ctx.fillText(t('addWatches'), labelWidth + 16, axisHeight + 20);
    }
    ctx.restore();
    line(0, axisHeight, width, axisHeight, '#394758');
    line(labelWidth, 0, labelWidth, height, '#394758');
    if (cursor >= start && cursor <= end) {
      const at = x(cursor);
      ctx.fillStyle = '#68ebd5';
      ctx.fillRect(at - 2, 0, 5, 5);
      line(at, 5, at, height, '#68ebd5');
    }
  }

  private drawBus(ctx: CanvasRenderingContext2D, left: number, right: number, y: number, color: string, value: Vector, radix: Radix) {
    const inset = Math.min(4, (right - left) / 2);
    ctx.beginPath();
    ctx.moveTo(left, y + 16);
    ctx.lineTo(left + inset, y + 8); ctx.lineTo(right - inset, y + 8);
    ctx.lineTo(right, y + 16); ctx.lineTo(right - inset, y + 24);
    ctx.lineTo(left + inset, y + 24); ctx.closePath();
    ctx.strokeStyle = color;
    ctx.stroke();
    const text = formatValue(value, radix);
    if (ctx.measureText(text).width < right - left - 13) {
      ctx.fillStyle = color;
      ctx.fillText(text, left + 7, y + 16);
    }
  }
}
