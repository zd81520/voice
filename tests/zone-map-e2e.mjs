import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProject } from '../renderer/project.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(),'sampler-map-'));
const filePath = path.join(temp,'instrument.sampler.json');
const wav = await fs.readFile('示例素材/示例-C4.wav');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.SAMPLER_TEST_EXE || undefined;
let app;
try {
  app=await electron.launch({...(executablePath ? {executablePath} : {}),args:executablePath ? [`--user-data-dir=${path.join(temp,'profile')}`] : ['.',`--user-data-dir=${path.join(temp,'profile')}`],env});
  await app.evaluate(({dialog}, filename)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:filename});},filePath);
  const win=await app.firstWindow(), errors=[];
  win.on('pageerror',error=>errors.push(error.message));
  assert(await win.locator('#auto-map-zones').isDisabled());
  await win.locator('#file-input').setInputFiles(['a.wav','b.wav','c.wav'].map(name=>({name,mimeType:'audio/wav',buffer:wav})));
  await win.waitForFunction(()=>document.querySelector('#sample-status').textContent==='3 / 64');
  const first=win.getByRole('option',{name:/a\.wav/}), second=win.getByRole('option',{name:/b\.wav/}), third=win.getByRole('option',{name:/c\.wav/});
  await second.click(); await win.locator('#zone-root').fill('72'); await win.locator('#zone-velocity-high').fill('64');
  await win.locator('#apply-zone').click();
  await third.click(); await win.locator('#zone-root').fill('72'); await win.locator('#zone-velocity-low').fill('65');
  // Pending edits are included atomically in auto mapping.
  await win.locator('#auto-map-zones').click();
  assert.match(await win.locator('#message').innerText(),/已按根音分配/);
  assert.equal(Number(await win.locator('#zone-key-low').inputValue()),67);
  assert.equal(Number(await win.locator('#zone-key-high').inputValue()),127);
  assert.equal(Number(await win.locator('#zone-velocity-low').inputValue()),65);
  const graph=win.locator('#zone-map');
  assert.equal(await graph.getByRole('button').count(),3);
  assert.match(await graph.getByRole('button',{name:/c\.wav/}).getAttribute('aria-label'),/键位 67 至 127，力度 65 至 127，根音 72/);
  await graph.getByRole('button',{name:/a\.wav/}).focus();
  await win.keyboard.press('Enter');
  assert.equal(await win.locator('#zone-name').inputValue(),'a.wav');
  assert.equal(Number(await win.locator('#zone-key-low').inputValue()),0);
  assert.equal(Number(await win.locator('#zone-key-high').inputValue()),66);
  await win.evaluate(()=>{
    window.testAudio={starts:0,stops:0};
    const start=AudioBufferSourceNode.prototype.start, stop=AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start=function(...args){window.testAudio.starts++;return start.apply(this,args)};
    AudioBufferSourceNode.prototype.stop=function(...args){window.testAudio.stops++;return stop.apply(this,args)};
  });
  await win.locator('#enable-audio').click(); await win.keyboard.down('z');
  await win.waitForFunction(()=>window.testAudio.starts>0);
  await win.locator('#auto-map-zones').click();
  assert.match(await win.locator('#message').innerText(),/无需更改/);
  assert.equal((await win.evaluate(()=>window.testAudio.stops)),0);
  // Invalid pending edits neither change the mapping nor discard typed input.
  await win.locator('#zone-root').fill('128'); await win.locator('#auto-map-zones').click();
  assert.match(await win.locator('#message').innerText(),/自动分配未应用/);
  assert.equal(await win.locator('#zone-root').inputValue(),'128');
  assert.equal(Number(await win.locator('#zone-key-high').inputValue()),66);
  assert.equal((await win.evaluate(()=>window.testAudio.stops)),0);
  await win.keyboard.up('z');
  await win.locator('#zone-root').fill('60'); await win.locator('#apply-zone').click();
  await win.locator('#save-project').click(); await win.getByText('工程已保存。').waitFor();
  const saved=await fs.readFile(filePath,'utf8'), project=parseProject(saved);
  assert.deepEqual(project.zones.map(({rootNote,keyLow,keyHigh,velocityLow,velocityHigh})=>({rootNote,keyLow,keyHigh,velocityLow,velocityHigh})),[
    {rootNote:60,keyLow:0,keyHigh:66,velocityLow:1,velocityHigh:127},
    {rootNote:72,keyLow:67,keyHigh:127,velocityLow:1,velocityHigh:64},
    {rootNote:72,keyLow:67,keyHigh:127,velocityLow:65,velocityHigh:127},
  ]);
  await win.locator('#new-project').click();
  await win.locator('#project-input').setInputFiles({name:'saved.sampler.json',mimeType:'application/json',buffer:Buffer.from(saved)});
  await win.getByText('工程已打开。').waitFor();
  assert.equal(await graph.getByRole('button').count(),3);
  assert.match(await graph.getByRole('button',{name:/b\.wav/}).getAttribute('aria-label'),/键位 67 至 127，力度 1 至 64/);
  assert.deepEqual(errors,[]);
  console.log('PASS: automatic key mapping, velocity layers, accessible map, invalid pending edits, project save/restore.');
} finally {
  if(app) await app.close();
  assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));
  await fs.rm(temp,{recursive:true,force:true});
}
