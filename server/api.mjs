import {addOnFor} from "./add-ons.mjs";
import {comboVersion,priceCombos} from "../lib/combo-pricing.mjs";
import qrcode from "qrcode-generator";
import {dishes, itemNoteLimit, numberOf, tables, transitions} from "../lib/menu.mjs";
import {intakeLabels,intakeNotice} from "../lib/order-intake.mjs";
import {businessDate,businessDayRange} from "../lib/business-day.mjs";
import {changePortionLimit,copyPortionLimits,dailyLimits,exceededOrderPortions,exceededPortions,portionLimitHistory,
  readRemaining,restockHistory,restockPortions,restorePortionLimit,supplyTime} from "./daily-limits.mjs";
import {expirePaymentHolds,noBlockingPayment,paymentHoldMs} from "./payment-holds.mjs";
import {arrivalTiming,arrivalTimingRows,dailyTiming,dailyTimingRows,pickupPunctuality,pickupPunctualityRows} from "./daily-timing.mjs";
import {dailyPaymentRows,dailyPaymentSummary} from "./daily-payment-summary.mjs";
import {kitchenOverdue} from "./kitchen-overdue.mjs";
import {bookedPickupDate,pickupBookingDays,pickupCalendarStatus,pickupPrepLead,pickupSlotCapacity,pickupSlotsForDay} from "../lib/pickup-slots.mjs";
import {canReschedulePickup,capacityAtPickupSlot,editablePickupSlots,orderPortions,pickupChanges,pickupSlotLimits,
  pickupDayPaused,pickupDaySettings,pickupLimitEvent,pickupLimitHistory,pickupSlotOptions,pickupSlotUsage,pickupSlots,savePickupDay,
  savePickupSlotLimits,suggestCartPickupSlot,
  suggestPickupSlot,usedAtPickupSlot} from "./pickup-slots.mjs";
import {pickupCalendar} from "./pickup-calendar.mjs";
import {orderDetailsText,ticketTextAttachment} from "./ticket-document.mjs";
import {issuePickupPass,ownerPickupPass,readPickupPass,reportPickupPassArrival,revokePickupPass} from "./pickup-pass.mjs";
import {pickupDelayColumn,updatePickupDelay} from "./pickup-delay.mjs";
import {pickupRoster} from "./pickup-roster.mjs";
import {pickupWeek} from "./pickup-week.mjs";
import {cashCorrectionHistory,cashReceiptColumn,collectCash,correctCashReceipt,dailyCashReceipts} from "./cash-receipts.mjs";
import {cashCloseVersion,cashCloseVersions,saveCashClose} from "./cash-close-versions.mjs";
import {cashAmount} from "../lib/cash-reconciliation.mjs";

const json = (value, status=200) => Response.json(value,{status,headers:{"Cache-Control":"no-store"}});
const fail = (message,status=400) => json({error:message},status);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

