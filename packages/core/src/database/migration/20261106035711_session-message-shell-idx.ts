import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261106035711_session-message-shell-idx",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_message_session_shell_idx\` ON \`session_message\` (\`session_id\`,json_extract("data", '$.shellID')) WHERE "session_message"."type" = 'shell';`,
      )
    })
  },
}

export default migration
