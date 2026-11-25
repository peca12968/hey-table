import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  mode: text("mode").notNull(),
  source: text("source"),
  pickupSlot: integer("pickup_slot"),
  pickupChanges: text("pickup_changes"),
  pickupArrivedAt: integer("pickup_arrived_at"),
  tableNo: text("table_no"),
  tableMoves: text("table_moves"),
  note: text("note").notNull(),
  items: text("items").notNull(),
  paymentMethod: text("payment_method").notNull().default("cash"),
  paymentEnv: text("payment_env").notNull().default("cash"),
  paymentDueAt: integer("payment_due_at"),
  cashPaymentChange: text("cash_payment_change"),
  comboQuote: text("combo_quote"),
  total: integer("total").notNull(),
  status: text("status").notNull().default("pending"),
  statusHistory: text("status_history"),
  stationProgress: text("station_progress"),
  created: integer("created").notNull(),
}, t => [
  index("orders_status_id").on(t.status,t.id),
  index("orders_created").on(t.created),
  index("orders_supply_time").on(sql`COALESCE(${t.pickupSlot},${t.created})`),
  index("orders_pickup_slot").on(t.pickupSlot).where(sql`${t.pickupSlot} IS NOT NULL`),
  index("orders_pickup_arrival").on(t.pickupArrivedAt).where(sql`${t.pickupArrivedAt} IS NOT NULL`),
  index("orders_pending_payment_due").on(t.paymentDueAt).where(sql`${t.status}='pending' AND ${t.paymentDueAt} IS NOT NULL`),
]);
export const paymentAttempts = sqliteTable("payment_attempts", {
  id: integer("id").primaryKey({autoIncrement:true}),
  orderId: integer("order_id").notNull().references(()=>orders.id),
  reference: text("reference").notNull().unique(),
  merchant: text("merchant").notNull(),
  state: text("state").notNull().default("pending"),
  tradeId: text("trade_id").unique(),
  redirectUrl: text("redirect_url"),
  created: integer("created").notNull(),
  kitchenPayableAt: integer("kitchen_payable_at"),
  checked: integer("checked").notNull().default(0),
}, t => [
  index("attempt_order").on(t.orderId,t.id),
  index("payment_attempts_attention_age").on(t.created,t.orderId).where(sql`${t.state} IN ('pending','authorized')`),
]);
export const paymentAttentionNotes = sqliteTable("payment_attention_notes", {
  id: integer("id").primaryKey({autoIncrement:true}),
  attemptId: integer("attempt_id").notNull().references(()=>paymentAttempts.id),
  operationId: text("operation_id").notNull().unique(),
  state: text("state",{enum:["pending","authorized"]}).notNull(),
  note: text("note").notNull(),
  recordedAt: integer("recorded_at").notNull(),
}, t => [
  index("payment_attention_notes_attempt").on(t.attemptId,t.id),
  check("payment_attention_note_state",sql`${t.state} IN ('pending','authorized')`),
]);
export const pickupPasses = sqliteTable("pickup_passes", {
  orderId: integer("order_id").primaryKey().references(()=>orders.id),
  tokenHash: text("token_hash").unique(),
  expiresAt: integer("expires_at"),
  revision: integer("revision").notNull(),
}, t => [
  check("pickup_pass_revision",sql`${t.revision}>0`),
  check("pickup_pass_expiration",sql`(${t.expiresAt} IS NULL)=(${t.tokenHash} IS NULL)`),
]);
export const pickupDelayUpdates = sqliteTable("pickup_delay_updates", {
  orderId: integer("order_id").notNull().references(()=>orders.id),
  revision: integer("revision").notNull(),
  operationId: text("operation_id").notNull().unique(),
  readyAt: integer("ready_at"),
  recordedAt: integer("recorded_at").notNull(),
}, t => [
  primaryKey({columns:[t.orderId,t.revision]}),
  check("pickup_delay_revision",sql`${t.revision}>0`),
  check("pickup_delay_future",sql`${t.readyAt} IS NULL OR ${t.readyAt}>${t.recordedAt}`),
]);
export const pickupDelayAcknowledgements = sqliteTable("pickup_delay_acknowledgements", {
  orderId: integer("order_id").notNull(),
  revision: integer("revision").notNull(),
  acknowledgedAt: integer("acknowledged_at").notNull(),
}, t => [
  primaryKey({columns:[t.orderId,t.revision]}),
  foreignKey({columns:[t.orderId,t.revision],foreignColumns:[pickupDelayUpdates.orderId,pickupDelayUpdates.revision]}),
]);
export const demoRefunds = sqliteTable("demo_refunds", {
  orderId: integer("order_id").primaryKey().notNull().references(()=>orders.id),
  attemptId: integer("attempt_id").notNull().unique().references(()=>paymentAttempts.id),
  amount: integer("amount").notNull(),
  previousStatus: text("previous_status").notNull(),
  refundedAt: integer("refunded_at").notNull(),
}, t => [
  check("demo_refunds_amount",sql`${t.amount} > 0`),
  check("demo_refunds_status",sql`${t.previousStatus} IN ('pending','preparing','ready','completed','cancelled')`),
  index("demo_refunds_time").on(t.refundedAt,t.orderId),
]);
export const cashReceipts = sqliteTable("cash_receipts", {
  orderId: integer("order_id").primaryKey().notNull().references(()=>orders.id),
  operationId: text("operation_id").notNull().unique(),
  amount: integer("amount").notNull(),
  tendered: integer("tendered").notNull(),
  collectedAt: integer("collected_at").notNull(),
}, t => [
  check("cash_receipt_amount",sql`${t.amount} >= 0 AND ${t.tendered} >= ${t.amount}`),
  index("cash_receipts_collected_at").on(t.collectedAt,t.orderId),
]);
export const cashReceiptCorrections = sqliteTable("cash_receipt_corrections", {
  orderId: integer("order_id").notNull().references(()=>cashReceipts.orderId),
  revision: integer("revision").notNull(),
  operationId: text("operation_id").notNull().unique(),
  previousTendered: integer("previous_tendered").notNull(),
  tendered: integer("tendered").notNull(),
  reason: text("reason").notNull(),
  correctedAt: integer("corrected_at").notNull(),
}, t => [
  primaryKey({columns:[t.orderId,t.revision]}),
  check("cash_correction_revision",sql`${t.revision} > 0`),
  check("cash_correction_amount",sql`${t.previousTendered} >= 0 AND ${t.tendered} >= 0 AND ${t.previousTendered} <> ${t.tendered}`),
  index("cash_receipt_corrections_corrected_at").on(t.correctedAt,t.orderId,t.revision),
]);
export const cashCloseVersions = sqliteTable("cash_close_versions", {
  date: text("date").notNull(),
  revision: integer("revision").notNull(),
  operationId: text("operation_id").notNull().unique(),
  savedAt: integer("saved_at").notNull(),
  snapshot: text("snapshot").notNull(),
}, t => [
  primaryKey({columns:[t.date,t.revision]}),
  check("cash_close_revision",sql`${t.revision} > 0`),
]);
export const unavailable = sqliteTable("unavailable", {
  dish: text("dish").primaryKey(),
});
export const dailyPortionLimits = sqliteTable("daily_portion_limits", {
  date: text("date").notNull(),
  dish: text("dish").notNull(),
  capacity: integer("capacity"),
  revision: integer("revision").notNull(),
}, t => [
  primaryKey({columns:[t.date,t.dish]}),
  check("daily_portion_capacity",sql`${t.capacity} IS NULL OR ${t.capacity} >= 0`),
  check("daily_portion_revision",sql`${t.revision} > 0`),
]);
export const dailyPortionLimitChanges = sqliteTable("daily_portion_limit_changes", {
  date: text("date").notNull(),
  dish: text("dish").notNull(),
  revision: integer("revision").notNull(),
  actionId: text("action_id").notNull(),
  kind: text("kind",{enum:["manual","copy"]}).notNull(),
  previousCapacity: integer("previous_capacity"),
  capacity: integer("capacity"),
  sourceDate: text("source_date"),
  restoredFromRevision: integer("restored_from_revision"),
  changedAt: integer("changed_at").notNull(),
}, t=>[
  primaryKey({columns:[t.date,t.dish,t.revision]}),
  index("daily_portion_changes_action").on(t.actionId),
  check("daily_portion_changes_kind",sql`(${t.kind}='manual' AND ${t.sourceDate} IS NULL) OR
    (${t.kind}='copy' AND ${t.sourceDate} IS NOT NULL AND ${t.sourceDate}<>${t.date})`),
]);
export const dailyPortionRestocks = sqliteTable("daily_portion_restocks", {
  date: text("date").notNull(),
  dish: text("dish").notNull(),
  revision: integer("revision").notNull(),
  operationId: text("operation_id").notNull().unique(),
  quantity: integer("quantity").notNull(),
  previousCapacity: integer("previous_capacity").notNull(),
  used: integer("used").notNull(),
  capacity: integer("capacity").notNull(),
  restockedAt: integer("restocked_at").notNull(),
}, t => [
  primaryKey({columns:[t.date,t.dish,t.revision]}),
  check("daily_restock_revision",sql`${t.revision} > 1`),
  check("daily_restock_quantity",sql`${t.quantity} > 0 AND ${t.previousCapacity} >= 0 AND ${t.used} >= 0
    AND ${t.capacity} = MAX(${t.previousCapacity},${t.used}) + ${t.quantity} AND ${t.capacity} <= ${sql.raw(String(Number.MAX_SAFE_INTEGER))}`),
]);
export const pickupSlotLimits = sqliteTable("pickup_slot_limits", {
  start: integer("start").primaryKey().notNull(),
  capacity: integer("capacity"),
  revision: integer("revision").notNull(),
}, t => [
  check("pickup_slot_limit_capacity",sql`${t.capacity} IS NULL OR ${t.capacity} >= 0`),
  check("pickup_slot_limit_revision",sql`${t.revision} > 0`),
]);
export const pickupLimitEvents = sqliteTable("pickup_limit_events", {
  id: integer("id").primaryKey({autoIncrement:true}),
  operationId: text("operation_id").notNull().unique(),
  date: text("date").notNull(),
  changedAt: integer("changed_at").notNull(),
  kind: text("kind").notNull(),
  changes: text("changes").notNull(),
  restoredFromId: integer("restored_from_id"),
  sourceDate: text("source_date"),
}, t => [
  check("pickup_limit_event_kind",sql`${t.kind} IN ('slot','batch','day')`),
  index("pickup_limit_events_date").on(t.date,t.id),
]);
export const pickupDayIntake = sqliteTable("pickup_day_intake", {
  date: text("date").primaryKey().notNull(),
  accepting: integer("accepting", {mode:"boolean"}).notNull(),
  revision: integer("revision").notNull(),
}, t => [
  check("pickup_day_accepting",sql`${t.accepting} IN (0,1)`),
  check("pickup_day_revision",sql`${t.revision} > 0`),
]);
export const kitchenTiming = sqliteTable("kitchen_timing", {
  revision: integer("revision").primaryKey(),
  config: text("config").notNull(),
});
export const orderIntake = sqliteTable("order_intake", {
  mode: text("mode").primaryKey().notNull(),
  accepting: integer("accepting", {mode:"boolean"}).notNull(),
  revision: integer("revision").notNull(),
}, t => [
  check("order_intake_mode", sql`${t.mode} IN ('pickup','table')`),
  check("order_intake_accepting", sql`${t.accepting} IN (0,1)`),
  check("order_intake_revision", sql`${t.revision} > 0`),
]);

