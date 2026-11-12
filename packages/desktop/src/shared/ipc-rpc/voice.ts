import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Transferable } from "effect/workers"

export const VoiceModelRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  installed: Schema.Boolean,
  verified: Schema.Boolean,
  managed: Schema.Boolean,
  downloadBytes: Schema.NullOr(Schema.Number),
  languages: Schema.Array(Schema.String),
  supportsLanguageDetection: Schema.Boolean,
  source: Schema.NullOr(Schema.String),
})

export type VoiceModelRow = Schema.Schema.Type<typeof VoiceModelRow>

export const VoiceStatus = Rpc.make("VoiceStatus", {
  success: Schema.Struct({
    available: Schema.Boolean,
    reason: Schema.optionalKey(Schema.Literals(["platform", "helper", "pin"])),
    version: Schema.optionalKey(Schema.String),
  }),
})

export const VoiceModels = Rpc.make("VoiceModels", { success: Schema.Array(VoiceModelRow) })

export const VoicePrepare = Rpc.make("VoicePrepare", {
  payload: { model: Schema.String, language: Schema.optionalKey(Schema.String) },
})

export const VoiceTranscribe = Rpc.make("VoiceTranscribe", {
  payload: {
    audio: Transferable.Uint8Array,
    model: Schema.String,
    language: Schema.optionalKey(Schema.String),
  },
  success: Schema.Struct({ transcript: Schema.String, durationMs: Schema.Number }),
})

export const VoiceRpcs = RpcGroup.make(VoiceStatus, VoiceModels, VoicePrepare, VoiceTranscribe)
