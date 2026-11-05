# syntax=docker/dockerfile:1.7

# Build once; the resulting browser detector makes no external requests.
FROM emscripten/emsdk:4.0.23 AS wake-build
WORKDIR /src
ADD --checksum=sha256:24ecc0fccf6344c2556e7c229c849e9f61bf9456b915615197d85f35e3f177e7 https://codeload.github.com/k2-fsa/sherpa-onnx/tar.gz/refs/tags/v2.0.1 /tmp/sherpa.tar.gz
ADD --checksum=sha256:f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2 /tmp/kws.tar.bz2
RUN tar -xzf /tmp/sherpa.tar.gz --strip-components=1 \
    && mkdir /tmp/kws \
    && tar -xjf /tmp/kws.tar.bz2 -C /tmp/kws --strip-components=1 \
    && cp /tmp/kws/*-64.onnx /tmp/kws/tokens.txt wasm/kws/assets/ \
    && ./build-wasm-simd-kws.sh

FROM debian:bookworm-slim AS speech-build
RUN apt-get update && apt-get install --yes --no-install-recommends build-essential cmake ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
ADD --checksum=sha256:ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720 https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.9.5 /tmp/whisper.tar.gz
RUN tar -xzf /tmp/whisper.tar.gz --strip-components=1 \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=ON \
    && cmake --build build --config Release --target whisper-server -j 4

FROM debian:bookworm-slim AS speech
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=speech-build /src/build/bin/whisper-server /usr/local/bin/whisper-server
COPY --from=wake-build /src/build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-kws.js /wake/
COPY --from=wake-build /src/build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-wasm-kws-main.* /wake/
COPY --from=wake-build /src/LICENSE /wake/SHERPA-LICENSE
COPY --from=speech-build /src/LICENSE /wake/WHISPER-LICENSE
COPY --chmod=755 docker/download-speech-model.sh /usr/local/bin/download-speech-model
USER 65534:65534
EXPOSE 4320
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=5 CMD curl --fail --silent http://127.0.0.1:4320/health || exit 1
ENTRYPOINT ["whisper-server"]
CMD ["--host", "0.0.0.0", "--port", "4320", "--model", "/models/ggml-base.en.bin", "--public", "/wake", "--threads", "4", "--language", "en", "--no-gpu", "--suppress-nst"]
