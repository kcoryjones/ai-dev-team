import { ttsSpeedRange } from "@engineering-team/contracts";

export const voiceSettingsKey = "local-voice-settings:v1";
export const defaultVoiceSettings = { deviceId: "", speed: 1, volume: 1, threshold: 0.012, silenceSeconds: 1.2 };
export type VoiceSettings = typeof defaultVoiceSettings;

/** Stored preferences never enable the microphone or spoken replies. */
export function normalizeVoiceSettings(value: unknown): VoiceSettings {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const number = (key: keyof VoiceSettings, min: number, max: number) => {
    const n = input[key];
    return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max ? n : defaultVoiceSettings[key] as number;
  };
  return {
    deviceId: typeof input.deviceId === "string" && input.deviceId.length <= 512 ? input.deviceId : "",
    speed: number("speed", ttsSpeedRange.min, ttsSpeedRange.max), volume: number("volume", 0, 1),
    threshold: [0.006, 0.012, 0.024].includes(input.threshold as number) ? input.threshold as number : defaultVoiceSettings.threshold,
    silenceSeconds: [0.8, 1.2, 1.8].includes(input.silenceSeconds as number) ? input.silenceSeconds as number : defaultVoiceSettings.silenceSeconds,
  };
}

export function microphoneConstraints(deviceId: string): MediaStreamConstraints {
  return { audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
}

export function inputLevel(samples: Float32Array) {
  let sum = 0, peak = 0;
  for (const sample of samples) { sum += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return { db: Math.max(-60, Math.min(0, 20 * Math.log10(rms || 1e-6))), clipping: peak >= 0.99 };
}
