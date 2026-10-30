// The overview samples a bounded number of points rather than scanning long files.
// It is a visual approximation; playback always uses the original AudioBuffer.
const MAX_COLUMNS = 640;
const MAX_POINTS_PER_COLUMN = 64;
const FIELDS = ['startSeconds', 'endSeconds', 'loopStartSeconds', 'loopEndSeconds'];

export function validRanges(r, duration) {
  return !!r && Number.isFinite(duration) && duration > 0 && FIELDS.every(key => Number.isFinite(r[key])) &&
    0 <= r.startSeconds && r.startSeconds <= r.loopStartSeconds &&
    r.loopStartSeconds < r.loopEndSeconds && r.loopEndSeconds <= r.endSeconds && r.endSeconds <= duration;
}

export function adjustRanges(field, value, r, duration, sampleRate) {
  if (!FIELDS.includes(field) || !Number.isFinite(value) || !validRanges(r, duration)) return null;
  const span = r.endSeconds - r.startSeconds;
  const sampleDuration = Number.isFinite(sampleRate) && sampleRate > 0 ? 1 / sampleRate : span;
  const next = { ...r };
  let min, max;
  switch (field) {
    case 'startSeconds':
      min = 0; max = r.endSeconds - Math.min(sampleDuration, r.endSeconds / 2);
      next.startSeconds = Math.max(min, Math.min(max, value));
      if (next.startSeconds >= r.loopEndSeconds) {
        next.loopStartSeconds = next.startSeconds;
        next.loopEndSeconds = next.startSeconds + Math.min(sampleDuration, (r.endSeconds - next.startSeconds) / 2);
      } else next.loopStartSeconds = Math.max(r.loopStartSeconds, next.startSeconds);
      break;
    case 'endSeconds':
      min = r.startSeconds + Math.min(sampleDuration, (duration - r.startSeconds) / 2); max = duration;
      next.endSeconds = Math.max(min, Math.min(max, value));
      if (next.endSeconds <= r.loopStartSeconds) {
        next.loopEndSeconds = next.endSeconds;
        next.loopStartSeconds = next.endSeconds - Math.min(sampleDuration, (next.endSeconds - r.startSeconds) / 2);
      } else next.loopEndSeconds = Math.min(r.loopEndSeconds, next.endSeconds);
      break;
    case 'loopStartSeconds': min = r.startSeconds; max = r.loopEndSeconds - Math.min(sampleDuration, (r.loopEndSeconds - r.loopStartSeconds) / 2); break;
    case 'loopEndSeconds': max = r.endSeconds; min = r.loopStartSeconds + Math.min(sampleDuration, (r.loopEndSeconds - r.loopStartSeconds) / 2); break;
  }
  // Avoid creating an invalid span when floating-point precision is exhausted.
  if (field === 'loopStartSeconds' || field === 'loopEndSeconds') next[field] = Math.max(min, Math.min(max, value));
  return min <= max && validRanges(next, duration) ? next : { ...r };
}

export function computePeaks(buffer) {
  const length = buffer.length;
  const count = Math.min(MAX_COLUMNS, length);
  const peaks = new Float32Array(count * 2);
  const channels = Array.from({length: Math.min(2, buffer.numberOfChannels)}, (_, i) => buffer.getChannelData(i));
  for (let bin = 0; bin < count; bin++) {
    const from = Math.floor(bin * length / count), to = Math.floor((bin + 1) * length / count);
    const points = Math.min(MAX_POINTS_PER_COLUMN, to - from);
    let low = 0, high = 0;
    for (let point = 0; point < points; point++) {
      const index = from + Math.floor(point * (to - from) / points);
      for (const channel of channels) {
        const value = Number.isFinite(channel[index]) ? Math.max(-1, Math.min(1, channel[index])) : 0;
        low = Math.min(low, value); high = Math.max(high, value);
      }
    }
    peaks[bin * 2] = low; peaks[bin * 2 + 1] = high;
  }
  return peaks;
}

