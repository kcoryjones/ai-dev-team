/* sherpa-onnx runs inside this disposable worker; every asset is served locally. */
let detector;
let stream;
self.Module = {
  locateFile: name => `/api/voice/assets/${name}`,
  print: () => {},
  printErr: () => {},
  onAbort: () => self.postMessage({ type: "error", message: "The local wake-word model could not start." }),
  onRuntimeInitialized: () => {
    try {
      // Tokenized with the English model's bundled bpe.model (not the Chinese demo defaults).
      const keywords = "▁HE Y ▁DE V ▁TEA M @HEY_DEV_TEAM\n";
      detector = createKws(self.Module, {
        featConfig: { samplingRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: "./encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
            decoder: "./decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
            joiner: "./joiner-epoch-12-avg-2-chunk-16-left-64.onnx",
          },
          tokens: "./tokens.txt", provider: "cpu", modelType: "zipformer2",
          numThreads: 1, debug: 0, modelingUnit: "bpe", bpeVocab: "",
        },
        maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 1.5, keywordsThreshold: 0.25,
        keywords: "", keywordsBuf: keywords, keywordsBufSize: new TextEncoder().encode(keywords).length,
      });
      if (!detector.handle) throw new Error("Unable to create wake-word detector.");
      stream = detector.createStream();
      self.postMessage({ type: "ready" });
    } catch {
      self.postMessage({ type: "error", message: "The local wake-word model could not start." });
    }
  },
};

self.onmessage = event => {
  if (!detector || !stream) return;
  try {
    if (event.data.type === "reset") {
      stream.free();
      stream = detector.createStream();
    } else if (event.data.type === "audio") {
      stream.acceptWaveform(16000, event.data.samples);
      let wake = false;
      while (detector.isReady(stream)) {
        detector.decode(stream);
        if (detector.getResult(stream).keyword) {
          wake = true;
          detector.reset(stream);
        }
      }
      self.postMessage({ type: "processed", wake });
    }
  } catch {
    self.postMessage({ type: "error", message: "Local wake-word detection failed. Enable voice to retry." });
  }
};

importScripts("/api/voice/assets/sherpa-onnx-kws.js", "/api/voice/assets/sherpa-onnx-wasm-kws-main.js");
