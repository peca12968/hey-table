const byId = id => document.getElementById(id);
const batchForm = byId('batch-form'), decisionForm = byId('decision-form'), receiptForm = byId('receipt-form');
const batchInput = byId('batch'), lookupBatch = byId('lookup-batch'), lookupId = byId('lookup-id');
const balancePanel = byId('balances'), reviewPanel = byId('review-panel'), receiptPanel = byId('receipt-panel');
const submit = byId('submit'), edit = byId('edit');
const pendingKey = 'stockroom.quarantine.pending.v1';
const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const clock = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium',
});
let snapshot = null, inputs = [], receipt = null, draft = null, pending = readPending(), busy = false;

function readPending() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(pendingKey));
    if (saved && typeof saved.batch === 'string' && typeof saved.operation === 'string' &&
        idPattern.test(saved.batch) && idPattern.test(saved.operation) &&
        Array.isArray(saved.boxes) && saved.boxes.length) return saved;
  } catch { /* An unavailable storage area still permits a new review. */ }
  return null;
}

function remember(value) {
  try {
    if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value));
    else sessionStorage.removeItem(pendingKey);
    return true;
  } catch { return false; }
}

function setMessage(id, text = '') {
  const node = byId(id);
  node.textContent = text;
  node.hidden = !text;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function setDisabled(form, value) {
  for (const input of form.elements) input.disabled = value;
}

function refreshControls() {
  const frozen = Boolean(draft || pending);
  setDisabled(batchForm, busy || frozen);
  setDisabled(decisionForm, busy || frozen);
  setDisabled(receiptForm, busy);
  submit.disabled = busy;
  submit.textContent = busy ? '正在核對…' : pending ? '重試原複驗單' : '確認登記';
  edit.hidden = Boolean(pending);
  edit.disabled = busy;
}

function root(batch) {
  return '/return-inspections/' + encodeURIComponent(batch);
}

async function request(path, options) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(10000), ...options });
  if (!response.ok) {
    const error = new Error('Stockroom HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function numberInput(labelText, limit) {
  const label = element('label', labelText), input = element('input');
  input.type = 'number';
  input.min = '0';
  input.max = String(limit);
  input.step = '1';
  input.value = '0';
  input.inputMode = 'numeric';
  input.required = true;
  label.append(input);
  return [label, input];
}

function drawBalances() {
  balancePanel.hidden = !snapshot;
  inputs = [];
  if (!snapshot) return;
  const list = byId('box-list');
  list.replaceChildren();
  for (const box of snapshot.boxes) {
    const fieldset = element('fieldset');
    fieldset.append(element('legend', box.reservation_id + ' 單／' + box.shipment_id + ' 箱'));
    fieldset.append(element('p', '待處理 ' + box.remaining + ' 件 · 已回庫 ' + box.restocked +
      ' 件 · 已報廢 ' + box.discarded + ' 件', 'meta'));
    if (box.remaining > 0) {
      const fields = element('div', null, 'box-fields');
      const [restockLabel, restock] = numberInput('回庫件數', box.remaining);
      const [discardLabel, discard] = numberInput('報廢件數', box.remaining);
      const reasonLabel = element('label', '複驗原因', 'reason'), reason = element('input');
      reason.maxLength = 160;
      reasonLabel.append(reason);
      fields.append(restockLabel, discardLabel, reasonLabel);
      fieldset.append(fields);
      inputs.push({ box, restock, discard, reason });
    }
    list.append(fieldset);
  }
  byId('balance-summary').textContent = snapshot.boxes.length ? snapshot.batch_id + ' · 尚待處理 ' +
    snapshot.boxes.reduce((sum, row) => sum + row.remaining, 0) + ' 件' : '這個驗收批沒有隔離品。';
  byId('draft-actions').hidden = inputs.length === 0;
}

async function loadBatch(batch) {
  snapshot = null;
  drawBalances();
  const result = await request(root(batch) + '/quarantine');
  if (result.batch_id !== batch || !Array.isArray(result.boxes)) throw new Error('Unexpected batch');
  snapshot = result;
  drawBalances();
}

function showReview() {
  const choice = pending ?? draft;
  reviewPanel.hidden = !choice;
  if (choice) {
    byId('operation').textContent = choice.batch + ' · 複驗單 ' + choice.operation;
    byId('review-list').replaceChildren(...choice.boxes.map(box => element('li',
      box.shipment_id + ' 箱 · 回庫 ' + box.restock + ' 件 · 報廢 ' + box.discard + ' 件 · ' + box.reason)));
  }
  refreshControls();
}

function validateReceipt(result, batch, operation, boxes = null) {
  if (result.batch_id !== batch || result.disposition_id !== operation || !Array.isArray(result.boxes) || !result.boxes.length)
    throw new Error('Unexpected receipt');
  if (boxes && (result.boxes.length !== boxes.length || boxes.some(box => !result.boxes.some(saved =>
    saved.reservation_id === box.reservation_id && saved.shipment_id === box.shipment_id &&
      saved.restock === box.restock && saved.discard === box.discard && saved.reason === box.reason &&
      saved.remaining_after === box.expected_remaining - box.restock - box.discard))))
    throw new Error('Receipt differs from the submitted review');
  return result;
}

function showReceipt(result) {
  const at = clock.format(result.boxes[0].recorded_at_ms);
  receipt = result;
  receiptPanel.hidden = false;
  byId('receipt-id').textContent = result.batch_id + ' · 複驗單 ' + result.disposition_id + ' · ' + at;
  byId('receipt-list').replaceChildren(...result.boxes.map(box => element('li',
    box.shipment_id + ' 箱 · 回庫 ' + box.restock + ' 件 · 報廢 ' + box.discard +
      ' 件 · 剩餘 ' + box.remaining_after + ' 件 · ' + box.reason)));
  lookupBatch.value = result.batch_id;
  lookupId.value = result.disposition_id;
}

batchForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || pending || draft) return;
  busy = true;
  refreshControls();
  setMessage('status');
  setMessage('error');
  try {
    await loadBatch(batchInput.value);
  } catch (error) {
    setMessage('error', error.status === 404 ? '找不到此驗收批。' : '暫時無法讀取隔離餘額。');
  } finally {
    busy = false;
    refreshControls();
  }
});