export const tableIntake = sqliteTable("table_intake", {
  tableNo: text("table_no").primaryKey().notNull(),
  accepting: integer("accepting", {mode:"boolean"}).notNull(),
  revision: integer("revision").notNull(),
}, t => [
  check("table_intake_accepting", sql`${t.accepting} IN (0,1)`),
  check("table_intake_revision", sql`${t.revision} > 0`),
]);

export const stationBatchReceipts = sqliteTable("station_batch_receipts", {
  operationId: text("operation_id").primaryKey().notNull(),
  writeId: text("write_id").notNull(),
  station: text("station").notNull(),
  fingerprint: text("fingerprint").notNull(),
  orderIds: text("order_ids").notNull(),
  recordedAt: integer("recorded_at").notNull(),
}, t => [
  index("station_batch_receipts_day").on(t.recordedAt,t.operationId),
  index("station_batch_receipts_station_day").on(t.station,t.recordedAt,t.operationId),
]);

export const returnQuoteEntries = sqliteTable("return_quote_entries", {
  orderId: integer("order_id").notNull().references(()=>orders.id),
  revision: integer("revision").notNull(),
  operationId: text("operation_id").notNull().unique(),
  selection: text("selection").notNull(),
  quote: text("quote").notNull(),
  recordedAt: integer("recorded_at").notNull(),
}, t => [
  primaryKey({columns:[t.orderId,t.revision]}),
  index("return_quote_entries_by_day").on(t.recordedAt,t.orderId,t.revision),
  check("return_quote_revision",sql`${t.revision} > 0`),
]);