import {latestState,payableForKitchen,paymentApi,checkKitchenPayment,refundDemoPayment} from "./payment-api.mjs";
import {demoRefundReport,demoRefundReceiptColumn,demoRefundReceiptText} from "./demo-refund-report.mjs";
import {settings} from "./tappay.mjs";
import {canPrepare,methods} from "../lib/payments.mjs";
import {estimate} from "@peca12968/pickup-window";
import {activeKitchen,demoKitchen,importTiming,stationLabels,timingChanges} from "../lib/kitchen-timing.mjs";
import {finishStation,remainingStationItems,stationQueue} from "./station-work.mjs";
const timingRows = "SELECT revision,config FROM kitchen_timing ORDER BY revision DESC";
const fromTimingRow = row => ({revision:row?.revision??0, kitchen:activeKitchen(row ? JSON.parse(row.config) : null)});
const orderColumns = `SELECT orders.*, ${latestState} AS payment_state, ${cashReceiptColumn} AS cash_receipt`;
const selectOrders = orderColumns+" FROM orders";
const ticketWithRefund=`${orderColumns},${demoRefundReceiptColumn},${pickupDelayColumn} FROM orders WHERE token=?`;
const kitchenPayableAt=`, CASE WHEN orders.status='pending' AND orders.payment_method<>'cash'
  THEN (SELECT kitchen_payable_at FROM payment_attempts WHERE order_id=orders.id ORDER BY id DESC LIMIT 1) END AS kitchen_payable_at`;
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
    ...(row.source === "staff" ? {source:row.source} : {}),
    ...(row.pickup_slot!=null ? {pickupSlot:row.pickup_slot} : {}),
    ...(row.mode==="pickup"&&row.pickup_arrived_at!=null ? {pickupArrivedAt:row.pickup_arrived_at} : {}),
    ...(row.combo_quote ? {combo:JSON.parse(row.combo_quote)} : {}),
    ...(row.cash_receipt ? {cashReceipt:JSON.parse(row.cash_receipt)} : {}),
    paymentMethod:row.payment_method,paymentEnv:row.payment_env,paymentState:row.payment_state??'unpaid',total:row.total, status:row.status, created:row.created};
}
function kitchenOrder(row,capturedAt){
  const order=receipt(row);
  const overdue=kitchenOverdue(row,order,capturedAt);
  const booked=order.status==="pending"&&order.pickupSlot!=null;
  const changes=booked?pickupChanges(row):[];
  return {...order,...(row.station_progress?{stationProgress:true}:{}),
    ...(row.pickup_delay&&order.status==="preparing"&&canPrepare(order)?{pickupDelay:JSON.parse(row.pickup_delay)}:{}),
    ...(overdue?{overdue}:{}),
    ...(booked?{pickupRevision:changes.length,...(changes.length?{latestPickupChange:changes.at(-1)}:{}),
      ...(canReschedulePickup(row,capturedAt)?{pickupUpcoming:true}:{})}:{}),
    ...(row.table_moves?{tableRevision:JSON.parse(row.table_moves).length}:{})};
}
function statusHistory(row) {
  const history = [{status:"pending",at:row.created}];
  for (const {from,status,at,actor} of JSON.parse(row.status_history ?? "[]")) {
    if (history.at(-1).status !== from) history.push({status:from,at:null});
    history.push({status,at,...(status==="cancelled"&&["customer","payment_expiry","demo_refund"].includes(actor)?{actor}:{})});
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
function menuItems(lines, withNotes=false) {
  if (!Array.isArray(lines) || !lines.length || lines.length > dishes.length) return null;
  const byId = new Map();
  for (const line of lines) {
    if (!line || !dishes.some(d => d.id === line.id) || byId.has(line.id) ||
        !Number.isInteger(line.qty) || line.qty < 1 || line.qty > 20) return null;
    const note=withNotes&&Object.hasOwn(line,"note")?line.note:"";
    if(typeof note!=="string"||note.length>itemNoteLimit)return null;
    const clean=note.trim();
    byId.set(line.id,{qty:line.qty,...(clean?{note:clean}:{})});
  }
  return dishes.filter(d => byId.has(d.id)).map(({id,name,price}) => ({id,name,price,...byId.get(id)}));
}
function prepare(input) {
  const pickupSlot=input.pickupSlot??null;
  if (typeof input.token!=="string" || !uuid.test(input.token) || typeof input.mode!=="string" || !Object.hasOwn(intakeLabels,input.mode) ||
      (input.mode === "table" ? !tables.includes(input.table) : input.table != null) ||
      (pickupSlot!==null&&(input.mode!=="pickup"||!Number.isSafeInteger(pickupSlot)||pickupSlot<1)) ||
      typeof input.note !== "string" || input.note.length > 160) return null;
  const items = menuItems(input.items,true);
  if (!items) return null;
  return {token:input.token,mode:input.mode,table:input.table??null,pickupSlot,note:input.note.trim(),items,
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
  if(path==="/api/kitchen/demo-refund" && method==="PATCH")return refundDemoPayment(env,input);
  if(path==="/api/kitchen/demo-refunds"&&method==="GET"){
    const capturedAt=Date.now(),date=url.searchParams.get("date")??businessDate(capturedAt);
    const range=businessDayRange(date);
    if(!range)return fail("請選擇有效的退款日期。");
    return json(await demoRefundReport(db,date,range,capturedAt));
  }
  if(path==="/api/kitchen/cash-receipt"&&method==="POST"){
    const {id,operationId,expectedTotal,tendered}=input;
    if(!Number.isSafeInteger(id)||id<1||typeof operationId!=="string"||!uuid.test(operationId)||
        !Number.isSafeInteger(expectedTotal)||expectedTotal<0||!Number.isSafeInteger(tendered)||tendered<0)
      return fail("請確認餐號、收款金額與操作識別碼。");
    if(tendered<expectedTotal)return fail("實收金額少於應收金額。");
    const row=await collectCash(db,input,Date.now());
    if(!row)return fail("找不到餐單。",404);
    if(row.cash_receipt){
      const cashReceipt=JSON.parse(row.cash_receipt);
      if(row.operation_id===operationId&&cashReceipt.amount===expectedTotal&&cashReceipt.tendered===tendered)
        return json({id,cashReceipt});
      return fail("這張餐單已有現金收款紀錄，請先核對。",409);
    }
    if(row.payment_method!=="cash"||!["ready","completed"].includes(row.status))return fail("餐單目前無法登記現金收款。",409);
    if(row.total!==expectedTotal)return fail("應收金額已更新，請重新核對。",409);
    return fail("收款操作識別碼已使用，請重新核對餐單。",409);
  }
  if(path==="/api/kitchen/cash-close"&&method==="GET"){
    const dates=url.searchParams.getAll("date"),[date]=dates;
    const range=dates.length===1?businessDayRange(date):null;
    if(!range)return fail("請選擇有效的收款登記日期。");
    return json(await dailyCashReceipts(db,date,range,Date.now()));
  }
  if(path==="/api/kitchen/cash-corrections"&&method==="GET"){
    const id=collectionId(url);
    if(id===null)return fail("請輸入有效的餐號。");
    return json({id,corrections:await cashCorrectionHistory(db,id)});
  }
  if(path==="/api/kitchen/cash-corrections"&&method==="POST"){
    const {id,revision,operationId,tendered}=input;
    const reason=typeof input.reason==="string"?input.reason.trim():"";
    if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER||
      typeof operationId!=="string"||!uuid.test(operationId)||!Number.isSafeInteger(tendered)||tendered<0||
      !reason||reason.length>120)return fail("請確認餐號、版本、實收金額與更正原因。");
    const {stored,receipt}=await correctCashReceipt(db,{id,revision,operationId,tendered,reason},Date.now());
    if(stored?.orderId===id&&stored.revision===revision+1&&stored.tendered===tendered&&stored.reason===reason){
      const {amount,collectedAt,correctedAt}=stored;
      return json({id,cashReceipt:{amount,tendered,change:tendered-amount,collectedAt,revision:stored.revision,correctedAt}});
    }
    if(!receipt)return fail("找不到現金收款紀錄。",404);
    if(tendered<receipt.amount)return fail("實收金額少於應收金額。");
    return fail("現金紀錄已更新或金額相同，請重新核對。",409);
  }
  if(path==="/api/kitchen/cash-close-versions"&&method==="GET"){
    const dates=url.searchParams.getAll("date"),[date]=dates;
    if(dates.length!==1||!businessDayRange(date))return fail("請選擇有效的收款登記日期。");
    const expected=url.searchParams.get("revision");
    if(expected===null)return json({date,versions:await cashCloseVersions(db,date)});
    const revision=Number(expected);
    if(!/^\d+$/.test(expected)||!Number.isSafeInteger(revision)||revision<1)return fail("請選擇有效的盤點版本。");
    const saved=await cashCloseVersion(db,date,revision);
    return saved?json(saved):fail("找不到這一版盤點。",404);
  }
  if(path==="/api/kitchen/cash-close-versions"&&method==="POST"){
    const {date,revision,operationId,capturedAt,receiptCount,correctionCount=0,opening,adjustments,counted}=input;
    const now=Date.now(),range=businessDayRange(date);
    const amounts=[cashAmount(opening),cashAmount(adjustments,true),cashAmount(counted)];
    if(!range||date>businessDate(now)||!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER||
      typeof operationId!=="string"||!uuid.test(operationId)||!Number.isSafeInteger(capturedAt)||capturedAt<=0||capturedAt>now||
      !Number.isSafeInteger(receiptCount)||receiptCount<0||!Number.isSafeInteger(correctionCount)||correctionCount<0||
      amounts.includes(null))return fail("請確認日期、版本與盤點金額。");
    const saved=await saveCashClose(db,input,range,now,amounts);
    return saved?json(saved):fail("收款資料或盤點版本已更新，請重新擷取後再核對。",409);
  }
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
  if (path === "/api/kitchen/daily-limits" && method === "GET") {
    const date=url.searchParams.get("date"),range=businessDayRange(date);
    if(!range)return fail("請選擇有效的供應日期");
    return json({date,limits:await dailyLimits(db,date,range)});
  }
  if (path === "/api/kitchen/daily-limits" && method === "PATCH") {
    const {date,dish,capacity,revision}=input;
    if(typeof date!=="string"||!businessDayRange(date)||!dishes.some(item=>item.id===dish)||
      (capacity!==null&&(!Number.isSafeInteger(capacity)||capacity<0))||
      !Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)
      return fail("供應日期、餐點、份數或版本無效");
    const saved=await changePortionLimit(db,{date,dish,capacity,revision},Date.now());
    return saved?json({date,...saved}):
      fail("供應上限已由其他店員更新，請重新載入後再儲存。",409);
  }
  if(path==="/api/kitchen/daily-limits/restore"&&method==="POST"){
    const {date,dish,revision,fromRevision}=input;
    if(typeof date!=="string"||!businessDayRange(date)||!dishes.some(item=>item.id===dish)||
      !Number.isSafeInteger(revision)||revision<1||revision>=Number.MAX_SAFE_INTEGER||
      !Number.isSafeInteger(fromRevision)||fromRevision<1||fromRevision>revision)
      return fail("請確認供應日期、品項與可還原的版次。");
    const saved=await restorePortionLimit(db,{date,dish,revision,fromRevision},Date.now());
    return saved?json({date,...saved,restoredFromRevision:fromRevision}):
      fail("目前上限已變更、相同，或查無該版次。請重新核對供應紀錄。",409);
  }
  if(path==="/api/kitchen/daily-limits/copy"&&method==="POST"){
    const {sourceDate,date,items}=input;
    if(typeof sourceDate!=="string"||typeof date!=="string"||sourceDate===date||
      !businessDayRange(sourceDate)||!businessDayRange(date)||!Array.isArray(items)||
      !items.length||items.length>dishes.length)return fail("請選擇不同的來源與目的日期及要複製的品項。");
    const chosen=new Set();
    for(const item of items){
      if(!item||!dishes.some(dish=>dish.id===item.dish)||chosen.has(item.dish)||
        !Number.isSafeInteger(item.sourceRevision)||item.sourceRevision<0||
        !Number.isSafeInteger(item.targetRevision)||item.targetRevision<0||item.targetRevision>=Number.MAX_SAFE_INTEGER)
        return fail("請確認品項與其版本，且每個品項只能選一次。");
      chosen.add(item.dish);
    }
    const limits=await copyPortionLimits(db,sourceDate,date,items,Date.now());
    return limits.length?json({sourceDate,date,limits}):
      fail("來源或目的設定已變更，請重新讀取後核對。這次沒有套用任何品項。",409);
  }
  if((path==="/api/kitchen/daily-limits/restock"||path==="/api/kitchen/daily-limits/history")&&method==="GET"){
    const dates=url.searchParams.getAll("date"),dishesRequested=url.searchParams.getAll("dish");
    const [date]=dates,[dish]=dishesRequested;
    const cursor=url.searchParams.getAll("before");
    const before=cursor.length?Number(cursor[0]):null;
    if(dates.length!==1||!businessDayRange(date)||dishesRequested.length!==1||!dishes.some(item=>item.id===dish)||
      cursor.length>1||(before!==null&&(!/^\d+$/.test(cursor[0])||!Number.isSafeInteger(before)||before<2)))
      return fail("請確認供應日期、餐點與查詢位置。");
    return json(await (path.endsWith("/restock")?restockHistory:portionLimitHistory)(db,date,dish,before));
  }
  if(path==="/api/kitchen/daily-limits/restock"&&method==="POST"){
    const {date,dish,quantity,revision,operationId}=input;
    const range=typeof date==="string"?businessDayRange(date):null;
    if(!range||!dishes.some(item=>item.id===dish)||!Number.isSafeInteger(quantity)||quantity<1||
      !Number.isSafeInteger(revision)||revision<1||revision>=Number.MAX_SAFE_INTEGER||
      typeof operationId!=="string"||!uuid.test(operationId))return fail("請確認日期、餐點、補貨份數與版本。");
    const saved=await restockPortions(db,{date,dish,quantity,revision,operationId},range,Date.now());
    return saved?json(saved):fail("無法套用此筆補貨。請重新載入並核對品項有設定上限、版次與補貨份數。",409);
  }
  if(path==="/api/kitchen/pickup-slots"&&method==="GET"){
    const date=url.searchParams.get("date");
    if(!businessDayRange(date))return fail("請選擇有效的取餐日期。");
    return json({date,defaultCapacity:pickupSlotCapacity,...await pickupSlotLimits(db,date,Date.now())});
  }
  if(path==="/api/kitchen/pickup-week"&&method==="GET"){
    return json(await pickupWeek(db,Date.now()));
  }
  if(path==="/api/kitchen/pickup-slots/history"&&method==="GET"){
    const dates=url.searchParams.getAll("date"),cursors=url.searchParams.getAll("before"),[date]=dates,[cursor]=cursors;
    const before=cursor===undefined?null:Number(cursor);
    if(dates.length!==1||!businessDayRange(date)||cursors.length>1||
      (before!==null&&(!/^\d+$/.test(cursor)||!Number.isSafeInteger(before)||before<1)))
      return fail("請確認取餐日期與紀錄查詢範圍。");
    return json(await pickupLimitHistory(db,date,before));
  }
  if(path==="/api/kitchen/pickup-slots/copy"&&method==="PATCH"){
    const {date,sourceDate,slots}=input;
    const range=businessDayRange(date),sourceRange=businessDayRange(sourceDate);
    if(!range||!sourceRange||date===sourceDate)return fail("請選擇有效且不同的來源與目的日期。");
    const allowed=new Set(pickupSlotsForDay(date));
    if(!Array.isArray(slots)||!slots.length||slots.length>allowed.size||
      slots.some(slot=>!slot||!allowed.has(slot.start)||
        !Number.isSafeInteger(slot.revision)||slot.revision<0||slot.revision>=Number.MAX_SAFE_INTEGER||
        !Number.isSafeInteger(slot.sourceRevision)||slot.sourceRevision<0)||
      new Set(slots.map(slot=>slot.start)).size!==slots.length)return fail("請確認時段與兩天的設定版本。");
    const now=Date.now(),editable=new Set(editablePickupSlots(date,now));
    const conflict="來源或目的上限已更新、相同或截止，請重新讀取兩天設定。";
    if(slots.some(slot=>!editable.has(slot.start)))return fail(conflict,409);
    const plan=slots.map(({start,revision,sourceRevision})=>({start,revision,sourceRevision,sourceStart:sourceRange[0]+(start-range[0])}));
    const saved=await savePickupSlotLimits(db,date,plan,"batch",now,{sourceDate});
    return saved.length?json({date,sourceDate,slots:saved}):fail(conflict,409);
  }
  if(path==="/api/kitchen/pickup-slots/restore"&&method==="PATCH"){
    const {date,fromId,revision,slots}=input;
    if(!businessDayRange(date)||!Number.isSafeInteger(fromId)||fromId<1)return fail("請確認取餐日期與還原來源。");
    const source=await pickupLimitEvent(db,date,fromId);
    if(!source)return fail("找不到這一天的調整紀錄。",404);
    const now=Date.now(),editable=new Set(editablePickupSlots(date,now));
    const validVersion=value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
    const conflict="預約狀態已更新、截止或已是目標設定，請重新核對後再還原。";
    if(source.kind==="day"){
      if(!validVersion(revision)||slots!==undefined)return fail("請確認整日預約版本。");
      const accepting=source.changes[0].previousAccepting;
      if(!editable.size||!await savePickupDay(db,date,accepting,revision,now,fromId))return fail(conflict,409);
      return json({date,accepting,revision:revision+1,restoredFromId:fromId});
    }
    if(revision!==undefined||!Array.isArray(slots)||slots.length!==source.changes.length||
      slots.some(slot=>!slot||!validVersion(slot.revision)))return fail("請核對所有時段與版本。");
    const versions=new Map(slots.map(slot=>[slot.start,slot.revision]));
    if(source.changes.some(change=>!versions.has(change.start)))return fail("請核對所有時段與版本。");
    if(source.changes.some(change=>!editable.has(change.start)))return fail(conflict,409);
    const plan=source.changes.map(({start,previousCapacity})=>({start,capacity:previousCapacity,revision:versions.get(start)}));
    const saved=await savePickupSlotLimits(db,date,plan,source.kind,now,{restoredFromId:fromId});
    return saved.length?json({date,slots:saved,restoredFromId:fromId}):fail(conflict,409);
  }
  if(path==="/api/kitchen/pickup-day"&&method==="PATCH"){
    const {date,accepting,revision}=input;
    if(!businessDayRange(date)||typeof accepting!=="boolean"||!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)
      return fail("取餐日期、預約狀態或版本無效。");
    const now=Date.now();
    if(!editablePickupSlots(date,now).length)return fail("此日期已停止預約，無法調整。",409);
    const saved=await savePickupDay(db,date,accepting,revision,now);
    return saved?json({date,accepting,revision:revision+1}):
      fail("整日預約狀態已由其他店員更新，請重新載入。",409);
  }
  if(["/api/kitchen/pickup-slots","/api/kitchen/pickup-slot-batch"].includes(path)&&method==="PATCH"){
    const {date,start,capacity,revision}=input,batch=path==="/api/kitchen/pickup-slot-batch";
    const slots=batch?input.slots:[{start,revision}],allowed=new Set(pickupSlotsForDay(date));
    if((capacity!==null&&(!Number.isSafeInteger(capacity)||capacity<0))||!Array.isArray(slots)||
      !slots.length||slots.length>allowed.size||slots.some(slot=>!slot||!allowed.has(slot.start)||
        !Number.isSafeInteger(slot.revision)||slot.revision<0||slot.revision>=Number.MAX_SAFE_INTEGER)||
      new Set(slots.map(slot=>slot.start)).size!==slots.length)
      return fail("取餐時段、份數或版本無效。");
    const now=Date.now(),editable=new Set(editablePickupSlots(date,now));
    const conflict="部分時段已截止或上限已變更，整批未儲存。請重新核對。";
    if(slots.some(slot=>!editable.has(slot.start)))return fail(batch?conflict:"此時段已停止預約，無法調整上限。",409);
    const saved=await savePickupSlotLimits(db,date,slots.map(slot=>({start:slot.start,revision:slot.revision,capacity})),batch?"batch":"slot",now);
    if(!saved.length)return fail(batch?conflict:"上限已由其他店員更新，請重新載入。",409);
    return batch?json({date,slots:saved}):json({date,...saved[0]});
  }
  const staffPickup=path === "/api/kitchen/create-pickup";
  if(path === "/api/pickup-slots" && method === "GET") {
    const now=Date.now(),date=url.searchParams.get("date")??businessDate(now);
    if(!pickupBookingDays(now).includes(date))return fail("請選擇七天內的取餐日期。");
    return json(await pickupSlots(db,now,date));
  }
  if(["/api/pickup-suggestion","/api/kitchen/pickup-suggestion"].includes(path)&&method==="POST"){
    const items=menuItems(input.items);
    if(!items)return fail("請確認餐點與數量。");
    const now=Date.now(),date=input.afterDate??businessDate(now);
    if(!pickupBookingDays(now).includes(date))return fail("請選擇七天內的取餐日期。");
    return json({suggestion:await suggestCartPickupSlot(db,now,date,items,path.startsWith("/api/kitchen/"))});
  }
  if ((path === "/api/menu" || staffPickup) && method === "GET") {
    const now=Date.now(),date=url.searchParams.get("date")??businessDate(now);
    if(!pickupBookingDays(now).includes(date))return fail("請選擇七天內的取餐日期。");
    const [,stock,modes,seats,portions,day]=await db.batch([expirePaymentHolds(db,now),
      db.prepare("SELECT dish FROM unavailable"),db.prepare(intakeRows),
      db.prepare(tableIntakeRows),readRemaining(db,date,businessDayRange(date)),pickupDaySettings(db,date)]);
    const remaining=Object.fromEntries(portions.results.map(row=>[row.dish,row.remaining]));
    return json({payments:settings(env),unavailable:stock.results.map(r=>r.dish),
      accepting:acceptingOnly(modeState(modes.results)),acceptingTables:acceptingOnly(tableState(seats.results)),
      ...(day.results[0]?.accepting===0?{pickupPaused:true}:{}),
      ...(portions.results.length?{remaining}:{})});
  }
  if (path === "/api/add-on" && method === "POST") {
    const items = menuItems(input.items);
    if (!items) return fail("請確認餐點與數量");
    const now=Date.now(),date=input.pickupDate??businessDate(now);
    if(!pickupBookingDays(now).includes(date))return fail("請選擇七天內的取餐日期。");
    return json({suggestion: await addOnFor(db,items,now,date)});
  }
  if (path === "/api/quote" && method === "POST") {
    const items = menuItems(input.items);
    if (!items) return fail("請確認餐點與數量");
    const now=Date.now(),date=businessDate(now);
    const [,stock,queue,timing,exceeded]=await db.batch([
      expirePaymentHolds(db,now),
      db.prepare("SELECT dish FROM unavailable"),
      db.prepare("SELECT id,created,items,status,station_progress FROM orders WHERE status='preparing' ORDER BY id DESC"),
      db.prepare(timingRows+" LIMIT 1"),
      db.prepare(exceededPortions).bind(JSON.stringify(items),date,...businessDayRange(date)),
    ]);
    if (stock.results.some(row => items.some(item => item.id === row.dish)))
      return fail("餐單中有已售完餐點，請調整數量後再試算",409);
    if (exceeded.results.length)
      return fail("餐單中有餐點超過今日剩餘份數，請調整後再試算",409);
    const {plan,timingSource}=kitchenSchedule(queue.results,timing.results[0],{cart:{items}});
    return json({capturedAt:plan.capturedAt,seconds:plan.quote.seconds,timingSource});
  }
  if ((path === "/api/orders" || staffPickup) && method === "POST") {
    const order = prepare(staffPickup ? {...input,mode:"pickup",table:null} : input);
    if (!order) return fail("請確認桌號、餐點數量與備註");
    const source=staffPickup ? "staff" : null;
    const method=staffPickup ? "cash" : input.paymentMethod ?? "cash", config=settings(env);
    if(!Object.hasOwn(methods,method))return fail("付款方式無效");
    if(staffPickup && !Number.isSafeInteger(input.expectedTotal))return fail("請確認餐單金額");
    const selected = !staffPickup && Object.hasOwn(input,"comboVersion");
    if (selected && (typeof input.comboVersion !== "string" || !Number.isSafeInteger(input.expectedTotal)))
      return fail("請重新確認套餐版本與金額");
    const quote = selected && input.comboVersion === comboVersion && config.mode === "demo"
      ? priceCombos(order.items) : null;
    const validPrice = staffPickup ? order.total === input.expectedTotal :
      !selected || (quote?.discount > 0 && quote.total === input.expectedTotal);
    const snapshot = quote && validPrice ? JSON.stringify({version:comboVersion,quote}) : null;
    const available=config.methods.includes(method);
    const lines = JSON.stringify(order.items);
    const created=Date.now(),today=businessDate(created);
    const booked=order.pickupSlot!==null;
    const date=booked?bookedPickupDate(created,order.pickupSlot):today;
    const range=businessDayRange(date??today);
    const portions=booked?order.items.reduce((sum,item)=>sum+item.qty,0):0;
    const slotGuard=booked?` AND NOT ${pickupDayPaused} AND ${usedAtPickupSlot}+?<=${capacityAtPickupSlot}`:"";
    const stmt = db.prepare(`INSERT INTO orders(token,mode,source,table_no,note,items,total,created,payment_method,payment_env,combo_quote,payment_due_at,pickup_slot)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ? AND (? OR NOT ${modePaused}) AND NOT ${tablePaused}
      AND NOT EXISTS (SELECT 1 FROM unavailable u
      JOIN json_each(?) j ON u.dish=json_extract(j.value,'$.id'))
      AND NOT EXISTS (${exceededPortions})${slotGuard} ON CONFLICT(token) DO NOTHING`);
    const [,,savedOrder,intake,exceeded,slotUsage]=await db.batch([
      expirePaymentHolds(db,created),
      stmt.bind(order.token,order.mode,source,order.table,order.note,lines,quote?.total??order.total,created,method,method==='cash'?'cash':config.mode,snapshot,
        method==="cash"?null:created+paymentHoldMs,order.pickupSlot,available&&validPrice&&date?1:0,staffPickup?1:0,
        order.mode,order.table,lines,lines,date??today,...range,...(booked?[date,order.pickupSlot,portions,order.pickupSlot]:[])),
      db.prepare(selectOrders+" WHERE token=?").bind(order.token),
      db.prepare(`SELECT ${modePaused} AS mode_paused, ${tablePaused} AS table_paused`).bind(order.mode,order.table),
      db.prepare(`SELECT dish FROM (${exceededPortions}) WHERE NOT EXISTS (SELECT 1 FROM orders WHERE token=?)`)
        .bind(lines,date??today,...range,order.token),
      ...(booked?[pickupSlotUsage(db,order.pickupSlot,date)]:[]),
    ]);
    const row=savedOrder.results[0];
    if (!row && !validPrice) return fail(staffPickup?"菜單金額已變更，請重新整理後確認餐單。":"套餐優惠或金額已變更，請重新確認餐單",409);
    if (!row && !available) return fail('此付款方式暫停使用',409);
    if (!row && !staffPickup && intake.results[0].mode_paused)
      return json({error:intakeNotice(order.mode),code:"intake_paused"},409);
    if (!row && intake.results[0].table_paused)
      return json({error:intakeNotice(order.mode,order.table),code:"table_paused"},409);
    if (!row && !date)return json({error:"這個取餐時段已停止預約，請重新選擇。",code:"pickup_slot_closed"},409);
    if (!row && booked && slotUsage.results[0].paused)
      return json({error:"此日期已暫停預約，請改選日期。",code:"pickup_day_paused"},409);
    if (!row && exceeded.results.length)
      return json({error:date===today?"部分餐點已超過今日剩餘份數，請調整餐單":
        "部分餐點已超過取餐日的剩餘份數，請調整餐單或日期。",code:"portion_limit"},409);
    if (!row && booked && slotUsage.results[0].used+portions>slotUsage.results[0].capacity)
      return json({error:"此時段剩餘份數不足，請改選時段或調整餐點。",code:"pickup_slot_full"},409);
    if (!row) return fail("部分餐點已售完，請重新確認菜單",409);
    const saved = receipt(row);
    const submittedTable=row.table_moves?JSON.parse(row.table_moves)[0]?.from??row.table_no:row.table_no;
    const submittedSlot=pickupChanges(row)[0]?.from??row.pickup_slot??null;
    const sameItems = saved.items.length === order.items.length && saved.items.every(line =>
      order.items.some(item => item.id === line.id && item.qty === line.qty && (item.note??"")===(line.note??"")));
    if ((row.source??null)!==source || (!staffPickup && saved.combo?.version !== input.comboVersion) ||
        ((selected||staffPickup) && saved.total !== input.expectedTotal) ||
        row.payment_method!==method || row.mode!==order.mode || submittedTable!==order.table || row.note!==order.note ||
        submittedSlot!==order.pickupSlot || !sameItems)
      return fail("送單識別碼已用於另一張訂單",409);
    return json(saved);
  }
  const passArrival=path==="/api/pickup-pass/arrival"&&method==="POST";
  if((path==="/api/pickup-pass"&&method==="GET")||passArrival){
    const pass=request.headers.get("X-Pickup-Pass");
    const load=passArrival?reportPickupPassArrival:readPickupPass;
    const row=uuid.test(pass)?await load(db,pass,Date.now()):null;
    return row?json(row):fail("代取連結已失效，請向原訂餐人確認。",404);
  }
  if(path==="/api/ticket/pickup-pass"&&["GET","POST","PATCH"].includes(method)){
    const token=request.headers.get("X-Ticket");
    if(!uuid.test(token))return fail("找不到訂單",404);
    const now=Date.now();
    if(method==="GET"){
      const state=await ownerPickupPass(db,token,now);
      return state?json(state):fail("找不到訂單",404);
    }
    const {pass,revision}=input;
    if(!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER||
       (method==="POST"&&(typeof pass!=="string"||!uuid.test(pass)||pass.toLowerCase()===token.toLowerCase())))
      return fail("代取連結或版本無效。");
    const state=method==="POST"?await issuePickupPass(db,token,pass,revision,now):await revokePickupPass(db,token,revision,now);
    if(state===null)return fail("找不到訂單",404);
    return state?json(state):fail("餐單狀態或代取連結已更新，請重新讀取。",409);
  }
  if(path==="/api/ticket/calendar"&&method==="GET"){
    const token=request.headers.get("X-Ticket");
    if(!uuid.test(token))return fail("找不到訂單",404);
    const [,saved]=await db.batch([expirePaymentHolds(db,Date.now(),token),db.prepare(selectOrders+" WHERE token=?").bind(token)]);
    const row=saved.results[0];
    if(!row||row.mode!=="pickup"||row.pickup_slot==null)return fail("找不到可匯出的預約取餐時段。",404);
    const order=receipt(row),status=pickupCalendarStatus(order);
    if(!status)return fail("付款確認後可下載取餐行事曆。",409);
    const changes=pickupChanges(row),cancelled=status==="CANCELLED";
    const modified=cancelled?statusHistory(row).at(-1)?.at:null;
    const file=await pickupCalendar({id:order.id,token,created:order.created,start:order.pickupSlot,
      modified:modified??changes.at(-1)?.at??order.created,revision:changes.length+Number(cancelled),status});
    return new Response(file,{headers:{"Content-Type":"text/calendar; charset=utf-8","Cache-Control":"private, no-store",
      "Content-Disposition":`attachment; filename="hey-table-pickup-${numberOf(order.id)}.ics"`,"X-Content-Type-Options":"nosniff"}});
  }
  if(path==="/api/ticket/refund-receipt"&&method==="GET"){
    const token=request.headers.get("X-Ticket");
    if(!uuid.test(token))return fail("找不到訂單",404);
    const row=await db.prepare(`SELECT id,payment_method,${demoRefundReceiptColumn} FROM orders WHERE token=?`).bind(token).first();
    if(!row)return fail("找不到訂單",404);
    if(!row.demo_refund_receipt)return fail("這張餐單目前沒有示範退款收據。",409);
    const file=demoRefundReceiptText({id:row.id,paymentMethod:row.payment_method},JSON.parse(row.demo_refund_receipt));
    return ticketTextAttachment(file,"refund",row.id);
  }
  if(path==="/api/ticket/order-details"&&method==="GET"){
    const token=request.headers.get("X-Ticket");
    if(!uuid.test(token))return fail("找不到訂單",404);
    const capturedAt=Date.now();
    const [,lookup]=await db.batch([expirePaymentHolds(db,capturedAt,token),db.prepare(ticketWithRefund).bind(token)]);
    const row=lookup.results[0];
    if(!row)return fail("找不到訂單",404);
    const order=receipt(row);
    if(row.demo_refund_receipt)order.demoRefund=JSON.parse(row.demo_refund_receipt);
    return ticketTextAttachment(orderDetailsText(order,capturedAt),"order",order.id);
  }
  if (path === "/api/ticket" && method === "GET") {
    const token = request.headers.get("X-Ticket");
    if (!uuid.test(token)) return fail("找不到訂單",404);
    const lookup=db.prepare(ticketWithRefund).bind(token);
    const now=Date.now();
    const expiry=expirePaymentHolds(db,now,token);
    const withTiming=url.searchParams.get("timing")==="1";
    let row, queue, timing;
    if(withTiming){
      const [,saved,active,settings]=await db.batch([
        expiry,lookup,
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
    }else{
      const [,saved]=await db.batch([expiry,lookup]);
      row=saved.results[0];
    }
    if (!row) return fail("找不到訂單",404);
    const saved = receipt(row);
    if(row.demo_refund_receipt)saved.demoRefund=JSON.parse(row.demo_refund_receipt);
    if (url.searchParams.get("progress") === "1") {
      saved.statusHistory = statusHistory(row);
      if(row.payment_due_at!==null)saved.paymentDueAt=row.payment_due_at;
      if(row.table_moves)saved.tableMoves=JSON.parse(row.table_moves);
      if(row.pickup_slot!=null){
        saved.pickupChanges=pickupChanges(row);
        saved.canReschedulePickup=canReschedulePickup(row,now);
      }
    }
    if(row.pickup_delay&&row.status==="preparing"&&canPrepare(saved)){
      const {readyAt,recordedAt}=JSON.parse(row.pickup_delay);
      if(readyAt!==null)saved.pickupDelay={readyAt,recordedAt,passed:readyAt<=now};
    }
    if(withTiming&&row.status==="preparing"&&!saved.pickupDelay){
      const quote=receiptTiming(row,queue,timing);
      if(quote)saved.kitchenQuote=quote;
    }
    return json(saved);
  }
  const staffReschedule=path==="/api/kitchen/pickup-reschedule"&&method==="PATCH";
  if(["/api/ticket/reschedule-options","/api/kitchen/pickup-reschedule-options"].includes(path)&&method==="GET"){
    const staff=path.startsWith("/api/kitchen/");
    const ref=staff?collectionId(url):request.headers.get("X-Ticket");
    if(staff?ref===null:!uuid.test(ref))return fail("找不到訂單",404);
    const now=Date.now(),date=url.searchParams.get("date")??businessDate(now);
    if(!pickupBookingDays(now).includes(date))return fail("請選擇七天內的取餐日期。");
    const orderKey=staff?"id":"token";
    if(url.searchParams.get("suggest")==="1"){
      const {order,suggestion}=await suggestPickupSlot(db,now,date,orderKey,ref);
      if(!order)return fail("找不到訂單",404);
      if(!canReschedulePickup(order,now))return fail("這張餐單已進入備餐時間或已結單，無法更改時段。",409);
      return json({suggestion});
    }
    const range=businessDayRange(date);
    const lookup=db.prepare(`SELECT mode,status,pickup_slot,
      CASE WHEN pickup_slot>=? AND pickup_slot<? THEN '[]'
      ELSE (SELECT json_group_array(dish) FROM (${exceededOrderPortions})) END AS shortages
      FROM orders WHERE ${orderKey}=?`).bind(...range,date,...range,ref);
    const {order,availability}=await pickupSlotOptions(db,now,date,lookup);
    if(!order)return fail("找不到訂單",404);
    if(!canReschedulePickup(order,now))return fail("這張餐單已進入備餐時間或已結單，無法更改時段。",409);
    return json({...availability,shortages:JSON.parse(order.shortages)});
  }
  if(staffReschedule||(path==="/api/ticket/reschedule"&&method==="POST")){
    const orderRef=staffReschedule?input.id:request.headers.get("X-Ticket");
    if(staffReschedule){
      if(!Number.isSafeInteger(orderRef)||orderRef<1)return fail("請輸入有效的取餐號碼");
    }else if(!uuid.test(orderRef))return fail("找不到訂單",404);
    const {from,to,revision}=input;
    if(!Number.isSafeInteger(from)||from<1||!Number.isSafeInteger(to)||to<1||from===to||
      !Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)
      return fail("請選擇另一個有效的預約時段。");
    const now=Date.now(),date=bookedPickupDate(now,to);
    const range=businessDayRange(date??businessDate(now));
    const changesDay=from<range[0]||from>=range[1];
    const orderKey=staffReschedule?"id":"token";
    const actor=staffReschedule?",'actor','staff'":"";
    const [,,current,target]=await db.batch([
      expirePaymentHolds(db,now),
      db.prepare(`UPDATE orders SET pickup_slot=?, pickup_changes=json_insert(COALESCE(pickup_changes,'[]'),'$[#]',
        json_object('from',pickup_slot,'to',?,'at',?${actor}))
        WHERE ${orderKey}=? AND mode='pickup' AND status='pending' AND pickup_slot=? AND pickup_slot>?
        AND COALESCE(json_array_length(pickup_changes),0)=? AND ?
        AND NOT ${pickupDayPaused}
        AND ${usedAtPickupSlot}+${orderPortions}<=${capacityAtPickupSlot}
        AND (?=0 OR NOT EXISTS (${exceededOrderPortions}))`)
        .bind(to,to,now,orderRef,from,now+pickupPrepLead,revision,date?1:0,date,to,to,Number(changesDay),date,...range),
      db.prepare(`SELECT mode,status,pickup_slot,pickup_changes,${orderPortions} AS portions,
        (? AND EXISTS (${exceededOrderPortions})) AS daily_full FROM orders WHERE ${orderKey}=?`)
        .bind(Number(changesDay),date,...range,orderRef),
      pickupSlotUsage(db,to,date),
    ]);
    const row=current.results[0];
    if(!row)return fail("找不到訂單",404);
    const changes=pickupChanges(row),last=changes.at(-1);
    if(changes.length===revision+1&&row.pickup_slot===to&&last.from===from&&last.to===to)
      return json({pickupSlot:to,pickupChanges:changes,canReschedulePickup:canReschedulePickup(row,now)});
    if(row.pickup_slot==null)return fail("這張餐單沒有可改期的預約時段。",409);
    if(!canReschedulePickup(row,now))return fail("這張餐單已進入備餐時間或已結單，無法更改時段。",409);
    const stale=()=>fail(staffReschedule?"取餐時段已更新，請核對接單台。":"取餐時段已更新，請先核對收據。",409);
    if(row.pickup_slot!==from||changes.length!==revision)return stale();
    if(!date)return json({error:"這個取餐時段已停止預約，請重新選擇。",code:"pickup_slot_closed"},409);
    if(target.results[0].paused)return json({error:"此日期已暫停預約，原預約仍有效。",code:"pickup_day_paused"},409);
    if(row.daily_full)return json({error:"取餐日的餐點份數不足，原預約仍有效。",code:"portion_limit"},409);
    if(target.results[0].used+row.portions>target.results[0].capacity)
      return json({error:"此時段剩餘份數不足，原預約仍有效。",code:"pickup_slot_full"},409);
    return stale();
  }
  if (path === "/api/ticket/arrival" && method === "POST") {
    const token=request.headers.get("X-Ticket");
    if(!uuid.test(token))return fail("找不到訂單",404);
    const [,lookup]=await db.batch([
      db.prepare(`UPDATE orders SET pickup_arrived_at=?
        WHERE token=? AND mode='pickup' AND status IN ('preparing','ready')
        AND pickup_arrived_at IS NULL AND ${payableForKitchen}`).bind(Date.now(),token),
      db.prepare("SELECT id,pickup_arrived_at FROM orders WHERE token=?").bind(token),
    ]);
    const row=lookup.results[0];
    if(!row)return fail("找不到訂單",404);
    return row.pickup_arrived_at==null?fail("目前無法回報到店，請核對餐單與付款狀態。",409):
      json({id:row.id,pickupArrivedAt:row.pickup_arrived_at});
  }
  if (path === "/api/ticket/cancel" && method === "POST") {
    const token=request.headers.get("X-Ticket");
    if(!uuid.test(token))return fail("找不到訂單",404);
    const now=Date.now();
    const [,,current]=await db.batch([
      expirePaymentHolds(db,now,token),
      db.prepare(`UPDATE orders SET status='cancelled',
        status_history=json_insert(COALESCE(status_history,'[]'),'$[#]',
          json_object('from',status,'status','cancelled','at',?, 'actor','customer'))
        WHERE token=? AND status='pending' AND ${noBlockingPayment}`).bind(now,token),
      db.prepare("SELECT status FROM orders WHERE token=?").bind(token),
    ]);
    const row=current.results[0];
    if(!row)return fail("找不到訂單",404);
    return row.status==="cancelled" ? json({status:row.status}) :
      fail("餐單已開始處理或付款狀態已更新，請重新核對收據。",409);
  }
  if (path === "/api/kitchen/prep" && method === "GET") {
    const now=Date.now(),today=businessDate(now),date=url.searchParams.get("date")??today;
    if(!pickupBookingDays(now).includes(date))return fail("請選擇七天內的備料日期。");
    const includeRemaining=url.searchParams.get("stationProgress")==="1";
    const [start,end]=businessDayRange(date);
    const from=date===today?"":` AND ${supplyTime}>=?`;
    const {results} = await db.prepare(`SELECT id, created, status, items${includeRemaining?", station_progress":""} FROM orders
      WHERE status IN ('pending','preparing') AND ${payableForKitchen}
      AND ${supplyTime}<?${from} ORDER BY id`).bind(end,...(from?[start]:[])).all();
    const portions=items=>items.map(({id,qty})=>({id,qty}));
    const orders=results.map(({id,created,status,items})=>({id,created,status,items:portions(JSON.parse(items))}));
    const remainingOrders=includeRemaining?results.flatMap((row,index)=>{
      const order=orders[index];
      if(row.status!=="preparing"||!row.station_progress)return [order];
      const items=portions(remainingStationItems(row));
      return items.length?[{...order,items}]:[];
    }):undefined;
    return json({capturedAt:now,date,orders,...(includeRemaining?{remainingOrders}:{})});
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
    const includeTiming=url.searchParams.get("timing")==="1";
    const includeItemChannels=url.searchParams.get("itemChannels")==="1";
    const includePickupPunctuality=url.searchParams.get("pickupPunctuality")==="1";
    const includePaymentSummary=url.searchParams.get("paymentSummary")==="1";
    const optional={
      ...(includeTiming?{timing:dailyTimingRows(db,range),arrival:arrivalTimingRows(db,range)}:{}),
      ...(includePickupPunctuality?{pickup:pickupPunctualityRows(db,range)}:{}),
      ...(includePaymentSummary?{payment:dailyPaymentRows(db,range)}:{}),
    };
    const [,counts,portions,...details] = await db.batch([
      expirePaymentHolds(db,Date.now()),
      db.prepare(`SELECT mode, COUNT(*) AS orders, SUM(status='pending') AS pending,
        SUM(status='preparing') AS preparing, SUM(status='ready') AS ready,
        SUM(status='completed') AS completed, SUM(status='cancelled') AS cancelled,
        SUM(CASE WHEN status='completed' THEN total ELSE 0 END) AS completedTotal
        FROM orders WHERE created>=? AND created<? GROUP BY mode`).bind(...range),
      db.prepare(`SELECT json_extract(line.value,'$.id') AS id,
        MIN(json_extract(line.value,'$.name')) AS name, SUM(json_extract(line.value,'$.qty')) AS qty,
        SUM(CASE WHEN mode='pickup' THEN json_extract(line.value,'$.qty') ELSE 0 END) AS pickupQty,
        SUM(CASE WHEN mode='table' THEN json_extract(line.value,'$.qty') ELSE 0 END) AS tableQty
        FROM orders JOIN json_each(orders.items) AS line
        WHERE created>=? AND created<? AND status='completed'
        GROUP BY json_extract(line.value,'$.id') ORDER BY qty DESC, id`).bind(...range),
      ...Object.values(optional),
    ]);
    const empty={orders:0,pending:0,preparing:0,ready:0,completed:0,cancelled:0,completedTotal:0};
    const channels={pickup:empty,table:empty};
    for(const {mode,...count} of counts.results) {
      if(Object.hasOwn(channels,mode)) channels[mode]=count;
    }
    const names=new Map(dishes.map(({id,name})=>[id,name]));
    const items=portions.results.map(({id,name,qty,pickupQty,tableQty})=>({
      id,name:names.get(id)??name??id,qty,...(includeItemChannels?{pickupQty,tableQty}:{}),
    }));
    const capturedAt=Date.now();
    const rows=Object.fromEntries(Object.keys(optional).map((key,index)=>[key,details[index].results]));
    return json({format:"hey-table.daily-operations.v1",date,timeZone:"Asia/Taipei",capturedAt,channels,items,
      ...(includeTiming?{timing:dailyTiming(rows.timing,capturedAt),arrivalTiming:arrivalTiming(rows.arrival,capturedAt)}:{}),
      ...(includePickupPunctuality?{pickupPunctuality:pickupPunctuality(rows.pickup,capturedAt)}:{}),
      ...(includePaymentSummary?{paymentSummary:dailyPaymentSummary(rows.payment)}:{})});
  }
  if (path === "/api/kitchen/handoff" && method === "GET") {
    const id = collectionId(url);
    if (id === null) return fail("請輸入有效的取餐號碼");
    const row = await db.prepare("SELECT id,table_no,source,status,items,pickup_slot FROM orders WHERE id=?").bind(id).first();
    if (!row) return fail("找不到這個取餐號碼",404);
    if (!["ready","completed"].includes(row.status)) return fail("餐單尚無可列印的交餐小票。",409);
    const items = JSON.parse(row.items).map(({name,qty,note}) => ({name,qty,...(note?{note}:{})}));
    return json({id:row.id,table:row.table_no,status:row.status,items,...(row.source==="staff"?{source:row.source}:{}),
      ...(row.pickup_slot!=null?{pickupSlot:row.pickup_slot}:{})});
  }
  if (path === "/api/kitchen/pickup" && method === "GET") {
    const id = collectionId(url);
    if (id === null) return fail("請輸入有效的取餐號碼");
    const row = await db.prepare(`${selectOrders} WHERE id=? AND mode='pickup'`).bind(id).first();
    return row ? json(receipt(row)) : fail("找不到這張自取餐單",404);
  }
  if (path === "/api/kitchen/pickup-booking" && method === "GET") {
    const id=collectionId(url);
    if(id===null)return fail("請輸入有效的取餐號碼");
    const capturedAt=Date.now();
    const [,lookup]=await db.batch([expirePaymentHolds(db,capturedAt),db.prepare(`${orderColumns}${kitchenPayableAt},${pickupDelayColumn}
      FROM orders WHERE id=? AND mode='pickup' AND pickup_slot IS NOT NULL`).bind(id)]);
    const row=lookup.results[0];
    return row?json(kitchenOrder(row,capturedAt)):fail("找不到這張預約自取餐單。",404);
  }
  if (path === "/api/kitchen/pickup-display" && method === "GET") {
    const {results}=await db.prepare(`SELECT id,status FROM orders
      WHERE mode='pickup' AND status IN ('preparing','ready') AND ${payableForKitchen}
      ORDER BY id`).all();
    const numbers={ready:[],preparing:[]};
    for(const {id,status} of results)numbers[status].push(id);
    return json({capturedAt:Date.now(),...numbers});
  }
  if (path === "/api/kitchen/pickup-roster" && method === "GET") {
    const capturedAt=Date.now(),date=url.searchParams.get("date")??businessDate(capturedAt);
    const range=businessDayRange(date);
    if(!range)return fail("請選擇有效的取餐日期。");
    const slot=url.searchParams.get("slot");
    if(slot!==null){
      const start=pickupSlotsForDay(date).find(value=>String(value)===slot);
      if(start===undefined)return fail("請選擇這個日期的取餐時段。");
      return json(await pickupRoster(db,date,[start,start+1],capturedAt));
    }
    return json(await pickupRoster(db,date,range,capturedAt));
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
    const forBoard=path==="/api/kitchen";
    const extra=forBoard?`${kitchenPayableAt},${pickupDelayColumn}`:"";
    const capturedAt=Date.now();
    const [,queue] = await db.batch([expirePaymentHolds(db,capturedAt),db.prepare(`${orderColumns}${extra} FROM orders WHERE status NOT IN ('completed','cancelled')
        OR id IN (SELECT id FROM orders WHERE status IN ('completed','cancelled') ORDER BY id DESC LIMIT 20)
        ORDER BY id DESC`)]);
    const {results}=queue;
    if (path === "/api/kitchen/stations") {
      const orders=results.map(receipt);
      return json({format:"hey-table.station-orders.v1",capturedAt:Date.now(),throughId:orders[0]?.id ?? 0,
        orders:orders.map(({id,created,mode,table,note,status,items}) => ({
          id,created,mode,table,note,status,items:items.map(({id,name,qty,note:itemNote}) => ({id,name,qty,...(itemNote?{note:itemNote}:{})}))
        }))});
    }
    return json(results.map(row=>kitchenOrder(row,capturedAt)));
  }
  if(path==="/api/kitchen/pickup-delay"&&method==="PATCH"){
    const {id,revision,operationId,minutes}=input;
    if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER||
      typeof operationId!=="string"||!uuid.test(operationId)||(minutes!==null&&(!Number.isInteger(minutes)||minutes<1||minutes>240)))
      return fail("餐號、版次或預計分鐘數無效。");
    const update=await updatePickupDelay(db,{id,revision,operationId:operationId.toLowerCase(),minutes},Date.now());
    if(update===null)return fail("找不到餐單。",404);
    return update?json(update):fail("餐單或備妥時間已更新，請核對接單台。",409);
  }
  if (path === "/api/kitchen/table" && method === "PATCH") {
    const {id,from,to,revision}=input;
    if(!Number.isSafeInteger(id)||id<1||!tables.includes(from)||!tables.includes(to)||from===to||
      !Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)
      return fail("餐單、桌號或版本無效");
    const {meta}=await db.prepare(`UPDATE orders SET table_no=?,
      table_moves=json_insert(COALESCE(table_moves,'[]'),'$[#]',json_object('from',table_no,'to',?,'at',?))
      WHERE id=? AND mode='table' AND table_no=? AND status IN ('pending','preparing','ready')
      AND COALESCE(json_array_length(table_moves),0)=?`).bind(to,to,Date.now(),id,from,revision).run();
    return meta.changes?json({id,table:to,tableRevision:revision+1}):
      fail("餐單或桌號已更新，請核對後再換桌。",409);
  }
  if (path === "/api/kitchen/table-handoff" && method === "PATCH") {
    const {table,orders}=input;
    if (!tables.includes(table) || !Array.isArray(orders) || orders.length<2 ||
        orders.some(order=>!order || !Number.isSafeInteger(order.id) || order.id<1 ||
          !Number.isSafeInteger(order.tableRevision) || order.tableRevision<0) ||
        new Set(orders.map(order=>order.id)).size!==orders.length)
      return fail("請提供同桌待交餐的餐單及桌號版本。");
    const reviewed=orders.map(({id,tableRevision})=>[id,tableRevision]);
    // Freeze the reviewed set before changing any of the rows it reads.
    const {meta}=await db.prepare(`WITH expected AS (
        SELECT json_extract(value,'$[0]') AS id, json_extract(value,'$[1]') AS revision FROM json_each(?)
      ), ready AS MATERIALIZED (
        SELECT orders.id, expected.id IS NOT NULL AND expected.revision=COALESCE(json_array_length(table_moves),0)
          AND ${payableForKitchen} AS reviewed
        FROM orders LEFT JOIN expected ON expected.id=orders.id
        WHERE orders.mode='table' AND table_no=? AND status='ready'
      )
      UPDATE orders SET status='completed',
        status_history=json_insert(COALESCE(status_history,'[]'),'$[#]',json_object('from','ready','status','completed','at',?))
      WHERE id IN (SELECT id FROM ready WHERE (SELECT COUNT(*) FROM ready)=?
        AND (SELECT COUNT(*) FROM ready WHERE reviewed)=?)`)
      .bind(JSON.stringify(reviewed),table,Date.now(),orders.length,orders.length).run();
    return meta.changes ? json({table,completed:meta.changes}) :
      fail("待交餐餐單已更新或付款狀態有變，請重新核對整桌。",409);
  }
  if (path === "/api/kitchen/status" && method === "PATCH") {
    if (!Number.isSafeInteger(input.id) || !Object.hasOwn(transitions,input.from) ||
        !transitions[input.from].includes(input.to)) return fail("無效的訂單狀態轉換");
    const expectedTable=input.tableRevision;
    if(expectedTable!==undefined&&(input.to!=="completed"||!Number.isSafeInteger(expectedTable)||expectedTable<0))
      return fail("桌號版本無效");
    const expectedPickup=input.pickupRevision;
    if(expectedPickup!==undefined&&(input.to!=="preparing"||!Number.isSafeInteger(expectedPickup)||expectedPickup<0))
      return fail("預約版本無效");
    const readyGuard=input.to==="ready"?" AND station_progress IS NULL":"";
    const tableGuard=expectedTable===undefined?"":" AND COALESCE(json_array_length(table_moves),0)=?";
    const now=Date.now();
    const prepGuard=input.to==="preparing"?` AND (pickup_slot IS NULL OR
      (pickup_slot<=? AND COALESCE(json_array_length(pickup_changes),0)=?))`:"";
    const {meta} = await db.prepare(`UPDATE orders SET status=?,
      status_history=json_insert(COALESCE(status_history,'[]'),'$[#]',json_object('from',status,'status',?,'at',?))
      WHERE id=? AND status=? AND `+(input.to==="cancelled" ?
      "(payment_method='cash' OR COALESCE("+latestState+",'unpaid') IN ('unpaid','failed','cancelled','refunded'))" : payableForKitchen)+readyGuard+tableGuard+prepGuard)
      .bind(input.to,input.to,now,input.id,input.from,...(expectedTable===undefined?[]:[expectedTable]),
        ...(prepGuard?[now+pickupPrepLead,expectedPickup??0]:[])).run();
    return meta.changes ? json({ok:true}) : fail(input.to==="ready"?"訂單已更新，請重新整理或開啟分站看板":
      expectedPickup!==undefined?"取餐時段或餐單狀態已更新，請核對後再接單。":"訂單已更新，請重新整理",409);
  }
  if (path === "/api/kitchen/availability" && method === "PATCH") {
    if (!dishes.some(d=>d.id===input.id) || typeof input.available !== "boolean") return fail("餐點狀態錯誤");
    await db.prepare(input.available ? "DELETE FROM unavailable WHERE dish=?" :
      "INSERT INTO unavailable VALUES (?) ON CONFLICT DO NOTHING").bind(input.id).run();
    return json({ok:true});
  }
  return fail("找不到此操作",404);
}
