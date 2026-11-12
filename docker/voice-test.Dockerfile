# Test-only browser image. A virtual output lets Firefox/WebKit run real Web
# Audio in a headless Linux container; it does not simulate physical acoustics.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
RUN apt-get update && apt-get install --yes --no-install-recommends pulseaudio \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 docker/voice-test-entrypoint.sh /usr/local/bin/voice-test-entrypoint
ENTRYPOINT ["/usr/local/bin/voice-test-entrypoint"]
