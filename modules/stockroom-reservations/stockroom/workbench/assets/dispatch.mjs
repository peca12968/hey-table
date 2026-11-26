const byId = id => document.getElementById(id);
const draft = byId('draft'), batch = byId('batch'), boxes = byId('boxes'), ship = byId('ship'), lookupKey = byId('receipt-key');
const upload = byId('manifest'), importOrder = byId('import-order');
const pendingKey = 'stockroom.dispatch.pending.v1';
const endpoint = '/dispatch-batches';
const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const times = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23',
});
let busy = false, reviewed = null, preview = null, receipt = null, imports = [];

const validId = value => typeof value === 'string' && idPattern.test(value);
const boxKey = box => box.reservation_id + '/' + box.shipment_id;
function validBoxes(items) {
  return Array.isArray(items) && items.length >= 1 && items.length <= 100 && items.every(box =>
    box && validId(box.reservation_id) && validId(box.shipment_id) && Number.isInteger(box.quantity) &&
    box.quantity >= 1 && box.quantity <= 1_000_000) && new Set(items.map(boxKey)).size === items.length;
}
function validWindow(window) {
  return Number.isSafeInteger(window?.not_before_ms) && Number.isSafeInteger(window.before_ms) &&
    window.not_before_ms >= 0 && window.before_ms > window.not_before_ms;
}

function manifestJobs(manifest) {
  const { load_check: check, jobs } = manifest ?? {};
  if (manifest?.format !== 'dispatch-window.workbench.v1' || check?.format !== 'dispatch-window.load-check.v1' ||
      check.ready !== true || !Array.isArray(check.issues) || check.issues.length ||
      !Array.isArray(check.missing) || check.missing.length || !Array.isArray(jobs) || jobs.length < 1 || jobs.length > 17)
    throw new Error('Incomplete load check');
  const reservations = new Set(), batches = new Set();
  let verifiedBoxes = 0, verifiedUnits = 0;
  const parsed = jobs.map(job => {
    const { reservation_id, batch_id, boxes, window } = job ?? {};
    if (!validId(reservation_id) || reservations.has(reservation_id) ||
        typeof batch_id !== 'string' || !/^dispatch-[a-f0-9]{64}$/.test(batch_id) ||
        batches.has(batch_id) || !validWindow(window) || !validBoxes(boxes) || boxes.some(box => box.reservation_id !== reservation_id))
      throw new Error('Invalid scheduled box list');
    const units = boxes.reduce((total, box) => total + box.quantity, 0);
    if (job.units !== units) throw new Error('Wrong scheduled quantity');
    reservations.add(reservation_id);
    batches.add(batch_id);
    verifiedBoxes += boxes.length;
    verifiedUnits += units;
    return { batch: batch_id, boxes: boxes.map(({reservation_id, shipment_id, quantity}) => ({reservation_id, shipment_id, quantity})),
      window: { not_before_ms: window.not_before_ms, before_ms: window.before_ms } };
  });
  if (verifiedBoxes !== check.verified_boxes || verifiedUnits !== check.verified_units) throw new Error('Wrong load totals');
  return parsed;
}

let pending = readPending();
let imported = pending?.window ? pending : null;

