import {addOnFor} from "./add-ons.mjs";
import {comboVersion,priceCombos} from "../lib/combo-pricing.mjs";
import qrcode from "qrcode-generator";
import {dishes, tables, transitions} from "../lib/menu.mjs";
import {intakeLabels,intakeNotice} from "../lib/order-intake.mjs";
import {businessDayRange} from "../lib/business-day.mjs";

const json = (value, status=200) => Response.json(value,{status,headers:{"Cache-Control":"no-store"}});
const fail = (message,status=400) => json({error:message},status);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

import {latestState,payableForKitchen,paymentApi,checkKitchenPayment} from "./payment-api.mjs";
import {settings} from "./tappay.mjs";
import {methods} from "../lib/payments.mjs";
import {estimate} from "@peca12968/pickup-window";
import {activeKitchen,demoKitchen,importTiming,stationLabels,timingChanges} from "../lib/kitchen-timing.mjs";
import {finishStation,remainingStationItems,stationQueue} from "./station-work.mjs";
const timingRows = "SELECT revision,config FROM kitchen_timing ORDER BY revision DESC";
const fromTimingRow = row => ({revision:row?.revision??0, kitchen:activeKitchen(row ? JSON.parse(row.config) : null)});
const selectOrders = "SELECT orders.*, "+latestState+" AS payment_state FROM orders";
const intakeRows = "SELECT mode,accepting,revision FROM order_intake";
const tableIntakeRows = "SELECT table_no,accepting,revision FROM table_intake";
const modePaused = "EXISTS (SELECT 1 FROM order_intake WHERE mode=? AND accepting=0)";
const tablePaused = "EXISTS (SELECT 1 FROM table_intake WHERE table_no=? AND accepting=0)";
function intakeState(rows,key,scopes) {
  const stored = new Map(rows.map(row=>[row[key],row]));
  return Object.fromEntries(scopes.map(scope=>{
    const row=stored.get(scope);
    return [scope,{accepting:row?.accepting!==0,revision:row?.revision??0}];
  }));
}
const modeState=rows=>intakeState(rows,"mode",Object.keys(intakeLabels));
const tableState=rows=>intakeState(rows,"table_no",tables);
const acceptingOnly=states=>Object.fromEntries(Object.entries(states).map(([scope,state])=>[scope,state.accepting]));
function collectionId(url) {
  const number = url.searchParams.get("id");
  const id = Number(number);
  return /^[0-9]+$/.test(number ?? "") && Number.isSafeInteger(id) && id > 0 ? id : null;
}
function receipt(row) {
  return {id:row.id, mode:row.mode, table:row.table_no, note:row.note, items:JSON.parse(row.items),
    ...(row.combo_quote ? {combo:JSON.parse(row.combo_quote)} : {}),
    paymentMethod:row.payment_method,paymentEnv:row.payment_env,paymentState:row.payment_state??'unpaid',total:row.total, status:row.status, created:row.created};
}
function statusHistory(row) {
  const history = [{status:"pending",at:row.created}];
  for (const {from,status,at} of JSON.parse(row.status_history ?? "[]")) {
    if (history.at(-1).status !== from) history.push({status:from,at:null});
    history.push({status,at});
  }
  if (history.at(-1).status !== row.status) history.push({status:row.status,at:null});
  return history;
}
function kitchenSchedule(rows, timing, cart) {
  const capturedAt = Date.now();
  const orders = rows.map(({id,created,status,...row}) => ({id,created,status,items:remainingStationItems(row)}));
  const snapshot = {format:"hey-table.station-orders.v1",capturedAt,throughId:orders[0]?.id??0,orders};
  const {kitchen}=fromTimingRow(timing);
  const plan=estimate(snapshot,kitchen,cart);
  return {plan, timingSource:timingChanges(demoKitchen,kitchen).length?"store":undefined};
}
function receiptTiming(row, queue, timing) {
  try {
    const {plan,timingSource}=kitchenSchedule(queue,timing);
    const order=plan.orders.find(entry=>entry.orderId===row.id);
    return order && {capturedAt:plan.capturedAt,seconds:order.seconds,timingSource};
  } catch {
    // A historic item can outlive its recipe. Keep the receipt and status available.
    return undefined;
  }
}
function menuItems(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > dishes.length) return null;
  const byId = new Map();
  for (const line of lines) {
    if (!line || !dishes.some(d => d.id === line.id) || byId.has(line.id) ||
        !Number.isInteger(line.qty) || line.qty < 1 || line.qty > 20) return null;
    byId.set(line.id,line.qty);
  }
  return dishes.filter(d => byId.has(d.id)).map(({id,name,price}) => ({id,name,price,qty:byId.get(id)}));
}
function prepare(input) {
  if (!uuid.test(input.token) || typeof input.mode!=="string" || !Object.hasOwn(intakeLabels,input.mode) ||
      (input.mode === "table" ? !tables.includes(input.table) : input.table != null) ||
      typeof input.note !== "string" || input.note.length > 160) return null;
  const items = menuItems(input.items);
  if (!items) return null;
  return {token:input.token,mode:input.mode,table:input.table??null,note:input.note.trim(),items,
    total:items.reduce((sum,line) => sum + line.qty * line.price,0)};
}

