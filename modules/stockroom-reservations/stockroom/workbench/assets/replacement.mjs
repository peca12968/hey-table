const byId = id => document.getElementById(id);
const form = byId('batch-form'), input = byId('batch'), lookup = byId('lookup'), submit = byId('submit');
const previewPanel = byId('preview'), confirmPanel = byId('confirmation'), receiptPanel = byId('receipt');
const pendingKey = 'stockroom.replacement.pending.v1';
const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const time = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23',
});
const batchStates = {
  cancelled: '原批次已取消。',
  active: '原批次仍有有效保留，待全部關閉後再查詢。',
  none_expired: '原批次沒有可接續的到期餘量。',
  item_replaced: '有品項已個別接續。',
  shortage: '有品項缺貨，整批暫時無法接續。',
  ready: '目前各品項庫存足夠。',
  replaced: '此批次已重新保留。',
};
const itemStates = { active: '保留有效', replaced: '已有新保留', closed: '已結束', ready: '可接續' };
const endpoint = batch => '/reservation-batches/' + encodeURIComponent(batch) + '/replacement';
let busy = false, snapshot = null, receipt = null;
let pending = readPending();

function readPending() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(pendingKey));
    if (typeof saved?.batch === 'string' && idPattern.test(saved.batch) &&
        typeof saved.operation === 'string' && idPattern.test(saved.operation)) return saved;
  } catch { /* Storage may be unavailable. */ }
  return null;
}

function remember(value) {
  try {
    if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value));
    else sessionStorage.removeItem(pendingKey);
    return true;
  } catch { return false; }
}

async function request(path, options) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(12_000), ...options });
  if (!response.ok) throw Object.assign(new Error('Stockroom request failed'), { status: response.status });
  return response.json();
}

function message(kind, text = '') {
  const node = byId(kind);
  node.textContent = text;
  node.hidden = text === '';
}

function list(target, lines) {
  byId(target).replaceChildren(...lines.map(text => {
    const row = document.createElement('li');
    row.textContent = text;
    return row;
  }));
}

function render() {
  input.disabled = lookup.disabled = busy || pending !== null;
  previewPanel.hidden = snapshot === null;
  confirmPanel.hidden = !pending && snapshot?.status !== 'ready';
  receiptPanel.hidden = receipt === null;
  submit.disabled = busy;
  submit.textContent = pending ? '重試原重新保留請求' : '整批重新保留';
  if (pending) {
    byId('confirm-text').textContent = '原批號 ' + pending.batch + ' · 請求編號 ' + pending.operation;
  } else if (snapshot?.status === 'ready') {
    const quantity = snapshot.items.reduce((total, row) => total + row.expired_quantity, 0);
    byId('confirm-text').textContent = '接續 ' + quantity + ' 件到期餘量。送出時會重新核對庫存。';
  }
}

function showSnapshot(result, batch) {
  if (result.source_batch_id !== batch || !Object.hasOwn(batchStates, result.status)) throw new Error('Unexpected preview');
  byId('captured').textContent = batch + ' · 台灣擷取時間 ' + time.format(result.captured_at_ms);
  byId('preview-status').textContent = batchStates[result.status];
  list('preview-items', result.items.map(row => row.sku + ' · 到期餘量 ' + row.expired_quantity + ' 件 · 可用 ' +
    row.available + ' 件 · ' + (row.status === 'shortage' ? '缺 ' + row.shortfall + ' 件' : itemStates[row.status])));
  snapshot = result;
}

function showReceipt(result, batch, expectedId = result.batch_id) {
  if (result.source_batch_id !== batch || result.batch_id === batch || result.batch_id !== expectedId ||
      !idPattern.test(result.batch_id ?? '') || !Array.isArray(result.items) || !result.items.length)
    throw new Error('Unexpected replacement receipt');
  byId('receipt-batch').textContent = '原批號 ' + batch + ' · 新批號 ' + result.batch_id;
  byId('receipt-deadline').textContent = '初始期限（台灣時間）' + time.format(result.expires_at_ms);
  list('receipt-items', result.items.map(row =>
    row.sku + ' · 新保留 ' + row.quantity + ' 件 · ' + row.source_id + ' → ' + row.id));
  receipt = result;
}

async function loadBatch(batch) {
  snapshot = receipt = null;
  showSnapshot(await request(endpoint(batch) + '-preview'), batch);
  if (snapshot.status === 'replaced') {
    showReceipt(await request(endpoint(batch)), batch, snapshot.replacement_batch_id);
  }
}

function selectBatch(batch) {
  input.value = batch;
  history.replaceState(null, '', '/workbench/replacement?' + new URLSearchParams({ batch }));
}

async function lookupBatch(batch) {
  if (busy || pending) return;
  busy = true;
  snapshot = receipt = null;
  selectBatch(batch);
  message('error');
  message('status');
  render();
  try {
    await loadBatch(batch);
  } catch (error) {
    message('error', error.status === 404 && !snapshot ? '找不到此保留批次。' : '暫時無法讀取批次或原收據。');
  } finally {
    busy = false;
    render();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (idPattern.test(input.value)) void lookupBatch(input.value);
});

submit.addEventListener('click', async () => {
  if (busy || (!pending && snapshot?.status !== 'ready')) return;
  const retry = pending !== null;
  if (!pending) {
    const random = crypto.getRandomValues(new Uint8Array(16));
    const operation = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
    pending = { batch: snapshot.source_batch_id, operation };
  }
  const { batch, operation } = pending;
  const saved = remember(pending);
  busy = true;
  message('error');
  message('status');
  render();
  try {
    const result = await request(endpoint(batch), { method: 'POST', headers: { 'Idempotency-Key': operation } });
    showReceipt(result, batch);
    snapshot = null;
    pending = null;
    remember(null);
    message('status', retry ? '已確認原請求並取回收據。' : '已建立新保留批次。');
  } catch (error) {
    if ([404, 409, 422].includes(error.status)) {
      pending = null;
      remember(null);
      try {
        await loadBatch(batch);
        if (receipt) message('status', '此批已由另一操作建立，已取回原收據。');
        else message('error', '整批未建立，請按最新結果核對。');
      } catch {
        message('error', '請求未能建立批次，請重新查詢批次與收據。');
      }
    } else {
      message('error', '尚未確認重新保留結果，請重試同一筆請求。' + (saved ? '' : '此分頁無法暫存，請保持開啟。'));
    }
  } finally {
    busy = false;
    render();
  }
});

byId('download').addEventListener('click', () => {
  if (!receipt) return;
  const blob = new Blob([JSON.stringify(receipt, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url;
  link.download = receipt.source_batch_id + '-replacement.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

const requested = new URLSearchParams(location.search).get('batch');
if (pending) {
  selectBatch(pending.batch);
  message('status', '有一筆重新保留請求等待確認。');
  render();
} else if (requested && idPattern.test(requested)) {
  void lookupBatch(requested);
}
