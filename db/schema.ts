import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  mode: text("mode").notNull(),
  tableNo: text("table_no"),
  note: text("note").notNull(),
  items: text("items").notNull(),
  total: integer("total").notNull(),
  status: text("status").notNull().default("pending"),
  created: integer("created").notNull(),
});
export const unavailable = sqliteTable("unavailable", {
  dish: text("dish").primaryKey(),
});
