import {copyFileSync, mkdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";

function insert(db, basket, status = "completed") {
  const {id} = db.prepare("SELECT coalesce(max(id),0)+1 AS id FROM orders").get();
  const prices = {katsudon: 190, oyakodon: 170, karaage: 110, gyoza: 85, sencha: 45};
  const items = basket.map(id => ({id, price: prices[id], qty: 1}));
  db.prepare("INSERT INTO orders(id,token,mode,note,items,total,status,created) VALUES(?,?,'pickup','',?,?,?,?)")
    .run(id, "sample-ticket-" + id, JSON.stringify(items), items.reduce((a,r) => a + r.price, 0), status, id * 1000);
}

export function seed(directory, migrations) {
  mkdirSync(directory);
  const first = join(directory, "training.db"), second = join(directory, "later.db");
  const db = new DatabaseSync(first);
  try {
    if (migrations) {
      const journal = JSON.parse(readFileSync(join(migrations, "meta", "_journal.json"), "utf8"));
      for (const {tag} of journal.entries) db.exec(readFileSync(join(migrations, tag + ".sql"), "utf8"));
    } else {
      db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY,token TEXT,mode TEXT,note TEXT,items TEXT,total INTEGER,status TEXT,created INTEGER)");
    }
    for (let i = 0; i < 6; i++) insert(db, ["oyakodon", "sencha"]);
    for (let i = 0; i < 4; i++) insert(db, ["katsudon", "gyoza"]);
    insert(db, ["katsudon"]);
    insert(db, ["katsudon", "sencha"], "pending");
    insert(db, ["katsudon", "sencha"], "cancelled");
  } finally {
    db.close();
  }
  copyFileSync(first, second);
  const later = new DatabaseSync(second);
  try {
    later.exec("UPDATE orders SET status='completed' WHERE status='pending'");
    for (let i = 0; i < 3; i++) insert(later, ["katsudon", "gyoza"]);
    insert(later, ["oyakodon", "sencha"]);
    insert(later, ["katsudon"]);
    insert(later, ["katsudon", "sencha"]);
    insert(later, ["karaage", "sencha"]);
    insert(later, ["sencha"]);
    insert(later, ["oyakodon", "sencha"], "cancelled");
  } finally {
    later.close();
  }
  return {first, second};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.argv[2]) throw new Error("Usage: node examples/seed.mjs NEW_DIRECTORY [HEY_TABLE_DRIZZLE]");
  seed(process.argv[2], process.argv[3]);
}