export async function api(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === "/api/qr" && method === "GET") {
    const table = url.searchParams.get("table");
    if (!tables.includes(table)) return fail("桌號無效",404);
    const code = qrcode(0,"M");
    code.addData(url.origin + "/?table=" + table);
    code.make();
    return new Response(code.createSvgTag({cellSize:6,margin:24,scalable:true}),{
      headers:{"Content-Type":"image/svg+xml","Cache-Control":"no-store"}});
  }
  const db = env.DB;
  if (!db) return fail("點餐服務尚未連上資料庫",503);
  if (path.startsWith("/api/kitchen")) {
    const email = request.headers.get("oai-authenticated-user-email");
    const signedIn = env.STAFF_EMAIL && request.headers.get("oai-authenticated-user-id") && email &&
      env.STAFF_EMAIL.toLowerCase() === email.toLowerCase();
    const keyed = env.STAFF_KEY && request.headers.get("Authorization") === "Bearer " + env.STAFF_KEY;
    if (!signedIn && !keyed) {
      // Finish small, length-delimited writes before returning on a reused HTTP connection.
      const length=request.headers.get("Content-Length");
      if(request.body && length && /^\d+$/.test(length) && Number(length)<=8192)await request.arrayBuffer();
      return fail("請以店主管理帳號登入",403);
    }
  }
  if (!["GET","HEAD"].includes(method) && request.headers.get("Origin") && request.headers.get("Origin") !== url.origin)
    return fail("請從本站提交",403);
  let input;
  if (["POST","PATCH"].includes(method)) {
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return fail("需要 JSON",415);
    try { input = await request.json(); } catch {return fail("資料格式錯誤");}
    if (!input || typeof input !== "object") return fail("資料格式錯誤");
  }
  if(path==="/api/kitchen/payment" && method==="PATCH")return checkKitchenPayment(env,input.id);
  if(path==="/api/kitchen/timing" && method==="GET"){
    const {results}=await db.prepare(timingRows+" LIMIT 2").all();
    return json({current:fromTimingRow(results[0]),previous:results.length ? fromTimingRow(results[1]) : null});
  }
  if(path==="/api/kitchen/timing" && method==="PATCH"){
    if(!Number.isSafeInteger(input.revision)||input.revision<0||input.revision>=Number.MAX_SAFE_INTEGER)return fail("版本編號無效");
    let kitchen;
    try{kitchen=importTiming(input.kitchen);}catch(e){return fail(e.message);}
    const current=fromTimingRow(await db.prepare(timingRows+" LIMIT 1").first());
    if(current.revision!==input.revision)return fail("工時已由其他店員更新，請重新載入並比較。",409);
    if(!timingChanges(current.kitchen,kitchen).length)return json(current);
    const revision=input.revision+1;
    const result=await db.prepare(`INSERT INTO kitchen_timing(revision,config) SELECT ?,?
      WHERE COALESCE((SELECT MAX(revision) FROM kitchen_timing),0)=?`)
      .bind(revision,JSON.stringify(kitchen),input.revision).run();
    if(!result.meta.changes)return fail("工時已由其他店員更新，請重新載入並比較。",409);
    return json({revision,kitchen});
  }
  if(path.startsWith("/api/payments/") && method==="POST")return paymentApi(path,request,env,input);
  if (path === "/api/kitchen/intake" && method === "GET") {
    const [modes,seats]=await db.batch([db.prepare(intakeRows),db.prepare(tableIntakeRows)]);
    return json({...modeState(modes.results),tables:tableState(seats.results)});
  }
  if (path === "/api/kitchen/intake" && method === "PATCH") {
    const {mode,table,accepting,revision}=input;
    const byTable=Object.hasOwn(input,"table");
    const validScope=byTable ? !Object.hasOwn(input,"mode") && tables.includes(table)
      : typeof mode==="string" && Object.hasOwn(intakeLabels,mode);
    if (!validScope || typeof accepting!=="boolean" ||
        !Number.isSafeInteger(revision) || revision<0 || revision>=Number.MAX_SAFE_INTEGER)
      return fail("接單管道、桌號、狀態或版本無效");
    const [relation,key,scope]=byTable ? ["table_intake","table_no",table] : ["order_intake","mode",mode];
    const {meta}=await db.prepare(`INSERT INTO ${relation} (${key},accepting,revision)
      SELECT ?,?,? WHERE COALESCE((SELECT revision FROM ${relation} WHERE ${key}=?),0)=?
      ON CONFLICT(${key}) DO UPDATE SET accepting=excluded.accepting,revision=excluded.revision`)
      .bind(scope,accepting?1:0,revision+1,scope,revision).run();
    if (!meta.changes) return fail("接單設定已由其他店員更新，請載入最新狀態。",409);
    return json({...(byTable ? {table} : {mode}),accepting,revision:revision+1});
  }
  if (path === "/api/menu" && method === "GET") {
    const [stock,modes,seats]=await db.batch([db.prepare("SELECT dish FROM unavailable"),db.prepare(intakeRows),db.prepare(tableIntakeRows)]);
    return json({payments:settings(env),unavailable:stock.results.map(r=>r.dish),
      accepting:acceptingOnly(modeState(modes.results)),acceptingTables:acceptingOnly(tableState(seats.results))});
  }
  if (path === "/api/add-on" && method === "POST") {
    const items = menuItems(input.items);
    if (!items) return fail("請確認餐點與數量");
    return json({suggestion: await addOnFor(db, items)});
  }
  if (path === "/api/quote" && method === "POST") {
    const items = menuItems(input.items);
    if (!items) return fail("請確認餐點與數量");
    const [stock, queue, timing] = await db.batch([
      db.prepare("SELECT dish FROM unavailable"),
      db.prepare("SELECT id,created,items,status,station_progress FROM orders WHERE status='preparing' ORDER BY id DESC"),
      db.prepare(timingRows+" LIMIT 1")
    ]);
    if (stock.results.some(row => items.some(item => item.id === row.dish)))
      return fail("餐單中有已售完餐點，請調整數量後再試算",409);
    const {plan,timingSource}=kitchenSchedule(queue.results,timing.results[0],{cart:{items}});
    return json({capturedAt:plan.capturedAt,seconds:plan.quote.seconds,timingSource});
  }
  if (path === "/api/orders" && method === "POST") {
    const order = prepare(input);
    if (!order) return fail("請確認桌號、餐點數量與備註");
    const method=input.paymentMethod ?? "cash", config=settings(env);
    if(!Object.hasOwn(methods,method))return fail("付款方式無效");
    const selected = Object.hasOwn(input,"comboVersion");
    if (selected && (typeof input.comboVersion !== "string" || !Number.isSafeInteger(input.expectedTotal)))
      return fail("請重新確認套餐版本與金額");
    const quote = selected && input.comboVersion === comboVersion && config.mode === "demo"
      ? priceCombos(order.items) : null;
    const validPrice = !selected || (quote?.discount > 0 && quote.total === input.expectedTotal);
    const snapshot = quote && validPrice ? JSON.stringify({version:comboVersion,quote}) : null;
    const available=config.methods.includes(method);
    const lines = JSON.stringify(order.items);
    const stmt = db.prepare(`INSERT INTO orders(token,mode,table_no,note,items,total,created,payment_method,payment_env,combo_quote)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ? AND NOT ${modePaused} AND NOT ${tablePaused}
      AND NOT EXISTS (SELECT 1 FROM unavailable u
      JOIN json_each(?) j ON u.dish=json_extract(j.value,'$.id')) ON CONFLICT(token) DO NOTHING`);
    const [,savedOrder,intake] = await db.batch([
      stmt.bind(order.token,order.mode,order.table,order.note,lines,quote?.total??order.total,Date.now(),method,method==='cash'?'cash':config.mode,snapshot,available&&validPrice?1:0,order.mode,order.table,lines),
      db.prepare(selectOrders+" WHERE token=?").bind(order.token),
      db.prepare(`SELECT ${modePaused} AS mode_paused, ${tablePaused} AS table_paused`).bind(order.mode,order.table)
    ]);
    const row=savedOrder.results[0];
    if (!row && !validPrice) return fail("套餐優惠或金額已變更，請重新確認餐單",409);
    if (!row && !available) return fail('此付款方式暫停使用',409);
    if (!row && intake.results[0].mode_paused)
      return json({error:intakeNotice(order.mode),code:"intake_paused"},409);
    if (!row && intake.results[0].table_paused)
      return json({error:intakeNotice(order.mode,order.table),code:"table_paused"},409);
    if (!row) return fail("部分餐點已售完，請重新確認菜單",409);
    const saved = receipt(row);
    const sameItems = saved.items.length === order.items.length && saved.items.every(line =>
      order.items.some(item => item.id === line.id && item.qty === line.qty));
    if (saved.combo?.version !== input.comboVersion || (selected && saved.total !== input.expectedTotal) ||
        row.payment_method!==method || row.mode!==order.mode || row.table_no!==order.table || row.note!==order.note || !sameItems)
      return fail("送單識別碼已用於另一張訂單",409);
    return json(saved);
  }
  if (path === "/api/ticket" && method === "GET") {
    const token = request.headers.get("X-Ticket");
    if (!uuid.test(token)) return fail("找不到訂單",404);
    const lookup=db.prepare(selectOrders+" WHERE token=?").bind(token);
    const withTiming=url.searchParams.get("timing")==="1";
    let row, queue, timing;
    if(withTiming){
      const [saved,active,settings]=await db.batch([
        lookup,
        db.prepare(`SELECT queued.id,queued.created,queued.items,queued.status,queued.station_progress
          FROM orders AS ticket JOIN orders AS queued
          ON queued.status='preparing' AND
          (queued.created<ticket.created OR (queued.created=ticket.created AND queued.id<=ticket.id))
          WHERE ticket.token=? AND ticket.status='preparing' ORDER BY queued.id DESC`).bind(token),
        db.prepare(timingRows+" LIMIT 1"),
      ]);
      row=saved.results[0];
      queue=active.results;
      timing=settings.results[0];
    }else row=await lookup.first();
    if (!row) return fail("找不到訂單",404);
    const saved = receipt(row);
    if (url.searchParams.get("progress") === "1") saved.statusHistory = statusHistory(row);
    if(withTiming&&row.status==="preparing"){
      const quote=receiptTiming(row,queue,timing);
      if(quote)saved.kitchenQuote=quote;
    }
    return json(saved);
  }
  if (path === "/api/kitchen/prep" && method === "GET") {
    const {results} = await db.prepare(`SELECT id, created, status, items FROM orders
      WHERE status IN ('pending','preparing') AND ${payableForKitchen} ORDER BY id`).all();
    const orders = results.map(row => ({
      ...row, items: JSON.parse(row.items).map(({id, qty}) => ({id, qty}))
    }));
    return json({capturedAt: Date.now(), orders});
  }
  if(path==="/api/kitchen/station-work"&&method==="GET"){
    const station=url.searchParams.get("station");
    if(!Object.hasOwn(stationLabels,station))return fail("請選擇有效的工作站");
    return json({station,orders:await stationQueue(db,station)});
  }
  if(path==="/api/kitchen/station-work"&&method==="PATCH"){
    const {id,station}=input;
    if(!Number.isSafeInteger(id)||id<1||typeof station!=="string"||!Object.hasOwn(stationLabels,station))
      return fail("分站回報格式無效");
    const result=await finishStation(db,id,station);
    if(!result)return fail("找不到餐單",404);
    return result.doneAt!==null ? json(result) : fail("目前無法回報這張分站餐單，請更新看板。",409);
  }
  if (path === "/api/kitchen/daily" && method === "GET") {
    const dates = url.searchParams.getAll("date");
    const [date] = dates;
    const range = dates.length === 1 ? businessDayRange(date) : null;
    if (!range) return fail("請選擇有效的餐單日期");
    const [counts, portions] = await db.batch([
      db.prepare(`SELECT mode, COUNT(*) AS orders, SUM(status='pending') AS pending,
        SUM(status='preparing') AS preparing, SUM(status='ready') AS ready,
        SUM(status='completed') AS completed, SUM(status='cancelled') AS cancelled,
        SUM(CASE WHEN status='completed' THEN total ELSE 0 END) AS completedTotal
        FROM orders WHERE created>=? AND created<? GROUP BY mode`).bind(...range),
      db.prepare(`SELECT json_extract(line.value,'$.id') AS id,
        MIN(json_extract(line.value,'$.name')) AS name, SUM(json_extract(line.value,'$.qty')) AS qty
        FROM orders JOIN json_each(orders.items) AS line
        WHERE created>=? AND created<? AND status='completed'
        GROUP BY json_extract(line.value,'$.id') ORDER BY qty DESC, id`).bind(...range),
    ]);
    const empty={orders:0,pending:0,preparing:0,ready:0,completed:0,cancelled:0,completedTotal:0};
    const channels={pickup:empty,table:empty};
    for(const {mode,...count} of counts.results) {
      if(Object.hasOwn(channels,mode)) channels[mode]=count;
    }
    const names=new Map(dishes.map(({id,name})=>[id,name]));
    const items=portions.results.map(({id,name,qty})=>({id,name:names.get(id)??name??id,qty}));
    return json({format:"hey-table.daily-operations.v1",date,timeZone:"Asia/Taipei",capturedAt:Date.now(),channels,items});
  }
  if (path === "/api/kitchen/handoff" && method === "GET") {
    const id = collectionId(url);
    if (id === null) return fail("請輸入有效的取餐號碼");
    const row = await db.prepare("SELECT id,table_no,status,items FROM orders WHERE id=?").bind(id).first();
    if (!row) return fail("找不到這個取餐號碼",404);
    if (!["ready","completed"].includes(row.status)) return fail("餐單尚無可列印的交餐小票。",409);
    const items = JSON.parse(row.items).map(({name,qty}) => ({name,qty}));
    return json({id:row.id,table:row.table_no,status:row.status,items});
  }
  if (path === "/api/kitchen/pickup" && method === "GET") {
    const id = collectionId(url);
    if (id === null) return fail("請輸入有效的取餐號碼");
    const row = await db.prepare(`${selectOrders} WHERE id=? AND mode='pickup'`).bind(id).first();
    return row ? json(receipt(row)) : fail("找不到這張自取餐單",404);
  }
  if (path === "/api/kitchen/return-receipt" && method === "GET") {
    const id = collectionId(url);
    if (id === null) return fail("請輸入有效的取餐號碼");
    const row = await db.prepare("SELECT id,created,items,total,combo_quote FROM orders WHERE id=?").bind(id).first();
    if (!row) return fail("找不到這個取餐號碼",404);
    const items = JSON.parse(row.items).map(({id,name,price,qty}) => ({id,name,price,qty}));
    return json({id:row.id, created:row.created, items, total:row.total,
      ...(row.combo_quote ? {combo:JSON.parse(row.combo_quote)} : {})});
  }
  if (path === "/api/kitchen/payment-snapshot" && method === "GET") {
    const environments = url.searchParams.getAll("environment");
    const [environment] = environments;
    if (environments.length !== 1 || !["sandbox", "production"].includes(environment))
      return fail("請指定一個金流環境");
    const limit = 5000;
    const {results} = await db.prepare(`SELECT a.order_id, a.reference, a.trade_id, a.merchant, a.created, a.state,
      o.payment_method, o.total FROM payment_attempts a JOIN orders o ON o.id=a.order_id
      WHERE o.payment_env=? ORDER BY a.id LIMIT ?`).bind(environment, limit + 1).all();
    if (results.length > limit) return fail("付款紀錄超過匯出範圍，請使用 SQLite 備份核帳",409);
    return json({format:"hey-table.payment-snapshot.v1", capturedAt:Date.now(), environment, attempts:results});
  }
  if ((path === "/api/kitchen" || path === "/api/kitchen/stations") && method === "GET") {
    const {results} = await db.prepare(`${selectOrders} WHERE status NOT IN ('completed','cancelled')
        OR id IN (SELECT id FROM orders WHERE status IN ('completed','cancelled') ORDER BY id DESC LIMIT 20)
        ORDER BY id DESC`).all();
    const orders = results.map(receipt);
    if (path === "/api/kitchen/stations") {
      return json({format:"hey-table.station-orders.v1",capturedAt:Date.now(),throughId:orders[0]?.id ?? 0,
        orders:orders.map(({id,created,mode,table,note,status,items}) => ({
          id,created,mode,table,note,status,items:items.map(({id,name,qty}) => ({id,name,qty}))
        }))});
    }
    return json(orders.map((order,index)=>results[index].station_progress?{...order,stationProgress:true}:order));
  }
  if (path === "/api/kitchen/status" && method === "PATCH") {
    if (!Number.isSafeInteger(input.id) || !Object.hasOwn(transitions,input.from) ||
        !transitions[input.from].includes(input.to)) return fail("無效的訂單狀態轉換");
    const readyGuard=input.to==="ready"?" AND station_progress IS NULL":"";
    const {meta} = await db.prepare(`UPDATE orders SET status=?,
      status_history=json_insert(COALESCE(status_history,'[]'),'$[#]',json_object('from',status,'status',?,'at',?))
      WHERE id=? AND status=? AND `+(input.to==="cancelled" ?
      "(payment_method='cash' OR COALESCE("+latestState+",'unpaid') IN ('unpaid','failed','cancelled','refunded'))" : payableForKitchen)+readyGuard)
      .bind(input.to,input.to,Date.now(),input.id,input.from).run();
    return meta.changes ? json({ok:true}) : fail(input.to==="ready"?"訂單已更新，請重新整理或開啟分站看板":"訂單已更新，請重新整理",409);
  }
  if (path === "/api/kitchen/availability" && method === "PATCH") {
    if (!dishes.some(d=>d.id===input.id) || typeof input.available !== "boolean") return fail("餐點狀態錯誤");
    await db.prepare(input.available ? "DELETE FROM unavailable WHERE dish=?" :
      "INSERT INTO unavailable VALUES (?) ON CONFLICT DO NOTHING").bind(input.id).run();
    return json({ok:true});
  }
  return fail("找不到此操作",404);
}
