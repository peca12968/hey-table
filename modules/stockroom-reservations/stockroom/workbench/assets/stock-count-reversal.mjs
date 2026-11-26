const by = id => document.getElementById(id);
const batchInput = by('batch'), reason = by('reason');
const key = 'stockroom.pending-stock-count-reversal.v1';
const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const clock = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei' });
let pending = restorePending(), preview = null, receipt = null, busy = false;

function restorePending() {
  try {
    const entry = JSON.parse(sessionStorage.getItem(key));
    if (!entry || !idPattern.test(entry.batch) || !idPattern.test(entry.operation) ||
        !digestPattern.test(entry.data?.preview_digest) || typeof entry.data?.reason !== 'string' ||
        !entry.data.reason.trim() || entry.data.reason.length > 240) return null;
    return entry;
  } catch { return null; }
}

function remember(entry) {
  try {
    if (entry) sessionStorage.setItem(key, JSON.stringify(entry));
    else sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
}

function message(id, text = '') {
  by(id).hidden = !text;
  by(id).textContent = text;
}

function controls() {
  batchInput.disabled = by('load').disabled = busy || Boolean(pending);
  reason.disabled = by('submit').disabled = busy || !preview?.preview_digest;
  by('retry').disabled = by('download').disabled = busy;
  by('pending').hidden = !pending;
  by('review').hidden = Boolean(pending) || !preview?.lines.length;
  by('receipt').hidden = !receipt;
  if (pending) by('pending-info').textContent = pending.batch + ' · ' + pending.data.reason;
}

const sourcePath = id => '/stock-count-batches/' + encodeURIComponent(id);
async function request(path, entry) {
  const response = await fetch(path, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000), ...(entry ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': entry.operation },
    body: JSON.stringify(entry.data),
  } : {}) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(), { status: response.status });
  return data;
}

function lines(id, values) {
  by(id).replaceChildren(...values.map(text => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
}

function showReceipt(data, source, expectedReason) {
  if (data?.source_batch_id !== source || !idPattern.test(data?.batch_id) || !Array.isArray(data.items) ||
      !data.items.length || (expectedReason && data.items.some(row => row.reason !== expectedReason))) throw new Error();
  receipt = data;
  preview = null;
  by('receipt-info').textContent = data.batch_id + ' · 原盤點 ' + source + ' · ' + data.items[0].reason;
  by('source-receipt').href = '/workbench/stock-count?' + new URLSearchParams({ batch: source });
  lines('receipt-lines', data.items.map(row => row.sku + ' · 帳面 ' + row.previous_capacity + ' → ' + row.counted +
    ' 件 · 可用 ' + row.previous_available + ' → ' + row.available + ' 件'));
}

async function refresh(id) {
  preview = receipt = null;
  const current = await request(sourcePath(id) + '/reversal-preview');
  if (current.source_batch_id !== id) throw new Error();
  if (current.reversal_batch_id) {
    showReceipt(await request(sourcePath(id) + '/reversal'), id);
    message('status', '原批次已沖回，已取回沖回收據。');
    return;
  }
  preview = current;
  by('capture').textContent = id + ' · 台灣擷取時間 ' + clock.format(current.captured_at_ms);
  lines('lines', current.lines.map(row => {
    const amounts = row.sku + ' · 目前 ' + row.current_capacity + ' → 恢復 ' + row.restore_to +
      ' 件 · 已保留 ' + row.held + ' 件';
    const remaining = row.available_after === null ? ' · 恢復後低於保留量' : ' · 恢復後可用 ' + row.available_after + ' 件';
    return amounts + remaining + (row.revision_changed ? ' · 版次已變，無法沖回' : '');
  }));
  message('status', current.preview_digest ? '請核對各品項件數，填寫原因後再送出。' : '目前無法沖回，請核對受影響品項。');
}

batchInput.addEventListener('input', () => {
  preview = receipt = null;
  reason.value = '';
  message('status'); message('error'); controls();
});
by('lookup').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || pending) return;
  busy = true;
  message('status'); message('error'); controls();
  try { await refresh(batchInput.value); }
  catch (error) { message('error', error.status === 404 ? '找不到原盤點批次。' : '暫時無法擷取沖回預覽。'); }
  finally { busy = false; controls(); }
});

async function send(entry, retry) {
  pending = entry;
  const stored = remember(entry);
  busy = true;
  message('status'); message('error'); controls();
  try {
    showReceipt(await request(sourcePath(entry.batch) + '/reversal', entry), entry.batch, entry.data.reason);
    pending = null;
    remember(null);
    message('status', retry ? '已確認原沖回操作。' : '整批已沖回。');
  } catch (error) {
    if ([404, 409, 422].includes(error.status)) {
      pending = null;
      remember(null);
      message('error', '這次操作未入帳，請核對最新資料。');
      try { await refresh(entry.batch); } catch { message('status', '請重新擷取沖回預覽。'); }
    } else {
      message('error', '尚未收到沖回結果，可重試原操作。' + (stored ? '' : '此分頁無法暫存，請保持開啟。'));
    }
  } finally { busy = false; controls(); }
}

by('confirm').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || pending || !preview?.preview_digest) return;
  const note = reason.value.trim();
  if (!note) { message('error', '請填寫沖回原因。'); return; }
  void send({ batch: preview.source_batch_id, operation: crypto.randomUUID(),
    data: { reason: note, preview_digest: preview.preview_digest } }, false);
});
by('retry').addEventListener('click', () => {
  if (!busy && pending) void send(pending, true);
});
by('download').addEventListener('click', () => {
  if (!receipt) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'stock-count-reversal-' + receipt.batch_id + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

const query = new URLSearchParams(location.search);
try {
  const back = new URL(query.get('from') ?? '', location.origin);
  if (back.origin === location.origin && ['/workbench/stock-count', '/workbench/stock-count-history'].includes(back.pathname))
    by('back').href = back.pathname + back.search;
} catch {}
const batch = query.get('batch');
batchInput.value = pending?.batch ?? (idPattern.test(batch ?? '') ? batch : '');
controls();
if (!pending && batchInput.value) by('lookup').requestSubmit();
