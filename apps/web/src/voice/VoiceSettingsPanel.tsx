import { ttsSpeedRange, ttsVoice } from "@engineering-team/contracts";
import type { MicrophoneInfo } from "./LocalVoiceSession";
import type { useVoiceSettings } from "./useVoiceSettings";

export function VoiceSettingsPanel({ controls, microphoneOn, microphone, level }: {
  controls: ReturnType<typeof useVoiceSettings>; microphoneOn: boolean; microphone: MicrophoneInfo | null;
  level: { db: number; clipping: boolean } | null;
}) {
  const { settings, devices, deviceError, update } = controls;
  return <details className="voice-settings">
    <summary>Voice settings</summary>
    <div className="voice-settings-grid">
      <label>Microphone <select aria-label="Microphone" value={settings.deviceId} disabled={microphoneOn} onChange={event => update({ deviceId: event.target.value })}>
        <option value="">System default</option>
        {settings.deviceId && !devices.some(device => device.deviceId === settings.deviceId) && <option value={settings.deviceId}>Saved microphone (not currently listed)</option>}
        {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
      </select></label>
      <label>Pause to finish <select aria-label="Pause to finish" value={settings.silenceSeconds} disabled={microphoneOn} onChange={event => update({ silenceSeconds: Number(event.target.value) })}>
        <option value={0.8}>Short — 0.8 seconds</option><option value={1.2}>Normal — 1.2 seconds</option><option value={1.8}>Long — 1.8 seconds</option>
      </select></label>
      <label>Speech sensitivity <select aria-label="Speech sensitivity" value={settings.threshold} disabled={microphoneOn} onChange={event => update({ threshold: Number(event.target.value) })}>
        <option value={0.006}>High — quiet speech</option><option value={0.012}>Normal</option><option value={0.024}>Low — more background noise</option>
      </select></label>
      <label>Speaking speed <input aria-label="Speaking speed" type="range" min={ttsSpeedRange.min} max={ttsSpeedRange.max} step={0.05} value={settings.speed} onChange={event => update({ speed: Number(event.target.value) })} />
        <span>{settings.speed.toFixed(2)}× · next reply or replay</span></label>
      <label>Reply volume <input aria-label="Reply volume" type="range" min={0} max={1} step={0.05} value={settings.volume} onChange={event => update({ volume: Number(event.target.value) })} />
        <span>{Math.round(settings.volume * 100)}%{settings.volume === 0 ? " · muted" : ""}</span></label>
    </div>
    <p>Turn off the microphone to change capture settings. Device names appear after microphone permission. Sensitivity affects when your request finishes; the wake phrase stays “Hey Dev Team”.</p>
    {deviceError && <p className="voice-error" role="alert">{deviceError}</p>}
    <p>Reply voice: {ttsVoice.name} · English (US). One local voice is installed and shared by all agents.</p>
    <div className="voice-input-diagnostics" aria-label="Microphone diagnostics">
      <label>Input level <meter aria-label="Microphone input level" min={-60} max={0} value={level?.db ?? -60} /></label>
      <span>{level ? `${Math.round(level.db)} dBFS${level.clipping ? " · clipping — move away or lower microphone gain" : ""}` : "Meter active while listening"}</span>
      {microphone && <span>{microphone.label} · {(microphone.sampleRate / 1000).toFixed(1)} kHz capture · {microphone.channels ?? "unknown"} input channel(s), mixed to mono</span>}
    </div>
    <p>Try Normal first. If requests cut off, choose a longer pause. If background noise prevents finishing, try Low sensitivity or move closer to the microphone. Preferences stay in this browser; listening and spoken replies still require enabling.</p>
  </details>;
}
