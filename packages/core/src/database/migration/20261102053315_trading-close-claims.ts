import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261102053315_trading-close-claims",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`trading_close\` (
          \`id\` text PRIMARY KEY,
          \`symbol\` text NOT NULL,
          \`lock\` text,
          \`verdict\` text,
          \`ts\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`trading_close_lock_idx\` ON \`trading_close\` (\`lock\`);`)
    })
  },
}

export default migration