function readPending() {
  try {
    const data = JSON.parse(sessionStorage.getItem(pendingKey));
    if (validId(data?.batch) && validBoxes(data.boxes) && (data.window === undefined || validWindow(data.window))) return data;
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

async function request(path, body, batchId) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (batchId) headers['Idempotency-Key'] = batchId;
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers, cache: 'no-store',
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw Object.assign(new Error('Stockroom request failed'), { status: response.status });
  return response.json();
}

function message(kind, text = '') {
  const node = byId(kind);
  node.hidden = !text;
  node.textContent = text;
}

function lines(target, items) {
  byId(target).replaceChildren(...items.map(text => {
    const row = document.createElement('li');
    row.textContent = text;
    return row;
  }));
}

function windowState(window, at) {
  if (!window) return null;
  if (at < window.not_before_ms) return 'waiting';
  if (at >= window.before_ms) return 'expired';
  return 'due';
}

const windowLabels = { waiting: '尚未到交運時間，請稍後重新預覽。', expired: '交運已截止，請重新排程。', due: '目前在交運時窗內。' };
const stamp = at => at <= 8_640_000_000_000_000 ? times.format(at) : at + ' ms';
const canSubmit = () => preview?.can_dispatch && (!reviewed?.window || windowState(reviewed.window, preview.captured_at_ms) === 'due');

function render() {
  const locked = busy || pending !== null;
  for (const control of draft.elements) control.disabled = locked || (imported !== null && control.id !== 'preview-button');
  [...boxes.children].forEach((box, index) => {
    box.querySelector('legend').textContent = '箱件 ' + (index + 1);
    box.querySelector('[data-remove]').disabled = locked || imported !== null || boxes.children.length === 1;
  });
  byId('add').disabled ||= boxes.children.length >= 100;
  upload.disabled = importOrder.disabled = byId('use-import').disabled = byId('use-manual').disabled = locked;
  byId('import-actions').hidden = imports.length === 0;
  byId('use-manual').hidden = imported === null;
  const importSummary = byId('import-summary');
  importSummary.hidden = imported === null && !imports.length;
  importSummary.textContent = imported ? '已載入 ' + imported.boxes[0].reservation_id + ' · ' + imported.boxes.length + ' 箱' :
    '已核對 ' + imports.length + ' 張排程訂單，請選擇要交運的一張。';
  byId('lookup').disabled = lookupKey.disabled = locked;
  byId('review').hidden = !pending && !preview;
  byId('receipt').hidden = !receipt;
  ship.hidden = !pending && !canSubmit();
  ship.disabled = busy;
  ship.textContent = pending ? '重試原交運批次' : '確認整車交運';
  if (pending) {
    byId('summary').textContent = '待確認批號 ' + pending.batch;
    lines('review-lines', pending.boxes.map(box => boxKey(box) + ' · ' + box.quantity + ' 件'));
  }
  const window = (pending ?? reviewed)?.window, windowLine = byId('review-window');
  windowLine.hidden = !window;
  if (window) {
    const timing = preview && !pending ? windowLabels[windowState(window, preview.captured_at_ms)] : '';
    windowLine.textContent = '交運時窗（台灣時間）' + stamp(window.not_before_ms) + ' 至 ' + stamp(window.before_ms) + '。' + timing;
  }
}

function addBox(values = {}) {
  const row = byId('box-template').content.firstElementChild.cloneNode(true);
  for (const input of row.querySelectorAll('input')) input.value = values[input.name] ?? '';
  row.querySelector('[data-remove]').addEventListener('click', () => {
    row.remove();
    invalidate();
    batch.focus();
  });
  boxes.append(row);
}

function invalidate() {
  reviewed = preview = null;
  message('error');
  message('status');
  render();
}

function showPreview(result) {
  preview = result;
  byId('summary').textContent = times.format(result.captured_at_ms) + '（台灣時間） · ' +
    (result.can_dispatch ? '箱件保留量足夠' : imported ? '箱件保留量有變，請核對現況後重新排程' : '請修正箱單後重新預覽');
  lines('review-lines', result.boxes.map(box => {
    const detail = {
      ready: '保留量 ' + box.held_before + ' → ' + box.held_after,
      unknown_reservation: '查無保留單',
      already_shipped: '箱號已出貨',
      insufficient_held: '保留量 ' + box.held_before + ' · 缺 ' + box.shortfall + ' 件',
    }[box.status];
    return boxKey(box) + ' · ' + (box.sku ? box.sku + ' · ' : '') + box.quantity + ' 件 · ' + detail;
  }));
}

function showReceipt(result, batchId, expected) {
  if (result.batch_id !== batchId || !validBoxes(result.boxes)) throw new Error('Unexpected dispatch receipt');
  if (expected) {
    const quantities = new Map(result.boxes.map(box => [boxKey(box), box.quantity]));
    if (result.boxes.length !== expected.length || expected.some(box => quantities.get(boxKey(box)) !== box.quantity))
      throw Object.assign(new Error('Batch receipt differs from the draft'), { status: 409 });
  }
  receipt = result;
  lookupKey.value = batchId;
  byId('saved-batch').textContent = '交運批號 ' + batchId;
  lines('saved-lines', result.boxes.map(box => boxKey(box) + ' · 已交運 ' + box.quantity +
    ' 件 · 登記後剩餘 ' + box.held_after + ' 件'));
}

byId('add').addEventListener('click', () => {
  addBox();
  invalidate();
  boxes.lastElementChild.querySelector('input').focus();
});
upload.addEventListener('change', async () => {
  const file = upload.files[0];
  if (!file || busy || pending) return;
  busy = true;
  message('error');
  render();
  try {
    if (file.size > 1_048_576) throw new Error('Manifest is too large');
    imports = manifestJobs(JSON.parse(await file.text()));
    importOrder.replaceChildren(...imports.map((job, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = job.boxes[0].reservation_id + ' · ' + job.boxes.length + ' 箱';
      return option;
    }));
  } catch {
    imports = [];
    message('error', '無法匯入。請使用已通過裝車掃碼核對的 JSON 檔。');
  } finally {
    busy = false;
    upload.value = '';
    render();
  }
});

function loadDraft(operation) {
  imported = operation;
  batch.value = operation?.batch ?? '';
  boxes.replaceChildren();
  (operation?.boxes ?? [{}]).forEach(addBox);
  receipt = null;
  invalidate();
}

byId('use-import').addEventListener('click', () => {
  const selected = imports[Number(importOrder.value)];
  if (selected && !busy && !pending) loadDraft(selected);
});
byId('use-manual').addEventListener('click', () => {
  if (!busy && !pending) loadDraft(null);
});
draft.addEventListener('input', invalidate);
draft.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || pending) return;
  const items = [...boxes.children].map(row => Object.fromEntries([...row.querySelectorAll('input')].map(input =>
    [input.name, input.name === 'quantity' ? input.valueAsNumber : input.value])));
  invalidate();
  if (!validId(batch.value) || !validBoxes(items)) {
    message('error', '請確認同一保留單內的箱號各自唯一，並填寫有效的批號與件數。');
    return;
  }
  receipt = null;
  const operation = imported ?? { batch: batch.value, boxes: items };
  busy = true;
  render();
  try {
    if (operation.window) {
      const prior = await findReceipt(operation.batch);
      if (prior) {
        showReceipt(prior, operation.batch, operation.boxes);
        message('status', '已取回同一份掃碼箱單的原交運收據。');
        return;
      }
    }
    showPreview(await request(endpoint + '/preview', { boxes: operation.boxes }));
    reviewed = operation;
  } catch (error) {
    message('error', error.status === 409 ? '原收據與匯入的箱單不同，請按批號核對。' : '暫時無法預覽交運，請重新查詢。');
  } finally {
    busy = false;
    render();
  }
});

