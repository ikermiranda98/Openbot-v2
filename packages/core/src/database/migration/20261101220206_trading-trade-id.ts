import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261101220206_trading-trade-id",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`trading_trade\` ADD \`id\` text;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_trading_trade\` (
          \`id\` text PRIMARY KEY,
          \`system\` text NOT NULL,
          \`ts\` integer NOT NULL,
          \`pnl\` real,
          \`message\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_trading_trade\`(\`id\`, \`system\`, \`ts\`, \`pnl\`, \`message\`, \`time_created\`, \`time_updated\`) SELECT \`system\` || ':' || \`ts\` || ':0', \`system\`, \`ts\`, \`pnl\`, \`message\`, \`time_created\`, \`time_updated\` FROM \`trading_trade\`;`,
      )
      yield* tx.run(`DROP TABLE \`trading_trade\`;`)
      yield* tx.run(`ALTER TABLE \`__new_trading_trade\` RENAME TO \`trading_trade\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
    })
  },
}

export default migration
