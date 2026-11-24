import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {execFileSync,spawnSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import jsQR from "jsqr";
import {PNG} from "pngjs";
import {businessDate} from "../lib/business-day.mjs";

test("staff recheck a changed table and complete its reviewed orders together",async({page,request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"};
  const path="/api/kitchen/table-handoff";
  async function create(table,dish,qty){
    const token=randomUUID();
    const response=await request.post("/api/orders",{data:{token,mode:"table",table,note:"",items:[{id:dish,qty}]}});
    expect(response.ok()).toBe(true);
    return {id:(await response.json()).id,token,tableRevision:0};
  }
  async function advance(order,from,to){
    expect((await request.patch("/api/kitchen/status",{headers,data:{id:order.id,from,to}})).ok()).toBe(true);
  }
  async function prepare(order){
    await advance(order,"pending","preparing");
    await advance(order,"preparing","ready");
  }
  const progress=order=>request.get("/api/ticket?progress=1",{headers:{"X-Ticket":order.token}}).then(r=>r.json());
  const review=(...orders)=>({table:"A07",orders:orders.map(({id,tableRevision})=>({id,tableRevision}))});
  const submit=(data,auth=headers)=>request.patch(path,{headers:auth,data});
  const first=await create("A07","oyakodon",1),second=await create("A07","sencha",2);
  const third=await create("A07","edamame",1),other=await create("A08","gyoza",1);
  const pending=await create("A07","sencha",1);
  await prepare(first);await prepare(second);await prepare(other);
  expect((await submit(review(first,second),{})).status()).toBe(403);
  expect((await submit(review(first,first))).status()).toBe(400);
  expect((await submit(review(first,other))).status()).toBe(409);
  expect((await submit(review(first,{...second,tableRevision:1}))).status()).toBe(409);

  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen");
  await page.getByRole("button",{name:"待交餐",exact:true}).click();
  await page.getByRole("button",{name:"A07 桌 · 2 張待交餐"}).click();
  const group=page.getByRole("region",{name:"A07 桌同桌交餐"});
  await group.getByRole("button",{name:"核對 2 張待交餐餐單"}).click();
  await expect(group.getByText("雞肉親子丼",{exact:true})).toBeVisible();
  await expect(group.getByText("×2",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);

  await page.route("**"+path,async route=>{
    await prepare(third);
    await route.continue();
  },{times:1});
  await group.getByRole("button",{name:"確認交餐 2 張餐單"}).click();
  await expect(page.getByText("待交餐餐單已更新或付款狀態有變，請重新核對整桌。")).toBeVisible();
  await expect(group.getByRole("button",{name:"確認交餐 2 張餐單"})).toBeDisabled();
  for(const order of [first,second,third])expect((await progress(order)).status).toBe("ready");
  await group.getByRole("button",{name:"重新核對這桌"}).click();
  await expect(group.getByText("鹽味毛豆",{exact:true})).toBeVisible();
  await group.getByRole("button",{name:"確認交餐 3 張餐單"}).click();
  await expect(page.getByText("A07 桌已完成 3 張餐單的交餐。")).toBeVisible();
  await expect(group).toHaveCount(0);
  const completed=await Promise.all([first,second,third].map(progress));
  const handoffs=completed.map(order=>order.statusHistory.filter(event=>event.status==="completed"));
  expect(handoffs[0]).toHaveLength(1);
  expect(handoffs).toEqual([handoffs[0],handoffs[0],handoffs[0]]);
  expect((await progress(pending)).status).toBe("pending");
  expect((await progress(other)).status).toBe("ready");
  expect((await submit(review(first,second,third))).status()).toBe(409);

  const next=await create("A08","sencha",1);
  await prepare(next);
  const race={...review(other,next),table:"A08"};
  const outcomes=await Promise.all([submit(race),submit(race)]);
  expect(outcomes.map(r=>r.status()).sort()).toEqual([200,409]);
  expect(await outcomes.find(r=>r.ok()).json()).toEqual({table:"A08",completed:2});
  expect((await progress(other)).statusHistory.filter(event=>event.status==="completed")).toHaveLength(1);
  await advance(pending,"pending","cancelled");
});

test("table moves keep the original order retry and guard stale handoff and printing",async({page,browser,request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"};
  const input={token:randomUUID(),mode:"table",table:"A03",note:"換桌測試備註",items:[{id:"oyakodon",qty:1}]};
  const post=data=>request.post("/api/orders",{data});
  const created=await post(input);
  expect(created.ok()).toBe(true);
  const original=await created.json(),number=String(original.id).padStart(4,"0");
  const move=(from,to,revision)=>request.patch("/api/kitchen/table",{headers,data:{id:original.id,from,to,revision}});
  const advance=(from,to,tableRevision)=>request.patch("/api/kitchen/status",{headers,data:{id:original.id,from,to,tableRevision}});
  expect((await request.patch("/api/kitchen/table",{data:{id:original.id,from:"A03",to:"A04",revision:0}})).status()).toBe(403);
  expect((await move("A03","A03",0)).status()).toBe(400);
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>{
    sessionStorage.setItem("he-ri-staff","local-test-kitchen");
    window.printCalls=0;
    window.print=()=>{window.printCalls++;};
  });
  const guest=await browser.newContext({viewport:{width:360,height:780}});
  try{
    const receipt=await guest.newPage();
    await receipt.addInitScript(token=>{
      if(!localStorage.getItem("he-ri-last"))localStorage.setItem("he-ri-last",JSON.stringify(token));
    },input.token);
    await receipt.goto("/ticket#"+input.token);
    await expect(receipt.getByText("A03 桌內用",{exact:true})).toBeVisible();
    await expect(receipt.locator(".receiptHistory")).toHaveCount(1);
    await page.goto("/kitchen");
    const card=page.locator(".kitchenTicket").filter({has:page.getByRole("heading",{name:"#"+number,exact:true})});
    await card.getByText("更換桌號",{exact:true}).click();
    await card.getByLabel("新桌號").selectOption("A04");
    await card.getByRole("button",{name:"確認換桌"}).click();
    await expect(card.getByText("A04 桌內用",{exact:true})).toBeVisible();
    await expect(page.getByRole("status")).toContainText("已換到 A04 桌");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    await receipt.getByRole("button",{name:"更新進度"}).click();
    await expect(receipt.getByText("店家已將餐單從 A03 桌移到 A04 桌。")).toBeVisible();
    await receipt.getByText("最近餐單",{exact:false}).click();
    await expect(receipt.locator(".receiptHistory").getByText(/A04 桌內用/)).toBeVisible();
    const retry=await post(input);
    expect(retry.ok()).toBe(true);
    expect(await retry.json()).toEqual({...original,table:"A04"});
    expect((await post({...input,table:"A04"})).status()).toBe(409);
    expect((await advance("pending","preparing")).ok()).toBe(true);
    const station=await (await request.get("/api/kitchen/station-work?station=hot",{headers})).json();
    expect(station.orders.find(order=>order.id===original.id)?.table).toBe("A04");
    const outcomes=await Promise.all([move("A04","A05",1),move("A04","A06",1)]);
    expect(outcomes.map(response=>response.status()).sort()).toEqual([200,409]);
    const {table:current}=await outcomes.find(response=>response.ok()).json();
    expect((await advance("preparing","ready")).ok()).toBe(true);
    await page.getByRole("button",{name:"更新",exact:true}).click();
    await card.getByRole("link",{name:"交餐小票"}).click();
    const slip=page.getByRole("article",{name:"交餐小票內容"});
    await expect(slip.getByText(current+" 桌內用",{exact:true})).toBeVisible();
    expect((await move(current,"A04",2)).ok()).toBe(true);
    expect((await move("A04","A03",1)).status()).toBe(409);
    expect((await advance("ready","completed",2)).status()).toBe(409);
    const print=page.getByRole("button",{name:"列印交餐小票"});
    await print.click();
    await expect(page.getByRole("status")).toHaveText("桌號已更新，請核對後再列印。");
    await expect(slip.getByText("A04 桌內用",{exact:true})).toBeVisible();
    expect(await page.evaluate(()=>window.printCalls)).toBe(0);
    await print.click();
    await expect.poll(()=>page.evaluate(()=>window.printCalls)).toBe(1);
    expect((await advance("ready","completed",3)).ok()).toBe(true);
    expect((await move("A04","A02",3)).status()).toBe(409);
    const ticket=await (await request.get("/api/ticket?progress=1",{headers:{"X-Ticket":input.token}})).json();
    expect(ticket.tableMoves.map(({from,to})=>[from,to])).toEqual([["A03","A04"],["A04",current],[current,"A04"]]);
  }finally{await guest.close();}
});

test("the pickup screen follows station readiness, clears stale numbers, and hides collected orders",async({page,request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"};
  const url="/api/kitchen/pickup-display";
  async function create(mode,paymentMethod="cash"){
    const response=await request.post("/api/orders",{data:{token:randomUUID(),mode,
      table:mode==="table"?"A03":null,note:"只給廚房",items:[{id:"sencha",qty:2}],paymentMethod}});
    expect(response.ok()).toBe(true);
    return (await response.json()).id;
  }
  async function move(id,from,to){
    const response=await request.patch("/api/kitchen/status",{headers,data:{id,from,to}});
    expect(response.ok()).toBe(true);
  }
  const pickup=await create("pickup");
  const table=await create("table");
  const unpaid=await create("pickup","px_pay_plus");
  await move(pickup,"pending","preparing");
  await move(table,"pending","preparing");
  await move(table,"preparing","ready");
  const number=String(pickup).padStart(4,"0");
  expect((await request.get(url)).status()).toBe(403);
  const visible=await request.get(url,{headers});
  expect(visible.headers()["cache-control"]).toBe("no-store");
  const state=await visible.json();
  expect(Object.keys(state).sort()).toEqual(["capturedAt","preparing","ready"]);
  expect(state.preparing).toContain(pickup);
  expect([...state.preparing,...state.ready]).not.toContain(table);
  expect([...state.preparing,...state.ready]).not.toContain(unpaid);
  expect(state.preparing.every(Number.isSafeInteger)).toBe(true);
  expect(state.ready.every(Number.isSafeInteger)).toBe(true);

  await page.setViewportSize({width:360,height:780});
  await page.goto("/kitchen/pickup-display");
  await expect(page.getByRole("alert")).toContainText("請登入店家接單台");
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen");
  await page.getByRole("link",{name:"櫃台取餐看板"}).click();
  const preparing=page.getByRole("region",{name:"製作中"});
  const ready=page.getByRole("region",{name:"請取餐"});
  await expect(preparing.getByText(number,{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  expect((await request.patch("/api/kitchen/station-work",{headers,data:{id:pickup,station:"bar"}})).ok()).toBe(true);
  await expect(ready.getByText(number,{exact:true})).toBeVisible({timeout:8000});
  await expect(preparing.getByText(number,{exact:true})).toHaveCount(0);

  const update=page.getByRole("button",{name:"更新看板"});
  await page.route("**/api/kitchen/pickup-display",route=>route.abort("internetdisconnected"),{times:1});
  await update.click();
  await expect(page.getByRole("alert")).toContainText("請向櫃台確認");
  await expect(ready).toHaveCount(0);
  await update.click();
  await expect(ready.getByText(number,{exact:true})).toBeVisible();
  await page.setViewportSize({width:1280,height:900});
  expect((await ready.boundingBox()).x).toBeLessThan((await preparing.boundingBox()).x);
  const fullscreen=page.getByRole("button",{name:"全螢幕",exact:true});
  if(await fullscreen.isVisible()){
    await fullscreen.click();
    const exit=page.getByRole("button",{name:"離開全螢幕"});
    await expect(exit).toBeVisible();
    expect(await page.evaluate(()=>document.fullscreenElement?.classList.contains("pickupDisplay"))).toBe(true);
    await exit.click();
    await expect(fullscreen).toBeVisible();
  }
  await move(pickup,"ready","completed");
  await update.click();
  await expect(ready.getByText(number,{exact:true})).toHaveCount(0);
  await move(table,"ready","completed");
  await move(unpaid,"pending","cancelled");
});

test("station boards finish only their items and the last of two concurrent reports marks the order ready once",async({page,request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"};
  const token=randomUUID();
  const url="/api/kitchen/station-work";
  const created=await request.post("/api/orders",{data:{token,mode:"table",table:"A03",note:"分站核對備註",
    items:[{id:"katsudon",qty:1},{id:"edamame",qty:1},{id:"sencha",qty:2}]}});
  expect(created.ok()).toBe(true);
  const {id}=await created.json();
  const number=String(id).padStart(4,"0");
  const finish=station=>request.patch(url,{headers,data:{id,station}});
  const move=(from,to)=>request.patch("/api/kitchen/status",{headers,data:{id,from,to}});
  const ticket=async()=>(await request.get("/api/ticket?progress=1",{headers:{"X-Ticket":token}})).json();
  expect((await request.get(url+"?station=hot")).status()).toBe(403);
  expect((await request.patch(url,{data:{id,station:"hot"}})).status()).toBe(403);
  expect((await finish("unsupported")).status()).toBe(400);
  expect((await finish("hot")).status()).toBe(409);
  expect((await move("pending","preparing")).ok()).toBe(true);
  expect((await finish("other")).status()).toBe(409);
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen");
  await page.getByRole("link",{name:"分站看板"}).click();
  const card=page.locator(".kitchenTicket").filter({has:page.getByRole("heading",{name:"#"+number,exact:true})});
  await expect(card.getByText("滑蛋豬排丼")).toBeVisible();
  await expect(card.getByText("日式熱煎茶")).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await card.getByRole("button",{name:"本站已備妥"}).click();
  await expect(card.getByText("本站已備妥，等待其他工作站。")).toBeVisible();
  expect((await ticket()).status).toBe("preparing");
  const retry=await (await finish("hot")).json();
  expect(retry.status).toBe("preparing");
  expect(retry.doneAt).toEqual(expect.any(Number));
  expect((await move("preparing","ready")).status()).toBe(409);
  await page.getByRole("button",{name:"飲品台",exact:true}).click();
  await expect(card.getByText("日式熱煎茶")).toBeVisible();
  await expect(card.getByText("滑蛋豬排丼")).toHaveCount(0);
  await expect(card.getByText("已備妥 1／3 站")).toBeVisible();

  const responses=await Promise.all([finish("cold"),finish("bar")]);
  expect(responses.every(response=>response.ok())).toBe(true);
  expect((await Promise.all(responses.map(response=>response.json()))).map(result=>result.status).sort())
    .toEqual(["preparing","ready"]);
  await page.getByRole("button",{name:"更新看板"}).click();
  await expect(card).toHaveCount(0);
  const done=await ticket();
  expect(done.status).toBe("ready");
  expect(done.statusHistory.filter(step=>step.status==="ready")).toHaveLength(1);
  expect(await (await finish("hot")).json()).toEqual({status:"ready",doneAt:retry.doneAt});
  expect((await move("ready","completed")).ok()).toBe(true);
});

test("staff can view a Taiwan-date summary and download the displayed snapshot on mobile",async({page,request})=>{
  await page.setViewportSize({width:360,height:780});
  await page.goto("/kitchen/daily");
  await expect(page.getByRole("alert")).toContainText("請以店主管理帳號登入");
  await expect(page.getByRole("button",{name:"下載摘要 JSON"})).toHaveCount(0);
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  const headers={Authorization:"Bearer local-test-kitchen"};
  const response=await request.post("/api/orders",{data:{token:randomUUID(),mode:"pickup",note:"交班測試備註",items:[{id:"sencha",qty:2}]}});
  expect(response.ok()).toBe(true);
  const {id,created}=await response.json();
  for(const [from,to] of [["pending","preparing"],["preparing","ready"],["ready","completed"]])
    expect((await request.patch("/api/kitchen/status",{headers,data:{id,from,to}})).ok()).toBe(true);
  await page.goto("/kitchen");
  await page.getByRole("link",{name:"每日訂單摘要"}).click();
  const date=page.getByLabel("餐單日期");
  const query=page.getByRole("button",{name:"查詢摘要"});
  const download=page.getByRole("button",{name:"下載摘要 JSON"});
  await expect(download).toBeVisible();
  await date.fill(businessDate(created));
  const read=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/kitchen/daily");
  await query.click();
  const report=await (await read).json();
  await expect(page.locator(".dailyCapture time")).toHaveAttribute("datetime",new Date(report.capturedAt).toISOString());
  await expect(page.getByRole("heading",{name:"每日訂單摘要"})).toBeVisible();
  await expect(page.getByRole("row",{name:/日式熱煎茶/})).toBeVisible();
  const timing=page.getByRole("region",{name:"製作與交餐耗時"});
  const pickup=timing.getByRole("article",{name:"自取耗時",exact:true});
  expect(report.timing.pickup.preparation.samples).toBeGreaterThan(0);
  expect(report.timing.pickup.handoff.samples).toBeGreaterThan(0);
  await expect(pickup.getByText(/中位數/)).toHaveCount(2);
  const {samples,eligible}=report.timing.pickup.preparation;
  await expect(pickup.locator("dl > div").first()).toContainText("可用紀錄 "+samples+"／"+eligible+" 張");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  const pending=page.waitForEvent("download");
  await download.click();
  const file=await pending;
  expect(file.suggestedFilename()).toContain("hey-table-daily-"+report.date);
  expect(JSON.parse(await readFile(await file.path(),"utf8"))).toEqual(report);
  expect(JSON.stringify(report)).not.toContain("交班測試備註");
  await date.fill("2001-03-05");
  await expect(download).toHaveCount(0);
  await query.click();
  await expect(page.getByText("這一天沒有已交餐品項。")).toBeVisible();
  await expect(timing.getByText("目前無可用時間紀錄")).toHaveCount(4);
});

test("this browser keeps separate receipt links across tabs and removes only the chosen local entry",async({context,page,request})=>{
  const token=randomUUID();
  const oldResponse=await request.post("/api/orders",{data:{token,mode:"pickup",note:"舊版備註",items:[{id:"sencha",qty:1}]}});
  expect(oldResponse.ok()).toBe(true);
  const old=await oldResponse.json();
  await page.setViewportSize({width:360,height:780});
  await page.goto("/");
  await page.evaluate(token=>localStorage.setItem("he-ri-last",JSON.stringify(token)),token);
  await page.goto("/ticket");
  const recent=page.locator(".receiptHistory");
  const title=id=>"取餐號碼 "+String(id).padStart(4,"0");
  await expect(recent.getByRole("link",{name:title(old.id)})).toHaveAttribute("href","/ticket#"+token);
  await expect(page.getByRole("heading",{name:title(old.id)})).toBeVisible();

  const checkout=await context.newPage();
  async function send(path,dish){
    await checkout.goto(path);
    await checkout.getByRole("button",{name:"加入"+dish,exact:true}).click();
    await checkout.getByRole("button",{name:"確認送出訂單",exact:true}).click();
    await checkout.waitForURL("**/ticket#*");
    const token=new URL(checkout.url()).hash.slice(1);
    const saved=await request.get("/api/ticket",{headers:{"X-Ticket":token}});
    expect(saved.ok()).toBe(true);
    const receipt=await saved.json();
    await expect(checkout.getByRole("heading",{name:title(receipt.id)})).toBeVisible();
    return {...receipt,token};
  }
  const table=await send("/?table=A03","日式唐揚雞");
  const pickup=await send("/","鹽味毛豆");
  await expect(recent.getByRole("link")).toHaveText([title(pickup.id),title(table.id),title(old.id)]);
  await expect(recent.getByText(/A03 桌內用/)).toHaveCount(1);
  await expect(recent.getByText(/線上自取/)).toHaveCount(2);
  await expect(page.getByRole("heading",{name:title(old.id)})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  const storage=await page.evaluate(token=>JSON.parse(localStorage.getItem("he-ri-receipt-v1:"+token)),table.token);
  expect(storage).toEqual({id:table.id,table:"A03",created:table.created});

  await page.goto("/ticket");
  await expect(page.getByRole("heading",{name:title(pickup.id)})).toBeVisible();
  page.once("dialog",dialog=>dialog.accept());
  await recent.getByRole("button",{name:"從本機移除 "+String(pickup.id).padStart(4,"0")}).click();
  await expect(page.getByRole("heading",{name:title(table.id)})).toBeVisible();
  await expect(recent.getByRole("link")).toHaveText([title(table.id),title(old.id)]);
  await recent.getByRole("link",{name:title(old.id)}).click();
  await expect(page.getByRole("heading",{name:title(old.id)})).toBeVisible();
  await expect(page.getByText("舊版備註")).toBeVisible();
  const serverReceipt=await request.get("/api/ticket",{headers:{"X-Ticket":pickup.token}});
  expect(serverReceipt.ok()).toBe(true);
  await page.goto("/ticket");
  await expect(recent.getByRole("link")).toHaveCount(2);
  for(const {id} of [old,table,pickup]){
    const cancelled=await request.patch("/api/kitchen/status",{headers:{Authorization:"Bearer local-test-kitchen"},
      data:{id,from:"pending",to:"cancelled"}});
    expect(cancelled.ok()).toBe(true);
  }
  await checkout.close();
});

test("a new receipt trims the local history to the newest eight",async({page,request})=>{
  await page.goto("/");
  const entries=Array.from({length:8},(_,i)=>({token:randomUUID(),id:900000+i,table:null,created:i+1}));
  await page.evaluate(entries=>{
    for(const {token,...value} of entries)localStorage.setItem("he-ri-receipt-v1:"+token,JSON.stringify(value));
  },entries);
  await page.getByRole("button",{name:"加入日式熱煎茶",exact:true}).click();
  await page.getByRole("button",{name:"確認送出訂單",exact:true}).click();
  await page.waitForURL("**/ticket#*");
  const token=new URL(page.url()).hash.slice(1);
  await page.goto("/ticket");
  const recent=page.locator(".receiptHistory");
  await expect(recent.getByRole("link")).toHaveCount(8);
  await expect(recent.getByRole("link",{name:"取餐號碼 900000"})).toHaveCount(0);
  expect(await page.evaluate(token=>localStorage.getItem("he-ri-receipt-v1:"+token),entries[0].token)).toBeNull();
  const {id}=await request.get("/api/ticket",{headers:{"X-Ticket":token}}).then(response=>response.json());
  const cancelled=await request.patch("/api/kitchen/status",{headers:{Authorization:"Bearer local-test-kitchen"},
    data:{id,from:"pending",to:"cancelled"}});
  expect(cancelled.ok()).toBe(true);
});

test("a ready pickup QR opens the exact staff order without sharing the customer receipt",async({page,browser,request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"};
  const token=randomUUID();
  const created=await request.post("/api/orders",{data:{token,mode:"pickup",note:"請取餐時核對",items:[{id:"karaage",qty:2}]}});
  expect(created.ok()).toBe(true);
  const {id}=await created.json();
  const other=await request.post("/api/orders",{data:{token:randomUUID(),mode:"pickup",note:"",items:[{id:"edamame",qty:1}]}});
  expect(other.ok()).toBe(true);
  const {id:otherId}=await other.json();
  const number=String(id).padStart(4,"0");
  await page.setViewportSize({width:360,height:780});
  await page.goto("/ticket#"+token);
  await expect(page.getByRole("heading",{name:"取餐號碼 "+number})).toBeVisible();
  const disclosure=page.getByText("出示取餐 QR 碼",{exact:true});
  await expect(disclosure).toHaveCount(0);
  for(const orderId of [id,otherId]){
    for(const [from,to] of [["pending","preparing"],["preparing","ready"]])
      expect((await request.patch("/api/kitchen/status",{headers,data:{id:orderId,from,to}})).ok()).toBe(true);
  }
  await page.getByRole("button",{name:"更新進度"}).click();
  await disclosure.click();
  const image=page.getByRole("img",{name:"取餐 "+number+" QR 碼"});
  const png=PNG.sync.read(await image.screenshot());
  const scanned=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);
  const target="/kitchen?pickup="+number;
  expect(scanned?.data).toBe(new URL(target,page.url()).href);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);

  const staff=await browser.newContext({viewport:{width:360,height:780}});
  try{
    const kitchen=await staff.newPage();
    const lookups=[];
    kitchen.on("request",req=>{
      const url=new URL(req.url());
      if(url.pathname.startsWith("/api/"))lookups.push(url.pathname+url.search);
    });
    await kitchen.goto(scanned.data);
    await expect(kitchen.getByRole("heading",{name:"店員登入"})).toBeVisible();
    await expect(kitchen.getByRole("link",{name:"使用 ChatGPT 登入"}))
      .toHaveAttribute("href","/signin-with-chatgpt?return_to="+encodeURIComponent(target));
    await expect(kitchen.getByText("請取餐時核對")).toHaveCount(0);
    await kitchen.getByText("使用自架店員金鑰").click();
    await kitchen.getByLabel("店員金鑰",{exact:true}).fill("local-test-kitchen");
    await kitchen.getByRole("button",{name:"登入",exact:true}).click();
    await expect(kitchen.getByRole("heading",{name:"自取交餐"})).toBeVisible();
    await expect(kitchen.getByRole("link",{name:"返回店家接單台"})).toHaveAttribute("href","/kitchen");
    const cards=kitchen.locator(".kitchenTicket");
    await expect(cards).toHaveCount(1);
    await expect(cards.getByRole("heading",{name:"#"+number,exact:true})).toBeVisible();
    await expect(cards.getByText("請取餐時核對")).toBeVisible();
    await expect(cards.getByRole("button",{name:"完成交餐"})).toBeInViewport();
    expect(new Set(lookups)).toEqual(new Set(["/api/kitchen/pickup?id="+number]));
    const receipt=async()=>(await request.get("/api/ticket",{headers:{"X-Ticket":token}})).json();
    expect((await receipt()).status).toBe("ready");
    await cards.getByRole("button",{name:"完成交餐"}).click();
    await expect(kitchen.getByRole("status")).toHaveText("已完成交餐。");
    await expect(cards.getByText("已完成",{exact:true})).toBeVisible();
    await page.getByRole("button",{name:"更新進度"}).click();
    await expect(page.getByText("已完成",{exact:true})).toBeVisible();
    await expect(disclosure).toHaveCount(0);
    await kitchen.reload();
    await expect(cards).toHaveCount(1);
    await expect(cards.getByText("已完成",{exact:true})).toBeVisible();
    expect((await request.get("/api/kitchen/handoff?id="+otherId,{headers}).then(r=>r.json())).status).toBe("ready");
  }finally{await staff.close();}
});

test("pickup lookup stays scoped and a stale handoff shows the committed status",async({page,request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"};
  async function order(mode){
    const token=randomUUID();
    const response=await request.post("/api/orders",{data:{token,mode,table:mode==="table"?"A03":null,note:"",items:[{id:"sencha",qty:1}]}});
    expect(response.ok()).toBe(true);
    return {...await response.json(),token};
  }
  async function status(id,from,to){
    return request.patch("/api/kitchen/status",{headers,data:{id,from,to}});
  }
  async function prepare(id){
    expect((await status(id,"pending","preparing")).ok()).toBe(true);
    expect((await status(id,"preparing","ready")).ok()).toBe(true);
  }

  const pickup=await order("pickup"),table=await order("table");
  const number=String(pickup.id).padStart(4,"0"),lookup="/api/kitchen/pickup?id=";
  expect((await request.get(lookup+number)).status()).toBe(403);
  expect((await request.get(lookup+"0",{headers})).status()).toBe(400);
  expect((await request.get(lookup+table.id,{headers})).status()).toBe(404);
  expect((await status(table.id,"pending","cancelled")).ok()).toBe(true);
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen?pickup=0");
  await expect(page.getByRole("alert")).toHaveText("取餐 QR 碼的號碼無效。");
  await page.goto("/kitchen?pickup="+number);
  await expect(page.getByText("等待接單",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"接單製作"})).toHaveCount(0);
  await prepare(pickup.id);
  await page.getByRole("button",{name:"更新",exact:true}).click();
  const handoff=page.getByRole("button",{name:"完成交餐"});
  await expect(handoff).toBeEnabled();
  await page.route("**/api/kitchen/status",async route=>{
    expect((await status(pickup.id,"ready","completed")).ok()).toBe(true);
    await route.continue();
  },{times:1});
  const rejected=page.waitForResponse(res=>res.url().endsWith("/api/kitchen/status")&&res.status()===409);
  await handoff.click();
  await rejected;
  await expect(page.getByRole("status")).toHaveText("餐單狀態已更新，請核對最新狀態。");
  await expect(page.getByText("已完成",{exact:true})).toBeVisible();
  await expect(handoff).toHaveCount(0);
  const progress=await request.get("/api/ticket?progress=1",{headers:{"X-Ticket":pickup.token}});
  expect((await progress.json()).statusHistory.filter(step=>step.status==="completed")).toHaveLength(1);

  for(let index=0;index<20;index++){
    const newer=await order("pickup");
    expect((await status(newer.id,"pending","cancelled")).ok()).toBe(true);
  }
  expect((await (await request.get("/api/kitchen",{headers})).json()).some(row=>row.id===pickup.id)).toBe(false);
  const archived=await request.get(lookup+number,{headers});
  expect(archived.headers()["cache-control"]).toBe("no-store");
  expect(await archived.json()).toMatchObject({id:pickup.id,mode:"pickup",status:"completed"});
  await page.reload();
  await expect(page.getByText("已完成",{exact:true})).toBeVisible();
});

test("a staff handoff slip rechecks concurrent handoff and prints only the selected order",async({page,request})=>{
  await page.setViewportSize({width:360,height:800});
  const headers={Authorization:"Bearer local-test-kitchen"};
  await page.addInitScript(()=>{
    sessionStorage.setItem("he-ri-staff","local-test-kitchen");
    window.printCalls=0;
    window.print=()=>{window.printCalls++;};
  });
  const token=randomUUID();
  const created=await request.post("/api/orders",{data:{token,mode:"table",table:"A03",note:"店內備註",
    items:[{id:"karaage",qty:2}]}});
  expect(created.ok()).toBe(true);
  const {id}=await created.json();
  const number=String(id).padStart(4,"0"), api="/api/kitchen/handoff?id=";
  expect((await request.get(api+number)).status()).toBe(403);
  expect((await request.get(api+"1e1",{headers})).status()).toBe(400);
  expect((await request.get(api+"999999999",{headers})).status()).toBe(404);
  expect((await request.get(api+number,{headers})).status()).toBe(409);
  for(const [from,to] of [["pending","preparing"],["preparing","ready"]])
    expect((await request.patch("/api/kitchen/status",{headers,data:{id,from,to}})).ok()).toBe(true);
  const result=await request.get(api+number,{headers});
  expect(result.headers()["cache-control"]).toBe("no-store");
  expect(await result.json()).toEqual({id,table:"A03",status:"ready",items:[{name:"日式唐揚雞",qty:2}]});
  await page.goto("/kitchen");
  const card=page.locator(".kitchenTicket").filter({has:page.getByRole("heading",{name:"#"+number,exact:true})});
  await card.getByRole("link",{name:"交餐小票"}).click();
  const slip=page.getByRole("article",{name:"交餐小票內容"});
  const button=page.getByRole("button",{name:"列印交餐小票"});
  await expect(slip.getByText("A03 桌內用")).toBeVisible();
  await expect(slip.getByText("待交餐")).toBeVisible();
  expect((await request.patch("/api/kitchen/status",{headers,data:{id,from:"ready",to:"completed"}})).ok()).toBe(true);
  await button.click();
  await expect(slip.getByText("已交餐")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("交餐狀態已更新，請核對後再列印。");
  expect(await page.evaluate(()=>window.printCalls)).toBe(0);
  await button.click();
  await expect.poll(()=>page.evaluate(()=>window.printCalls)).toBe(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await page.emulateMedia({media:"print"});
  await expect(button).toBeHidden();
  await expect(page.getByRole("link",{name:"返回店家接單台"})).toBeHidden();
  await expect(slip.getByRole("heading",{name:"取餐號碼 "+number})).toBeVisible();
  await expect(slip.getByText("日式唐揚雞")).toBeVisible();
  await expect(slip.getByText("× 2")).toBeVisible();
  await expect(page.getByText("店內備註")).toHaveCount(0);
});

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
  await reopened.goto("/ticket");
  await expect(reopened.locator(".receiptHistory").getByRole("link")).toHaveAttribute("href","/ticket#"+attempts[0].token);
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
  await expect(page.getByText("A01 桌內用",{exact:true})).toBeVisible();
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
    await expect(mobile.getByText("A03 桌內用",{exact:true})).toBeVisible();
    await page.goto("/kitchen");
    await page.getByText("使用自架店員金鑰").click();
    await page.getByLabel("店員金鑰",{exact:true}).fill("local-test-kitchen");
    await page.getByRole("button",{name:"登入",exact:true}).click();
    const ticket=page.locator(".kitchenTicket").filter({hasText:"不用餐具"});
    await ticket.getByRole("button",{name:"接單製作"}).click();
    await ticket.getByRole("button",{name:"完成製作"}).click();
    await mobile.getByRole("button",{name:"更新進度"}).click();
    await expect(mobile.getByText("可取餐",{exact:true})).toBeVisible();
    await expect(mobile.getByText("出示取餐 QR 碼",{exact:true})).toHaveCount(0);
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
