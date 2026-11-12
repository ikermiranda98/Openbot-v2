import { Effect } from "effect"
import { VoiceRpcs } from "../../shared/ipc-rpc"
import { VoiceEngine } from "../voice/engine"

// A failed job crosses the bridge as a defect whose message carries the engine's verdict
// (`VoiceEngine.describeError`): the one resolvable code maps onto its copy, everything else the
// renderer lands on the generic failure.
const surfaced = (error: unknown) => Effect.die(new Error(VoiceEngine.describeError(error)))

export const voiceHandlers = VoiceRpcs.toLayer(
  Effect.gen(function* () {
    return VoiceRpcs.of({
      VoiceStatus: () => Effect.promise(() => VoiceEngine.status()),
      VoiceModels: () => Effect.tryPromise(() => VoiceEngine.models()).pipe(Effect.catch(surfaced)),
      VoicePrepare: ({ model, language }) => Effect.tryPromise(() => VoiceEngine.prepare(model, language)).pipe(Effect.catch(surfaced)),
      VoiceTranscribe: ({ audio, model, language }) =>
        Effect.tryPromise(() => VoiceEngine.transcribe(audio, model, language)).pipe(Effect.catch(surfaced)),
    })
  }),
)
