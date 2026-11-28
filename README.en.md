# Verilog IDE

[简体中文](README.md) · English

<img width="2560" height="1344" alt="Verilog IDE workbench" src="https://github.com/user-attachments/assets/7774a997-2078-446f-b011-c9329b8773a5" />

Verilog IDE is a desktop Verilog and SystemVerilog workbench built with Electron, Monaco, Yosys, and slang. It includes a four-state netlist simulator and a ready-to-synthesize counter and tri-state bus example.

See the [English changelog](CHANGELOG.en.md) or [Simplified Chinese changelog](CHANGELOG.md) for version history.

## Getting started

1. Extract the archive for your system. Run `Verilog IDE.exe` on Windows or `./verilog-ide` on Linux x64. Choose **English** or **简体中文** in the title bar. The workbench updates immediately and remembers the choice. Monaco’s built-in menus and Command Palette use the selected language the next time you launch the app.
2. Use the editor toolbar to create, open, or save HDL files. Click **Synthesize** to open the schematic and waveforms. Drag the divider to resize the editor, or use the arrows to hide it, set it to a quarter of the workspace, or expand it. Live lint and synthesis use the current editor contents, including unsaved edits.
3. The first build produces an **RTL** schematic. Select **Gate-level** or **RTL** on the schematic toolbar to rebuild using the current sources and settings. The arrow next to **Synthesize** opens the HDL standard, top module, macro, parameter, include directory, hierarchy, optimization, and probe settings. Hover over a setting to see the corresponding command. You can run additional Yosys commands before writing the netlist and inspect the actual scripts in **Diagnostics & logs**.
4. Click a signal in the **Signals** list or right-click a schematic wire to add it to the waveform watch list. Click **×** to remove a watch, or click the radix chip to change its display. Radix choices are shared across the schematic, signal list, and waveforms. Click a submodule to enter its scope.
5. Click a single-bit input in the schematic to toggle it. Right-click to set `X`, `Z`, or a bus value in binary, hexadecimal, unsigned decimal, or signed two’s-complement decimal. Schematic edits take effect at the cursor and last until the next edit or the end of simulation.
6. While paused, edit an input in the waveform to cover the current cycle, a single time step, or the rest of the run. The previous stimulus resumes after a temporary override. Editing past stimulus moves the cursor back to the first affected point. Scheduling a future edit preserves the current cursor.
7. Click the waveform ruler to set the cursor. Major ticks are divided into ten equal parts. Drag either end of the time window to resize it, or drag the highlighted window to pan. Enable **Follow cursor** to keep the cursor in view. In the schematic, scroll to zoom around the pointer, drag to pan, and use the fit button to show the whole diagram.

## Schematics and simulation

- Schematics use ANSI/IEEE 91-style logic gates, clock-marked registers, trapezoidal multiplexers, and orthogonal routing. Dots mark connected branches. Inputs and clocks are arranged on the left and outputs on the right. Dense gate-level diagrams can split a layer into multiple columns.
- RTL `$tribuf` and gate-level `$_TBUF_` share the same symbol size. Hover over a shortened multiplexer label or a tri-state buffer’s constant pin label to see the full assignment.
- Bus borders frame a center line colored by logic state. The **Colors** dialog includes port and component styles, bus borders, the critical path, and the canvas background. Color choices are saved.
- Bus joiners and splitters show declared bit ranges, such as `src[3:2]`. Unnamed signals use instance, port, and bit selection, such as `$procmux$50.B[14:0]`. For example, `32×sel[0]` repeats one bit 32 times and `32'b0` represents 32 zeros. Hover over a branch to see its mapping, or over a wire or port to see its width, value, and radix.
- **Critical path** highlights the longest propagation path within the current scope. Hover over the total delay to see the path order. A path runs from an input or storage output to an output or a storage data or synchronous control input. The estimate sums component delays, including the starting storage element’s output delay, and excludes wire and setup delays. Latches are timing boundaries. If combinational feedback reaches an endpoint, the schematic shows a message.
- The default time step is 50 ps, the clock period is 1 ns, and the end time is 100 ns. The clock period must be a positive even multiple of the time step. The end time supports up to 100,000 steps, and playback ranges from 1 to 100 ns/s with a default of 10 ns/s. Valid timing edits apply after a short pause, on Enter, or on blur. Changing the time step resets input stimuli.
- Inputs start low, external bidirectional drivers start in high impedance, and recognized clocks start low. The main clock period controls cycle stepping and cycle-length waveform edits. Recognized clocks can have individual periods.
- Component delays are enabled by default. Adjust them by component type, set all to zero, or restore the defaults in **Components**. Delay edits preserve stimuli and recompute from zero. Relative defaults are measured in time steps, from 1 for inverters and NAND gates through 8 for multiplication and 12 for division. Actual delays depend on mapping, width, load, and routing. The simulator uses inertial delay, which can filter pulses shorter than a component’s delay.
- Simulation uses the synthesized RTL or gate-level netlist. It supports common combinational, arithmetic, tri-state, multiplexer, register, latch, and mapped logic cells. It reports unsupported custom or black-box components. Synthesis may remove signals or change behavior involving unknown values.
- Press `F11` to toggle full screen. Use `Ctrl++` (or `Ctrl+=`), `Ctrl+-`, and `Ctrl+0` to zoom the workbench or restore its default zoom.

## Build and test

Windows and Linux packages bundle the synthesis and lint tools. Linux requires a graphical session and Electron’s system graphics libraries.

For development, use Node.js 22 or later and an [OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build/releases) build with Yosys and `read_slang`, standalone slang, and ABC. Add the tools to `PATH` or set `VERILOG_IDE_TOOLCHAIN` to the suite directory.

```sh
npm ci
npm run typecheck
npm test
npm start
```

Run `npm run build` and then `node_modules/.bin/electron test/electron-smoke.cjs` for desktop integration tests covering the editor, live lint, synthesis, simulation controls, language switching, and narrow layouts.

## Packaging and release notes

Add a matching `## v<version>` section to `CHANGELOG.md` and `CHANGELOG.en.md` for each release. Packaging uses the version in `package.json` to include bilingual notes as `CHANGELOG.md` at the root of each archive. Run `npm run release:notes` to generate the bilingual `release/Verilog-IDE-<version>-更新日志.md` file for the GitHub Release body.

Packaging verifies the Electron ZIP and writes the archives to `release/`. It uses the system `tar.exe` on Windows and `unzip`, `tar`, and `curl` on Linux when the Electron ZIP is unavailable locally.

```powershell
npm run package -- --platform win32 --toolchain C:/HDLTools
```

```sh
npm run package -- --platform linux --toolchain /opt/oss-cad-suite
```

To build a Linux archive on Windows, pass the Linux toolchain tarball.

```powershell
npm run package -- --platform linux --toolchain-archive runtime/oss-cad-suite-linux-x64.tgz
```
