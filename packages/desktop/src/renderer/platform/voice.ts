import type { VoiceModelProgress } from "../../shared/ipc-rpc/events"
import type { Platform } from "@opencode/app/desktop"
import type { ElectronAPI } from "../api-types"

/** Local dictation rides the same bridge every other platform surface uses. */
export function createVoiceDictation(api: ElectronAPI): NonNullable<Platform["voiceDictation"]> {
  return {
    available: () => api.voiceStatus().then((status) => status.available),
    models: () =>
      api.voiceModels().then((rows) =>
        rows.map((row) => ({ id: row.id, name: row.name, languages: [...row.languages], installed: row.installed })),
      ),
    prepare: (model, language) => api.voicePrepare(model, language),
    transcribe: (audio, model, language) => api.voiceTranscribe(audio, model, language),
    onProgress: (cb) =>
      api.onVoiceModelProgress((event: VoiceModelProgress) =>
        cb({
          model: event.model,
          stage: event.stage,
          ...(event.downloadedBytes !== undefined ? { received: event.downloadedBytes } : {}),
          ...(event.totalBytes !== undefined ? { total: event.totalBytes } : {}),
        }),
      ),
  }
}
