const byId = id => document.getElementById(id);
const draft = byId('draft'), batchInput = byId('batch'), boxes = byId('boxes');
const add = byId('add'), confirm = byId('confirm'), lookup = byId('lookup-form');
const review = byId('review'), receiptPanel = byId('receipt');
const storageKey = 'stockroom.pending-return-inspection.v1';
const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const labelPattern = /^DW1\/([A-Za-z0-9_-]{1,80})\/([A-Za-z0-9_-]{1,80})\/([1-9][0-9]{0,6})$/;
const count = value => Number.isInteger(value) && value >= 0 && value <= 1_000_000;
let pending = restorePending(), preview = null, receipt = null, busy = false;

function message(id, text = '') {
  const area = byId(id);
  area.textContent = text;
  area.hidden = !text;
}

function remember(value) {
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

function validBox(box) {
  return box && typeof box.reservation_id === 'string' && idPattern.test(box.reservation_id) &&
    typeof box.shipment_id === 'string' && idPattern.test(box.shipment_id) &&
    count(box.sellable) && count(box.quarantined) && count(box.sellable + box.quarantined) &&
    box.sellable + box.quarantined > 0;
}

function restorePending() {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey));
    return value && typeof value.batch === 'string' && idPattern.test(value.batch) &&
      Array.isArray(value.boxes) && value.boxes.length > 0 && value.boxes.length <= 100 &&
      value.boxes.every(box => validBox(box) && count(box.label_quantity) && box.label_quantity > 0) ? value : null;
  } catch {
    return null;
  }
}

function refreshControls() {
  for (const control of draft.elements) control.disabled = busy || Boolean(pending);
  add.disabled = busy || Boolean(pending) || boxes.children.length >= 100;
  for (const remove of boxes.querySelectorAll('[data-remove]')) {
    remove.disabled = busy || Boolean(pending) || boxes.children.length === 1;
  }
  for (const control of lookup.elements) control.disabled = busy;
  review.hidden = !pending && !preview;
  confirm.textContent = pending ? '重試原驗收批次' : '確認整批驗收';
  confirm.disabled = busy || (!pending && !preview?.can_receive);
}

function addBox(values) {
  const row = byId('box-template').content.firstElementChild.cloneNode(true);
  if (values) {
    row.querySelector('[name=barcode]').value =
      'DW1/' + values.reservation_id + '/' + values.shipment_id + '/' + values.label_quantity;
    row.querySelector('[name=sellable]').value = values.sellable;
    row.querySelector('[name=quarantined]').value = values.quarantined;
  }
  boxes.append(row);
  numberBoxes();
  return row.querySelector('[name=barcode]');
}

function numberBoxes() {
  Array.from(boxes.children).forEach((row, index) => {
    row.querySelector('legend').textContent = '箱件 ' + (index + 1);
  });
}

function clearPreview() {
  preview = null;
  message('error');
  message('status');
  refreshControls();
}

function readDraft() {
  const seen = new Set();
  return Array.from(boxes.children, (row, index) => {
    const label = labelPattern.exec(row.querySelector('[name=barcode]').value.trim());
    if (!label || Number(label[3]) > 1_000_000) throw new Error('箱件 ' + (index + 1) + ' 的原出貨條碼格式有誤。');
    const [, reservation_id, shipment_id, quantity] = label;
    const box = { reservation_id, shipment_id, label_quantity: Number(quantity),
      sellable: row.querySelector('[name=sellable]').valueAsNumber,
      quarantined: row.querySelector('[name=quarantined]').valueAsNumber };
    if (!validBox(box)) throw new Error('箱件 ' + (index + 1) + ' 的合格與隔離件數合計須為 1 至 100 萬件。');
    const key = reservation_id + '/' + shipment_id;
    if (seen.has(key)) throw new Error(key + ' 已掃描，請在同一箱件輸入驗收件數。');
    seen.add(key);
    return box;
  });
}

async function request(path, options) {
  const response = await fetch(path, { cache: 'no-store', redirect: 'error', ...options });
  if (!response.ok) throw Object.assign(new Error(), { status: response.status });
  return response.json();
}

function post(path, boxes, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  return request(path, { method: 'POST', headers, body: JSON.stringify({ boxes }) });
}

const inspection = '/return-inspections';
const receiptPath = batch => inspection + '/' + encodeURIComponent(batch);
const boxName = box => box.reservation_id + ' 單／' + box.shipment_id + ' 箱';
const conditions = box => '合格 ' + box.sellable + ' 件，隔離 ' + box.quarantined + ' 件';

