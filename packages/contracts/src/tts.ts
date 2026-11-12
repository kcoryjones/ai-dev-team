/** Wire format shared by the local synthesis service and its browser client. */
export const ttsVoice = { id: "en_US-ljspeech-medium", name: "LJSpeech", language: "en-US", sampleRate: 22_050 } as const;
export const maxTtsTextCharacters = 2_000;
export const maxTtsRequestBytes = 16_384;
export const maxTtsAudioSeconds = 90;
export const maxTtsAudioBytes = 44 + ttsVoice.sampleRate * 2 * maxTtsAudioSeconds;
export const ttsSpeedRange = { min: 0.75, max: 1.5, default: 1 } as const;
