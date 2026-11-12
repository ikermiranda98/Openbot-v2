import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// One finished request this machine sent to OpenCode's free gateway. The gateway's counter is
// per client /64 and UTC day, and its refusal is the only exact read of the free allowance;
// this table mirrors that counter so the ring can read the exit and the day from this desk's
// own traffic instead of inferring them from session steps (titles, compactions and generate
// never leave a step). The gateway does not raise its counter on its own refusal, so a 429 is
// not stored here either.
export const GatewayRequestTable = sqliteTable(
  "gateway_request",
  {
    id: integer().primaryKey(),
    created: integer().notNull(),
    project_id: text(),
  },
  (table) => [index("gateway_request_created_idx").on(table.created)],
)
