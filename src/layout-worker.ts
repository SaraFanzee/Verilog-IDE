import { errorMessage } from './i18n';
import type { Message } from './i18n';
import ELK from 'elkjs/lib/elk-api.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import { routeChannels, routeNets } from './routing';
import { optimizeLayout, refineLayout } from './optimize-layout';
import type { Box, Route, Terminal } from './routing';

export interface LayoutRequest {
  boxes: Box[];
  kinds: string[];
  nodes: ElkNode[];
  edges: ElkExtendedEdge[];
  groups: { part: number; at: Terminal }[][];
}

export type LayoutResult = { width: number; height: number; boxes: Box[]; routes: Route[] } | { error: Message | string };

const elk = new ELK({ workerUrl: './elk-worker.js', workerFactory: url => new Worker(url!) });
const worker = self as DedicatedWorkerGlobalScope;
worker.onmessage = async ({ data }: MessageEvent<LayoutRequest>) => {
  const { boxes, nodes, edges, groups, kinds } = data;
  try {
    const margin = 8;
    const graph = await elk.layout<ElkNode>({
      id: 'circuit', children: nodes, edges,
      layoutOptions: {
        'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
        'elk.padding': `[top=${margin},left=${margin},bottom=${margin},right=${margin}]`,
        'elk.spacing.nodeNode': '6', 'elk.layered.spacing.nodeNodeBetweenLayers': '12',
        'elk.layered.spacing.edgeNodeBetweenLayers': '2', 'elk.spacing.componentComponent': '6',
        'elk.separateConnectedComponents': 'false',
      },
    });
    let width = margin * 2;
    let height = margin * 2;
    for (const node of graph.children ?? []) {
      const box = boxes[Number(node.id.slice(1))];
      box.x = Math.round(node.x ?? margin);
      box.y = Math.round(node.y ?? margin);
      width = Math.max(width, box.x + box.width + margin);
      height = Math.max(height, box.y + box.height + margin);
    }
    // Reserve the outer columns even for isolated ports and feedback networks.
    const inputWidth = Math.max(0, ...boxes.map((box, i) => ['input', 'clock', 'inout'].includes(kinds[i]) ? box.width : 0));
    const outputX = width + inputWidth + 12;
    const portRows = [margin, margin];
    const indices = boxes.map((_, i) => i).sort((a, b) => boxes[a].y - boxes[b].y);
    for (const i of indices) {
      const box = boxes[i];
      const side = kinds[i] === 'output' ? 1 : ['input', 'clock', 'inout'].includes(kinds[i]) ? 0 : -1;
      if (side < 0) box.x += inputWidth + 6;
      else {
        box.x = side ? outputX : margin;
        box.y = Math.max(box.y, portRows[side]);
        portRows[side] = box.y + box.height + 4;
      }
      width = Math.max(width, box.x + box.width + margin);
      height = Math.max(height, box.y + box.height + margin);
    }
    let layout;
    if (groups.length <= 100) {
      const terminals = groups.map(group => group.map(({ part, at }) => ({
        side: at.side, point: { x: boxes[part].x + at.point.x, y: boxes[part].y + at.point.y },
      })));
      try {
        const routes = routeNets(width, height, boxes, terminals, performance.now() + 700);
        layout = { width, height, boxes, routes };
      } catch {
        // A congested grid uses the channel router below.
      }
    }
    const initial = layout ?? routeChannels(boxes, groups, kinds);
    worker.postMessage(optimizeLayout(refineLayout(initial, groups, kinds)) satisfies LayoutResult);
  } catch (error) {
    worker.postMessage({ error: errorMessage(error) } satisfies LayoutResult);
  }
};
