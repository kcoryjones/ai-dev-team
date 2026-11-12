import { useCallback, useEffect, useState } from "react";
import { normalizeVoiceSettings, voiceSettingsKey, type VoiceSettings } from "./voiceSettings";

export function useVoiceSettings() {
  const [settings, setSettings] = useState(() => {
    try { return normalizeVoiceSettings(JSON.parse(localStorage.getItem(voiceSettingsKey) ?? "null")); }
    catch { return normalizeVoiceSettings(null); }
  });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceError, setDeviceError] = useState("");
  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setDevices(devices.filter(device => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default"));
      setDeviceError("");
    } catch { setDeviceError("Unable to list microphones. You can still try System default."); }
  }, []);
  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, [refresh]);
  return { settings, devices, deviceError, refresh, update(patch: Partial<VoiceSettings>) {
    setSettings(current => {
      const next = normalizeVoiceSettings({ ...current, ...patch });
      try { localStorage.setItem(voiceSettingsKey, JSON.stringify(next)); } catch { /* Preferences still work for this page. */ }
      return next;
    });
  } };
}
