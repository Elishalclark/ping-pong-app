// Transient detection, shared by the AudioWorklet and the compatibility path
// so there is only ever one copy of this logic to reason about.
//
// It reports every sharp rise above an adapting noise floor, and measures the
// sound's zero-crossing rate and decay so the caller can tell a ball's bright
// click from a racket's duller ring.

export class TransientDetector {
  constructor({ sampleRate, refractory = 0.045, tail = 1024 } = {}) {
    this.sampleRate = sampleRate;
    this.refractory = refractory;
    this.tail = tail;
    this.baseline = 1e-4;
    this.lastOnset = -1;
    this.capture = null;
  }

  /**
   * Feed one block of mono samples.
   * Returns { level } always, and { onset } on the block that completes a
   * transient's tail (a frame or two after the transient itself).
   */
  process(ch, now, { sensitivity = 4.5, gateDb = -48 } = {}) {
    let sum = 0, peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / ch.length);
    const db = 20 * Math.log10(rms + 1e-9);
    let onset = null;

    if (this.capture) {
      const c = this.capture;
      for (let i = 0; i < ch.length && c.n < c.buf.length; i++) c.buf[c.n++] = ch[i];
      if (c.n >= c.buf.length) { onset = this._describe(c); this.capture = null; }
    } else if (db > gateDb && rms > this.baseline * sensitivity &&
               now - this.lastOnset > this.refractory) {
      this.lastOnset = now;
      this.capture = { t: now, db, peak, ratio: rms / (this.baseline + 1e-9), buf: new Float32Array(this.tail), n: 0 };
      for (let i = 0; i < ch.length && this.capture.n < this.tail; i++) this.capture.buf[this.capture.n++] = ch[i];
    }

    // The floor rises slowly and falls quickly, so a loud rally doesn't
    // gradually deafen the detector to the next bounce.
    this.baseline += (rms - this.baseline) * (rms > this.baseline ? 0.0008 : 0.02);

    return { level: { db, rms, baseline: this.baseline, t: now }, onset };
  }

  _describe(c) {
    const b = c.buf;
    let crossings = 0, peak = 0, peakIdx = 0;
    for (let i = 1; i < b.length; i++) {
      if ((b[i - 1] <= 0 && b[i] > 0) || (b[i - 1] >= 0 && b[i] < 0)) crossings++;
      const a = Math.abs(b[i]);
      if (a > peak) { peak = a; peakIdx = i; }
    }
    const zcr = (crossings * this.sampleRate) / b.length / 2; // ~dominant frequency
    let decay = b.length - peakIdx;
    const floor = peak * 0.1;
    for (let i = peakIdx; i < b.length; i++) {
      if (Math.abs(b[i]) < floor) { decay = i - peakIdx; break; }
    }
    return { t: c.t, db: c.db, peak, ratio: c.ratio, zcr, decayMs: (decay / this.sampleRate) * 1000 };
  }
}
