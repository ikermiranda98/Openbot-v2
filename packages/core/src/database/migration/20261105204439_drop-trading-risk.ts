import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261105204439_drop-trading-risk",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE \`trading_risk\`;`)
    })
  },
}

export default migration
