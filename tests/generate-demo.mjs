import fs from 'node:fs';
const sr = 48000, seconds = 2, count = sr * seconds, data = Buffer.alloc(44 + count * 2);
data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(count * 2, 40);
for (let i=0; i<count; i++) { const t=i/sr; const a=Math.min(1,t/0.008)*Math.exp(-2.2*t)*Math.min(1,(seconds-t)/0.05); const s=(Math.sin(2*Math.PI*261.6256*t)+0.30*Math.sin(2*Math.PI*523.2512*t)+0.12*Math.sin(2*Math.PI*784.8768*t))*a*0.48; data.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(s*32767))),44+i*2); }
fs.mkdirSync('示例素材',{recursive:true}); fs.writeFileSync('示例素材/示例-C4.wav',data);
