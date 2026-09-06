// AudioWorklet wrapper around the shared transient detector.
//
// Running on the audio thread means a bounce is timestamped from the sample
// clock, in 128-sample blocks (~2.7 ms), instead of whenever the main thread
// next gets a turn — which on a busy phone can be tens of milliseconds late.

import { TransientDetector } from './detector.js';

class OnsetProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sensitivity', defaultValue: 4.5, minValue: 1, maxValue: 20 },
      { name: 'gateDb', defaultValue: -48, minValue: -90, maxValue: -10 },
    ];
  }

  constructor() {
    super();
    this.det = new TransientDetector({ sampleRate });
  }

  process(inputs, _outputs, params) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    const { level, onset } = this.det.process(ch, currentTime, {
      sensitivity: params.sensitivity[0],
      gateDb: params.gateDb[0],
    });
    if (onset) this.port.postMessage({ type: 'onset', ...onset });
    this.port.postMessage({ type: 'level', ...level });
    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
