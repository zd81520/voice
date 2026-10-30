import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProject } from '../renderer/project.js';

function tone(f) {
  const wav = Buffer.alloc(44 + 4800 * 2);
  wav.write('RIFF',0); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(48000,24); wav.writeUInt32LE(96000,28); wav.writeUInt16LE(2,32);
  wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(9600,40);
  for(let i=0;i<4800;i++) wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*f/48000)*5000),44+i*2);
  return wav;
}
const temp = await fs.mkdtemp(path.join(os.tmpdir(),'sampler-e2e-'));
const savePath = path.join(temp,'instrument.sampler.json');
const a=tone(440), b=tone(880);
const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  const executablePath = process.env.SAMPLER_TEST_EXE || undefined;
  app=await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [`--user-data-dir=${path.join(temp,'profile')}`] : ['.',`--user-data-dir=${path.join(temp,'profile')}`], env});
  await app.evaluate(({dialog,session})=>{
    globalThis.testSaveResult={canceled:true};
    dialog.showSaveDialog=async()=>globalThis.testSaveResult;
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_details,cb)=>cb({cancel:true}));
  });
  const window=await app.firstWindow();
  const errors=[]; window.on('pageerror',e=>errors.push(e.message));
  const message=window.locator('#message');
  await window.locator('#file-input').setInputFiles([{name:'low.wav',mimeType:'audio/wav',buffer:a},{name:'high.wav',mimeType:'audio/wav',buffer:b}]);
  await window.waitForFunction(()=>document.querySelector('#sample-status').textContent==='2 / 64');
  assert.match(await message.innerText(),/已添加 2/);
  const fill=async(id,val)=>window.locator('#'+id).fill(String(val));
  // Set boundaries with the visible waveform before applying the zone.
  const canvas=window.locator('#waveform-canvas');
  const mark=async(field,fraction)=>{
    await window.locator('#waveform-field').selectOption(field);
    await canvas.scrollIntoViewIfNeeded();
    const box=await canvas.boundingBox();
    await window.mouse.click(box.x+box.width*fraction,box.y+box.height/2);
  };
  await mark('startSeconds',0.1);
  assert(Math.abs(Number(await window.locator('#zone-loop-start').inputValue())-0.01)<0.001);
  await mark('endSeconds',0.9);
  assert(Math.abs(Number(await window.locator('#zone-loop-end').inputValue())-0.09)<0.001);
  await mark('loopStartSeconds',0.2);
  await mark('loopEndSeconds',0.8);
  for(const [id,expected] of [['zone-start',0.01],['zone-end',0.09],['zone-loop-start',0.02],['zone-loop-end',0.08]])
    assert(Math.abs(Number(await window.locator('#'+id).inputValue())-expected)<0.001, id);
  assert.match(await window.locator('#dirty-status').innerText(),/未保存/);
  await fill('zone-end',0.001);
  await mark('startSeconds',0.05);
  assert.equal(Number(await window.locator('#zone-end').inputValue()),0.001);
  assert.match(await message.innerText(),/请先修正无效的采样时间/);
  await fill('zone-end',0.09);
  await window.locator('#apply-zone').click();
  await fill('project-name','测试多采样');
  await fill('zone-name','低力度'); await fill('zone-root',60); await fill('zone-key-low',48); await fill('zone-key-high',72);
  await fill('zone-velocity-low',1); await fill('zone-velocity-high',80); await window.locator('#apply-zone').click();
  await fill('zone-end',0.001);
  await window.getByRole('option',{name:/high.wav/}).click();
  assert.match(await message.innerText(),/时间范围无效/);
  assert.equal(await window.locator('#zone-name').inputValue(),'低力度');
  assert.equal(Number(await window.locator('#zone-end').inputValue()),0.001);
  await fill('zone-start',0.01); await fill('zone-end',0.09); await fill('zone-loop-start',0.02); await fill('zone-loop-end',0.08);
  await window.locator('#apply-zone').click();
  await window.getByRole('option',{name:/high.wav/}).click();
  await fill('zone-name','高力度'); await fill('zone-root',60); await fill('zone-key-low',48); await fill('zone-key-high',72);
  await fill('zone-velocity-low',40); await fill('zone-velocity-high',127); await window.locator('#apply-zone').click();
  assert.match(await window.locator('#zone-list').innerText(),/低力度/);
  assert.match(await window.locator('#zone-list').innerText(),/高力度/);
  await window.locator('#attack').fill('0'); await window.locator('#decay').fill('100'); await window.locator('#sustain').fill('0.7'); await window.locator('#release').fill('180'); await window.locator('#gain').fill('0');
  await window.locator('#loop').check();
  await window.locator('#save-project').click();
  await message.getByText(/已取消保存/).waitFor();
  assert.match(await window.locator('#dirty-status').innerText(),/未保存/);
  await app.evaluate(({},{filePath})=>{globalThis.testSaveResult={canceled:false,filePath}}, {filePath:path.join(temp,'missing','x.json')});
  await window.locator('#save-project').click(); await message.getByText(/保存失败/).waitFor();
  assert.match(await window.locator('#dirty-status').innerText(),/未保存/);
  await app.evaluate(({},{filePath})=>{globalThis.testSaveResult={canceled:false,filePath}}, {filePath:savePath});
  await window.evaluate(()=>{ document.querySelector('#message').textContent=''; });
  await window.locator('#save-project').click(); await message.getByText('工程已保存。').waitFor();
  assert.equal(await window.locator('#dirty-status').innerText(),'已保存');
  const saved=await fs.readFile(savePath,'utf8');
  const project=parseProject(saved);
  assert.equal(project.name,'测试多采样');
  assert.deepEqual(project.parameters,{attackMs:0,decayMs:100,sustainLevel:0.7,releaseMs:180,gainDb:0,loop:true});
  assert.deepEqual((( {startSeconds,endSeconds,loopStartSeconds,loopEndSeconds} )=>({startSeconds,endSeconds,loopStartSeconds,loopEndSeconds}))(project.zones[0]),{startSeconds:0.01,endSeconds:0.09,loopStartSeconds:0.02,loopEndSeconds:0.08});
  assert.equal(project.zones.length,2);
  assert.equal(project.zones[1].endSeconds,null);
  assert.equal(project.zones[1].loopEndSeconds,null);
  assert.deepEqual(Buffer.from(project.zones[0].wavBytes),a);
  assert.deepEqual(Buffer.from(project.zones[1].wavBytes),b);
  assert.deepEqual(project.zones.map(({name,rootNote,keyLow,keyHigh,velocityLow,velocityHigh})=>({name,rootNote,keyLow,keyHigh,velocityLow,velocityHigh})),[
    {name:'低力度',rootNote:60,keyLow:48,keyHigh:72,velocityLow:1,velocityHigh:80},
    {name:'高力度',rootNote:60,keyLow:48,keyHigh:72,velocityLow:40,velocityHigh:127}]);
  const rendered=await window.evaluate(async savedText=>{
    const {SamplerEngine}=await import('./sampler.js');
    const {parseProject}=await import('./project.js');
    const p=parseProject(savedText);
    async function render(velocity,note=60){
      const ctx=new OfflineAudioContext(1,4800,48000), e=new SamplerEngine(ctx);
      const zones=[];
      for(const z of p.zones) { const buffer=await e.decodeSample(z.wavBytes); zones.push({...z,buffer,startSeconds:0,endSeconds:buffer.duration,loopStartSeconds:0,loopEndSeconds:buffer.duration}); }
      e.replaceZones(zones); e.setParameters({...p.parameters,decayMs:0,sustainLevel:1}); e.noteOn(note,velocity);
      const audio=await ctx.startRendering(); const samples=audio.getChannelData(0);
      function amplitude(freq){let c=0,s=0; for(let i=0;i<samples.length;i++){const x=2*Math.PI*freq*i/48000;c+=samples[i]*Math.cos(x);s+=samples[i]*Math.sin(x)} return 2*Math.hypot(c,s)/samples.length;}
      return [amplitude(440),amplitude(880)];
    }
    return {low:await render(20),high:await render(100),overlap:await render(60),outside:await render(60,80)};
  },saved);
  assert(rendered.low[0]>0.01 && rendered.low[1]<0.001,JSON.stringify(rendered));
  assert(rendered.high[1]>0.05 && rendered.high[0]<0.001,JSON.stringify(rendered));
  assert(rendered.overlap[0]>0.04 && rendered.overlap[1]>0.04,JSON.stringify(rendered));
  assert(rendered.outside.every(x=>x<0.00001),JSON.stringify(rendered));
  // Render real Web Audio output to verify boundaries, looping and ADSR over time.
  const synthesis=await window.evaluate(async()=>{
    const {SamplerEngine}=await import('./sampler.js');
    async function render({loop,adsr}) {
      const ctx=new OfflineAudioContext(1,12000,48000), e=new SamplerEngine(ctx);
      const buffer=ctx.createBuffer(1,24000,48000), data=buffer.getChannelData(0);
      for(let i=0;i<data.length;i++) data[i]=i<12000 ? 0.2 : 0.8;
      e.replaceZones([{id:'test',buffer,rootNote:60,keyLow:0,keyHigh:127,velocityLow:1,velocityHigh:127,startSeconds:0.25,endSeconds:0.35,loopStartSeconds:0.25,loopEndSeconds:0.3}]);
      e.setParameters({gainDb:0,loop,attackMs:adsr?40:0,decayMs:adsr?40:0,sustainLevel:adsr?0.25:1,releaseMs:40});
      e.noteOn(60,127);
      let paused;
      if(adsr) paused=ctx.suspend(0.12);
      const rendering=ctx.startRendering();
      if(adsr) { await paused; e.noteOff(60); await ctx.resume(); }
      const output=(await rendering).getChannelData(0);
      return [0.02,0.06,0.12,0.14,0.18].map(t=>output[Math.round(t*48000)]);
    }
    return {oneShot:await render({loop:false,adsr:false}),loop:await render({loop:true,adsr:false}),adsr:await render({loop:true,adsr:true})};
  });
  assert(Math.abs(synthesis.oneShot[0]-0.8)<0.02 && Math.abs(synthesis.oneShot[2])<0.001,JSON.stringify(synthesis));
  assert(synthesis.loop.every(x=>Math.abs(x-0.8)<0.02),JSON.stringify(synthesis));
  assert(Math.abs(synthesis.adsr[0]-0.4)<0.03 && Math.abs(synthesis.adsr[1]-0.5)<0.03 && Math.abs(synthesis.adsr[2]-0.2)<0.03 && Math.abs(synthesis.adsr[3]-0.1)<0.04 && Math.abs(synthesis.adsr[4])<0.001,JSON.stringify(synthesis));
  await window.locator('#new-project').click();
  assert.equal(await window.locator('#sample-status').innerText(),'0 / 64');
  await window.locator('#project-input').setInputFiles({name:'instrument.sampler.json',mimeType:'application/json',buffer:Buffer.from(saved)});
  await message.getByText('工程已打开。').waitFor();
  assert.equal(await window.locator('#sample-status').innerText(),'2 / 64');
  assert.equal(await window.locator('#project-name').inputValue(),'测试多采样');
  assert.equal(await window.locator('#zone-name').inputValue(),'低力度');
  assert.equal(await window.locator('#zone-velocity-high').inputValue(),'80');
  assert.equal(await window.locator('#release').inputValue(),'180');
  assert.equal(await window.locator('#decay').inputValue(),'100');
  assert.equal(await window.locator('#sustain').inputValue(),'0.7');
  assert.equal(Number(await window.locator('#zone-start').inputValue()),0.01);
  assert.equal(Number(await window.locator('#zone-loop-end').inputValue()),0.08);
  assert(await window.locator('#loop').isChecked());
  await window.getByRole('option',{name:/高力度/}).click();
  assert.equal(await window.locator('#zone-velocity-low').inputValue(),'40');
  await window.locator('#project-input').setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{bad')});
  await message.getByText(/打开失败，原工程未改变/).waitFor();
  assert.equal(await window.locator('#sample-status').innerText(),'2 / 64');
  assert.equal(await window.locator('#project-name').inputValue(),'测试多采样');
  assert.equal(await window.locator('#zone-name').inputValue(),'高力度');
  assert.equal(await window.locator('#dirty-status').innerText(),'已保存');
  await window.locator('#save-project').click(); await message.getByText('工程已保存。').waitFor();
  const restored = parseProject(await fs.readFile(savePath,'utf8'));
  assert.deepEqual(Buffer.from(restored.zones[0].wavBytes),a);
  assert.deepEqual(Buffer.from(restored.zones[1].wavBytes),b);
  assert.deepEqual(restored.parameters,project.parameters);
  assert.deepEqual(restored.zones.map(({wavBytes,...z})=>z),project.zones.map(({wavBytes,...z})=>z));
  const legacy=JSON.parse(saved); legacy.version=1;
  delete legacy.parameters.decayMs; delete legacy.parameters.sustainLevel;
  for(const z of legacy.zones) for(const key of ['startSeconds','endSeconds','loopStartSeconds','loopEndSeconds']) delete z[key];
  await window.evaluate(()=>{ document.querySelector('#message').textContent=''; });
  await window.locator('#project-input').setInputFiles({name:'legacy.sampler.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(legacy))});
  await message.getByText('工程已打开。').waitFor();
  assert.equal(await window.locator('#sample-status').innerText(),'2 / 64');
  assert.equal(Number(await window.locator('#zone-start').inputValue()),0);
  assert(Math.abs(Number(await window.locator('#zone-end').inputValue())-0.1)<0.001);
  assert.equal(Number(await window.locator('#decay').inputValue()),0);
  assert.equal(Number(await window.locator('#sustain').inputValue()),1);
  assert.deepEqual(errors,[]);
  console.log('PASS: batch WAV import, zone editing, save/cancel/failure and dirty state, exact sample bytes after restore, corrupt import retention, offline rendered velocity layers/overlap/keyboard range.');
  console.log('Offline frequency amplitudes:',JSON.stringify(rendered));
} finally {
  if(app) await app.close();
  assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));
  await fs.rm(temp,{recursive:true,force:true});
}
