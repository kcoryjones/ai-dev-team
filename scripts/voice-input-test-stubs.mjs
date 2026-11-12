// Serialized into Chromium by addInitScript. Speech output still uses real Web
// Audio; only microphone frames, wake detection, and their timing are stubbed.
export function installVoiceInputStubs() {
  window.__tracks = [];
  window.__playbacks = 0;
  window.__sources = [];
  window.__gains = [];
  window.__micConstraints = [];
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    window.__micConstraints.push(constraints);
    const stream = await getUserMedia(constraints); window.__tracks.push(...stream.getTracks()); return stream;
  };
  const NativeAudioContext = window.AudioContext;
  window.AudioContext = class extends NativeAudioContext {
    constructor() { super(); this.audioWorklet.addModule = async () => {}; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { const gain = super.createGain(); window.__gains.push(gain); return gain; }
    createBufferSource() {
      const source = super.createBufferSource(), start = source.start.bind(source);
      source.start = (...args) => { window.__playbacks++; start(...args); };
      window.__sources.push(source); return source;
    }
  };
  window.AudioWorkletNode = class {
    epoch = 0; paused = false;
    port = { onmessage: null, close() {}, postMessage: message => { this.epoch = message.epoch; this.paused = message.paused; } };
    constructor() { window.__capture = this; } connect() {} disconnect() {}
  };
  window.Worker = class {
    constructor() { window.__wake = this; queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } })); }
    postMessage(message) {
      if (message.type === "audio") queueMicrotask(() => this.onmessage?.({ data: { type: "processed", wake: true, epoch: message.epoch } }));
    }
    terminate() { this.onmessage = null; }
  };
  window.__say = async (epoch = window.__capture.epoch) => {
    const frame = level => window.__capture.port.onmessage({ data: { samples: new Float32Array(1600).fill(level), epoch } });
    frame(0.1); await new Promise(resolve => setTimeout(resolve, 0));
    for (let n = 0; n < 5; n++) frame(0.1);
    for (let n = 0; n < 13; n++) frame(0);
  };
  window.__lateWake = epoch => window.__wake.onmessage?.({ data: { type: "processed", wake: true, epoch } });
}
