import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261101141553_trading-mt5-bridge",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`trading_link\` ADD \`mt5_login\` integer;`)
      yield* tx.run(`ALTER TABLE \`trading_link\` ADD \`mt5_server\` text;`)
    })
  },
}

export default migration
