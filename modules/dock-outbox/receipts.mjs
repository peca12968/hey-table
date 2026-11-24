import { DatabaseSync } from "node:sqlite";

export class Receipts {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL, quantity INTEGER NOT NULL
    ) STRICT`);
    this.insert = this.db.prepare("INSERT INTO receipts VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING");
    this.find = this.db.prepare("SELECT * FROM receipts WHERE id=?");
  }

  receive(input) {
    const { id, sku, quantity } = input ?? {};
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
        typeof sku !== "string" || !/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(sku) ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      return { status: 400, body: { error: "收貨資料格式錯誤" } };
    }
    const { changes } = this.insert.run(id, sku, quantity);
    const receipt = this.find.get(id);
    if (receipt.sku !== sku || receipt.quantity !== quantity) {
      return { status: 409, body: { error: "同一筆收貨識別碼已有其他內容", receipt } };
    }
    return { status: changes ? 201 : 200, body: receipt };
  }

  close() {
    this.db.close();
  }
}
