import type { Message } from './i18n';

export interface Source {
  id: string;
  name: string;
  path?: string;
  text: string;
}

export interface BuildOptions {
  standard: '1364-2005' | '1800-2017' | '1800-2023';
  top: string;
  mode: 'rtl' | 'gate';
  hierarchy: boolean;
  optimize: boolean;
  abc: boolean;
  observe: boolean;
  includes: string[];
  defines: string[];
  parameters: string[];
  extraCommands?: string[];
}

export type Bit = number | '0' | '1' | 'x' | 'z';
export type Direction = 'input' | 'output' | 'inout';
export interface Port {
  direction: Direction;
  bits: Bit[];
  offset?: number;
  upto?: number;
  signed?: number;
}
export interface Net {
  bits: Bit[];
  hide_name?: number;
  attributes?: Record<string, string>;
  offset?: number;
  upto?: number;
  signed?: number;
}
export interface Cell {
  type: string;
  parameters: Record<string, string>;
  connections: Record<string, Bit[]>;
  port_directions: Record<string, Direction>;
}
export interface Module {
  attributes?: Record<string, string>;
  ports: Record<string, Port>;
  netnames: Record<string, Net>;
  cells: Record<string, Cell>;
}
export interface Netlist {
  modules: Record<string, Module>;
}
export interface Diagnostic {
  id: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}
export interface BuildResult {
  ok: boolean;
  log: string;
  logMessage?: Message;
  diagnostics: Diagnostic[];
  netlist?: Netlist;
  sourceNetlist?: Netlist;
  top?: string;
}
export interface Desktop {
  open(): Promise<Source[]>;
  save(source: Source, as: boolean): Promise<string | undefined>;
  directory(): Promise<string | undefined>;
  hdl(sources: Source[], options: BuildOptions, lint: boolean): Promise<BuildResult>;
}
