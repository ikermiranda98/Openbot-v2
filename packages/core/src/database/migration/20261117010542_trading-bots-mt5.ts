import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261117010542_trading-bots-mt5",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`trading_bot_fill\` (
          \`id\` text PRIMARY KEY,
          \`system\` text NOT NULL,
          \`time\` integer NOT NULL,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`trading_bot_order\` (
          \`id\` integer PRIMARY KEY,
          \`system\` text NOT NULL,
          \`status\` text NOT NULL,
          \`data\` text NOT NULL,
          \`updated\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
}

export default migration
