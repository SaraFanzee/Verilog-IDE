# Verilog IDE changelog

[简体中文](CHANGELOG.md) · English

## v0.1.19

- Switch between Simplified Chinese and English from the title bar. The workbench updates immediately and saves the selection. Monaco’s built-in menus and Command Palette use the selected language the next time the app launches.
- Toolbars wrap to the available panel width, and text buttons can display longer labels in narrow panels.
- Add English documentation and historical changelogs. A horizontal rule separates the Chinese and English release notes.
- Match the NOT gate’s inversion bubble, the XOR gate’s extra arc, and both XNOR details to their gate outline and critical-path colors.
- Center the divider between the source editor and the results area. Increase the collapse and expand buttons from 26 to 208 pixels tall while keeping them 12 pixels wide.
- Draw the title bar divider below the native window controls so it spans the full window at different interface zoom levels.

## v0.1.18

- Translate common editor context-menu and Command Palette commands into Chinese.
- Center workbench button icons and clock icons in the signal list vertically.
- Align the delay heading above the component delay controls.
- Document synthesis results, waveform editing, clock triggering, and component delays.

## v0.1.17

- Narrow the synthesis settings button. Use consistent time-step terminology and show single-step and cycle-step icons as `>|` and `>||`.
- Show clock, input, and output icons before names in the signal list. Their colors follow the schematic, and tooltips explain how to add or remove watches.
- Show the total component instance count and place the zero and default delay buttons below the delay heading on the right.
- Make Follow cursor and Critical path highlighted toggle buttons. Rename the waveform edit range to Default edit range.
- Maintain critical-path stroke widths for single-bit wires and buses when zooming out.

## v0.1.16

- Refine schematic junctions and local routing to eliminate avoidable detours and corners.
- Put the fit controls between zoom out and zoom in, and use a color wheel for schematic colors.
- Adopt the MIT license and include it in both Windows and Linux packages.

## v0.1.15

- Move New, Open, and Save to the editor header with synthesis and its settings on the right.
- Reduce the main title bar and window controls from 46 to 32 logical pixels.
- Center the top module or scope path in the schematic header. Parent scopes remain clickable, and narrow headers give the path its own row.

## v0.1.14

- Add RTL and gate-level tabs to the schematic. The first synthesis defaults to RTL. Changing tabs rebuilds the current sources and settings at the selected level and preserves the panel width. Selecting the active tab skips the rebuild.
- Move synthesis and its settings dropdown to the right side of the editor header.

## v0.1.13

- Use the reference v0.1.12 tri-state buffer size for both gate-level `$_TBUF_` and RTL `$tribuf`. Keep the pin names inside the triangle and show connected constants on hover. Instances of the same cell or submodule type share a size within a diagram.
- Give the multiplexer title and output Y dedicated space. Shorten long input constants such as `B=D…` and show the full assignment on hover.

## v0.1.12

- Narrow the `$tribuf` triangle by one third compared with v0.1.11. Keep its height and move Y closer to the tip while preserving clearance for the A, EN, and Y labels.

## v0.1.11

- Add persistent colors for the critical path and schematic canvas. The path, pins, component outlines, and delay readout share the critical-path color.
- Move A, EN, and Y inside the `$tribuf` triangle, with inputs and output in separate columns. Reserve space for pin labels with constants.

## v0.1.10

- Qualify unnamed bus joiner and splitter port labels with the component instance name, for example `$procmux$50.B[14:0]`. Apply the same naming to hover mappings. Use the driving instance and port when a splitter connects several components.

## v0.1.9

- Remove the general app menu. The file toolbar starts with New, while the editor retains edit shortcuts and context-menu actions for Undo, Redo, Cut, Copy, Paste, Delete, and Select All.
- Use `F11` for full screen and `Ctrl++`, `Ctrl+=`, `Ctrl+-`, or `Ctrl+0` for interface zoom.
- Iterate routing cleanup by straightening wires, removing corners, and compacting whitespace until no further improvements are available.
- Add borders to multibit buses and their pins. The center still shows the logic state, and the border color is saved separately.