function renderLines(id, rows) {
  byId(id).replaceChildren(...rows.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
}

async function loadPreview(current) {
  const result = await post(inspection + '/preview', current.boxes);
  const states = {
    ready: box => '可驗收',
    unknown_shipment: box => '找不到原出貨箱件',
    label_mismatch: box => '條碼標示 ' + box.label_quantity + ' 件，原出貨紀錄為 ' + box.dispatched + ' 件',
    insufficient_returnable: box => '本次件數超過尚可驗收件數',
  };
  renderLines('review-lines', result.boxes.map(box => {
    const available = box.returnable === null ? '' : ' · ' + box.sku + ' · 尚可驗收 ' + box.returnable + ' 件';
    return boxName(box) + available + ' · ' + conditions(box) + ' · ' + states[box.status](box);
  }));
  byId('summary').textContent = result.can_receive ?
    current.batch + ' · ' + current.boxes.length + ' 箱已核對' :
    current.batch + ' · 請修正標示的箱件後重新預覽';
  preview = { ...current, can_receive: result.can_receive };
}

function showReceipt(result, batch, expected) {
  if (result?.batch_id !== batch || !Array.isArray(result.boxes) || !result.boxes.length ||
      !result.boxes.every(box => validBox(box) && count(box.returnable_after))) throw new Error('收據格式有誤');
  if (expected && (expected.length !== result.boxes.length || expected.some(box =>
    !result.boxes.some(saved => saved.reservation_id === box.reservation_id && saved.shipment_id === box.shipment_id &&
      saved.sellable === box.sellable && saved.quarantined === box.quarantined)))) {
    throw Object.assign(new Error(), { status: 409 });
  }
  receipt = result;
  byId('saved-batch').textContent = result.batch_id + ' · ' + result.boxes.length + ' 箱';
  renderLines('saved-lines', result.boxes.map(box =>
    boxName(box) + ' · ' + conditions(box) + ' · 驗收後尚可退 ' + box.returnable_after + ' 件'));
  const quarantine = byId('quarantine');
  quarantine.href = '/workbench/quarantine?batch=' + encodeURIComponent(batch);
  quarantine.hidden = !result.boxes.some(box => box.quarantined > 0);
  byId('return-history').href = '/workbench/return-history?batch=' + encodeURIComponent(batch);
  receiptPanel.hidden = false;
  byId('receipt-key').value = batch;
}

draft.addEventListener('input', clearPreview);
boxes.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.name === 'barcode') {
    event.preventDefault();
    event.target.closest('fieldset').querySelector('[name=sellable]').focus();
  }
});
boxes.addEventListener('click', event => {
  if (event.target.matches('[data-remove]')) {
    event.target.closest('fieldset').remove();
    numberBoxes();
    clearPreview();
  }
});
add.addEventListener('click', () => {
  const barcode = addBox();
  clearPreview();
  barcode.focus();
});

draft.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || pending) return;
  clearPreview();
  let current;
  try {
    current = { batch: batchInput.value, boxes: readDraft() };
  } catch (error) {
    message('error', error.message);
    return;
  }
  busy = true;
  refreshControls();
  try {
    await loadPreview(current);
  } catch {
    message('error', '暫時無法預覽退貨驗收。');
  } finally {
    busy = false;
    refreshControls();
  }
});

confirm.addEventListener('click', async () => {
  if (busy || (!pending && !preview?.can_receive)) return;
  const retry = Boolean(pending);
  pending ??= { batch: preview.batch, boxes: preview.boxes };
  const current = pending;
  const persisted = remember(current);
  busy = true;
  preview = null;
  message('error');
  message('status');
  byId('summary').textContent = current.batch + ' · 等待驗收結果';
  renderLines('review-lines', current.boxes.map(box => boxName(box) + ' · ' + conditions(box)));
  refreshControls();
  try {
    let result;
    if (retry) {
      try {
        result = await request(receiptPath(current.batch));
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    if (!result) {
      const rows = current.boxes.map(({ label_quantity, ...box }) => box);
      result = await post(inspection, rows, current.batch);
    }
    showReceipt(result, current.batch, current.boxes);
    pending = null;
    remember(null);
    batchInput.value = '';
    boxes.replaceChildren();
    addBox();
    message('status', retry ? '已取回原驗收收據。' : '已登記整批退貨。');
  } catch (error) {
    if ([404, 409, 422].includes(error.status)) {
      pending = null;
      remember(null);
      try {
        await loadPreview(current);
      } catch {
        message('error', '請重新預覽後確認箱件。');
      }
      if (preview) {
        const issue = preview.can_receive && error.status === 409 ?
          '這個驗收批號已被其他箱件使用，請更換批號。' : '箱件紀錄已更新，整批未登記。請重新核對。';
        message('error', issue);
        if (preview.can_receive && error.status === 409) preview = null;
      }
    } else {
      message('error', '尚未收到驗收結果，請重試原驗收批次。' + (persisted ? '' : '此分頁無法暫存，請保持開啟。'));
    }
  } finally {
    busy = false;
    refreshControls();
  }
});

lookup.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  refreshControls();
  message('error');
  message('status');
  const batch = byId('receipt-key').value;
  try {
    showReceipt(await request(receiptPath(batch)), batch);
    message('status', '已取回驗收收據。');
  } catch (error) {
    receipt = null;
    receiptPanel.hidden = true;
    message('error', error.status === 404 ? '找不到此驗收收據。' : '暫時無法讀取驗收收據。');
  } finally {
    busy = false;
    refreshControls();
  }
});

byId('download').addEventListener('click', () => {
  if (!receipt) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = receipt.batch_id + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

if (pending) {
  batchInput.value = pending.batch;
  pending.boxes.forEach(addBox);
  byId('summary').textContent = pending.batch + ' · 等待驗收結果';
  renderLines('review-lines', pending.boxes.map(box => boxName(box) + ' · ' + conditions(box)));
  message('status', '有一批退貨等待確認結果。');
} else {
  addBox();
}
refreshControls();
