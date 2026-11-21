import type { Part } from './design';

export function symbolKind(part: Part) {
  if (part.signal) return part.type;
  if (part.child) return 'module';
  const name = part.type.toLowerCase().replace(/^\$_?|_$/g, '');
  if (/^(logic_|reduce_)?(and|or|xor|xnor|nand|nor|not|buf|andnot|ornot)$/.test(name)) return name.replace(/^(logic_|reduce_)/, '');
  if (/^(?:[pbn]?mux|bwmux|mux\d+)$/.test(name)) return 'mux';
  if (/^(?:tri?buf|tbuf)$/.test(name)) return 'tribuf';
  if (/dff|latch|^sr(?:_|$)/.test(name)) return 'register';
  return 'block';
}

export const gateKinds = new Set(['and', 'nand', 'or', 'nor', 'xor', 'xnor', 'not', 'buf', 'andnot', 'ornot']);

export function symbolShape(kind: string, w: number, h: number) {
  const middle = h / 2;
  const left = 10;
  const top = 4;
  const bottom = h - 4;
  const inverted = ['not', 'nand', 'nor', 'xnor'].includes(kind);
  const tip = w - (inverted ? 14 : 8);
  let body: string | undefined;
  let extra: string | undefined;
  let input = left;
  let inputAt = (_y: number) => input;
  if (['and', 'nand', 'andnot'].includes(kind)) {
    const shoulder = w * 0.46;
    body = `M ${left} ${top} H ${shoulder} Q ${tip} ${top}, ${tip} ${middle} Q ${tip} ${bottom}, ${shoulder} ${bottom} H ${left} Z`;
  } else if (['or', 'nor', 'xor', 'xnor', 'ornot'].includes(kind)) {
    body = `M ${left} ${top} Q ${w * .65} ${top}, ${tip} ${middle} Q ${w * .65} ${bottom}, ${left} ${bottom} Q ${left + 17} ${middle}, ${left} ${top} Z`;
    input = left + 8;
    if (kind === 'xor' || kind === 'xnor') {
      const outerX = 5;
      const bend = 17;
      extra = `M ${outerX} ${top} Q ${outerX + bend} ${middle}, ${outerX} ${bottom}`;
      inputAt = y => {
        const t = (y - top) / (bottom - top);
        return outerX + 2 * bend * t * (1 - t);
      };
    }
  } else if (['not', 'buf', 'tribuf'].includes(kind)) {
    body = `M ${left} ${top} L ${tip} ${middle} L ${left} ${bottom} Z`;
  } else if (kind === 'mux') {
    body = `M 9 3 L ${w - 8} 15 V ${h - 15} L 9 ${h - 3} Z`;
  } else if (['input', 'clock', 'output', 'inout'].includes(kind)) {
    const hasRight = kind !== 'output';
    const hasLeft = kind === 'output' || kind === 'inout';
    const start = hasLeft ? 12 : 2;
    const finish = hasRight ? w - 12 : w - 2;
    body = `M ${start} 3 H ${finish}${hasRight ? ` L ${w} ${middle} L ${finish} ${h - 3}` : ` V ${h - 3}`} H ${start}${hasLeft ? ` L 0 ${middle}` : ''} Z`;
    input = 0;
  }
  return { body, extra, inputAt, tip, inverted };
}