export const returnQuoteVoids = sqliteTable("return_quote_voids", {
  orderId: integer("order_id").notNull(),
  revision: integer("revision").notNull(),
  targetRevision: integer("target_revision").notNull(),
  operationId: text("operation_id").notNull().unique(),
  reason: text("reason").notNull(),
  restoredAmount: integer("restored_amount").notNull(),
  remainingValue: integer("remaining_value").notNull(),
  recordedAt: integer("recorded_at").notNull(),
}, t => [
  primaryKey({columns:[t.orderId,t.revision]}),
  foreignKey({columns:[t.orderId,t.targetRevision],foreignColumns:[returnQuoteEntries.orderId,returnQuoteEntries.revision]}),
  uniqueIndex("return_quote_void_target").on(t.orderId,t.targetRevision),
  index("return_quote_voids_by_day").on(t.recordedAt,t.orderId,t.revision),
  check("return_quote_void_values",sql`${t.targetRevision} > 0 AND ${t.revision} > ${t.targetRevision}
    AND ${t.restoredAmount} >= 0 AND ${t.remainingValue} >= 0`),
]);

export const returnLedgerReviews = sqliteTable("return_ledger_reviews", {
  date: text("date").notNull(),
  fingerprint: text("fingerprint").notNull(),
  eventCount: integer("event_count").notNull(),
  netAmount: integer("net_amount").notNull(),
  reviewedAt: integer("reviewed_at").notNull(),
  note: text("note").notNull(),
  capturedAt: integer("captured_at"),
}, t => [
  primaryKey({columns:[t.date,t.fingerprint]}),
  check("return_review_event_count",sql`${t.eventCount} >= 0`),
  index("return_ledger_reviews_by_day").on(t.date,t.eventCount,t.reviewedAt,t.fingerprint),
]);

export const returnLedgerReviewEvents = sqliteTable("return_ledger_review_events", {
  date: text("date").notNull(),
  fingerprint: text("fingerprint").notNull(),
  orderId: integer("order_id").notNull(),
  revision: integer("revision").notNull(),
  recordedAt: integer("recorded_at").notNull(),
  kind: text("kind",{enum:["recorded","voided"]}).notNull(),
  amount: integer("amount").notNull(),
  targetRevision: integer("target_revision"),
  reason: text("reason"),
}, t => [
  primaryKey({columns:[t.date,t.fingerprint,t.orderId,t.revision]}),
  foreignKey({columns:[t.date,t.fingerprint],foreignColumns:[returnLedgerReviews.date,returnLedgerReviews.fingerprint]}),
]);
