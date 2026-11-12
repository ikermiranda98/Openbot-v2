import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261101013536_trading-link-broker",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`trading_link\` ADD \`broker\` text DEFAULT 'ibkr' NOT NULL;`)
    })
  },
}

export default migration
