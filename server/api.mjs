import qrcode from "qrcode-generator";
import {dishes, tables, transitions} from "../lib/menu.mjs";

const json = (value, status=200) => Response.json(value,{status,headers:{"Cache-Control":"no-store"}});
const fail = (message,status=400) => json({error:message},status);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function receipt(row) {
  return {id:row.id, mode:row.mode, table:row.table_no, note:row.note, items:JSON.parse(row.items),
    total:row.total, status:row.status, created:row.created};
}
function prepare(input) {
  if (!uuid.test(input.token) || !["pickup","table"].includes(input.mode) ||
      (input.mode === "table" ? !tables.includes(input.table) : input.table != null) ||
      typeof input.note !== "string" || input.note.length > 160 ||
      !Array.isArray(input.items) || !input.items.length || input.items.length > dishes.length) return null;
  const byId = new Map();
  for (const line of input.items) {
    if (!line || !dishes.some(d => d.id === line.id) || byId.has(line.id) ||
        !Number.isInteger(line.qty) || line.qty < 1 || line.qty > 20) return null;
    byId.set(line.id,line.qty);
  }
  const items = dishes.filter(d => byId.has(d.id)).map(({id,name,price}) => ({id,name,price,qty:byId.get(id)}));
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
    if (!signedIn && !keyed) return fail("請以店主管理帳號登入",403);
  }
  if (!["GET","HEAD"].includes(method) && request.headers.get("Origin") && request.headers.get("Origin") !== url.origin)
    return fail("請從本站提交",403);
  let input;
  if (["POST","PATCH"].includes(method)) {
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return fail("需要 JSON",415);
    try { input = await request.json(); } catch {return fail("資料格式錯誤");}
    if (!input || typeof input !== "object") return fail("資料格式錯誤");
  }
  if (path === "/api/menu" && method === "GET") {
    const {results} = await db.prepare("SELECT dish FROM unavailable").all();
    return json({unavailable:results.map(r=>r.dish)});
  }
  if (path === "/api/orders" && method === "POST") {
    const order = prepare(input);
    if (!order) return fail("請確認桌號、餐點數量與備註");
    const lines = JSON.stringify(order.items);
    const stmt = db.prepare(`INSERT INTO orders(token,mode,table_no,note,items,total,created)
      SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM unavailable u
      JOIN json_each(?) j ON u.dish=json_extract(j.value,'$.id')) ON CONFLICT(token) DO NOTHING`);
    await stmt.bind(order.token,order.mode,order.table,order.note,lines,order.total,Date.now(),lines).run();
    const row = await db.prepare("SELECT * FROM orders WHERE token=?").bind(order.token).first();
    if (!row) return fail("部分餐點已售完，請重新確認菜單",409);
    if (row.mode!==order.mode || row.table_no!==order.table || row.note!==order.note || row.items!==lines)
      return fail("送單識別碼已用於另一張訂單",409);
    return json(receipt(row));
  }
  if (path === "/api/ticket" && method === "GET") {
    const token = request.headers.get("X-Ticket");
    if (!uuid.test(token)) return fail("找不到訂單",404);
    const row = await db.prepare("SELECT * FROM orders WHERE token=?").bind(token).first();
    return row ? json(receipt(row)) : fail("找不到訂單",404);
  }
  if (path === "/api/kitchen/prep" && method === "GET") {
    const {results} = await db.prepare(`SELECT id, created, status, items FROM orders
      WHERE status IN ('pending','preparing') ORDER BY id`).all();
    const orders = results.map(row => ({
      ...row, items: JSON.parse(row.items).map(({id, qty}) => ({id, qty}))
    }));
    return json({capturedAt: Date.now(), orders});
  }
  if (path === "/api/kitchen" && method === "GET") {
    const {results} = await db.prepare(`SELECT * FROM orders WHERE status NOT IN ('completed','cancelled')
        OR id IN (SELECT id FROM orders WHERE status IN ('completed','cancelled') ORDER BY id DESC LIMIT 20)
        ORDER BY id DESC`).all();
    return json(results.map(receipt));
  }
  if (path === "/api/kitchen/status" && method === "PATCH") {
    if (!Number.isSafeInteger(input.id) || !Object.hasOwn(transitions,input.from) ||
        !transitions[input.from].includes(input.to)) return fail("無效的訂單狀態轉換");
    const {meta} = await db.prepare("UPDATE orders SET status=? WHERE id=? AND status=?")
      .bind(input.to,input.id,input.from).run();
    return meta.changes ? json({ok:true}) : fail("訂單已更新，請重新整理",409);
  }
  if (path === "/api/kitchen/availability" && method === "PATCH") {
    if (!dishes.some(d=>d.id===input.id) || typeof input.available !== "boolean") return fail("餐點狀態錯誤");
    await db.prepare(input.available ? "DELETE FROM unavailable WHERE dish=?" :
      "INSERT INTO unavailable VALUES (?) ON CONFLICT DO NOTHING").bind(input.id).run();
    return json({ok:true});
  }
  return fail("找不到此操作",404);
}
