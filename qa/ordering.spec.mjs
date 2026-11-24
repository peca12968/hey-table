import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {execFileSync,spawnSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import jsQR from "jsqr";
import {PNG} from "pngjs";

test("reorder adds available quantities at today's prices and submits only after confirmation",async({page,request})=>{
  await page.setViewportSize({width:360,height:800});
  const staff={Authorization:"Bearer local-test-kitchen"};
  const token=randomUUID();
  const original=await request.post("/api/orders",{data:{token,mode:"table",table:"A03",note:"舊餐單備註",
    items:[{id:"oyakodon",qty:3},{id:"sencha",qty:1}]}});
  expect(original.ok()).toBe(true);
  const {id}=await original.json();
  expect((await request.patch("/api/kitchen/status",{headers:staff,data:{id,from:"pending",to:"cancelled"}})).ok()).toBe(true);
  const mark=available=>request.patch("/api/kitchen/availability",{headers:staff,data:{id:"sencha",available}});
  expect((await mark(false)).ok()).toBe(true);
  try{
    await page.goto("/ticket#"+token);
    await page.evaluate(()=>{
      localStorage.setItem("he-ri-cart-v1:A03",JSON.stringify({cart:{oyakodon:19},note:"本次備註",method:"cash"}));
      localStorage.setItem("he-ri-cart-v1:pickup",JSON.stringify({cart:{edamame:2},note:"自取餐單"}));
    });
    let posted=0;
    page.on("request",req=>{if(req.method()==="POST"&&new URL(req.url()).pathname==="/api/orders")posted++;});
    await page.route("**/api/ticket",async route=>{
      const reply=await route.fetch();
      const receipt=await reply.json();
      await route.fulfill({response:reply,json:{...receipt,items:receipt.items.map(item=>({...item,price:1}))}});
    });
    await page.getByRole("link",{name:"再次點餐"}).click();
    const review=page.getByRole("region",{name:"再次點餐"});
    await expect(review.getByText(/雞肉親子丼.*可加入 1 份.*最多 20 份/)).toBeVisible();
    await expect(review.getByText(/日式熱煎茶.*已售完/)).toBeVisible();
    await expect(page.getByRole("textbox",{name:/訂單備註/})).toHaveValue("本次備註");
    expect(posted).toBe(0);
    await review.getByRole("button",{name:"加入這些餐點"}).click();
    await expect(review).toBeHidden();
    expect(new URL(page.url()).hash).toBe("");
    const cart=page.getByRole("complementary",{name:"我的餐單"});
    await expect(cart.getByRole("heading",{name:"我的餐單"})).toBeVisible();
    await expect(cart.getByText("NT$ 3400",{exact:true}).first()).toBeVisible();
    await expect(cart.getByText("日式熱煎茶",{exact:true})).toHaveCount(0);
    expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("he-ri-cart-v1:pickup")).cart)).toEqual({edamame:2});
    expect(posted).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    await cart.getByRole("button",{name:"確認送出訂單"}).click();
    await expect(page.getByRole("heading",{name:/取餐號碼/})).toBeVisible();
    expect(posted).toBe(1);
    const newer=new URL(page.url()).hash.slice(1);
    expect(newer).not.toBe(token);
    const receipt=await (await request.get("/api/ticket",{headers:{"X-Ticket":newer}})).json();
    expect(receipt).toMatchObject({table:"A03",note:"本次備註",total:3400,items:[{id:"oyakodon",qty:20,price:170}]});
  }finally{
    expect((await mark(true)).ok()).toBe(true);
  }
});

test("reorder review preserves an unresolved order in the same cart",async({page,request})=>{
  const token=randomUUID();
  const response=await request.post("/api/orders",{data:{token,mode:"pickup",table:null,note:"",items:[{id:"oyakodon",qty:1}]}});
  expect(response.ok()).toBe(true);
  const {id}=await response.json();
  expect((await request.patch("/api/kitchen/status",{headers:{Authorization:"Bearer local-test-kitchen"},
    data:{id,from:"pending",to:"cancelled"}})).ok()).toBe(true);
  const pending={token:randomUUID(),mode:"pickup",table:null,note:"待查餐單",items:[{id:"karaage",qty:1}]};
  await page.addInitScript(draft=>localStorage.setItem("he-ri-cart-v1:pickup",
    JSON.stringify({draft,cart:{karaage:1},note:draft.note})),pending);
  await page.goto("/#reorder="+token);
  const review=page.getByRole("region",{name:"再次點餐"});
  await expect(review.getByText(/可加入 1 份/)).toBeVisible();
  await expect(review.getByRole("button",{name:"加入這些餐點"})).toBeDisabled();
  await review.getByRole("button",{name:"取消帶入"}).click();
  await expect(review).toBeHidden();
  await expect(page.getByRole("button",{name:"重試同一張訂單"})).toBeVisible();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("he-ri-cart-v1:pickup")).draft)).toEqual(pending);
});

