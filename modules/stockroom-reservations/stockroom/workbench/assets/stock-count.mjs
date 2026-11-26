const by = id => document.getElementById(id);
const scope = by('scope'), draft = by('draft'), lookup = by('lookup');
const skuInput = by('skus'), batchInput = by('batch'), sessionInput = by('session'), reasonInput = by('reason');
const confirm = by('confirm'), countInputs = new Map();
const storageKey = 'stockroom.pending-stock-count.v1';
const collection = '/stock-count-batches';
const batchId = /^[A-Za-z0-9_-]{1,80}$/;
const skuValid = value => typeof value === 'string' && value.length > 0 && value.length <= 80;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const textWithin = (value, max) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max;
const clock = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'short' });
let basis = null, review = null, pending = readPending(), receipt = null, busy = false;

function readPending() {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey));
    const data = value?.data;
    return value && typeof value.batch === 'string' && batchId.test(value.batch) &&
      textWithin(data?.count_session, 80) && textWithin(data?.reason, 240) && Array.isArray(data.items) &&
      data.items.length > 0 && data.items.length <= 100 &&
      data.items.every(row => skuValid(row?.sku) && integer(row.expected_revision) && integer(row.counted)) &&
      new Set(data.items.map(row => row.sku)).size === data.items.length ? value : null;
  } catch {
    return null;
  }
}

function savePending(value) {
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

function setMessage(id, message = '') {
  by(id).textContent = message;
  by(id).hidden = !message;
}

function controls() {
  for (const input of [...scope.elements, ...draft.elements]) input.disabled = busy || Boolean(pending);
  for (const input of lookup.elements) input.disabled = busy;
  by('count-panel').hidden = !basis;
  by('review').hidden = !review && !pending;
  confirm.textContent = pending ? '查詢或重試原盤點批次' : '確認整批入帳';
  confirm.disabled = busy || (!pending && !review?.ready);
}

function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function lines(id, list) {
  by(id).replaceChildren(...list.map(text => node('li', text)));
}

function showPending() {
  if (!pending) return;
  const { batch, data } = pending;
  lines('changes', data.items.map(row => row.sku + ' · 實點 ' + row.counted + ' 件 · 基準版次 ' + row.expected_revision));
  by('review-heading').textContent = '待確認盤點批次 ' + batch;
}

async function request(path, data, key) {
  const options = { cache: 'no-store', redirect: 'error' };
  if (data) {
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) };
    options.body = JSON.stringify(data);
  }
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(), { status: response.status, detail: body.detail });
  return body;
}

function scopeSkus() {
  const skus = skuInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!skus.length || skus.length > 100 || !skus.every(skuValid) || new Set(skus).size !== skus.length)
    throw new Error('請輸入 1 至 100 個不同的 SKU，每行一個。');
  return skus;
}

async function capture(skus, previous = []) {
  const result = await request('/stock-count-basis', { skus });
  const prior = new Map(previous.map(row => [row.sku, row]));
  if (!Array.isArray(result?.products) || result.products.length !== skus.length ||
      new Set(result.products.map(row => row.sku)).size !== skus.length ||
      !result.products.every(row => skus.includes(row.sku) &&
        [row.capacity, row.held, row.available, row.revision].every(integer) && row.held + row.available === row.capacity) ||
      !integer(result.captured_at_ms)) throw Object.assign(new Error(), { unsupportedBasis: true });
  basis = result;
  by('captured').textContent = '基準擷取時間（台灣） ' + clock.format(basis.captured_at_ms);
  countInputs.clear();
  const recheck = [];
  const rows = basis.products.map(product => {
    const priorRow = prior.get(product.sku);
    const fieldset = node('fieldset');
    const facts = node('p', '帳面實體 ' + product.capacity + ' 件 · 已保留 ' + product.held +
      ' 件 · 可用 ' + product.available + ' 件 · 版次 ' + product.revision);
    const label = node('label', '實點件數'), input = node('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '0';
    input.max = String(Number.MAX_SAFE_INTEGER);
    input.step = '1';
    input.required = true;
    if (priorRow?.expected_revision === product.revision) input.value = String(priorRow.counted);
    if (priorRow && priorRow.expected_revision !== product.revision) recheck.push(product.sku);
    countInputs.set(product.sku, input);
    label.append(input);
    fieldset.append(node('legend', product.sku), facts, label);
    return fieldset;
  });
  by('counts').replaceChildren(...rows);
  return recheck;
}

function showReceipt(result, id, expected) {
  if (result?.batch_id !== id || !Array.isArray(result.items) || !result.items.length ||
      !result.items.every(row => skuValid(row?.sku) &&
        [row.previous_capacity, row.previous_available, row.previous_revision, row.counted, row.available, row.revision,
          row.recorded_at_ms].every(integer)))
    throw new Error('盤點收據格式有誤。');
  if (expected && (expected.items.length !== result.items.length || expected.items.some(line =>
    !result.items.some(saved => saved.sku === line.sku && saved.previous_revision === line.expected_revision &&
      saved.counted === line.counted && saved.count_session === expected.count_session && saved.reason === expected.reason))))
    throw Object.assign(new Error(), { status: 409, detail: 'Stock count batch key already used with different input' });
  receipt = result;
  const { count_session, reason, recorded_at_ms } = receipt.items[0];
  by('receipt-batch').textContent = id + ' · ' + count_session + ' · ' + clock.format(recorded_at_ms) + ' · ' + reason;
  lines('receipt-lines', receipt.items.map(row => row.sku + ' · 帳面 ' + row.previous_capacity + ' → ' + row.counted +
    ' 件 · 可用 ' + row.previous_available + ' → ' + row.available + ' 件 · 版次 ' + row.revision));
  by('receipt').hidden = false;
  by('lookup-batch').value = id;
}

skuInput.addEventListener('input', () => {
  basis = review = null;
  controls();
});
scope.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || pending) return;
  setMessage('status'); setMessage('error');
  let skus;
  try {
    skus = scopeSkus();
  } catch (error) {
    setMessage('error', error.message);
    return;
  }
  busy = true;
  basis = review = null;
  controls();
  try {
    await capture(skus);
    setMessage('status', '已擷取同一份庫存基準，請填寫實點數量。');
  } catch (error) {
    setMessage('error', error.status === 404 ? '至少一個 SKU 查無庫存。' :
      error.unsupportedBasis ? '基準資料格式不符或超出可精確輸入的整數範圍。' : '暫時無法擷取庫存基準。');
  } finally {
    busy = false;
    controls();
  }
});

