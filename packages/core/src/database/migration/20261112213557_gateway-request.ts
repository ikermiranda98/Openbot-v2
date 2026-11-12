import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261112213557_gateway-request",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`gateway_request\` (
          \`id\` integer PRIMARY KEY,
          \`created\` integer NOT NULL,
          \`project_id\` text
        );
      `)
      yield* tx.run(`CREATE INDEX \`gateway_request_created_idx\` ON \`gateway_request\` (\`created\`);`)
      // The day already running when this release starts must not read empty. Every stored free
      // step is one request the gateway counted, and every completed free compaction is another;
      // titles and generate left no durable record, so they cannot be recovered. A step refused
      // with a 429 was not counted by the gateway; any other stored error answered a dispatched
      // request, so it counts like a finished one.
      yield* tx.run(`
        INSERT INTO \`gateway_request\` (\`created\`, \`project_id\`)
        SELECT m.\`time_created\`, s.\`project_id\`
        FROM \`session_message\` m
        JOIN \`session_v2\` s ON s.\`id\` = m.\`session_id\`
        WHERE (
          m.\`type\` = 'assistant'
          AND COALESCE(json_extract(m.\`data\`, '$.error.status'), 0) <> 429
          AND json_extract(m.\`data\`, '$.model.providerID') = 'opencode'
          AND COALESCE(json_extract(m.\`data\`, '$.cost'), 0) = 0
        ) OR (
          m.\`type\` = 'compaction'
          AND json_extract(m.\`data\`, '$.status') = 'completed'
          AND json_extract(m.\`data\`, '$.model.providerID') = 'opencode'
          AND COALESCE(json_extract(m.\`data\`, '$.cost'), 0) = 0
        )
      `)
    })
  },
}

export default migration