test("staff filter a mobile handoff queue by channel, table and exact collection number",async({page,request})=>{
  await page.setViewportSize({width:360,height:800});
  const headers={Authorization:"Bearer local-test-kitchen"};
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  async function ready(mode,table){
    const token=randomUUID();
    const submitted=await request.post("/api/orders",{data:{mode,table,token,note:"",items:[{id:"oyakodon",qty:1}]}});
    expect(submitted.ok()).toBe(true);
    const {id}=await submitted.json();
    for (const [from,to] of [["pending","preparing"],["preparing","ready"]]){
      const moved=await request.patch("/api/kitchen/status",{headers,data:{id,from,to}});
      expect(moved.ok()).toBe(true);
    }
    return {id,token};
  }
  const pickup=await ready("pickup",null), table=await ready("table","A03"), other=await ready("table","A04");
  const number=id=>String(id).padStart(4,"0");
  const card=({id})=>page.locator(".kitchenTicket").filter({has:page.getByRole("heading",{name:"#"+number(id),exact:true})});
  const search=page.getByRole("searchbox",{name:"取餐號碼"});
  const scope=page.getByRole("combobox",{name:"管道或桌號"});
  await page.goto("/kitchen");
  await page.getByRole("button",{name:"待交餐",exact:true}).click();
  await scope.selectOption("table");
  await expect(card(pickup)).toHaveCount(0);
  await expect(card(table)).toBeVisible();
  await expect(card(other)).toBeVisible();
  await scope.selectOption("A03");
  await expect(card(other)).toHaveCount(0);
  await expect(card(table)).toBeVisible();
  await search.fill("#"+number(pickup.id));
  await expect(page.locator(".kitchenTicket")).toHaveCount(0);
  await scope.selectOption("pickup");
  await search.fill("＃"+number(pickup.id).replace(/\d/g,d=>String.fromCharCode(d.charCodeAt(0)+0xfee0)));
  await expect(card(pickup)).toBeVisible();
  await expect(page.locator(".kitchenTicket")).toHaveCount(1);
  await search.fill("A03");
  await expect(search).toHaveAttribute("aria-invalid","true");
  await expect(page.locator(".kitchenTicket")).toHaveCount(0);
  await search.fill(String(pickup.id));
  await card(pickup).getByRole("button",{name:"完成交餐"}).click();
  await expect(card(pickup)).toHaveCount(0);
  await expect(search).toHaveValue(String(pickup.id));
  await page.getByRole("button",{name:"含近期結單",exact:true}).click();
  await expect(card(pickup)).toBeVisible();
  const receipt=await request.get("/api/ticket",{headers:{"X-Ticket":pickup.token}});
  expect((await receipt.json()).status).toBe("completed");
  await page.getByRole("button",{name:"清除搜尋條件"}).click();
  await expect(search).toHaveValue("");
  await expect(scope).toHaveValue("all");
  await expect(card(table)).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
});