draft.addEventListener('input', () => {
  review = null;
  controls();
});
draft.addEventListener('submit', event => {
  event.preventDefault();
  if (busy || pending || !basis) return;
  setMessage('status'); setMessage('error');
  const count_session = sessionInput.value.trim(), reason = reasonInput.value.trim();
  if (!count_session || !reason) {
    setMessage('error', '請填寫盤點場次和理由。');
    return;
  }
  const items = basis.products.map(product => ({ sku: product.sku, expected_revision: product.revision,
    counted: countInputs.get(product.sku).valueAsNumber }));
  if (!items.every(line => integer(line.counted))) {
    setMessage('error', '請填寫可精確記錄的非負整數件數。');
    return;
  }
  const below = items.map((line, index) => line.counted < basis.products[index].held);
  review = { batch: batchInput.value, data: { count_session, reason, items }, ready: !below.includes(true) };
  by('review-heading').textContent = '核對盤點差異';
  lines('changes', items.map((line, index) => {
    const { capacity, held } = basis.products[index], delta = line.counted - capacity;
    return line.sku + ' · 帳面 ' + capacity + ' → 實點 ' + line.counted + ' 件（' +
      (delta > 0 ? '+' : '') + delta + '） · ' + (below[index] ? '低於保留量 ' + held + ' 件' :
      '預估可用 ' + (line.counted - held) + ' 件');
  }));
  controls();
});

const receiptPath = id => collection + '/' + encodeURIComponent(id);
confirm.addEventListener('click', async () => {
  if (busy || (!pending && !review?.ready)) return;
  const retry = Boolean(pending);
  pending ??= { batch: review.batch, data: review.data };
  const entry = pending;
  const kept = savePending(entry);
  review = null;
  busy = true;
  setMessage('error'); setMessage('status');
  showPending();
  controls();
  try {
    let result;
    if (retry) {
      try {
        result = await request(receiptPath(entry.batch));
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    result ??= await request(collection, entry.data, entry.batch);
    showReceipt(result, entry.batch, entry.data);
    pending = basis = null;
    savePending(null);
    batchInput.value = '';
    setMessage('status', retry ? '已取回原盤點收據。' : '整批盤點已入帳。');
  } catch (error) {
    if ([404, 409, 422].includes(error.status)) {
      pending = null;
      savePending(null);
      if (error.detail === 'Stock count batch key already used with different input' && basis) {
        setMessage('error', '這個盤點批號已用於其他內容，請更換批號。');
      } else {
        basis = null;
        try {
          const touched = await capture(entry.data.items.map(row => row.sku), entry.data.items);
          setMessage('error', '整批未入帳，基準已更新。' + (touched.length ?
            '請複點 ' + touched.join('、') + '。' : '請重新核對保留量及批號。'));
        } catch {
          setMessage('error', '整批未入帳。請重新擷取盤點基準。');
        }
      }
    } else {
      setMessage('error', '尚未收到盤點結果，請查詢或重試原批次。' + (kept ? '' : '此分頁無法暫存，請保持開啟。'));
    }
  } finally {
    busy = false;
    controls();
  }
});

lookup.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  controls();
  setMessage('status'); setMessage('error');
  const id = by('lookup-batch').value;
  receipt = null;
  by('receipt').hidden = true;
  try {
    showReceipt(await request(receiptPath(id)), id);
    setMessage('status', '已取回原盤點收據。');
  } catch (error) {
    setMessage('error', error.status === 404 ? '找不到這個盤點批號。' : '暫時無法讀取盤點收據。');
  } finally {
    busy = false;
    controls();
  }
});

by('download').addEventListener('click', () => {
  if (!receipt) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2) + '\n'], { type: 'application/json' }));
  const a = node('a');
  a.href = url;
  a.download = 'stock-count-' + receipt.batch_id + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

if (pending) {
  skuInput.value = pending.data.items.map(row => row.sku).join('\n');
  batchInput.value = pending.batch;
  sessionInput.value = pending.data.count_session;
  reasonInput.value = pending.data.reason;
  showPending();
  setMessage('status', '這一批盤點等待確認。');
}
controls();
const locationQuery = new URLSearchParams(location.search);
try {
  const back = new URL(locationQuery.get('from') ?? '', location.origin);
  if (back.origin === location.origin && back.pathname === '/workbench/stock-count-history')
    by('history-link').href = back.pathname + back.search;
} catch {}
const linkedBatch = locationQuery.get('batch');
if (/^[A-Za-z0-9_-]{1,80}$/.test(linkedBatch ?? '')) {
  by('lookup-batch').value = linkedBatch;
  lookup.requestSubmit();
}
