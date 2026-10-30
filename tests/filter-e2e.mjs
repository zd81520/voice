import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProject } from '../renderer/project.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sampler-filter-'));
const savePath = path.join(temp, 'filter.sampler.json');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.SAMPLER_TEST_EXE || undefined;
let app;
try {
  app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [`--user-data-dir=${path.join(temp,'profile')}`] : ['.', `--user-data-dir=${path.join(temp,'profile')}`], env });
  await app.evaluate(({dialog}, filename) => { dialog.showSaveDialog = async () => ({canceled:false, filePath:filename}); }, savePath);
  const win = await app.firstWindow(), errors = [];
  win.on('pageerror', error => errors.push(error.message));
  assert.equal(await win.locator('#filter-enabled').isChecked(), false);
  await win.locator('#filter-enabled').check();
  await win.locator('#filter-cutoff').fill('1000');
  await win.locator('#filter-q').fill('0.7');
  await win.locator('#save-project').click();
  await win.getByText('工程已保存。').waitFor();
  const saved = await fs.readFile(savePath, 'utf8');
  const settings = parseProject(saved).parameters;
  assert.equal(settings.filterEnabled, true);
  assert.equal(settings.filterCutoffHz, 1000);
  assert.equal(settings.filterQ, 0.7);
  await win.locator('#new-project').click();
  assert.equal(await win.locator('#filter-enabled').isChecked(), false);
  await win.locator('#project-input').setInputFiles({name:'filter.sampler.json', mimeType:'application/json', buffer:Buffer.from(saved)});
  await win.getByText('工程已打开。').waitFor();
  assert.equal(await win.locator('#filter-enabled').isChecked(), true);
  assert.equal(Number(await win.locator('#filter-cutoff').inputValue()), 1000);
  assert.equal(Number(await win.locator('#filter-q').inputValue()), 0.7);
  const levels = await win.evaluate(async parameters => {
    const { SamplerEngine } = await import('./sampler.js');
    async function render(filterEnabled) {
      const context = new OfflineAudioContext(1, 48000, 48000), engine = new SamplerEngine(context);
      const buffer = context.createBuffer(1, 48000, 48000), samples = buffer.getChannelData(0);
      for (let i=0;i<samples.length;i++) samples[i]=0.2*Math.sin(2*Math.PI*200*i/48000)+0.2*Math.sin(2*Math.PI*8000*i/48000);
      engine.replaceZones([{id:'tone',buffer,rootNote:60,keyLow:0,keyHigh:127,velocityLow:1,velocityHigh:127}]);
      engine.setParameters({...parameters,filterEnabled,gainDb:0,attackMs:0,decayMs:0,sustainLevel:1});
      engine.noteOn(60,127);
      const result=(await context.startRendering()).getChannelData(0);
      function amplitude(freq) {
        let a=0,b=0;
        for(let i=24000;i<48000;i++) { const phase=2*Math.PI*freq*i/48000; a+=result[i]*Math.cos(phase); b+=result[i]*Math.sin(phase); }
        return 2*Math.hypot(a,b)/24000;
      }
      return {low:amplitude(200),high:amplitude(8000)};
    }
    return {bypass:await render(false), filtered:await render(true)};
  }, settings);
  assert(levels.bypass.low > 0.19 && levels.bypass.high > 0.19, JSON.stringify(levels));
  assert(levels.filtered.low > 0.18 && levels.filtered.high < 0.01, JSON.stringify(levels));
  assert.deepEqual(errors, []);
  console.log('PASS: filter UI, save/restore, bypass and low-pass frequency response:', JSON.stringify(levels));
} finally {
  if (app) await app.close();
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  await fs.rm(temp, {recursive:true, force:true});
}