test("mobile receipt follows committed kitchen progress for its own order",async({page,request})=>{
  await page.setViewportSize({width:360,height:800});
  const staff={Authorization:"Bearer local-test-kitchen"};
  const sample=JSON.parse(await readFile(new URL("../examples/receipt-progress.json",import.meta.url),"utf8"));
  const statuses=history=>history.map(event=>event.status);
  async function create(mode,table){
    const token=randomUUID();
    const response=await request.post("/api/orders",{data:{token,mode,table,note:"",items:[{id:"oyakodon",qty:1}]}});
    expect(response.ok()).toBeTruthy();
    return {token,...await response.json()};
  }
  const table=await create("table","A03");
  const pickup=await create("pickup",null);
  const move=(id,from,to)=>request.patch("/api/kitchen/status",{headers:staff,data:{id,from,to}});
  const ticket=token=>request.get("/api/ticket?progress=1",{headers:{"X-Ticket":token}});
  await page.goto("/ticket#"+table.token);
  const progress=page.getByRole("region",{name:"餐單進度"});
  const list=progress.getByRole("listitem");
  await expect(list).toHaveText([/^已送單/]);
  const race=await Promise.all([move(table.id,"pending","preparing"),move(table.id,"pending","preparing")]);
  expect(race.map(response=>response.status()).sort()).toEqual([200,409]);
  await expect(list).toHaveText([/^已送單/,/^店家接單，開始製作/],{timeout:8000});
  expect((await move(table.id,"preparing","ready")).status()).toBe(200);
  expect((await move(table.id,"ready","completed")).status()).toBe(200);
  await page.getByRole("button",{name:"更新進度"}).click();
  await expect(list).toHaveText([/^已送單/,/^店家接單，開始製作/,/^餐點已備妥/,/^已交餐/]);
  const history=(await (await ticket(table.token)).json()).statusHistory;
  expect(statuses(history)).toEqual(statuses(sample.find(row=>row.scenario==="table").statusHistory));
  expect(history[0].at).toBe(table.created);
  expect(history.every(event=>Number.isSafeInteger(event.at))).toBe(true);
  for (const [index,event] of history.entries())
    await expect(list.nth(index).locator("time")).toHaveAttribute("datetime",new Date(event.at).toISOString());
  await expect(progress.locator('[aria-current="step"]')).toHaveText(/^已交餐/);
  await page.reload();
  await expect(list).toHaveCount(4);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);

  expect((await move(pickup.id,"pending","cancelled")).status()).toBe(200);
  await page.goto("/ticket#"+pickup.token);
  await expect(list).toHaveText([/^已送單/,/^店家已取消/]);
  expect(statuses((await (await ticket(pickup.token)).json()).statusHistory))
    .toEqual(statuses(sample.find(row=>row.scenario==="pickup").statusHistory));
  expect((await ticket(randomUUID())).status()).toBe(404);
  expect((await ticket("")).status()).toBe(404);
});

test("reopen a lost A03 receipt after the kitchen committed, without resubmitting",async({context,page,request})=>{
  await page.setViewportSize({width:390,height:844});
  const attempts=[];
  let accepted;
  await context.route("**/api/orders",async route=>{
    attempts.push(route.request().postDataJSON());
    const response=await route.fetch();
    expect(response.status()).toBe(200);
    accepted=await response.json();
    await route.abort("connectionreset");
  });
  await context.route("**/api/ticket",route=>route.abort("internetdisconnected"));
  await page.goto("/?table=A03");
  await page.getByRole("button",{name:"加入雞肉親子丼",exact:true}).click();
  await page.getByRole("button",{name:/我的餐單/}).click();
  await page.getByRole("textbox").fill("斷線收據回復");
  await page.getByRole("button",{name:"確認送出訂單"}).click();
  await expect(page.getByRole("button",{name:"重試同一張訂單"})).toBeEnabled();
  await page.close();

  await context.unroute("**/api/ticket");
  const reopened=await context.newPage();
  await reopened.goto("/ticket");
  await reopened.getByRole("link",{name:"確認 A03 桌送單結果"}).click();
  await expect(reopened.getByRole("heading",{name:"取餐號碼 "+String(accepted.id).padStart(4,"0")})).toBeVisible();
  expect(new URL(reopened.url()).hash).toBe("#"+attempts[0].token);
  expect(attempts).toHaveLength(1);
  const orders=await (await request.get("/api/kitchen",{headers:{Authorization:"Bearer local-test-kitchen"}})).json();
  expect(orders.filter(row=>row.note==="斷線收據回復").map(row=>row.id)).toEqual([accepted.id]);
  await reopened.goto("/?table=A03");
  await expect(reopened.getByText("餐單還是空的")).toBeVisible();
});

