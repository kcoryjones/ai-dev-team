// Test-only audio source. Everything after getUserMedia (including the actual
// AudioWorklet, resampler, WASM wake worker and HTTP services) remains real.
// This does not measure device permissions, hardware echo cancellation, or room acoustics.
export function installControlledMicrophone() {
  const NativeContext = window.AudioContext;
  const createSource = NativeContext.prototype.createBufferSource;
  const inputs = [];
  window.__voiceTracks = [];
  window.__voicePlaybacks = [];
  window.__voiceEchoCopies = 0;
  window.__voiceEcho = true;
  let input, echoControl;
  const rawSource = (context, buffer, destination) => {
    const source = createSource.call(context); source.buffer = buffer; source.connect(destination); return source;
  };
  navigator.mediaDevices.getUserMedia = async () => {
    const context = new NativeContext();
    await context.resume();
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    // Keep a live silent input between recordings, as a physical microphone
    // does. Firefox otherwise stops delivering frames once a source ends.
    const silence = context.createConstantSource(); silence.offset.value = 0; silence.connect(destination); silence.start();
    input = { context, destination, silence }; inputs.push(input);
    window.__voiceTracks.push(...destination.stream.getTracks());
    return destination.stream;
  };
  NativeContext.prototype.createBufferSource = function () {
    const source = createSource.call(this), start = source.start.bind(source), stop = source.stop.bind(source);
    let echo, delay, record;
    source.start = (...args) => {
      record = { startedAt: performance.now(), duration: source.buffer.duration, endedAt: null, stoppedAt: null };
      window.__voicePlaybacks.push(record);
      start(...args);
      if (window.__voiceEcho && input?.destination.stream.getAudioTracks()[0]?.readyState === "live") {
        // Full-volume digital feedback plus a 120 ms tail deliberately tests
        // the pause/reset mechanism without relying on acoustic cancellation.
        delay = input.context.createDelay(1); delay.delayTime.value = 0.12; delay.connect(input.destination);
        echo = rawSource(input.context, echoControl ?? source.buffer, delay); echo.start();
        window.__voiceEchoCopies++;
      }
    };
    source.stop = (...args) => {
      if (record) record.stoppedAt = performance.now();
      try { echo?.stop(); } catch { /* Already ended. */ }
      stop(...args);
    };
    source.addEventListener("ended", () => {
      if (record) record.endedAt = performance.now();
      setTimeout(() => { echo?.disconnect(); delay?.disconnect(); }, 150);
    });
    return source;
  };
  async function feed(buffer, noiseRms = 0) {
    if (!input) throw new Error("Enable the microphone first.");
    const copy = input.context.createBuffer(1, buffer.length, buffer.sampleRate);
    const data = copy.getChannelData(0), original = buffer.getChannelData(0);
    let seed = 123456;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = Math.max(-1, Math.min(1, original[i] + (seed / 2 ** 32 * 2 - 1) * noiseRms * Math.sqrt(3)));
    }
    const source = rawSource(input.context, copy, input.destination);
    source.addEventListener("ended", () => source.disconnect()); source.start();
    return { duration: buffer.duration, sampleRate: input.context.sampleRate };
  }
  window.__feedVoice = async (base64, noiseRms = 0) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    return feed(await input.context.decodeAudioData(bytes.buffer), noiseRms);
  };
  window.__setEchoControl = async base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    echoControl = await input.context.decodeAudioData(bytes.buffer);
  };
  window.__closeVoiceInputs = async () => {
    for (const { context, destination, silence } of inputs) {
      silence.stop(); silence.disconnect(); destination.stream.getTracks().forEach(track => track.stop()); await context.close();
    }
  };
}