## v0.1.8

- Fix gaps on the outside of right-angle corners in wires and buses, including at different zoom levels.
- Review RTL and gate-level routes after routing. Prefer direct runs and then a single right angle, keeping detours where obstacles, occupied segments, or junctions require them.
- Align directly connected pins in dense diagrams where possible. Compact empty rows and columns while preserving component sizes, port contacts, crossings, and connections.

## v0.1.7

- Draw bus joiners and splitters as thick vertical lines with inputs on the left and outputs on the right. Show declared ranges, repeated bits, and constants, and show their mapping on hover.
- Connect XOR and XNOR inputs to the outermost curve at each pin’s height. Verify the connection points on the Lab6 ALU.

## v0.1.6

- Share signal radix choices across the schematic, signal list, and waveform watch list. Signals on the same wire can keep separate choices.
- Add remove and radix buttons to waveform watch rows.
- Draw inversion bubbles with transparent interiors and separate shared wire labels with commas. Size input and output symbols to accommodate 32-bit binary values.
- Add bus joiners and splitters that preserve slices, fan-out, repeated bits, and constants. In Lab6, `src1` uses a single 32-bit bus and the bitwise XNOR shows A, B, and Y.

## v0.1.5

- Keep inversion bubbles round when logic gates are widened.
- Apply timing edits after a brief pause, on Enter, or on blur. Keep the last valid settings when a draft is invalid.
- Replace New, Open, and Save with icons, use two bars for Pause, and move the current/total time beside playback.

## v0.1.4

- Highlight the longest propagation path in the current schematic scope. Show its total delay and component order, and recompute after delay or time-step edits.
- Widen logic gates by 50% and narrow multiplexers by 25%.
- About halve the size of the editor divider arrows and blend their edges into the divider.

## v0.1.3

- Show the editor full-width at launch and at one quarter of the workspace after synthesis. The divider supports dragging and toggling between hidden, quarter-width, and full-width views.
- Move simulation controls above the schematic. Default to a 50 ps step, 1 ns clock period, 100 ns end time, and adjustable playback. Use icons for return to zero, step, and step one cycle.
- Place inputs on the left and outputs on the right. Layer and split dense gate-level circuits into columns. Add separate port and component colors and include bus width in hover details.
- Allow dragging the waveform time-window edges and panning the entire selection.
- Open synthesis settings from the dropdown next to Synthesize, with Yosys command hints, extra commands, and a log of the scripts used.

## v0.1.2

- Use ANSI gate symbols with different input and output colors. Orthogonal nets distinguish crossings from connected junctions and label source variables where they map to the netlist.
- Add pointer-centered zoom, drag-to-pan, and right-click waveform watches for schematic wires, including internal nets.
- Restore delays by default. Set relative delays by component type, zero them, or restore defaults.
- Divide waveform major ticks into ten parts. Default edits to the current clock cycle and support binary, hexadecimal, unsigned decimal, and signed decimal display.

## v0.1.1

- Add functional and delayed simulation modes. Default to zero-delay functional simulation for comparing steady-state logic values.
- Extend the four-state Yosys `$bmux` model to merge candidate bits for X or Z selector values.
- Disable state recoding in gate-level synthesis when probe preservation is enabled.

## v0.1.0

- Release Windows and Linux x64 desktop packages with bundled HDL tools. Support multiple Verilog/SystemVerilog files, live lint of unsaved sources, and configurable RTL and gate-level synthesis.
- Provide interactive four-state simulation through color-coded hierarchical schematics and waveforms. Locate component types and set delays from the component list.
- Detect clocks and support custom periods, stepping, playback, signal watches, and waveform zoom, pan, and cursor follow.
- Edit stimuli from both the schematic and the waveform, with temporary and persistent edit ranges.
- Preserve earlier simulation results after stimulus changes and recompute from the affected time, prioritizing the cursor and visible waveform range.