test("an undelivered pickup remains editable only after a definitive rejection",async({context,page,request})=>{
  const attempts=[];
  await context.route("**/api/orders",async route=>{
    attempts.push(route.request().postDataJSON());
    if(attempts.length===1) await route.abort("connectionreset");
    else await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button",{name:"加入滑蛋豬排丼",exact:true}).click();
  await page.getByRole("textbox").fill("保留自取餐單");
  await page.getByRole("button",{name:"確認送出訂單"}).click();
  await expect(page.getByText(/目前查無這張訂單/)).toBeVisible();
  const unavailable=route=>route.fulfill({status:503,contentType:"application/json",body:'{"error":"暫時無法查詢"}'});
  await context.route("**/api/ticket",unavailable);
  await page.reload();
  await expect(page.getByText(/目前無法確認送單結果/)).toBeVisible();
  await expect(page.getByRole("textbox")).toBeDisabled();
  expect(attempts).toHaveLength(1);
  await context.unroute("**/api/ticket",unavailable);
  await page.evaluate(()=>window.dispatchEvent(new Event("online")));
  await expect(page.getByText(/目前查無這張訂單/)).toBeVisible();
  expect(attempts).toHaveLength(1);
  const headers={Authorization:"Bearer local-test-kitchen"};
  const mark=available=>request.patch("/api/kitchen/availability",{headers,data:{id:"katsudon",available}});
  try{
    expect((await mark(false)).ok()).toBeTruthy();
    await page.getByRole("button",{name:"重試同一張訂單"}).click();
    await expect(page.getByRole("alert")).toContainText("已售完");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(page.getByRole("textbox")).toBeEditable();
    await expect(page.getByRole("textbox")).toHaveValue("保留自取餐單");
  }finally{await mark(true);}
});

test("resume a saved v1 mobile cart and keep a different table's pending cart",async({page,request})=>{
  await page.setViewportSize({width:390,height:844});
  const draft=table=>({token:randomUUID(),mode:"table",table,note:"",items:[{id:"karaage",qty:2}]});
  const chosen=draft("A01"), other=draft("A02");
  await page.goto("/ticket");
  await page.evaluate(carts=>{
    for(const draft of carts) localStorage.setItem("he-ri-cart-v1:"+draft.table,
      JSON.stringify({draft,cart:{karaage:2},note:""}));
  },[chosen,other]);
  const posts=[];
  page.on("request",r=>{if(new URL(r.url()).pathname==="/api/orders"&&r.method()==="POST")posts.push(r.postDataJSON());});
  await page.reload();
  await expect(page.getByRole("link",{name:"確認 A02 桌送單結果"})).toBeVisible();
  await page.getByRole("link",{name:"確認 A01 桌送單結果"}).click();
  await expect(page.getByText(/目前查無這張訂單/)).toBeVisible();
  expect(posts).toEqual([]);
  await page.getByRole("button",{name:"重試同一張訂單"}).click();
  await expect(page.getByRole("heading",{name:/取餐號碼/})).toBeVisible();
  await expect(page.getByText("A01 桌內用")).toBeVisible();
  expect(posts).toEqual([chosen]);
  await page.goto("/ticket");
  await expect(page.getByRole("link",{name:"確認 A02 桌送單結果"})).toBeVisible();
  await expect(page.getByRole("link",{name:"確認 A01 桌送單結果"})).toHaveCount(0);
  expect((await request.get("/api/ticket",{headers:{"X-Ticket":other.token}})).status()).toBe(404);
});

test("decode the printed table card and send a mobile order to an independent kitchen",async({browser,page})=>{
  await page.goto("/tables");
  const code=page.getByRole("img",{name:"A03 桌點餐 QR Code"});
  await expect(code).toBeVisible();
  const png=PNG.sync.read(await code.screenshot());
  const scanned=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);
  expect(scanned?.data).toBe("http://127.0.0.1:18841/?table=A03");
  const guest=await browser.newContext({viewport:{width:390,height:844}});
  try{
    const mobile=await guest.newPage();await mobile.goto(scanned.data);
    await mobile.getByRole("button",{name:"加入滑蛋豬排丼",exact:true}).click();
    await mobile.getByRole("button",{name:"我的餐單",exact:false}).click();
    await mobile.getByRole("textbox").fill("不用餐具");
    await mobile.getByRole("button",{name:"確認送出訂單"}).click();
    await expect(mobile.getByRole("heading",{name:/取餐號碼/})).toBeVisible();
    await expect(mobile.getByText("A03 桌內用")).toBeVisible();
    await page.goto("/kitchen");
    await page.getByText("使用自架店員金鑰").click();
    await page.getByLabel("店員金鑰",{exact:true}).fill("local-test-kitchen");
    await page.getByRole("button",{name:"登入",exact:true}).click();
    const ticket=page.locator(".kitchenTicket").filter({hasText:"不用餐具"});
    await ticket.getByRole("button",{name:"接單製作"}).click();
    await ticket.getByRole("button",{name:"完成製作"}).click();
    await mobile.getByRole("button",{name:"更新進度"}).click();
    await expect(mobile.getByText("可取餐",{exact:true})).toBeVisible();
    await ticket.getByRole("button",{name:"完成交餐"}).click();
    await mobile.getByRole("button",{name:"更新進度"}).click();
    await expect(mobile.getByText("已完成",{exact:true})).toBeVisible();
  }finally{await guest.close();}
});

test("pickup, retries, price authority, sold-out race and stale state transitions",async({page,request})=>{
  await page.goto("/");
  await page.getByRole("button",{name:"飲品",exact:true}).click();
  await page.getByRole("button",{name:"加入日式熱煎茶",exact:true}).click();
  await page.getByRole("button",{name:"確認送出訂單"}).click();
  await expect(page.getByRole("heading",{name:/取餐號碼/})).toBeVisible();
  await expect(page.getByText("線上自取",{exact:true})).toBeVisible();
  const admin={Authorization:"Bearer local-test-kitchen"};
  expect((await request.get("/api/kitchen")).status()).toBe(403);
  const data={token:randomUUID(),mode:"pickup",table:null,note:"",total:1,items:[{id:"gyoza",qty:2,price:1}]};
  const posts=await Promise.all([1,2,3].map(()=>request.post("/api/orders",{data})));
  const rows=await Promise.all(posts.map(r=>r.json()));
  expect(new Set(rows.map(r=>r.id)).size).toBe(1);expect(rows[0].total).toBe(170);
  expect((await request.post("/api/orders",{data:{...data,note:"不同"}})).status()).toBe(409);
  expect((await request.get("/api/ticket",{headers:{"X-Ticket":randomUUID()}})).status()).toBe(404);
  await request.patch("/api/kitchen/availability",{headers:admin,data:{id:"gyoza",available:false}});
  expect((await request.post("/api/orders",{data:{...data,token:randomUUID()}})).status()).toBe(409);
  expect((await request.post("/api/orders",{data})).status()).toBe(200);
  await request.patch("/api/kitchen/availability",{headers:admin,data:{id:"gyoza",available:true}});
  const change={id:rows[0].id,from:"pending",to:"preparing"};
  const race=await Promise.all([1,2].map(()=>request.patch("/api/kitchen/status",{headers:admin,data:change})));
  expect(race.map(r=>r.status()).sort()).toEqual([200,409]);
  expect((await request.post("/api/orders",{data:{...data,mode:"table",table:"Z99",token:randomUUID()}})).status()).toBe(400);
});

test("printable kitchen snapshot exports the displayed orders to Prep Sheet",async({page,request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"};
  expect((await request.get("/api/kitchen/prep")).status()).toBe(403);
  async function create(qty){
    const res=await request.post("/api/orders",{data:{mode:"table",table:"A03",token:randomUUID(),
      note:"這個備註只給接單台",items:[{id:"edamame",qty}]}});
    expect(res.ok()).toBeTruthy();
    return (await res.json()).id;
  }
  async function change(id,from,to){
    expect((await request.patch("/api/kitchen/status",{headers,data:{id,from,to}})).ok()).toBeTruthy();
  }
  const pending=await create(4), preparing=await create(2), cancelled=await create(8), ready=await create(5);
  await change(preparing,"pending","preparing");
  await change(cancelled,"pending","cancelled");
  await change(ready,"pending","preparing");
  await change(ready,"preparing","ready");
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen");
  await page.getByRole("link",{name:"查看備料單"}).click();
  await expect(page.getByRole("link",{name:"備料與採購試算說明"})).toHaveAttribute(
    "href","https://github.com/peca12968/hey-table/blob/main/modules/prep-sheet/README.md#從訂單匯出試算採購");
  const row=page.getByRole("row",{name:/鹽味毛豆/});
  await expect(row.getByRole("cell")).toHaveText(["4","2"]);
  await change(pending,"pending","cancelled");
  await page.emulateMedia({media:"print"});
  await expect(page.getByRole("heading",{name:"廚房備料單"})).toBeVisible();
  await expect(page.getByRole("button",{name:"列印備料單"})).toBeHidden();
  await page.emulateMedia({media:"screen"});
  const downloaded=page.waitForEvent("download");
  await page.getByRole("button",{name:"下載訂單 JSON"}).click();
  const path=await (await downloaded).path();
  const data=JSON.parse(await readFile(path,"utf8"));
  expect(data.map(order=>order.id)).toEqual(expect.arrayContaining([pending,preparing]));
  expect(data.some(order=>[cancelled,ready].includes(order.id))).toBe(false);
  for(const order of data){
    expect(Object.keys(order).sort()).toEqual(["created","id","items","status"]);
    for(const line of order.items) expect(Object.keys(line).sort()).toEqual(["id","qty"]);
  }
  {
    const root=process.env.PREP_PROJECT||fileURLToPath(new URL("../modules/prep-sheet/",import.meta.url));
    const result=spawnSync("python",[join(root,"lunch.py"),"--orders",path,
      "--recipes",join(root,"examples","recipes.json"),"--stock",join(root,"examples","stock.json"),
      "--suppliers",join(root,"..","pantry-freight","examples","suppliers.json")],
      {encoding:"utf8",env:{...process.env,PYTHONUTF8:"1"}});
    expect(result.status,result.stderr).toBe(3);
    const {prep,purchase}=JSON.parse(result.stdout);
    expect(prep.included_orders).toEqual(data.filter(order=>order.status==="pending").map(order=>order.id));
    expect(prep.portions.find(line=>line.dish==="edamame").quantity).toBe(4);
    expect(purchase.shortages).toContainEqual({component:"beans",unit:"g",required:400,offered:0,uncovered:400});
  }
  await page.getByRole("button",{name:"重新擷取"}).click();
  await expect(row.getByRole("cell")).toHaveText(["0","2"]);
});

test("mobile diners split a receipt locally, restore edits and switch between receipts",async({page,request})=>{
  async function order(items){
    const token=randomUUID();
    const response=await request.post("/api/orders",{data:{token,mode:"table",table:"A03",note:"",
      items:items.map(id=>({id,qty:1}))}});
    expect(response.ok()).toBeTruthy();
    return {token,receipt:await response.json()};
  }
  const first=await order(["katsudon","gyoza","edamame"]), second=await order(["sencha"]);
  const writes=[];
  page.on("request",r=>{if(r.method()!=="GET"&&new URL(r.url()).pathname.startsWith("/api/"))writes.push(r.url());});
  await page.setViewportSize({width:390,height:844});
  await page.goto("/ticket#"+first.token);
  const toggle=page.getByRole("button",{name:"這張餐單怎麼分帳？"});
  const totals=page.getByRole("region",{name:"每人應付"});
  const amounts=totals.locator("dl > div");
  await toggle.click();
  await page.getByRole("textbox",{name:"用餐人 1的稱呼"}).fill("小安");
  await page.getByRole("textbox",{name:"用餐人 2的稱呼"}).fill("小岑");
  const weight=(dish,name)=>page.getByRole("spinbutton",{name:dish+"・"+name+"的分攤份數",exact:true});
  await weight("滑蛋豬排丼","小岑").fill("0");
  await expect(amounts).toHaveText(["小安NT$ 260","小岑NT$ 70"]);
  const dumplings=page.getByRole("group",{name:/海苔柴魚煎餃/});
  await expect(dumplings.getByText("NT$ 42",{exact:true})).toBeVisible();
  await expect(dumplings.getByText("NT$ 43",{exact:true})).toBeVisible();
  await page.locator(".shareSheet").screenshot({path:test.info().outputPath("a03-split.png")});
  await page.getByRole("button",{name:"新增用餐人"}).click();
  await expect(amounts).toHaveCount(3);
  await page.getByRole("button",{name:"移除用餐人 3"}).click();
  await expect(amounts).toHaveText(["小安NT$ 260","小岑NT$ 70"]);
  await weight("滑蛋豬排丼","小安").fill("0");
  await expect(page.getByRole("alert")).toContainText("至少指定一人");
  await expect(totals).toHaveCount(0);
  await weight("滑蛋豬排丼","小安").fill("1");
  await weight("海苔柴魚煎餃","小安").fill("2");
  await expect(amounts).toHaveText(["小安NT$ 274","小岑NT$ 56"]);
  await page.reload();
  await toggle.click();
  await expect(amounts).toHaveText(["小安NT$ 274","小岑NT$ 56"]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.goto("/ticket#"+second.token);
  await expect(page.getByRole("heading",{name:"取餐號碼 "+String(second.receipt.id).padStart(4,"0")})).toBeVisible();
  await toggle.click();
  await expect(amounts).toHaveText(["用餐人 1NT$ 23","用餐人 2NT$ 22"]);
  await page.goto("/ticket#"+first.token);
  await expect(page.getByRole("heading",{name:"取餐號碼 "+String(first.receipt.id).padStart(4,"0")})).toBeVisible();
  await toggle.click();
  await expect(amounts).toHaveText(["小安NT$ 274","小岑NT$ 56"]);
  const cancelled=await request.patch("/api/kitchen/status",{headers:{Authorization:"Bearer local-test-kitchen"},
    data:{id:first.receipt.id,from:"pending",to:"cancelled"}});
  expect(cancelled.ok()).toBeTruthy();
  await page.getByRole("button",{name:"更新進度"}).click();
  await expect(page.getByText("已取消",{exact:true})).toBeVisible();
  await expect(toggle).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("staff downloads a fresh station export that remains safe to re-import out of order",async({page,request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"};
  const move=async(id,from,to)=>{
    expect((await request.patch("/api/kitchen/status",{headers,data:{id,from,to}})).ok()).toBe(true);
  };
  async function accepted(note){
    const response=await request.post("/api/orders",{data:{token:randomUUID(),mode:"table",table:"A03",
      items:[{id:"oyakodon",qty:1},{id:"sencha",qty:2}],note}});
    expect(response.ok()).toBe(true);
    const {id}=await response.json();
    await move(id,"pending","preparing");
    return id;
  }
  expect((await request.get("/api/kitchen/stations")).status()).toBe(403);
  await page.goto("/kitchen");
  const button=page.getByRole("button",{name:"下載分站出單檔"});
  await expect(page.getByRole("heading",{name:"店員登入"})).toBeVisible();
  await expect(button).toHaveCount(0);
  await page.evaluate(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.reload();
  await page.getByRole("button",{name:"待接單",exact:true}).click();
  async function download(){
    const event=page.waitForEvent("download");
    await button.click();
    const file=await event;
    expect(file.suggestedFilename()).toMatch(/^hey-table-stations-.*\.json$/);
    const path=await file.path();
    return {path,data:JSON.parse(await readFile(path,"utf8"))};
  }
  const first=await accepted("兩杯分裝");
  const old=await download();
  expect(old.data.format).toBe("hey-table.station-orders.v1");
  expect(old.data.throughId).toBe(first);
  const ticket=old.data.orders.find(order=>order.id===first);
  expect(ticket).toMatchObject({mode:"table",table:"A03",status:"preparing",note:"兩杯分裝"});
  expect(ticket.items).toEqual([{id:"oyakodon",name:"雞肉親子丼",qty:1},{id:"sencha",name:"日式熱煎茶",qty:2}]);
  for(const order of old.data.orders){
    expect(Object.keys(order).sort()).toEqual(["created","id","items","mode","note","status","table"]);
    for(const line of order.items)expect(Object.keys(line).sort()).toEqual(["id","name","qty"]);
  }
  await move(first,"preparing","ready");
  const second=await accepted("第二張");
  const recent=await download();
  expect(recent.data.throughId).toBe(second);
  expect(recent.data.orders.find(order=>order.id===first).status).toBe("ready");
  {
    const root=process.env.RAIL_PROJECT||fileURLToPath(new URL("../modules/pass-rail/",import.meta.url));
    const db=test.info().outputPath("station-rail.db");
    const run=(...args)=>JSON.parse(execFileSync("python",[join(root,"rail.py"),"--db",db,...args],
      {encoding:"utf8",env:{...process.env,PYTHONUTF8:"1"}}));
    const sync=path=>run("sync",path,join(root,"examples","routes.json"));
    sync(old.path);sync(recent.path);
    expect(sync(old.path)).toEqual({added:0,skipped:0});
    const jobs=run("status");
    expect(jobs.filter(j=>j.order_id===first).map(j=>j.state)).toEqual(["skipped","skipped"]);
    expect(jobs.filter(j=>j.order_id===second).map(j=>[j.station,j.state])).toEqual([["bar","queued"],["hot","queued"]]);
  }
});
