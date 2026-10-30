// Inspect uncompressed WAV metadata before Web Audio allocates decoded PCM.
// The returned estimate covers float32 output samples, not browser decoder
// scratch space, source bytes, audio nodes, or other application memory.
export const MAX_DECODED_SAMPLE_BYTES = 128 * 1024 * 1024;
export const MAX_DECODED_TOTAL_BYTES = 256 * 1024 * 1024;

export function inspectWav(buffer, outputSampleRate) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) throw new Error('WAV 文件为空或文件头不完整');
  if (!Number.isFinite(outputSampleRate) || outputSampleRate <= 0) throw new Error('音频输出采样率无效');
  const v = new DataView(buffer), size = buffer.byteLength;
  const fourcc = (p, s) => [...s].every((ch, i) => v.getUint8(p + i) === ch.charCodeAt(0));
  if (!fourcc(0, 'RIFF') || !fourcc(8, 'WAVE')) throw new Error('仅支持 RIFF/WAVE 格式');
  const end = 8 + v.getUint32(4, true);
  if (end < 12 || end > size) throw new Error('WAV 文件长度无效');
  let pos = 12, fmt, dataLength;
  while (pos < end) {
    if (end - pos < 8) throw new Error('WAV 数据块头不完整');
    const length = v.getUint32(pos + 4, true), start = pos + 8;
    const next = start + length + (length & 1);
    if (next > end) throw new Error('WAV 数据块超出文件边界');
    if (fourcc(pos, 'fmt ')) {
      if (fmt) throw new Error('WAV 包含重复格式块');
      if (length < 16) throw new Error('WAV 格式块不完整');
      let format = v.getUint16(start, true);
      const channels = v.getUint16(start + 2, true), sampleRate = v.getUint32(start + 4, true);
      const byteRate = v.getUint32(start + 8, true), blockAlign = v.getUint16(start + 12, true), bitsPerSample = v.getUint16(start + 14, true);
      if (length === 17) throw new Error('WAV 格式扩展不完整');
      if (length >= 18 && v.getUint16(start + 16, true) > length - 18) throw new Error('WAV 格式扩展长度无效');
      if (format === 0xfffe) {
        if (length < 40 || v.getUint16(start + 16, true) < 22) throw new Error('WAV 扩展格式不完整');
        const validBits = v.getUint16(start + 18, true);
        if (!validBits || validBits > bitsPerSample) throw new Error('WAV 有效位深无效');
        // KSDATAFORMAT_SUBTYPE_PCM / IEEE_FLOAT, little-endian GUID.
        const subtype = v.getUint32(start + 24, true);
        const tail = [0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
        if (!tail.every((b, i) => v.getUint8(start + 28 + i) === b)) throw new Error('不支持的 WAV 子格式');
        format = subtype;
        if (format === 3 && validBits !== bitsPerSample) throw new Error('WAV 浮点位深无效');
      }
      if (format !== 1 && format !== 3) throw new Error('仅支持未压缩 PCM 或浮点 WAV');
      if (channels !== 1 && channels !== 2) throw new Error('仅支持单声道或双声道 WAV');
      if (sampleRate < 8000 || sampleRate > 192000) throw new Error('WAV 采样率须在 8–192 kHz');
      if (!(format === 1 ? [8, 16, 24, 32].includes(bitsPerSample) : bitsPerSample === 32)) throw new Error('不支持的 WAV 位深');
      if (blockAlign !== channels * bitsPerSample / 8 || byteRate !== sampleRate * blockAlign) throw new Error('WAV 帧大小或字节率无效');
      fmt = { format, channels, sampleRate, bitsPerSample, blockAlign };
    } else if (fourcc(pos, 'data')) {
      if (dataLength !== undefined) throw new Error('WAV 包含重复采样数据块');
      dataLength = length;
    }
    pos = next;
  }
  if (!fmt || dataLength === undefined || !dataLength) throw new Error('WAV 缺少格式或采样数据');
  if (dataLength % fmt.blockAlign) throw new Error('WAV 采样数据帧不完整');
  const frames = dataLength / fmt.blockAlign;
  // Round up and add one frame to cover resampler rounding at the endpoint.
  const outputFrames = Math.ceil(frames * outputSampleRate / fmt.sampleRate) + 1;
  const estimatedBytes = outputFrames * fmt.channels * 4;
  if (!Number.isSafeInteger(outputFrames) || !Number.isSafeInteger(estimatedBytes)) throw new Error('WAV 解码大小超出范围');
  return { estimatedBytes, frames, channels: fmt.channels, sampleRate: fmt.sampleRate, bitsPerSample: fmt.bitsPerSample, format: fmt.format };
}
