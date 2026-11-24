import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  mode: text("mode").notNull(),
  source: text("source"),
  pickupSlot: integer("pickup_slot"),
  tableNo: text("table_no"),
  tableMoves: text("table_moves"),
  note: text("note").notNull(),
  items: text("items").notNull(),
  paymentMethod: text("payment_method").notNull().default("cash"),
  paymentEnv: text("payment_env").notNull().default("cash"),
  paymentDueAt: integer("payment_due_at"),
  comboQuote: text("combo_quote"),
  total: integer("total").notNull(),
  status: text("status").notNull().default("pending"),
  statusHistory: text("status_history"),
  stationProgress: text("station_progress"),
  created: integer("created").notNull(),
}, t => [
  index("orders_status_id").on(t.status,t.id),
  index("orders_created").on(t.created),
  index("orders_pickup_slot").on(t.pickupSlot).where(sql`${t.pickupSlot} IS NOT NULL`),
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
}, t => [index("attempt_order").on(t.orderId,t.id)]);
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