async function findReceipt(batchId) {
  try { return await request(endpoint + '/' + encodeURIComponent(batchId)); }
  catch (error) {
    if (error.status !== 404) throw error;
    return null;
  }
}

ship.addEventListener('click', async () => {
  if (busy || (!pending && !canSubmit())) return;
  const retry = pending !== null;
  pending ??= reviewed;
  const operation = pending;
  const saved = remember(operation);
  busy = true;
  message('error');
  message('status');
  render();
  try {
    let result = retry ? await findReceipt(operation.batch) : null;
    result ??= await request(endpoint, { boxes: operation.boxes, ...(operation.window && { window: operation.window }) }, operation.batch);
    showReceipt(result, operation.batch, operation.boxes);
    pending = preview = reviewed = null;
    remember(null);
    message('status', retry ? '已確認原交運批次。' : '已保存整車交運收據。');
  } catch (error) {
    if ([409, 422].includes(error.status)) {
      pending = preview = reviewed = null;
      remember(null);
      message('error', '未登記這份箱單。請核對最新貨量，或按批號查詢原收據。');
      try {
        showPreview(await request(endpoint + '/preview', { boxes: operation.boxes }));
        reviewed = operation;
      } catch { message('error', '未登記這份箱單，請重新預覽。'); }
    } else {
      message('error', '尚未確認交運結果，請重試原批次。' + (saved ? '' : '此分頁無法暫存，請保持開啟。'));
    }
  } finally {
    busy = false;
    render();
  }
});

byId('lookup-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || pending || !validId(lookupKey.value)) return;
  const batchId = lookupKey.value;
  busy = true;
  receipt = null;
  message('error');
  message('status');
  render();
  try {
    showReceipt(await request(endpoint + '/' + encodeURIComponent(batchId)), batchId);
    message('status', '已取回原交運收據。');
  } catch (error) {
    message('error', error.status === 404 ? '找不到此交運收據。' : '暫時無法取回交運收據。');
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
  link.download = receipt.batch_id + '-dispatch.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

if (pending) {
  batch.value = pending.batch;
  pending.boxes.forEach(addBox);
  message('status', '有一筆交運批次等待確認。');
} else {
  addBox();
}
render();
