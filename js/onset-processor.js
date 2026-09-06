// AudioWorklet: transient (onset) detector.
//
// Runs on the audio thread in 128-sample blocks, so a bounce is timestamped to
// within ~2.7 ms rather than to the nearest animation frame. It reports every
// transient it finds; deciding whether a transient was the ball hitting the
// table is the main thread's job.

const BLOCK = 128;

class OnsetProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sensitivity', defaultValue: 4.5, minValue: 1, maxValue: 20 },
      { name: 'gateDb', defaultValue: -48, minValue: -90, maxValue: -10 },
    ];
  }

  constructor() {
    super();
    this.baseline = 1e-4;      // slow-moving noise floor (RMS)
    this.lastOnset = -1;
    this.refractory = 0.045;   // s — two table bounces can't be closer than this
    this.capture = null;       // post-onset sample window being collected
    this.prevSample = 0;
  }

  process(inputs, _outputs, params) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch = input[0];
    if (!ch) return true;

    let sum = 0, peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / ch.length);

    // Collect the tail of a detected transient to measure its brightness.
    if (this.capture) {
      const c = this.capture;
      for (let i = 0; i < ch.length && c.n < c.buf.length; i++) c.buf[c.n++] = ch[i];
      if (c.n >= c.buf.length) {
        this.port.postMessage({ type: 'onset', ...this._describe(c) });
        this.capture = null;
      }
    }

    const sens = params.sensitivity[0];
    const gate = params.gateDb[0];
    const db = 20 * Math.log10(rms + 1e-9);

    if (!this.capture && db > gate && rms > this.baseline * sens &&
        currentTime - this.lastOnset > this.refractory) {
      this.lastOnset = currentTime;
      this.capture = {
        t: currentTime,
        db,
        peak,
        ratio: rms / (this.baseline + 1e-9),
        buf: new Float32Array(1024),
        n: 0,
      };
      for (let i = 0; i < ch.length && this.capture.n < 1024; i++) this.capture.buf[this.capture.n++] = ch[i];
    }

    // Adapt the floor only while nothing is transient, and let it rise slowly
    // and fall quickly so a loud rally doesn't deafen the detector.
    const rate = rms > this.baseline ? 0.0008 : 0.02;
    this.baseline += (rms - this.baseline) * rate;

    this.port.postMessage({ type: 'level', db, rms, baseline: this.baseline, t: currentTime });
    return true;
  }

  // Zero-crossing rate and decay time separate a bright click (ball on table)
  // from a duller, longer thud (paddle, body, floor).
  _describe(c) {
    const b = c.buf;
    let crossings = 0, peak = 0, peakIdx = 0;
    for (let i = 1; i < b.length; i++) {
      if ((b[i - 1] <= 0 && b[i] > 0) || (b[i - 1] >= 0 && b[i] < 0)) crossings++;
      const a = Math.abs(b[i]);
      if (a > peak) { peak = a; peakIdx = i; }
    }
    const zcr = (crossings * sampleRate) / b.length / 2; // ~dominant frequency
    let decay = b.length - peakIdx;
    const floor = peak * 0.1;
    for (let i = peakIdx; i < b.length; i++) {
      if (Math.abs(b[i]) < floor) { decay = i - peakIdx; break; }
    }
    return { t: c.t, db: c.db, peak, ratio: c.ratio, zcr, decayMs: (decay / sampleRate) * 1000 };
  }
}

registerProcessor('onset-processor', OnsetProcessor);
