import { openOutbox, enqueue, pending, synchronize, ReceiptConflict, acceptExisting } from "./outbox.js";

const byId = id => document.getElementById(id);
const status = byId("status");
const save = byId("save");
const sync = byId("sync");
let db, busy = false, count = 0, conflict = null;
const changes = new BroadcastChannel("dock-outbox-changes");

function controls() {
  save.disabled = !db || busy;
  byId("sku").disabled = save.disabled;
  byId("quantity").disabled = save.disabled;
  byId("accept").disabled = busy;
  sync.disabled = !db || busy || !count;
  byId("network").textContent = navigator.onLine ? "網路已連線" : "目前離線";
}

function nextQueueControl() {
  return count ? sync : byId("sku");
}

async function refresh() {
  if (!db) return;
  const entries = await pending(db);
  const rows = entries.map(({ sku, quantity }) => {
    const row = document.createElement("tr");
    row.insertCell().textContent = sku;
    row.insertCell().textContent = quantity + " 件";
    return row;
  });
  document.querySelector("tbody").replaceChildren(...rows);
  count = entries.length;
  if (conflict && !entries.some(entry => entry.sequence === conflict.sequence)) {
    conflict = null;
    if (!busy) status.textContent = "此筆待送項目已在其他分頁完成核對。";
  }
  const review = byId("review");
  const closingFocusedReview = !conflict && review.contains(document.activeElement);
  review.hidden = !conflict;
  byId("count").textContent = count + " 筆";
  byId("empty").hidden = count > 0;
  byId("table").hidden = count === 0;
  controls();
  if (closingFocusedReview && !busy) nextQueueControl().focus();
}

async function update(operation, focusAfter) {
  if (busy || !db) return;
  const trigger = document.activeElement;
  let showComparison = false;
  busy = true;
  controls();
  try {
    status.textContent = await operation();
  } catch (error) {
    if (error instanceof ReceiptConflict) {
      conflict = error;
      showComparison = true;
      const { local, received } = conflict;
      byId("comparison").textContent = "本機 " + local.sku + " × " + local.quantity +
        " 件。已入帳 " + received.sku + " × " + received.quantity + " 件。";
    }
    status.textContent = error instanceof TypeError || error.name === "TimeoutError"
      ? "未收到確認。請恢復連線後重送待送項目。" : error.message;
  } finally {
    changes.postMessage("refresh");
    busy = false;
    await refresh();
    if (document.activeElement === document.body || document.activeElement === trigger) {
      const target = showComparison && conflict ? byId("comparison") : focusAfter();
      target.focus();
    }
  }
}

byId("form").addEventListener("submit", event => {
  event.preventDefault();
  update(async () => {
    status.textContent = "正在存入本機…";
    const sku = byId("sku");
    const quantity = byId("quantity");
    const entry = await enqueue(db, sku.value, quantity.valueAsNumber);
    sku.value = "";
    quantity.value = "1";
    return entry.sku + " 已存入本機。";
  }, () => byId("sku"));
});
sync.addEventListener("click", () => update(async () => {
  status.textContent = "正在送往收貨站…";
  const sent = await synchronize(db);
  return "已確認 " + sent + " 筆收貨。";
}, nextQueueControl));
byId("accept").addEventListener("click", () => update(async () => {
  if (!conflict) return "請重新核對待送清單。";
  await acceptExisting(db, conflict);
  conflict = null;
  return "已採用入帳資料並移除此筆待送項目。";
}, () => conflict ? byId("comparison") : nextQueueControl()));
changes.onmessage = refresh;
window.addEventListener("pageshow", refresh);
window.addEventListener("online", controls);
window.addEventListener("offline", controls);
controls();
openOutbox().then(async result => { db = result; await refresh(); })
  .catch(() => { status.textContent = "無法開啟本機儲存空間，請確認瀏覽器設定。"; });

async function prepareOffline() {
  const registration = await navigator.serviceWorker.register("/sw.js");
  if (!registration.active && registration.installing) {
    const worker = registration.installing;
    await new Promise((resolve, reject) => {
      function changed() {
        if (worker.state === "activated") resolve();
        if (worker.state === "redundant") reject(new Error("install failed"));
      }
      worker.addEventListener("statechange", changed);
      changed();
    });
  }
  await navigator.serviceWorker.ready;
  byId("offline-ready").textContent = "離線頁面已就緒";
}
prepareOffline().catch(() => { byId("offline-ready").textContent = "離線頁面尚未備妥，請連線重新載入。"; });
