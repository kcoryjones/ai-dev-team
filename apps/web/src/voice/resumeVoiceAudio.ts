/** Some desktop audio backends leave resume() pending when no output device is
 * available. Do not leave microphone startup stuck or acquire tracks afterward. */
export async function resumeVoiceAudio(context: Pick<AudioContext, "resume" | "state">, signal: AbortSignal, timeoutMs = 5000) {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => reject(new Error("Microphone audio did not start. Check your browser's audio permissions and output device, then enable voice again.")), timeoutMs);
    });
    await Promise.race([context.resume(), interrupted]);
    signal.throwIfAborted();
    if (context.state !== "running") throw new Error("Microphone audio is unavailable. Check your audio device, then enable voice again.");
  } finally { clearTimeout(timer); if (cancel) signal.removeEventListener("abort", cancel); }
}
