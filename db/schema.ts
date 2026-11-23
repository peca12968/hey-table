import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  mode: text("mode").notNull(),
  tableNo: text("table_no"),
  note: text("note").notNull(),
  items: text("items").notNull(),
  paymentMethod: text("payment_method").notNull().default("cash"),
  paymentEnv: text("payment_env").notNull().default("cash"),
  comboQuote: text("combo_quote"),
  total: integer("total").notNull(),
  status: text("status").notNull().default("pending"),
  created: integer("created").notNull(),
}, t => [index("orders_status_id").on(t.status,t.id)]);
export const paymentAttempts = sqliteTable("payment_attempts", {
  id: integer("id").primaryKey({autoIncrement:true}),
  orderId: integer("order_id").notNull().references(()=>orders.id),
  reference: text("reference").notNull().unique(),
  merchant: text("merchant").notNull(),
  state: text("state").notNull().default("pending"),
  tradeId: text("trade_id").unique(),
  redirectUrl: text("redirect_url"),
  created: integer("created").notNull(),
  checked: integer("checked").notNull().default(0),
}, t => [index("attempt_order").on(t.orderId,t.id)]);
export const unavailable = sqliteTable("unavailable", {
  dish: text("dish").primaryKey(),
});
export const kitchenTiming = sqliteTable("kitchen_timing", {
  revision: integer("revision").primaryKey(),
  config: text("config").notNull(),
});
