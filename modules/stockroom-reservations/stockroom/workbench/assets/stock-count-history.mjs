const byId = id => document.getElementById(id);
const dateInput = byId('date'), skuInput = byId('sku'), error = byId('error');
const first = byId('first'), more = byId('more'), download = byId('download');
const clock = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei' });
let snapshot = null, page = null, busy = false;

function controls() {
  dateInput.disabled = skuInput.disabled = byId('search').disabled = first.disabled = more.disabled = download.disabled = busy;
  first.hidden = !page;
  more.hidden = !snapshot?.next;
  download.hidden = !snapshot;
}

function receiptLink(id, label = id) {
  const link = document.createElement('a');
  link.textContent = label;
  link.href = '/workbench/stock-count?' + new URLSearchParams({ batch: id, from: location.pathname + location.search });
  return link;
}

function showSnapshot() {
  const { date, sku, summary, captured_at_ms, batches } = snapshot;
  byId('summary').textContent = [date, sku, summary.total_batches + ' 批',
    '沖回單 ' + summary.reversal_batches + ' 批', '已沖回 ' + summary.reversed_batches + ' 批',
    batches.length ? null : '此頁沒有批次'].filter(Boolean).join(' · ');
  const stamp = byId('capture-time');
  stamp.dateTime = new Date(captured_at_ms).toISOString();
  stamp.textContent = clock.format(captured_at_ms);
  byId('captured').hidden = false;
  byId('batches').replaceChildren(...batches.map(batch => {
    const row = document.createElement('li'), heading = document.createElement('p');
    const details = document.createElement('p'), stamp = document.createElement('time');
    heading.append(receiptLink(batch.batch_id), batch.source_batch_id ? ' · 沖回單' : ' · 盤點入帳');
    if (batch.reversal_batch_id) heading.append(' · 已沖回');
    stamp.dateTime = new Date(batch.recorded_at_ms).toISOString();
    stamp.textContent = clock.format(batch.recorded_at_ms);
    details.className = 'meta';
    details.append(batch.count_session + ' · ' + batch.items + ' 個品項（' + batch.changed_items + ' 個有差異） · ', stamp);
    row.append(heading, details);
    if (batch.source_batch_id) row.append(receiptLink(batch.source_batch_id, '原盤點 ' + batch.source_batch_id));
    if (batch.source_batch_id && batch.reversal_batch_id) row.append(' · ');
    if (batch.reversal_batch_id) row.append(receiptLink(batch.reversal_batch_id, '沖回單 ' + batch.reversal_batch_id));
    return row;
  }));
}

async function load(scope, cursor = null) {
  if (busy) return;
  busy = true;
  error.hidden = true;
  controls();
  const query = new URLSearchParams();
  if (scope.date) query.set('date', scope.date);
  if (scope.sku) query.set('sku', scope.sku);
  if (cursor) for (const [key, value] of Object.entries(cursor)) query.set(key, value);
  try {
    const response = await fetch('/stock-count-batches?' + query, { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('History unavailable');
    snapshot = await response.json();
    page = cursor;
    history.replaceState(null, '', location.pathname + (query.size ? '?' + query : ''));
    showSnapshot();
  } catch {
    if (!snapshot) byId('summary').textContent = '盤點紀錄尚未擷取。';
    error.textContent = '無法擷取盤點紀錄，請確認日期與 SKU 後重試。';
    error.hidden = false;
  } finally {
    busy = false;
    controls();
  }
}

byId('filter').addEventListener('submit', event => {
  event.preventDefault();
  void load({ date: dateInput.value, sku: skuInput.value.trim() });
});
first.addEventListener('click', () => void load(snapshot));
more.addEventListener('click', () => void load(snapshot, snapshot.next));
download.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'stock-count-history-' + snapshot.captured_at_ms + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});
const query = new URLSearchParams(location.search);
dateInput.value = query.get('date') ?? '';
skuInput.value = query.get('sku') ?? '';
const beforeBatch = query.get('before_batch_id'), beforeTime = query.get('before_recorded_at_ms');
const cursor = beforeBatch && beforeTime ? { before_recorded_at_ms: beforeTime, before_batch_id: beforeBatch } : null;
void load({ date: dateInput.value, sku: skuInput.value }, cursor);
