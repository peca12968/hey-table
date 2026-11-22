export function openOutbox() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("dock-outbox", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("pending", { keyPath: "sequence", autoIncrement: true });
      store.createIndex("operation", "id", { unique: true });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function transact(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("pending", mode);
    const request = operation(transaction.objectStore("pending"));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || new Error("收貨佇列交易中斷"));
  });
}

export async function enqueue(db, sku, quantity) {
  const code = sku.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(code)) throw new Error("料號限 1 至 32 個英數字或連字號");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw new Error("數量限 1 至 9,999 的整數");
  const entry = { id: crypto.randomUUID(), sku: code, quantity };
  const sequence = await transact(db, "readwrite", store => store.add(entry));
  return { ...entry, sequence };
}

export function pending(db) {
  return transact(db, "readonly", store => store.getAll());
}

export class ReceiptConflict extends Error {
  constructor(sequence, local, received) {
    super("HTTP 409：同一筆收貨識別碼的內容不同，請核對兩筆資料。");
    this.sequence = sequence;
    this.local = local;
    this.received = received;
  }
}

export function acceptExisting(db, conflict) {
  return transact(db, "readwrite", store => store.delete(conflict.sequence));
}

export async function synchronize(db) {
  let confirmed = 0;
  for (const { id, sku, quantity, sequence } of await pending(db)) {
    const response = await fetch("/api/receipts", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, sku, quantity })
    });
    if (response.status === 409) {
      const { receipt } = await response.json();
      if (receipt?.id === id && typeof receipt.sku === "string" && Number.isInteger(receipt.quantity)) {
        throw new ReceiptConflict(sequence, { sku, quantity }, receipt);
      }
    }
    if (!response.ok) throw new Error("收貨尚未確認（HTTP " + response.status + "）");
    const receipt = await response.json();
    if (receipt.id !== id || receipt.sku !== sku || receipt.quantity !== quantity) {
      throw new Error("收貨回覆與本機紀錄不同");
    }
    await transact(db, "readwrite", store => store.delete(sequence));
    confirmed += 1;
  }
  return confirmed;
}
