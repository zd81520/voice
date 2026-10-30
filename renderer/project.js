// Portable instruments embed each original WAV. Decoding/format checks belong
// to the audio engine, so parsing never replaces a currently loaded instrument.
export const PROJECT_LIMITS = Object.freeze({
  zones: 64, sampleBytes: 32 * 1024 * 1024,
  totalSampleBytes: 40 * 1024 * 1024, jsonBytes: 64 * 1024 * 1024,
});
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const enc = new TextEncoder();

function fields(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== expected.length || expected.some(k => !Object.hasOwn(value, k))) {
    throw new Error(`${label}字段无效`);
  }
}
function label(value, what, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${what}无效`);
}
function params(value, version) {
  const base = version === 1 ? ['attackMs', 'releaseMs', 'gainDb', 'loop'] :
    ['attackMs', 'decayMs', 'sustainLevel', 'releaseMs', 'gainDb', 'loop'];
  fields(value, version === 3 ? [...base, 'filterEnabled', 'filterCutoffHz', 'filterQ'] : base, '声音设置');
  if (!Number.isFinite(value.attackMs) || value.attackMs < 0 || value.attackMs > 10000 ||
      (version !== 1 && (!Number.isFinite(value.decayMs) || value.decayMs < 0 || value.decayMs > 10000 ||
        !Number.isFinite(value.sustainLevel) || value.sustainLevel < 0 || value.sustainLevel > 1)) ||
      !Number.isFinite(value.releaseMs) || value.releaseMs < 0 || value.releaseMs > 10000 ||
      !Number.isFinite(value.gainDb) || value.gainDb < -96 || value.gainDb > 12 || typeof value.loop !== 'boolean' ||
      (version === 3 && (typeof value.filterEnabled !== 'boolean' ||
        !Number.isFinite(value.filterCutoffHz) || value.filterCutoffHz < 20 || value.filterCutoffHz > 20000 ||
        !Number.isFinite(value.filterQ) || value.filterQ < 0.1 || value.filterQ > 20))) {
    throw new Error('声音设置超出范围');
  }
  return { ...value, ...(version === 1 ? { decayMs: 0, sustainLevel: 1 } : {}),
    ...(version < 3 ? { filterEnabled: false, filterCutoffHz: 12000, filterQ: 0.7 } : {}) };
}
function metadata(z, ids, binaryKey, version) {
  const baseFields = ['id', 'name', 'rootNote', 'keyLow', 'keyHigh', 'velocityLow', 'velocityHigh', binaryKey];
  fields(z, version === 1 ? baseFields : [...baseFields, 'startSeconds', 'endSeconds', 'loopStartSeconds', 'loopEndSeconds'], '采样区');
  label(z.id, '采样区 ID', 128); label(z.name, '采样名称');
  if (ids.has(z.id)) throw new Error('采样区 ID 重复');
  ids.add(z.id);
  for (const k of ['rootNote', 'keyLow', 'keyHigh']) {
    if (!Number.isInteger(z[k]) || z[k] < 0 || z[k] > 127) throw new Error('采样区音高无效');
  }
  for (const k of ['velocityLow', 'velocityHigh']) {
    if (!Number.isInteger(z[k]) || z[k] < 1 || z[k] > 127) throw new Error('采样区力度无效');
  }
  if (z.keyLow > z.keyHigh || z.velocityLow > z.velocityHigh) throw new Error('采样区范围无效');
  // A null end follows the decoded sample's end. Its actual duration depends
  // on the playback device's sample rate and is checked by the audio engine.
  if (version !== 1 &&
      (!Number.isFinite(z.startSeconds) || (z.endSeconds !== null && !Number.isFinite(z.endSeconds)) ||
       !Number.isFinite(z.loopStartSeconds) || (z.loopEndSeconds !== null && !Number.isFinite(z.loopEndSeconds)) ||
       z.startSeconds < 0 || (z.endSeconds !== null && z.startSeconds >= z.endSeconds) ||
       z.loopStartSeconds < z.startSeconds ||
       (z.loopEndSeconds !== null && z.loopStartSeconds >= z.loopEndSeconds) ||
       (z.endSeconds !== null && (z.loopStartSeconds >= z.endSeconds ||
         (z.loopEndSeconds !== null && z.loopEndSeconds > z.endSeconds))))) throw new Error('采样播放或循环范围无效');
  return { id: z.id, name: z.name, rootNote: z.rootNote, keyLow: z.keyLow, keyHigh: z.keyHigh, velocityLow: z.velocityLow, velocityHigh: z.velocityHigh,
    startSeconds: version === 1 ? 0 : z.startSeconds,
    endSeconds: version === 1 ? null : z.endSeconds,
    loopStartSeconds: version === 1 ? 0 : z.loopStartSeconds,
    loopEndSeconds: version === 1 ? null : z.loopEndSeconds };
}
function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function base64Length(str) {
  if (typeof str !== 'string' || !str.length || str.length % 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(str)) throw new Error('采样数据编码无效');
  const pad = str.endsWith('==') ? 2 : str.endsWith('=') ? 1 : 0;
  if ((pad === 2 && (alphabet.indexOf(str[str.length - 3]) & 15)) ||
      (pad === 1 && (alphabet.indexOf(str[str.length - 2]) & 3))) throw new Error('采样数据编码无效');
  return str.length / 4 * 3 - pad;
}
function decode(str, length) {
  const binary = atob(str);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function checkLength(length, total) {
  if (!length || length > PROJECT_LIMITS.sampleBytes) throw new Error('单个采样为空或超过 32 MiB');
  if (total > PROJECT_LIMITS.totalSampleBytes) throw new Error('采样总大小超过 40 MiB');
}
function checkText(text) {
  if (typeof text !== 'string' || text.length > PROJECT_LIMITS.jsonBytes || enc.encode(text).byteLength > PROJECT_LIMITS.jsonBytes) throw new Error('工程文件无效或超过 64 MiB');
}

export function serializeProject(project) {
  fields(project, ['name', 'parameters', 'zones'], '工程');
  label(project.name, '工程名称');
  const parameters = params(project.parameters, 3);
  if (!Array.isArray(project.zones) || project.zones.length > PROJECT_LIMITS.zones) throw new Error('采样区数量无效');
  const ids = new Set(); let total = 0;
  const zones = project.zones.map(z => {
    const info = metadata(z, ids, 'wavBytes', 3);
    if (!(z.wavBytes instanceof ArrayBuffer)) throw new Error('采样数据无效');
    total += z.wavBytes.byteLength; checkLength(z.wavBytes.byteLength, total);
    return { ...info, wavBase64: bytesToBase64(z.wavBytes) };
  });
  const text = JSON.stringify({ version: 3, name: project.name, parameters, zones });
  checkText(text);
  return text;
}

export function parseProject(text) {
  checkText(text);
  let source;
  try { source = JSON.parse(text); } catch { throw new Error('工程文件不是有效 JSON'); }
  fields(source, ['version', 'name', 'parameters', 'zones'], '工程');
  if (source.version !== 1 && source.version !== 2 && source.version !== 3) throw new Error('不支持的工程版本');
  label(source.name, '工程名称');
  const parameters = params(source.parameters, source.version);
  if (!Array.isArray(source.zones) || source.zones.length > PROJECT_LIMITS.zones) throw new Error('采样区数量无效');
  const ids = new Set(); let total = 0;
  // Check all metadata and aggregate sizes before allocating decoded WAV buffers.
  const validated = source.zones.map(z => {
    const info = metadata(z, ids, 'wavBase64', source.version);
    const length = base64Length(z.wavBase64);
    total += length; checkLength(length, total);
    return { info, encoded: z.wavBase64, length };
  });
  const zones = validated.map(z => ({ ...z.info, wavBytes: decode(z.encoded, z.length) }));
  return { name: source.name, parameters, zones };
}
