const assert = require('node:assert/strict');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { basename } = require('node:path');
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const synthesisModes = [];
const handle = ipcMain.handle;
ipcMain.handle = function (channel, handler) {
  if (channel !== 'hdl') return handle.call(this, channel, handler);
  return handle.call(this, channel, (event, sources, options, lint) => {
    if (!lint) synthesisModes.push(options.mode);
    return handler(event, sources, options, lint);
  });
};
require(process.env.VERILOG_IDE_SMOKE_MAIN || '../dist/main.cjs');

const timeout = setTimeout(() => { console.error('UI verification timed out'); app.exit(1); }, 90_000);

app.whenReady().then(async () => {
  ipcMain.handle = handle;
  const window = BrowserWindow.getAllWindows()[0];
  const { webContents } = window;
  webContents.setBackgroundThrottling(false);
  const errors = [];
  webContents.on('console-message', (details, level, message) => {
    errors.push(details.message ?? message ?? String(level));
  });
  webContents.debugger.attach('1.3');
  webContents.debugger.on('message', (_, method, params) => {
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    if (method === 'Log.entryAdded') errors.push(params.entry.text);
  });
  await webContents.debugger.sendCommand('Runtime.enable');
  await webContents.debugger.sendCommand('Log.enable');
  if (webContents.isLoading()) await new Promise(resolve => webContents.once('did-finish-load', resolve));
  const evaluate = expression => webContents.executeJavaScript(expression);
  const value = id => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const checkWires = async name => {
    const metrics = await evaluate(`(() => {
      const svg = document.querySelector('#schematic svg');
      const tracks = new Map();
      const pins = new Set();
      const dimensions = new Map();
      for (const group of svg.querySelectorAll('.part')) {
        const type = group.querySelector(':scope > title').textContent.split(String.fromCharCode(10))[1];
        if (type && !group.classList.contains('bus-adapter')) {
          const body = group.querySelector('.schematic-node');
          const box = body.getBBox(), matrix = body.transform.baseVal.consolidate()?.matrix;
          const size = [box.width * (matrix?.a ?? 1), box.height * (matrix?.d ?? 1)].join(',');
          if (dimensions.has(type) && dimensions.get(type) !== size) throw Error('inconsistent size: ' + type);
          dimensions.set(type, size);
        }
        const m = group.transform.baseVal.getItem(0).matrix;
        for (const pin of group.querySelectorAll('.symbol-pin')) pins.add([m.e + pin.x1.baseVal.value, m.f + pin.y1.baseVal.value].join(','));
      }
      let bends = 0, length = 0;
      for (const wire of svg.querySelectorAll('.schematic-wire')) {
        let prior;
        const ends = new Map();
        const connected = new Map();
        const strokes = new Set();
        for (const [,command,x,y] of wire.getAttribute('d').matchAll(/([ML]) (\\d+) (\\d+)/g)) {
          const point = [+x, +y];
          if (command === 'M') {
            if (prior) strokes.add(prior.join(','));
            strokes.add(point.join(','));
          }
          if (command === 'L') {
            const h = prior[1] === point[1];
            if (!h && prior[0] !== point[0]) throw Error('diagonal wire');
            const axis = h ? 0 : 1;
            const track = (h ? 'h' : 'v') + point[1-axis];
            if (!tracks.has(track)) tracks.set(track, []);
            tracks.get(track).push([Math.min(prior[axis],point[axis]),Math.max(prior[axis],point[axis])]);
            length += Math.abs(prior[axis]-point[axis]);
            for (const p of [prior, point]) {
              const key = p.join(',');
              const list = ends.get(key) || [];
              list.push(axis);
              ends.set(key, list);
              if (!connected.has(key)) connected.set(key, []);
              connected.get(key).push((p === prior ? point : prior).join(','));
            }
          }
          prior = point;
        }
        strokes.add(prior.join(','));
        const joints = new Set([...wire.parentNode.querySelectorAll('.junction')].map(j=>j.getAttribute('cx')+','+j.getAttribute('cy')));
        for (const [key, axes] of ends) {
          if (axes.length === 1 && !pins.has(key)) throw Error('wire misses terminal at ' + key);
          if ((axes.length >= 3) !== joints.has(key)) throw Error('incorrect junction at ' + key);
          if (!joints.has(key) && axes.length === 2 && axes[0] !== axes[1]) {
            if (strokes.has(key)) throw Error('discontinuous elbow at ' + key);
            bends++;
          }
        }
        const seen = new Set([prior.join(',')]);
        for (const p of seen) for (const next of connected.get(p)) seen.add(next);
        if (seen.size !== ends.size) throw Error('disconnected network');
      }
      for (const spans of tracks.values()) {
        spans.sort((a,b)=>a[0]-b[0]);
        for (let i=1;i<spans.length;i++) if (spans[i][0]<spans[i-1][1]) throw Error('overlapping wire spans');
      }
      const bounds = svg.getBBox();
      return { bends, length, width:Math.round(bounds.width), height:Math.round(bounds.height) };
    })()`);
    console.log(name, metrics);
  };
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const buildMode = async mode => {
    const tab = 'mode-' + mode;
    const selected = await evaluate(`document.getElementById('${tab}').getAttribute('aria-selected') === 'true'`);
    await click(selected ? 'synthesize' : tab);
  };
  const editTime = (id, number) => evaluate(`(() => {
    const field = document.getElementById(${JSON.stringify(id)});
    field.value = ${JSON.stringify(number)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const checkCircles = () => evaluate(`[...document.querySelectorAll('#schematic circle')].every(circle => {
    const r = circle.getBoundingClientRect();
    return r.width > 0 && Math.abs(r.width - r.height) < .01;
  })`);
  const waveClick = (time, row) => evaluate(`(() => {
    const wave = document.getElementById('wave');
    const rect = wave.getBoundingClientRect();
    const x = 150 + (wave.clientWidth - 162) * ${time} / 100;
    wave.dispatchEvent(new MouseEvent('click', { clientX: rect.left + x, clientY: rect.top + 28 + 33 * ${row} + 14, bubbles: true }));
  })()`);
  async function wait(expression, info) {
    for (let attempt = 0; attempt < 90; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(info + ': ' + JSON.stringify({ status: await value('status'), lint: await value('lint-status'), tabs: await value('tabs'), preview: await value('preview'), log: (await value('log')).slice(-1000), errors,
      page: await evaluate("({ href: location.href, editor: !!document.querySelector('.monaco-editor'), desktop: typeof window.desktop, diagram: document.querySelector('#schematic').textContent.slice(0,120), visibility: document.visibilityState, rows: document.querySelectorAll('.watch-row').length })"),
    }));
  }
  await wait("document.querySelector('.monaco-editor') && document.getElementById('lint-status').textContent.includes('语法通过')", 'live lint');
  assert.equal(Menu.getApplicationMenu(), null);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.editor-panel .panel-header .file-actions button')].map(button => button.id)"), ['new', 'open', 'save']);
  for (const prefix of ['diagram', 'wave']) {
    const id = prefix + '-fit';
    assert.deepEqual(await evaluate(`(() => {
      const button = document.getElementById('${id}');
      return [button.previousElementSibling.id, button.nextElementSibling.id, !!button.querySelector('svg path'), !!button.getAttribute('aria-label')];
    })()`), [prefix + '-out', prefix + '-in', true, true]);
  }
  assert(await evaluate("document.querySelector('#colors img').naturalWidth > 0 && document.getElementById('colors').getAttribute('aria-label') === '配色'"));
  assert.equal(await evaluate("document.querySelector('.appbar').getBoundingClientRect().height"), 32);
  const key = async (keyCode, modifiers = []) => {
    const received = new Promise(resolve => webContents.once('before-input-event', (_,input) => resolve(input)));
    for (const type of ['keyDown','keyUp']) webContents.sendInputEvent({type,keyCode,modifiers});
    return received;
  };
  const originalZoom = webContents.getZoomLevel();
  const zoomKey = await key('=', ['control','shift']);
  assert(webContents.getZoomLevel() > originalZoom, JSON.stringify(zoomKey));
  await key('-', ['control']);
  assert.equal(webContents.getZoomLevel(), originalZoom);
  await key('=', ['control']);
  await key('0', ['control']);
  assert.equal(webContents.getZoomLevel(), 0);
  await key('F11');
  assert(window.isFullScreen());
  await key('F11');
  assert(!window.isFullScreen());
  const editorPoint = await evaluate("(() => {const r=document.querySelector('.view-lines .view-line').getBoundingClientRect(); return {x:Math.round(r.left+12),y:Math.round(r.top+r.height/2)};})()");
  for (const type of ['mouseDown','mouseUp']) webContents.sendInputEvent({type, ...editorPoint, button:'right',clickCount:1});
  const editMenu = "(document.querySelector('.monaco-editor .shadow-root-host')?.shadowRoot ?? document).querySelector('.monaco-menu')";
  await wait(editMenu, 'editor context menu');
  const actions = await evaluate(`[...${editMenu}.querySelectorAll('.action-label')].map(el=>el.textContent.trim())`);
  for (const action of ['撤销','重做','删除','全选','Cut','Copy','Paste']) assert(actions.includes(action), JSON.stringify(actions));
  webContents.sendInputEvent({type:'keyDown', keyCode:'Escape'});
  webContents.sendInputEvent({type:'keyUp', keyCode:'Escape'});
  await wait('!(' + editMenu + ')', 'editor menu closed');
  for (const type of ['mouseDown','mouseUp']) webContents.sendInputEvent({type, ...editorPoint, button:'left',clickCount:1});
  await key('a', ['control']);
  await wait("document.querySelectorAll('.view-overlays .selected-text').length > 1", 'editor multi-line selection');
  await webContents.insertText('Q');
  const sampleRestored = "document.querySelector('.view-lines').textContent.includes('counter')";
  await wait("document.querySelector('.view-lines').textContent.trim() === 'Q'", 'editor select all');
  await key('z', ['control']); await wait(sampleRestored, 'editor undo');
  await key('y', ['control']); await wait('!' + sampleRestored, 'editor redo');
  await key('z', ['control']); await wait(sampleRestored, 'restore source');
  assert(await evaluate("document.querySelector('.results').getBoundingClientRect().width === 0"));
  await click('editor-less'); await click('editor-less');
  assert.equal(await evaluate("document.getElementById('workspace').dataset.editor"), 'hidden');
  await click('editor-more'); await click('editor-more');
  assert(await evaluate("!!document.querySelector('.editor-panel .panel-header .synth-actions #synthesize + #settings')"));
  assert(await evaluate("!!document.querySelector('.diagram-panel .panel-header [role=tablist] #mode-rtl[aria-selected=true] + #mode-gate[aria-selected=false]')"));
  await click('settings');
  await evaluate("document.getElementById('extra-commands').value='check'; document.querySelector('#settings-form button[value=apply]').click()");
  await click('synthesize');
  await wait("document.querySelector('#schematic svg') && document.getElementById('preview').textContent.includes('100 ns')", 'synthesis and waveform');
  await click('mode-rtl');
  assert.deepEqual(synthesisModes, ['rtl']);
  assert.equal(await evaluate("document.getElementById('duration').value"), 'period');
  assert((await value('log')).includes('check\nwrite_json design.json'));
  assert(await evaluate("Math.abs(document.querySelector('.editor-panel').clientWidth / document.getElementById('workspace').clientWidth - .25) < .01"));
  assert(await evaluate("document.querySelector('.bus-wire + .wire-hit title').textContent.includes('4 bit')"));
  assert(await evaluate("['new','open','save'].every(id => { const b=document.getElementById(id); return b.querySelector('svg') && !b.textContent.trim() && b.title === b.getAttribute('aria-label'); })"));
  assert(await evaluate("document.querySelector('.schematic-node.not') && document.querySelector('circle.inversion')").then(Boolean));
  assert(await checkCircles());
  const sameRow = `(() => {
    const play = document.getElementById('play').getBoundingClientRect();
    const time = document.getElementById('time-readout').getBoundingClientRect();
    return Math.abs((play.top + play.bottom - time.top - time.bottom) / 2) < 1 && play.right <= time.left;
  })()`;
  const headersFit = `(() => {
    const bounds = selector => document.querySelector(selector).getBoundingClientRect();
    const editor = bounds('.editor-panel .panel-header');
    const buttons = [...document.querySelectorAll('.editor-panel .panel-header button')];
    const diagram = bounds('.diagram-panel .panel-header');
    const name = bounds('#scope-path > span');
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return buttons.every(button => {
      const r = button.getBoundingClientRect();
      return r.width > 0 && r.left >= editor.left && r.right <= editor.right && r.top >= editor.top && r.bottom <= editor.bottom;
    }) && name.width > 0 && Math.abs((name.left + name.right - diagram.left - diagram.right) / 2) < 1
      && !overlaps(name, bounds('.mode-tabs')) && !overlaps(name, bounds('.diagram-actions'));
  })()`;
  assert(await evaluate(headersFit), 'editor buttons and centered module name at normal width');
  assert(await evaluate(sameRow));
  assert(await evaluate("document.getElementById('timing').getBoundingClientRect().bottom >= document.getElementById('play').getBoundingClientRect().top"));
  const [initialWidth, initialHeight] = window.getSize();
  window.setSize(950, initialHeight);
  await wait('innerWidth <= 950', 'narrow window');
  assert(await evaluate(headersFit), 'editor buttons and centered module name at minimum window width');
  assert(await evaluate(sameRow));
  window.setSize(initialWidth, initialHeight);
  await wait('innerWidth > 950', 'normal window');
  assert.equal(await evaluate("document.querySelector('#timing button')"), null);
  await editTime('end', '80');
  await wait("document.getElementById('time-readout').textContent === '0 / 80 ns'", 'end applied while typing');
  await editTime('period', '.075');
  await wait("document.getElementById('status').textContent.includes('正偶数倍')", 'invalid draft');
  await click('cycle');
  await wait("document.getElementById('time-readout').textContent === '1 / 80 ns'", 'previous valid period retained');
  await editTime('period', '2');
  await evaluate("document.getElementById('period').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await click('cycle');
  await wait("document.getElementById('time-readout').textContent === '3 / 80 ns'", 'revised period applied');
  await editTime('step-size', '100');
  await wait("document.getElementById('time-readout').textContent === '0 / 80 ns'", 'new step resets cursor');
  await click('step');
  await wait("document.getElementById('time-readout').textContent === '0.1 / 80 ns'", 'new step applied');
  await editTime('end', '100'); await editTime('step-size', '50'); await editTime('period', '1');
  await wait("document.getElementById('time-readout').textContent === '0 / 100 ns'", 'restored timing');
  await click('step');
  await wait("document.getElementById('time-readout').textContent === '0.05 / 100 ns'", '50 ps step');
  await click('rewind');
  await click('colors');
  assert.equal(await evaluate("document.querySelectorAll('#color-controls input').length"), 15);
  assert(await evaluate(`(() => {
    const control = [...document.querySelectorAll('#color-controls label')].find(l => l.textContent === '总线边框').querySelector('input');
    const buses = [...document.querySelectorAll('path.bus-wire, line.bus-wire')];
    const old = control.value, core = buses[0].getAttribute('stroke');
    control.value = '#de139c'; control.dispatchEvent(new Event('input'));
    const valid = buses.length && buses.every(bus => {
      const outline = bus.previousElementSibling;
      return outline?.classList.contains('bus-outline') && getComputedStyle(outline).stroke === 'rgb(222, 19, 156)'
        && parseFloat(getComputedStyle(outline).strokeWidth) > parseFloat(getComputedStyle(bus).strokeWidth);
    }) && buses[0].getAttribute('stroke') === core && localStorage.getItem('--bus-outline') === '#de139c'
      && !document.querySelector('.bus-outline + .schematic-wire:not(.bus-wire)');
    control.value = old; control.dispatchEvent(new Event('input'));
    return valid;
  })()`));
  await evaluate("document.querySelector('#color-dialog button').click()");
  const dragHandle = async (id, dx) => {
    const [x, y] = await evaluate(`(() => { const r=document.getElementById('${id}').getBoundingClientRect(); return [Math.round(r.x+r.width/2), Math.round(r.y+r.height/2)]; })()`);
    webContents.sendInputEvent({type:'mouseDown', x, y, button:'left', clickCount:1});
    webContents.sendInputEvent({type:'mouseMove', x:x+dx, y, modifiers:['leftButtonDown']});
    webContents.sendInputEvent({type:'mouseUp', x:x+dx, y, button:'left', clickCount:1});
  };
  await dragHandle('range-start', 80);
  await wait("Number(document.getElementById('range-start').getAttribute('aria-valuenow')) > 0", 'range start drag');
  await dragHandle('range-end', -80);
  await wait("Number(document.getElementById('range-end').getAttribute('aria-valuenow')) < 100", 'range end drag');
  const initialSpan = await evaluate("document.getElementById('range-window').style.width");
  const initialStart = await evaluate("document.getElementById('range-window').style.left");
  await dragHandle('range-window', 30);
  await wait(`document.getElementById('range-window').style.left !== ${JSON.stringify(initialStart)}`, 'range pan');
  assert.equal(await evaluate("document.getElementById('range-window').style.width"), initialSpan);
  await click('wave-fit');
  await evaluate("document.getElementById('speed').value='100'; document.getElementById('speed').dispatchEvent(new Event('input'))");
  assert.equal(await value('speed-label'), '100 ns/s');
  await click('play');
  assert(await evaluate("document.querySelectorAll('.pause-icon rect').length === 2 && getComputedStyle(document.querySelector('.pause-icon')).display !== 'none' && document.getElementById('play').textContent.trim() === '暂停'"));
  await wait("parseFloat(document.getElementById('time-readout').textContent) >= 10", 'wall-clock playback');
  await click('play');
  assert(await evaluate("getComputedStyle(document.querySelector('.pause-icon')).display === 'none' && document.getElementById('play').textContent.trim() === '运行'"));
  await click('rewind');
  assert(await evaluate("document.querySelector('.schematic-node.mux') && document.querySelector('.schematic-node.input').tagName === 'path' && document.querySelector('.schematic-node.output').tagName === 'path'").then(Boolean));
  assert(await evaluate("[...document.querySelectorAll('.wire-label')].some(label => label.textContent.includes('next_count'))"));
  assert(await evaluate("document.querySelectorAll('.junction').length") >= 1);
  await evaluate("document.getElementById('duration').value = 'step'");
  await wait("document.querySelector('#schematic [aria-label=reset]')", 'interactive input visible');
  await evaluate("document.querySelector('#schematic [aria-label=reset]').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  await wait("document.querySelector('#schematic [aria-label=reset] text:last-child').textContent === '1'", 'schematic click');
  await click('cycle');
  await wait("document.getElementById('time-readout').textContent === '1 / 100 ns'", 'cycle step');
  await waveClick(45, 1);
  await wait("/4[45](?:[.][0-9]+)? ns/.test(document.getElementById('status').textContent)", 'future waveform edit scheduled');
  assert.equal(await value('time-readout'), '1 / 100 ns');
  await waveClick(0, 1);
  await wait("document.getElementById('time-readout').textContent === '0 / 100 ns'", 'historical waveform edit');
  await wait("document.getElementById('preview').textContent.includes('已计算至 100 ns')", 'future resimulation');
  await wait("document.querySelector('#schematic [aria-label=reset] text:last-child').textContent === '0'", 'schematic and waveform agree after rewind');
  await click('show-parts');
  await click('critical-path');
  const timing = await value('critical-delay');
  assert.match(timing, /[1-9]\d* (ps|ns)/);
  assert(await evaluate("document.querySelectorAll('.critical-wires path').length >= 2 && document.querySelectorAll('.critical-part').length >= 2"));
  const criticalStrokes = `(() => {
    const diagram = document.querySelector('#schematic svg');
    const highlights = [...diagram.querySelectorAll('.critical-wires path, .critical-pin')];
    return {
      busWidth: parseFloat(getComputedStyle(diagram).getPropertyValue('--bus-width')),
      busPins: diagram.querySelectorAll('.critical-pin.bus-wire').length,
      strokes: [...new Set(highlights.map(node => {
        const { strokeWidth, vectorEffect } = getComputedStyle(node);
        return strokeWidth + ' ' + vectorEffect;
      }))],
    };
  })()`;
  const fittedStrokes = await evaluate(criticalStrokes);
  assert(fittedStrokes.busPins > 0, 'fixture includes critical bus pins');
  assert.deepEqual(fittedStrokes.strokes, ['2.6px non-scaling-stroke']);
  for (let step = 0; step < 10; step++) await click('diagram-out');
  const reducedStrokes = await evaluate(criticalStrokes);
  assert(reducedStrokes.busWidth < 1 && reducedStrokes.busWidth < fittedStrokes.busWidth);
  assert.equal(reducedStrokes.busPins, fittedStrokes.busPins);
  assert.deepEqual(reducedStrokes.strokes, fittedStrokes.strokes);
  await click('diagram-fit');
  await click('colors');
  assert(await evaluate(`(() => {
    const controls = [...document.querySelectorAll('#color-controls label')];
    const pick = name => controls.find(l => l.textContent === name).querySelector('input');
    const set = (c, value) => { c.value = value; c.dispatchEvent(new Event('input')); };
    const path = pick('关键路径'), canvas = pick('画布背景');
    const oldPath = path.value, oldCanvas = canvas.value;
    try {
      set(path, '#28d7ad'); set(canvas, '#354456');
      return ['.critical-wires path','.critical-part .schematic-node','.critical-pin'].every(selector =>
        [...document.querySelectorAll(selector)].length && [...document.querySelectorAll(selector)].every(node => getComputedStyle(node).stroke === 'rgb(40, 215, 173)'))
        && getComputedStyle(document.querySelector('#critical-delay')).color === 'rgb(40, 215, 173)'
        && getComputedStyle(document.querySelector('#schematic')).backgroundColor === 'rgb(53, 68, 86)'
        && localStorage.getItem('--critical-color') === path.value && localStorage.getItem('--diagram-background') === canvas.value;
    } finally { set(path, oldPath); set(canvas, oldCanvas); }
  })()`));
  await evaluate("document.querySelector('#color-dialog button').click()");
  assert((await value('parts')).includes('$'));
  assert(await evaluate("new Set([...document.querySelectorAll('#parts input')].map(input => input.value)).size") > 1);
  await click('zero-delays');
  assert.equal(await value('critical-delay'), '关键路径 · 0 ps');
  assert(await evaluate("[...document.querySelectorAll('#parts input')].every(input => input.value === '0')"));
  await click('reset-delays');
  assert.equal(await value('critical-delay'), timing);
  await click('critical-path');
  assert.equal(await evaluate("document.querySelectorAll('.critical-wires path, .critical-part, .critical-pin').length"), 0);
  await click('critical-path');
  assert(await evaluate("[...document.querySelectorAll('#parts input')].every(input => input.value !== '0')"));
  await click('show-signals');
  await wait("document.getElementById('signal-pane').hidden === false", 'inspector tabs switch');
  const unnamed = await evaluate(`(() => {
    const wire = [...document.querySelectorAll('.net-route')].find(wire => JSON.parse(wire.dataset.net)[0] === '@wire');
    if (!wire) return '';
    return wire.dataset.net;
  })()`);
  assert(unnamed, 'unnamed wire exists');
  await evaluate(`[...document.querySelectorAll('.net-route')].find(wire => wire.dataset.net === ${JSON.stringify(unnamed)}).querySelector('.wire-hit').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:500,clientY:450}))`);
  await wait("!document.getElementById('signal-menu').hidden", 'wire context menu');
  await evaluate("document.querySelector('#signal-menu button').click()");
  await wait("document.getElementById('wave-scroll').scrollTop > 0", 'added anonymous watch scrolled into view');
  await evaluate(`[...document.querySelectorAll('.net-route')].find(wire => wire.dataset.net === ${JSON.stringify(unnamed)}).querySelector('.wire-hit').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:500,clientY:450}))`);
  assert((await value('signal-menu')).includes('从波形观察窗移除'));
  await evaluate("document.querySelector('[aria-label=\"data_in 的显示进制\"]').click()");
  await evaluate("[...document.querySelectorAll('#signal-menu button')].find(button => button.textContent === '无符号十进制').click()");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"data_in 的显示进制\"]').textContent"), 'DEC');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"data_out 的显示进制\"]').textContent"), 'HEX');
  await evaluate("document.getElementById('wave-scroll').scrollTop = 0");
  await wait("document.querySelector('[title=\"data_in 的波形显示进制\"]')?.textContent === 'DEC'", 'wave radix follows inspector');
  await evaluate("document.querySelector('[title=\"data_in 的波形显示进制\"]').click()");
  assert(!(await value('signal-menu')).includes('从波形观察窗移除'));
  await evaluate("[...document.querySelectorAll('#signal-menu button')].find(b => b.textContent === '二进制').click()");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"data_in 的显示进制\"]').textContent"), 'BIN');
  await wait("document.querySelector('.part[data-name=data_in] > title')?.textContent.includes('(BIN)')", 'port hover follows wave radix');
  await evaluate("document.querySelector('[title=\"移除 data_in\"]').click()");
  assert.equal(await evaluate("document.querySelector('#signals button[title=data_in]').getAttribute('aria-pressed')"), 'false');
  assert(await evaluate("getComputedStyle(document.querySelector('.watch-name')).cursor === 'default' && getComputedStyle(document.querySelector('#wave')).cursor === 'crosshair'"));
  assert(await evaluate("[...document.querySelectorAll('circle.inversion')].every(c => getComputedStyle(c).fill === 'none')"));
  const viewport = "document.querySelector('#schematic svg').getAttribute('viewBox')";
  const width = Number((await evaluate(viewport)).split(' ')[2]);
  await evaluate("document.getElementById('schematic').dispatchEvent(new WheelEvent('wheel',{deltaY:-100,clientX:500,clientY:400,cancelable:true}))");
  assert(Number((await evaluate(viewport)).split(' ')[2]) < width);
  const pan = await evaluate(viewport);
  webContents.sendInputEvent({ type: 'mouseDown', x: 520, y: 270, button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseMove', x: 560, y: 300, modifiers: ['leftButtonDown'] });
  webContents.sendInputEvent({ type: 'mouseUp', x: 560, y: 300, button: 'left', clickCount: 1 });
  await wait(`${viewport} !== ${JSON.stringify(pan)}`, 'left-button panning');
  await mkdir('.test-output', { recursive: true });
  await writeFile('.test-output/workbench.png', (await webContents.capturePage()).toPNG());
  await click('editor-less');
  await evaluate("for (const id of ['mode-gate','mode-rtl','mode-gate','mode-rtl']) document.getElementById(id).click()");
  await wait("document.querySelector('#schematic[aria-busy=false][aria-labelledby=mode-rtl] svg')", 'rapid mode switches');
  assert.deepEqual(synthesisModes, ['rtl', 'gate', 'rtl']);
  assert.equal(await evaluate("document.getElementById('workspace').dataset.editor"), 'hidden');
  await click('editor-more');
  const source = process.env.VERILOG_IDE_SMOKE_SOURCE;
  if (source) {
    ipcMain.removeHandler('open');
    ipcMain.handle('open', async () => [{ id: 'routing-fixture', name: basename(source), path: source, text: await readFile(source, 'utf8') }]);
    await click('open');
    await wait("document.getElementById('tabs').textContent.includes('Lab5_6.v')", 'real workspace sample');
    for (const mode of ['rtl', 'gate']) {
      await buildMode(mode);
      await wait(`document.getElementById('net-status').textContent.includes('${mode === 'gate' ? '门级' : 'RTL'}') && document.querySelector('#schematic svg[aria-label=Lab5_6] .schematic-wire')`, mode + ' Lab5_6 routes');
      const nets = await evaluate("document.querySelectorAll('#schematic .net-route').length");
      assert(await checkCircles(), mode + ' circles retain equal screen dimensions');
      assert(await evaluate("document.querySelectorAll('.critical-wires path').length >= 2"));
      console.log('Lab5_6', mode, await value('critical-delay'));
      assert(nets > (mode === 'gate' ? 100 : 20));
      await checkWires('Lab5_6 ' + mode);
      const geometry = await evaluate(`(() => {
        const parts = [...document.querySelectorAll('#schematic .part')].map(group => ({
          x: group.transform.baseVal.getItem(0).matrix.e,
          type: group.querySelector('.schematic-node').classList[1],
        }));
        const xs = parts.map(p => p.x);
        return { columns: new Set(xs).size, parts: parts.length,
          io: parts.every(p => ['clock','input','inout'].includes(p.type) ? p.x === Math.min(...xs)
            : p.type === 'output' ? p.x === Math.max(...xs) : p.x > Math.min(...xs) && p.x < Math.max(...xs)) };
      })()`);
      assert(geometry.io && geometry.columns >= (mode === 'gate' ? 5 : 3));
      console.log(geometry);
      console.log(`OK Lab5_6 ${mode}: ${nets} routed nets`);
      await writeFile(`.test-output/lab-${mode}.png`, (await webContents.capturePage()).toPNG());
    }
  }
  const lab6 = process.env.VERILOG_IDE_SMOKE_LAB6;
  if (lab6) {
    ipcMain.removeHandler('open');
    const files = await Promise.all(['Lab6_1.v', 'Lab6_2.v'].map(async name => {
      const path = require('node:path').join(lab6, name);
      return { id: name, name, path, text: await readFile(path, 'utf8') };
    }));
    ipcMain.handle('open', async () => files);
    await click('open'); await wait("document.getElementById('tabs').textContent.includes('Lab6_2.v')", 'ALU fixtures');
    await click('settings');
    await evaluate("document.getElementById('top').value='ALU'; document.querySelector('#settings-form button[value=apply]').click()");
    await buildMode('rtl');
    await wait("document.querySelector('#schematic svg[aria-label=ALU] .bus-adapter')", 'ALU adapters');
    assert.equal(await evaluate("document.querySelectorAll('.part[data-name=src1] .symbol-pin').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('.part[data-name=\"$8\"] .symbol-pin').length"), 3);
    await checkWires('Lab6 ALU');
    const adapterGeometry = await evaluate(`(() => {
      const labels = [];
      for (const group of document.querySelectorAll('.bus-adapter')) {
        const bar = group.querySelector('line.bus-bar');
        if (!bar || group.querySelector('rect, .schematic-text') || bar.x1.baseVal.value !== bar.x2.baseVal.value) return 'unexpected bar shape';
        const x = bar.x1.baseVal.value;
        const pins = [...group.querySelectorAll('.symbol-pin')];
        const texts = [...group.querySelectorAll('text')];
        if (pins.length !== texts.length || !pins.every(pin => pin.x2.baseVal.value === x)) return 'disconnected bar pin';
        for (const [i, text] of texts.entries()) {
          const bounds = text.getBBox();
          const outer = pins[i].x1.baseVal.value;
          if (bounds.x < Math.min(outer, x) || bounds.x + bounds.width > Math.max(outer, x)) return 'label outside pin: ' + JSON.stringify({label: text.firstChild.textContent, x, outer, bounds: [bounds.x, bounds.width], count: text.getNumberOfChars(), anchor:text.getAttribute('text-anchor'), font:getComputedStyle(text).font});
          labels.push(text.firstChild.textContent);
        }
      }
      return labels;
    })()`);
    assert(Array.isArray(adapterGeometry), String(adapterGeometry));
    assert(adapterGeometry.includes('32×sel[0]'), 'replicated select: ' + adapterGeometry.join(', '));
    assert(adapterGeometry.includes('$8.B[31:0]'), 'qualified XNOR input: ' + adapterGeometry.join(', '));
    assert(adapterGeometry.includes("31'b0"), 'zero padding: ' + adapterGeometry.join(', '));
    const curves = await evaluate(`(() => {
      const kinds = new Set();
      for (const body of document.querySelectorAll('.schematic-node.xor, .schematic-node.xnor')) {
        const group = body.parentNode;
        const arc = group.querySelector('path.symbol-detail');
        kinds.add(body.classList[1]);
        for (const pin of group.querySelectorAll('line.symbol-pin[x1="0"]')) {
          let low = 0, high = arc.getTotalLength();
          for (let i = 0; i < 24; i++) {
            const mid = (low + high) / 2;
            if (arc.getPointAtLength(mid).y < pin.y2.baseVal.value) low = mid; else high = mid;
          }
          const point = arc.getPointAtLength((low + high) / 2).matrixTransform(arc.transform.baseVal.consolidate().matrix);
          if (Math.abs(point.x - pin.x2.baseVal.value) > 0.05) return [];
        }
      }
      return [...kinds].sort();
    })()`);
    assert.deepEqual(curves, ['xnor', 'xor'], 'all XOR and XNOR inputs land on the outer arc');
    assert(await evaluate("document.querySelectorAll('.critical-wires path').length > 1"));
    const width = await evaluate("document.querySelector('.part[data-name=src1] .schematic-node').getBBox().width");
    await evaluate("document.querySelector('.part[data-name=src1]').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
    const binary = '1' + '0'.repeat(30) + '1';
    await evaluate(`document.getElementById('value-radix').value='bin'; document.getElementById('value-radix').dispatchEvent(new Event('change')); document.getElementById('value-input').value='${binary}'; document.getElementById('value-form').requestSubmit()`);
    await wait(`document.querySelector('.part[data-name=src1] text:last-child')?.textContent === '${binary}'`, 'all 32 bits displayed');
    await wait(`document.querySelector('.part[data-name=src1] .schematic-node')?.getBBox().width > ${width}`, 'port layout resized for binary');
    assert(await evaluate("document.querySelector('.part[data-name=src1] text:last-child').getBBox().width < document.querySelector('.part[data-name=src1] .schematic-node').getBBox().width"));
    assert.equal(await evaluate("document.querySelector('[aria-label=\"src1 的显示进制\"]').textContent"), 'BIN');
    assert(await evaluate("document.querySelector('.net-route[data-net*=src1] title').textContent.includes('32 bit') && document.querySelector('.net-route[data-net*=src1] title').textContent.includes('(BIN)')"));
    await click('cycle');
    await wait("[...document.querySelectorAll('.net-route title')].some(t => /arithmetic_b · 32 bit · 7FFFFFFE/.test(t.textContent))", 'XNOR result across replicated and sliced buses');
    await evaluate("document.querySelector('.net-route[data-net*=src0] .wire-hit').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:700,clientY:190}))");
    await evaluate(`(() => {
      const choice = document.querySelector('#signal-menu select');
      choice.value = [...choice.options].find(o => o.text === 'arithmetic_a').value;
      choice.dispatchEvent(new Event('change'));
      [...document.querySelectorAll('#signal-menu button')].find(b => b.textContent === '二进制').click();
    })()`);
    assert.equal(await evaluate("document.querySelector('[aria-label=\"arithmetic_a 的显示进制\"]').textContent"), 'BIN');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"src0 的显示进制\"]').textContent"), 'HEX');
    assert(await evaluate("document.querySelector('.net-route[data-net*=src0] title').textContent.includes('arithmetic_a · 32 bit · ' + '0'.repeat(32) + ' (BIN)')"));
    await writeFile('.test-output/lab6-alu.png', (await webContents.capturePage()).toPNG());
    console.log('OK Lab6 ALU: 32-bit src1 trunk, XNOR A/B/Y, replicated select, synchronized binary port value');
  }
  ipcMain.removeHandler('open');
  ipcMain.handle('open', async () => [{id:'tri_test',name:'tri_test.v',text:
    `module tri_test(input [15:0] a, input [63:0] data, input en, output [15:0] y, k, output [63:0] wide, mux_y);
       assign y=en?a:16'bz; assign k=en?16'hbeef:16'bz; assign wide=en?64'h123456789abcdef0:64'bz;
       assign mux_y=en?64'hdeadbeef01234567:data; endmodule
     module tri_gate(input a,en, output y,k,t);
       bufif1 u0(y,a,en); bufif1 u1(k,1'b1,en); bufif1 u2(t,1'b0,en); endmodule`}]);
  await click('open');
  await wait("document.getElementById('tabs').textContent.includes('tri_test.v')", 'tri-state fixture');
  await click('settings');
  await evaluate("document.getElementById('top').value='tri_test'; document.getElementById('extra-commands').value='tribuf'; document.querySelector('#settings-form button[value=apply]').click()");
  await buildMode('rtl');
  await wait("document.querySelectorAll('#schematic svg[aria-label=tri_test] .schematic-node.tribuf').length === 3", 'tri-state buffers');
  async function checkSymbolBounds(kind) {
    const geometry = await evaluate(`[...document.querySelectorAll('.schematic-node.${kind}')].map(body => {
      const labels = [...body.parentNode.querySelectorAll('.${kind === 'mux' ? 'mux-caption' : 'tribuf-label'}')];
      const matrix = body.transform.baseVal.consolidate().matrix;
      const inverse = matrix.inverse();
      const boxes = labels.map(l => l.getBBox());
      if ('${kind}' === 'tribuf') {
        const names = labels.map(l => l.firstChild.textContent).sort().join(',');
        if (!['A,EN,Y','A,E,Y'].includes(names)) return names;
        const triangle = body.getBBox(), width = triangle.width * matrix.a;
        const tip = new DOMPoint(triangle.x + triangle.width, triangle.y + triangle.height / 2).matrixTransform(matrix);
        const output = boxes[labels.findIndex(l => l.firstChild.textContent === 'Y')];
        const gap = tip.x - output.x - output.width;
        if (Math.abs(width - 122 / 3) > .01 || Math.abs(triangle.height * matrix.d - 40) > .01 ||
            gap <= 0 || gap >= width * .45) return {width,gap,height:triangle.height};
      }
      const fits = boxes.every((b,i) => [b.x-1.5,b.x+b.width+1.5].every(x => [b.y-1.5,b.y+b.height+1.5].every(y =>
        body.isPointInFill(new DOMPoint(x,y).matrixTransform(inverse)))) &&
        boxes.slice(i+1).every(other => b.x+b.width < other.x || other.x+other.width < b.x || b.y+b.height < other.y || other.y+other.height < b.y));
      return fits || {body:body.getAttribute('d'), labels:boxes.map((b,i)=>[labels[i].textContent,b.x,b.y,b.width,b.height])};
    })`);
    assert(geometry.length && geometry.every(g => g === true), kind + ' label bounds: ' + JSON.stringify(geometry));
  }
  assert(await evaluate(`[...document.querySelectorAll('.mux-caption')].some(label =>
    label.firstChild.textContent === 'B=D…' && label.querySelector('title')?.textContent === 'B=DEADBEEF01234567')`));
  for (let i=0; i<2; i++) {
    await checkSymbolBounds('tribuf');
    await checkSymbolBounds('mux');
    await click('diagram-in');
  }
  await click('settings');
  await evaluate("document.getElementById('top').value='tri_gate'; document.getElementById('extra-commands').value=''; document.querySelector('#settings-form button[value=apply]').click()");
  await buildMode('gate');
  await wait("document.querySelectorAll('#schematic svg[aria-label=tri_gate] .schematic-node.tribuf').length === 3", 'three separately mapped TBUFs');
  assert(await evaluate("[...document.querySelectorAll('.schematic-node.tribuf')].every(body => body.parentNode.querySelector('title').textContent.includes('$_TBUF_'))"));
  await checkSymbolBounds('tribuf');
  console.log('OK RTL and gate tri-state symbols have the same reference size; MUX title and shortened literal fit');
  clearTimeout(timeout);
  console.log('OK Electron UI: editor, live lint, synthesis, schematic input, stepping and historical edit');
  app.exit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
