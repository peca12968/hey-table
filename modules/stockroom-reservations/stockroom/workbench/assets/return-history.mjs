const byId = id => document.getElementById(id);
const lookup = byId('lookup'), batch = byId('batch'), filter = byId('filter'), error = byId('error');
const first = byId('first'), more = byId('more'), download = byId('download');
const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const clock = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei' });
let snapshot = null, laterPage = false, busy = false;

const name = box => box.reservation_id + ' 單／' + box.shipment_id + ' 箱';
const make = (tag, value) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  return node;
};
const timeNode = ms => {
  const time = make('time', clock.format(ms));
  time.dateTime = new Date(ms).toISOString();
  return time;
};
const counts = info => '合格入庫 ' + info.sellable + ' 件，初驗隔離 ' + info.quarantined + ' 件，複驗回庫 ' +
  info.restocked + ' 件，報廢 ' + info.discarded + ' 件，仍待複驗 ' + info.remaining + ' 件';

function render() {
  const { batch_id, summary, boxes, captured_at_ms, received_at_ms, dispositions, box_filter } = snapshot;
  const time = byId('captured');
  time.replaceChildren(batch_id + ' · ', received_at_ms === null ? '驗收時間未記錄' : timeNode(received_at_ms),
    ' · 擷取時間 ', timeNode(captured_at_ms));
  byId('summary').textContent = '全批合計 · ' + counts(summary);
  byId('balances').replaceChildren(...boxes.map(box =>
    make('li', name(box) + ' · ' + box.sku + ' · ' + counts(box))));
  const quarantine = byId('quarantine');
  quarantine.href = '/workbench/quarantine?batch=' + encodeURIComponent(batch_id);
  quarantine.hidden = summary.remaining === 0;
  const all = make('option', '所有箱件');
  all.value = '';
  filter.replaceChildren(all, ...boxes.map(box => {
    const choice = make('option', name(box) + ' · ' + box.sku);
    choice.value = box.reservation_id + '/' + box.shipment_id;
    return choice;
  }));
  filter.value = box_filter ? box_filter.reservation_id + '/' + box_filter.shipment_id : '';
  byId('dispositions').replaceChildren(...dispositions.map(disposition => {
    const item = make('li');
    const details = make('details');
    details.open = true;
    const heading = make('summary', disposition.disposition_id + ' · ');
    heading.append(timeNode(disposition.recorded_at_ms));
    const changes = make('ul');
    changes.append(...disposition.boxes.map(box => make('li', name(box) + ' · 回庫 ' + box.restock + ' 件，報廢 ' +
      box.discard + ' 件，當時剩 ' + box.remaining_after + ' 件 · ' + box.reason)));
    details.append(heading, changes);
    item.append(details);
    return item;
  }));
  byId('updates').textContent = dispositions.length ? '本頁 ' + dispositions.length + ' 張複驗單。' :
    (laterPage ? '此頁沒有較早的複驗單。' : '目前沒有符合條件的複驗單。');
  byId('inspection').hidden = byId('history').hidden = false;
  first.hidden = !laterPage;
  more.hidden = !snapshot.next;
}

async function load(id, selected = '', cursor = null) {
  if (busy) return;
  busy = true;
  error.hidden = true;
  const controls = [...lookup.elements, filter, first, more, download];
  for (const control of controls) control.disabled = true;
  try {
    const query = new URLSearchParams();
    if (selected) {
      const [reservation, shipment] = selected.split('/');
      query.set('reservation_id', reservation);
      query.set('shipment_id', shipment);
    }
    const address = new URLSearchParams({ batch: id, ...Object.fromEntries(query) });
    if (cursor) {
      query.set('before_recorded_at_ms', cursor.before_recorded_at_ms);
      query.set('before_disposition_id', cursor.before_disposition_id);
    }
    const response = await fetch('/return-inspections/' + encodeURIComponent(id) + '/history?' + query,
      { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error(), { status: response.status });
    snapshot = await response.json();
    laterPage = Boolean(cursor);
    history.replaceState(null, '', '?' + address);
    render();
  } catch (failure) {
    error.textContent = failure.status === 404 ? '找不到這個驗收批或箱件。' : '暫時無法查詢驗收歷程。';
    error.hidden = false;
    if (snapshot?.batch_id === id) {
      const old = snapshot.box_filter;
      filter.value = old ? old.reservation_id + '/' + old.shipment_id : '';
    } else {
      snapshot = null;
      byId('inspection').hidden = byId('history').hidden = true;
    }
  } finally {
    busy = false;
    for (const control of controls) control.disabled = false;
  }
}

lookup.addEventListener('submit', event => {
  event.preventDefault();
  void load(batch.value);
});
filter.addEventListener('change', () => void load(snapshot.batch_id, filter.value));
first.addEventListener('click', () => void load(snapshot.batch_id, filter.value));
more.addEventListener('click', () => void load(snapshot.batch_id, filter.value, snapshot.next));
download.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2) + '\n'], { type: 'application/json' }));
  const link = make('a');
  link.href = url;
  link.download = 'return-history-' + snapshot.batch_id + '-' + snapshot.captured_at_ms + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

const address = new URLSearchParams(location.search);
const initial = address.get('batch'), reservation = address.get('reservation_id'), shipment = address.get('shipment_id');
if (initial && idPattern.test(initial)) {
  batch.value = initial;
  void load(initial, reservation && shipment && idPattern.test(reservation) && idPattern.test(shipment) ?
    reservation + '/' + shipment : '');
}