decisionForm.addEventListener('submit', event => {
  event.preventDefault();
  if (busy || pending || draft || !snapshot) return;
  setMessage('error');
  setMessage('status');
  const boxes = [];
  for (const { box, restock, discard, reason } of inputs) {
    const back = Number(restock.value), scrap = Number(discard.value), why = reason.value.trim();
    if (back + scrap === 0) continue;
    if (!Number.isSafeInteger(back) || !Number.isSafeInteger(scrap) || back < 0 || scrap < 0 || back + scrap > box.remaining) {
      setMessage('error', box.shipment_id + ' 箱的回庫與報廢合計超過待處理件數。');
      restock.focus();
      return;
    }
    if (!why) {
      setMessage('error', '請填寫 ' + box.shipment_id + ' 箱的複驗原因。');
      reason.focus();
      return;
    }
    boxes.push({ reservation_id: box.reservation_id, shipment_id: box.shipment_id,
      restock: back, discard: scrap, expected_remaining: box.remaining, reason: why });
  }
  if (!boxes.length) {
    setMessage('error', '請至少填寫 1 件要回庫或報廢的隔離品。');
    return;
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  const operation = 'review-' + Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
  draft = { batch: snapshot.batch_id, operation, boxes };
  showReview();
  submit.focus();
});

edit.addEventListener('click', () => {
  draft = null;
  showReview();
  byId('review').focus();
});

submit.addEventListener('click', async () => {
  if (busy || !(pending || draft)) return;
  const retry = Boolean(pending);
  pending ??= draft;
  draft = null;
  const { batch, operation, boxes } = pending;
  const endpoint = root(batch) + '/dispositions';
  const persisted = remember(pending);
  busy = true;
  showReview();
  setMessage('status');
  setMessage('error');
  let posting = false;
  try {
    let result, recovered = false;
    if (retry) {
      try { result = await request(endpoint + '/' + encodeURIComponent(operation)); recovered = true; }
      catch (error) { if (error.status !== 404) throw error; }
    }
    if (!result) {
      posting = true;
      result = await request(endpoint, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Idempotency-Key': operation,
      }, body: JSON.stringify({ boxes }) });
    }
    showReceipt(validateReceipt(result, batch, operation, boxes));
    pending = null;
    remember(null);
    setMessage('status', recovered ? '已取回原複驗收據。' : '已保存複驗收據。');
    try { await loadBatch(batch); }
    catch { setMessage('error', '收據已取回。暫時無法重讀隔離餘額。'); }
  } catch (error) {
    if (posting && [400, 403, 404, 409, 422].includes(error.status)) {
      pending = null;
      remember(null);
      setMessage('error', error.status === 409 ? '隔離餘額有變，整批未登記。請重新核對。' : '這筆複驗未能登記，請重新核對。');
      try { await loadBatch(batch); }
      catch { setMessage('error', '這筆複驗未能登記。請重新查詢驗收批。'); }
    } else {
      setMessage('error', '尚未收到複驗結果，請重試原複驗單。' + (persisted ? '' : '此分頁無法暫存，請保持開啟。'));
    }
  } finally {
    busy = false;
    showReview();
  }
});

receiptForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  refreshControls();
  setMessage('error');
  setMessage('status');
  const batch = lookupBatch.value, operation = lookupId.value;
  try {
    const result = await request(root(batch) + '/dispositions/' + encodeURIComponent(operation));
    showReceipt(validateReceipt(result, batch, operation));
    setMessage('status', '已取回原複驗收據。');
  } catch (error) {
    receipt = null;
    receiptPanel.hidden = true;
    setMessage('error', error.status === 404 ? '找不到此複驗收據。' : '暫時無法讀取複驗收據。');
  } finally {
    busy = false;
    refreshControls();
  }
});

byId('download').addEventListener('click', () => {
  if (!receipt) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2) + '\n'], { type: 'application/json' }));
  const link = element('a');
  link.href = url;
  link.download = receipt.batch_id + '-' + receipt.disposition_id + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

if (pending) {
  batchInput.value = pending.batch;
  setMessage('status', '有一筆複驗等待確認結果。');
  showReview();
} else {
  const batch = new URLSearchParams(location.search).get('batch');
  if (batch && idPattern.test(batch)) {
    batchInput.value = batch;
    batchForm.requestSubmit();
  }
}