export class WaveformView {
  constructor(canvas, field, onChange) {
    this.canvas = canvas; this.field = field; this.onChange = onChange;
    this.zone = null; this.peaks = null; this.peakCache = new WeakMap(); this.pointer = null;
    canvas.addEventListener('pointerdown', event => {
      if (!this.zone || this.field.matches(':disabled') || event.button !== 0) return;
      event.preventDefault(); this.pointer = event.pointerId;
      canvas.setPointerCapture(event.pointerId); this.move(event);
    });
    canvas.addEventListener('pointermove', event => { if (this.pointer === event.pointerId) this.move(event); });
    const end = event => { if (this.pointer === event.pointerId) this.pointer = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('lostpointercapture', end);
    field.addEventListener('change', () => this.draw());
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(canvas);
    }
    this.draw();
  }

  setZone(zone) {
    if (!zone || !zone.buffer || !validRanges(zone, zone.buffer.duration)) {
      this.zone = null; this.peaks = null; this.field.disabled = true; this.draw(); return;
    }
    this.zone = {buffer: zone.buffer, ...Object.fromEntries(FIELDS.map(key => [key, zone[key]]))};
    this.field.disabled = false;
    if (!this.peakCache.has(zone.buffer)) this.peakCache.set(zone.buffer, computePeaks(zone.buffer));
    this.peaks = this.peakCache.get(zone.buffer);
    this.draw();
  }

  setRanges(ranges) {
    if (!this.zone || !validRanges(ranges, this.zone.buffer.duration)) return false;
    for (const field of FIELDS) this.zone[field] = ranges[field];
    this.draw(); return true;
  }

  move(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !this.zone) return;
    const time = (event.clientX - rect.left) / rect.width * this.zone.buffer.duration;
    const field = this.field.value;
    const ranges = adjustRanges(field, time, this.zone, this.zone.buffer.duration, this.zone.buffer.sampleRate);
    if (!ranges || FIELDS.every(key => ranges[key] === this.zone[key])) return;
    const previous = Object.fromEntries(FIELDS.map(key => [key, this.zone[key]]));
    this.setRanges(ranges);
    if (this.onChange(Object.fromEntries(FIELDS.map(key => [key, ranges[key]]))) === false) this.setRanges(previous);
  }

  draw() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    const c = this.canvas.getContext('2d'); if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, width, height);
    if (!this.zone) {
      c.fillStyle = '#91a49a'; c.font = '12px sans-serif'; c.textAlign = 'center';
      c.fillText('选择或添加采样后显示波形', width / 2, height / 2); return;
    }
    const z = this.zone, x = value => width * value / z.buffer.duration;
    c.fillStyle = '#e4f0e3'; c.fillRect(x(z.startSeconds), 0, x(z.endSeconds) - x(z.startSeconds), height);
    c.fillStyle = '#f7e9cb'; c.fillRect(x(z.loopStartSeconds), 0, x(z.loopEndSeconds) - x(z.loopStartSeconds), height);
    c.strokeStyle = '#629474'; c.lineWidth = 1; c.beginPath();
    const count = this.peaks.length / 2, mid = height / 2, amplitude = height * .40;
    for (let i = 0; i < count; i++) {
      const px = (i + .5) * width / count;
      c.moveTo(px, mid - this.peaks[i * 2 + 1] * amplitude);
      c.lineTo(px, mid - this.peaks[i * 2] * amplitude);
    }
    c.stroke();
    for (const name of FIELDS) {
      c.strokeStyle = name.startsWith('loop') ? '#c18a38' : '#467959';
      c.lineWidth = name === this.field.value ? 3 : 1;
      c.beginPath(); c.moveTo(x(z[name]), 0); c.lineTo(x(z[name]), height); c.stroke();
    }
    c.font = '10px sans-serif'; c.fillStyle = '#617b6c'; c.textAlign = 'left'; c.fillText('0 s', 6, height - 6);
    c.textAlign = 'right'; c.fillText(`${z.buffer.duration.toFixed(2)} s`, width - 6, height - 6);
  }
}
