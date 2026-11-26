const byId = id => document.getElementById(id);
const filter = byId('filter'), skuInput = byId('sku'), batches = byId('batches');
const first = byId('first'), more = byId('more'), download = byId('download'), error = byId('error');
const clock = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei' });
let snapshot = null, laterPage = false, busy = false;

function setControls() {
  byId('search').disabled = skuInput.disabled = first.disabled = more.disabled = download.disabled = busy;
  first.hidden = !laterPage;
  more.hidden = !snapshot?.next;
  download.hidden = !snapshot;
}

function timeNode(ms) {
  const time = document.createElement('time');
  time.dateTime = new Date(ms).toISOString();
  time.textContent = clock.format(ms);
  return time;
}

function showSnapshot() {
  const { sku, summary, captured_at_ms } = snapshot;
  const scope = sku ? sku + ' · ' : '';
  const counts = summary.batches + ' 批、' + summary.boxes + ' 箱、' + summary.units + ' 件';
  const empty = laterPage ? ' · 此頁已無待處理批次，可返回第一頁。' : ' · 目前沒有待複驗批次。';
  byId('summary').textContent = scope + counts + (snapshot.batches.length ? '' : empty);
  const display = byId('capture-time'), time = timeNode(captured_at_ms);
  display.dateTime = time.dateTime;
  display.textContent = time.textContent;
  byId('captured').hidden = false;
  batches.replaceChildren(...snapshot.batches.map(batch => {
    const row = document.createElement('li'), link = document.createElement('a');
    link.textContent = batch.batch_id;
    link.href = '/workbench/quarantine?batch=' + encodeURIComponent(batch.batch_id);
    const age = batch.received_at_ms === null ?
      document.createTextNode('驗收時間未記錄') : timeNode(batch.received_at_ms);
    row.append(link, ' · ' + batch.pending_boxes + ' 箱、' + batch.pending_units + ' 件 · ', age);
    return row;
  }));
}

async function load(sku, cursor = null) {
  if (busy) return;
  busy = true;
  error.hidden = true;
  setControls();
  try {
    const query = new URLSearchParams();
    if (sku) query.set('sku', sku);
    if (cursor) {
      query.set('after_received_at_ms', cursor.after_received_at_ms);
      query.set('after_batch_id', cursor.after_batch_id);
    }
    const response = await fetch('/quarantine-queue?' + query, { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('Queue unavailable');
    const next = await response.json();
    laterPage = Boolean(cursor);
    snapshot = next;
    showSnapshot();
  } catch {
    error.textContent = '暫時無法讀取待複驗清單。請再試一次。';
    error.hidden = false;
    if (!snapshot) byId('summary').textContent = '待複驗清單尚未讀取。';
  } finally {
    busy = false;
    setControls();
  }
}

filter.addEventListener('submit', event => {
  event.preventDefault();
  void load(skuInput.value.trim());
});
more.addEventListener('click', () => void load(snapshot.sku, snapshot.next));
first.addEventListener('click', () => void load(snapshot.sku));
download.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'quarantine-queue-' + snapshot.captured_at_ms + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});
void load('');
