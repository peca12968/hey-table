import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {businessDate} from "../lib/business-day.mjs";
const staff={Authorization:"Bearer local-test-kitchen"};

test("mobile receipt switches the original unpaid order to cash and recovers a lost switch response",async({page,request})=>{
  await page.setViewportSize({width:360,height:780});
  const token=randomUUID(),guest={"X-Ticket":token};
  const payload={token,mode:"pickup",note:"原餐單保留",items:[{id:"sencha",qty:1}],paymentMethod:"line_pay",paymentEnv:"demo"};
  const response=await request.post("/api/orders",{data:payload});
  expect(response.ok()).toBe(true);
  const original=await response.json();
  const number="取餐號碼 "+String(original.id).padStart(4,"0");
  const move=()=>request.patch("/api/kitchen/status",{headers:staff,data:{id:original.id,from:"pending",to:"preparing"}});
  expect((await move()).status()).toBe(409);
  let sent=0;
  await page.route("**/api/payments/cash",async route=>{
    sent++;
    expect((await route.fetch()).ok()).toBe(true);
    await route.abort("connectionreset");
  });
  await page.goto("/ticket#"+token);
  await expect(page.getByRole("heading",{name:number})).toBeVisible();
  const cash=page.getByRole("button",{name:"改用現場付款",exact:true});
  await cash.click();
  const confirm=page.getByRole("button",{name:"確認改用現場付款"});
  await expect(confirm).toBeVisible();
  await expect(page.getByRole("button",{name:/開始模擬付款/})).toBeDisabled();
  await page.getByRole("button",{name:"保留線上付款"}).click();
  expect(sent).toBe(0);
  await cash.click();
  await confirm.click();
  await expect(page.getByText("已由 LINE Pay 改為現場付款。")).toBeVisible();
  await expect(page.getByRole("heading",{name:number})).toBeVisible();
  await expect(page.getByRole("region",{name:"線上付款"})).toHaveCount(0);
  await expect(page.getByText(/付款保留至/)).toHaveCount(0);
  expect(sent).toBe(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  const saved=await (await request.get("/api/ticket?progress=1",{headers:guest})).json();
  expect(saved).toMatchObject({id:original.id,paymentMethod:"cash",paymentEnv:"cash",total:original.total,
    cashPaymentChange:{fromMethod:"line_pay",fromEnvironment:"demo"}});
  expect(saved.paymentDueAt).toBeUndefined();
  expect(saved.cashReceipt).toBeUndefined();
  expect((await (await request.post("/api/orders",{data:payload})).json()).id).toBe(original.id);
  expect((await move()).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading",{name:number})).toBeVisible();
  await expect(page.getByText("已由 LINE Pay 改為現場付款。")).toBeVisible();
});

test("mobile checkout can replace an unavailable wallet without losing a future pickup or notes",async({page,request})=>{
  const day=businessDate(Date.now()+86400000),slot=Date.parse(day+"T14:00:00+08:00");
  const available={mode:"demo",methods:["cash","px_pay_plus"]};
  const posts=[];
  let walletUnavailable=false,menuOffline=false;
  await page.setViewportSize({width:360,height:780});
  await page.route(/\/api\/menu(?:\?.*)?$/,async route=>{
    if(menuOffline)return route.abort("connectionreset");
    const upstream=await route.fetch(),body=await upstream.json();
    return route.fulfill({status:upstream.status(),json:walletUnavailable?{...body,payments:available}:body});
  });
  await page.route("**/api/orders",route=>{
    posts.push(route.request().postDataJSON());
    if(walletUnavailable)return route.continue();
    walletUnavailable=true;menuOffline=true;
    return route.fulfill({status:409,json:{error:"此付款方式暫停使用",code:"payment_unavailable",payments:available}});
  });
  await page.goto("/");
  const booking=page.getByLabel("取餐日期",{exact:true});
  await booking.selectOption(day);
  await page.getByRole("button",{name:"加入日式熱煎茶",exact:true}).click();
  await page.getByRole("button",{name:/我的餐單/}).click();
  const choose=page.getByRole("combobox",{name:"付款方式"}),submit=page.getByRole("button",{name:"確認送出訂單"});
  const time=page.getByLabel("自取時段"),note=page.getByLabel(/訂單備註/);
  await time.selectOption(String(slot));
  await note.fill("保留預約備註");
  await page.locator(".itemNotes summary").click();
  await page.getByLabel("日式熱煎茶備註").fill("無冰");
  await choose.selectOption("line_pay");
  await submit.click();
  await expect(page.getByText("LINE Pay 暫停使用，請改選付款方式。")).toBeVisible();
  await expect(choose).toHaveValue("line_pay");
  await expect(submit).toBeDisabled();
  await expect(time).toHaveValue(String(slot));
  await expect(note).toHaveValue("保留預約備註");
  await expect(page.getByLabel("日式熱煎茶備註")).toHaveValue("無冰");
  await choose.selectOption("px_pay_plus");
  expect(posts).toHaveLength(1);
  menuOffline=false;
  await page.evaluate(()=>window.dispatchEvent(new Event("online")));
  await expect(submit).toBeEnabled();
  await submit.click();
  await page.waitForURL("**/ticket#*");
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatchObject({paymentMethod:"line_pay",paymentEnv:"demo",pickupSlot:slot});
  expect(posts[1]).toMatchObject({paymentMethod:"px_pay_plus",paymentEnv:"demo",pickupSlot:slot,note:"保留預約備註",
    items:[{id:"sencha",qty:1,note:"無冰"}]});
  expect(posts[1].token).not.toBe(posts[0].token);
  expect((await request.get("/api/ticket",{headers:{"X-Ticket":posts[0].token}})).status()).toBe(404);
  const ticket=await (await request.get("/api/ticket",{headers:{"X-Ticket":posts[1].token}})).json();
  expect(ticket).toMatchObject({pickupSlot:slot,paymentMethod:"px_pay_plus",paymentEnv:"demo"});
});

test("stale checkout confirmation must be renewed for each changed payment environment",async({page})=>{
  let mode="demo";
  const sends=[];
  await page.setViewportSize({width:360,height:780});
  await page.route(/\/api\/menu(?:\?.*)?$/,async route=>{
    const upstream=await route.fetch(),body=await upstream.json();
    return route.fulfill({status:upstream.status(),json:{...body,payments:{mode,methods:["cash","line_pay"]}}});
  });
  await page.route("**/api/orders",route=>{
    sends.push(route.request().postDataJSON());
    if(sends.length===1){
      mode="sandbox";
      return route.fulfill({status:409,json:{error:"付款環境已變更，請重新確認",code:"payment_environment_changed",
        payments:{mode,methods:["cash","line_pay"]}}});
    }
    return route.fulfill({json:{id:701,mode:"table",table:"A06",created:Date.now()}});
  });
  await page.goto("/?table=A06");
  await page.getByRole("button",{name:"加入日式熱煎茶",exact:true}).click();
  const cart=page.getByRole("button",{name:/我的餐單/});
  await cart.click();
  const choose=page.getByRole("combobox",{name:"付款方式"}),submit=page.getByRole("button",{name:"確認送出訂單"});
  const confirm=page.getByRole("button",{name:"確認目前付款環境"});
  await choose.selectOption("line_pay");
  await expect(submit).toBeEnabled();
  mode="production";
  await page.reload();
  await cart.click();
  await expect(page.getByText(/付款環境已變更。.*正式付款/)).toBeVisible();
  await expect(choose).toHaveValue("line_pay");
  await expect(submit).toBeDisabled();
  await confirm.click();
  expect(sends).toEqual([]);
  await submit.click();
  await expect(page.getByText(/付款環境已變更。.*TapPay 測試環境/)).toBeVisible();
  await expect(submit).toBeDisabled();
  await confirm.click();
  expect(sends).toHaveLength(1);
  await submit.click();
  await page.waitForURL("**/ticket#*");
  expect(sends.map(({paymentMethod,paymentEnv})=>({paymentMethod,paymentEnv}))).toEqual([
    {paymentMethod:"line_pay",paymentEnv:"production"},{paymentMethod:"line_pay",paymentEnv:"sandbox"},
  ]);
});

test("mobile payment review distinguishes an unconfirmed, unavailable and verified lookup",async({page})=>{
  const id=91,date="2026-11-24",next=Promise.withResolvers();
  let paymentState="authorized",calls=0;
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.route("**/api/kitchen/payment-review?*",route=>route.fulfill({json:{
    id,mode:"pickup",status:"completed",items:[{id:"sencha",name:"日式熱煎茶",qty:1}],total:45,
    created:Date.parse(date+"T12:00:00+08:00"),paymentMethod:"line_pay",paymentEnv:"sandbox",paymentState,
  }}));
  await page.route("**/api/kitchen/payment",async route=>{
    calls++;
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().headers().authorization).toBe(staff.Authorization);
    expect(route.request().postDataJSON()).toEqual({id});
    if(calls===1){
      await next.promise;
      return route.fulfill({json:{ok:true,id,outcome:"unconfirmed",paymentState}});
    }
    if(calls===2)return route.fulfill({status:503,json:{error:"無法查詢金流，請稍後再查"}});
    paymentState="paid";
    return route.fulfill({json:{ok:true,id,outcome:"matched",paymentState}});
  });
  await page.goto("/kitchen?paymentReview="+id+"&date="+date);
  const card=page.getByRole("article"),check=card.getByRole("button",{name:"查詢金流",exact:true});
  await expect(card.getByText(/TapPay 測試環境 · 已授權，待請款/)).toBeVisible();
  try{
    await check.click();
    await expect(card.getByRole("button",{name:"正在查詢金流…"})).toBeDisabled();
  }finally{next.resolve();}
  await expect(card.getByRole("status")).toHaveText("本次未取得可核對的金流紀錄，畫面保留最後一次紀錄。");
  await expect(card.getByText(/TapPay 測試環境 · 已授權，待請款/)).toBeVisible();
  await check.click();
  await expect(card.getByRole("status")).toHaveText("無法查詢金流，請稍後再查。");
  await expect(card.getByText(/TapPay 測試環境 · 已授權，待請款/)).toBeVisible();
  await check.click();
  await expect(card.getByRole("status")).toHaveText("本次金流查詢結果為「已付款」。");
  await expect(card.getByText(/TapPay 測試環境 · 已付款/)).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  expect(calls).toBe(3);
});

test("mobile staff filter actual pending wallet attempts and return from the order with the same filters",async({page,request})=>{
  async function pending(paymentMethod){
    const token=randomUUID(),headers={"X-Ticket":token};
    const order=await request.post("/api/orders",{data:{token,mode:"pickup",note:"測試餐單",
      items:[{id:"sencha",qty:1}],paymentMethod,paymentEnv:"demo"}});
    expect(order.status()).toBe(200);
    const {id}=await order.json();
    const start=await request.post("/api/payments/start",{headers,data:{}});
    expect(start.status()).toBe(200);
    const {attempt}=await start.json();
    return {id,headers,attempt,number:String(id).padStart(4,"0")};
  }
  const line=await pending("line_pay"),px=await pending("px_pay_plus");
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen");
  await page.getByRole("link",{name:"線上付款待核對"}).click();
  const queue=page.getByRole("region",{name:"待核對付款清單"});
  const lineLink=queue.getByRole("link",{name:"餐單 #"+line.number,exact:true});
  const pxLink=queue.getByRole("link",{name:"餐單 #"+px.number,exact:true});
  await expect(lineLink).toBeVisible();
  await expect(pxLink).toBeVisible();
  await page.getByLabel("付款狀態").selectOption("pending");
  await page.getByLabel("付款工具").selectOption("line_pay");
  await page.getByLabel("金流環境").selectOption("demo");
  await page.getByRole("button",{name:"套用篩選"}).click();
  await expect(lineLink).toBeVisible();
  await expect(pxLink).toHaveCount(0);
  const filterUrl=page.url();
  await lineLink.click();
  await expect(page.getByRole("heading",{name:"餐單 #"+line.number})).toBeVisible();
  await page.getByRole("link",{name:"返回待核對付款"}).click();
  await expect(page).toHaveURL(filterUrl);
  await expect(lineLink).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  expect((await request.post("/api/payments/demo",{headers:line.headers,data:{ref:line.attempt.ref,outcome:"paid"}})).status()).toBe(200);
  await page.getByRole("button",{name:"重新擷取"}).click();
  await expect(queue).toBeVisible();
  await expect(lineLink).toHaveCount(0);
  expect((await request.post("/api/payments/demo",{headers:px.headers,data:{ref:px.attempt.ref,outcome:"cancelled"}})).status()).toBe(200);
});

test("mobile handoff summary downloads the same filtered capture after another payment settles",async({page,request})=>{
  const method="plus_pay";
  async function pending(){
    const token=randomUUID(),headers={"X-Ticket":token};
    const created=await request.post("/api/orders",{data:{token,mode:"pickup",note:"私人顧客備註",
      items:[{id:"sencha",qty:1}],paymentMethod:method,paymentEnv:"demo"}});
    expect(created.status()).toBe(200);
    const started=await request.post("/api/payments/start",{headers,data:{}});
    expect(started.status()).toBe(200);
    return {headers,attempt:(await started.json()).attempt};
  }
  const [first,second]=[await pending(),await pending()];
  const complete=(row,outcome)=>request.post("/api/payments/demo",{headers:row.headers,data:{ref:row.attempt.ref,outcome}});
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  const capture=()=>page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==="/api/kitchen/payment-attention"&&url.searchParams.get("summary")==="1";
  });
  const initial=capture();
  await page.goto("/kitchen/payment-attention?method="+method+"&state=pending&environment=demo");
  const {summary}=await (await initial).json();
  expect(summary.filters).toEqual({method,state:"pending",environment:"demo"});
  expect(summary.totals.orders).toBeGreaterThanOrEqual(2);
  const section=page.getByRole("region",{name:"待核對交班匯總"});
  await expect(section.getByRole("heading",{name:"全盈+PAY · 示範環境"})).toBeVisible();
  await expect(section.getByText("NT$ "+BigInt(summary.totals.amount).toLocaleString("zh-TW"),{exact:true}).first()).toBeVisible();
  expect((await complete(first,"paid")).status()).toBe(200);
  const [download]=await Promise.all([page.waitForEvent("download"),
    section.getByRole("button",{name:"下載付款交班摘要 JSON"}).click()]);
  const contents=await readFile(await download.path(),"utf8");
  expect(download.suggestedFilename()).toContain("hey-table-payment-handoff-");
  expect(JSON.parse(contents)).toEqual(summary);
  expect(contents).not.toContain(first.attempt.ref);
  expect(contents).not.toContain("私人顧客備註");
  const refreshed=capture();
  await page.getByRole("button",{name:"重新擷取"}).click();
  const next=(await (await refreshed).json()).summary;
  expect(next.totals.orders).toBe(summary.totals.orders-1);
  expect(next.totals.amount).toBe(String(BigInt(summary.totals.amount)-45n));
  await expect(section.getByText("NT$ "+BigInt(next.totals.amount).toLocaleString("zh-TW"),{exact:true}).first()).toBeVisible();
  await page.getByText("比較付款交班摘要",{exact:true}).click();
  const input=page.getByLabel("上一班摘要 JSON");
  const upload=text=>input.setInputFiles({name:"handoff.json",mimeType:"application/json",buffer:Buffer.from(text)});
  await upload("{}");
  await expect(page.getByRole("alert")).toContainText("無法讀取摘要");
  await upload(JSON.stringify({...summary,filters:{...summary.filters,state:null}}));
  await expect(page.getByRole("alert")).toContainText("篩選不同");
  await upload(contents);
  const comparison=page.getByRole("region",{name:"付款交班比較結果"});
  const totals=comparison.getByRole("table",{name:"整體變化"});
  await expect(comparison.getByText("上次擷取",{exact:false})).toBeVisible();
  await expect(totals.getByRole("row",{name:/^待核對/}).getByRole("cell").last()).toHaveText("−1 筆");
  await expect(totals.getByRole("row",{name:/^原餐單金額/}).getByRole("cell").last()).toHaveText("−45 元");
  const change=comparison.getByRole("table",{name:"全盈+PAY · 示範環境"});
  await expect(change.getByRole("cell",{name:"−45 元",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  expect((await complete(second,"cancelled")).status()).toBe(200);
  const latest=capture();
  await page.getByRole("button",{name:"重新擷取"}).click();
  await latest;
  await expect(totals.getByRole("row",{name:/^原餐單金額/}).getByRole("cell").last()).toHaveText("−90 元");
  await page.getByRole("button",{name:"清除已匯入摘要"}).click();
  await expect(comparison).toHaveCount(0);
});

test("mobile payment queue preserves unmatched payments and refreshes after a verified lookup",async({page})=>{
  const id=91,number="0091",startedAt=Date.parse("2026-11-24T23:30:00+08:00");
  const capture=startedAt+60*60_000;
  const row={id,method:"px_pay_plus",environment:"sandbox",total:45,status:"pending",state:"pending",startedAt,
    paymentDueAt:startedAt+15*60_000,checkedAt:null,canCheck:true};
  let calls=0,paid=false;
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.route(url=>url.pathname==="/api/kitchen/payment-attention",route=>route.fulfill({json:{
    format:"hey-table.payment-attention.v1",capturedAt:capture,orders:paid?[]:[row],nextAfter:null,
  }}));
  await page.route("**/api/kitchen/payment",route=>{
    const req=route.request();
    expect(req.method()).toBe("PATCH");
    expect(req.headers().authorization).toBe(staff.Authorization);
    expect(req.postDataJSON()).toEqual({id});
    calls++;
    if(calls===1)return route.fulfill({json:{ok:true,id,outcome:"unconfirmed",paymentState:"pending"}});
    paid=true;
    return route.fulfill({json:{ok:true,id,outcome:"matched",paymentState:"paid"}});
  });
  await page.goto("/kitchen/payment-attention");
  const check=page.getByRole("button",{name:"查詢餐單 "+number+" 的金流"});
  await expect(page.getByText("已到保留時間，付款仍待確認。")).toBeVisible();
  await expect(page.getByText(/已等 60 分鐘/)).toBeVisible();
  await check.click();
  await expect(page.getByText(/本次未取得可核對的金流紀錄/)).toBeVisible();
  await expect(check).toBeEnabled();
  await check.click();
  await expect(page.getByText("餐單 #0091 · 本次金流查詢結果為「已付款」。")).toBeVisible();
  await expect(page.getByText("目前沒有符合條件的待核對付款。")).toBeVisible();
  expect(calls).toBe(2);
});

test("mobile staff recover a lost payment note reply and find the note after a demo payment settles",async({page,request})=>{
  const api="/api/kitchen/payment-attention-notes",token=randomUUID(),customer={"X-Ticket":token};
  const created=await request.post("/api/orders",{data:{token,mode:"pickup",note:"",
    items:[{id:"sencha",qty:1}],paymentMethod:"line_pay",paymentEnv:"demo"}});
  expect(created.status()).toBe(200);
  const {id}=await created.json(),number=String(id).padStart(4,"0");
  const payment=await request.post("/api/payments/start",{headers:customer,data:{}});
  expect(payment.status()).toBe(200);
  const {attempt}=await payment.json(),filter="/kitchen/payment-attention?state=pending&method=line_pay&environment=demo";
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto(filter);
  await page.getByRole("link",{name:"付款交班備註 餐單 "+number}).click();
  const notes=page.locator("#payment-attention-notes");
  const input=notes.getByRole("textbox",{name:"交班備註"});
  await expect(input).toBeVisible();
  await input.fill("已告知顧客稍候，下一班再查。");
  let written;
  await page.route("**"+api,async route=>{
    written=route.request().postDataJSON();
    expect((await route.fetch()).status()).toBe(200);
    await route.abort("connectionreset");
  },{times:1});
  await notes.getByRole("button",{name:"儲存交班備註"}).click();
  await expect(notes.getByRole("alert")).toHaveText("尚未收到儲存結果，請重試同一筆備註。");
  const retry=page.waitForRequest(req=>req.method()==="POST"&&new URL(req.url()).pathname===api);
  await notes.getByRole("button",{name:"重試儲存同一筆備註"}).click();
  expect((await retry).postDataJSON()).toEqual(written);
  await expect(notes.getByText("已儲存交班備註。")).toBeVisible();
  const history=notes.getByRole("list",{name:"付款交班備註歷程"});
  await expect(history.getByRole("listitem")).toHaveCount(1);
  await expect(history.getByText(written.note,{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await page.getByRole("link",{name:"返回待核對付款"}).click();
  const row=page.getByRole("listitem").filter({has:page.getByRole("link",{name:"餐單 #"+number,exact:true})});
  await expect(row).toContainText(written.note);

  expect((await request.post("/api/payments/demo",{headers:customer,data:{ref:attempt.ref,outcome:"paid"}})).status()).toBe(200);
  await page.getByRole("button",{name:"重新擷取"}).click();
  await expect(page.getByRole("region",{name:"待核對付款清單"})).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.goto("/kitchen/order-detail?id="+number+"&notes=1");
  await expect(history.getByText(written.note,{exact:true})).toBeVisible();
  await expect(input).toHaveCount(0);
  const customerView=await (await request.get("/api/ticket",{headers:customer})).json();
  expect(JSON.stringify(customerView)).not.toContain(written.note);
});

test("mobile order history distinguishes failed and settled payment attempts and opens only the chosen notes",async({page,request})=>{
  const token=randomUUID(),customer={"X-Ticket":token},noteApi="/api/kitchen/payment-attention-notes";
  const created=await request.post("/api/orders",{data:{token,mode:"pickup",note:"",
    items:[{id:"sencha",qty:1}],paymentMethod:"px_pay_plus",paymentEnv:"demo"}});
  expect(created.status()).toBe(200);
  const {id}=await created.json(),number=String(id).padStart(4,"0");
  async function completeAttempt(note,outcome){
    const started=await request.post("/api/payments/start",{headers:customer,data:{}});
    expect(started.status()).toBe(200);
    const {attempt}=await started.json();
    const notes=await request.get(noteApi+"?id="+id,{headers:staff});
    expect(notes.status()).toBe(200);
    const {target}=await notes.json();
    expect((await request.post(noteApi,{headers:staff,data:{id,attemptId:target.attemptId,state:target.state,
      note,operationId:randomUUID()}})).status()).toBe(200);
    expect((await request.post("/api/payments/demo",{headers:customer,data:{ref:attempt.ref,outcome}})).status()).toBe(200);
    return attempt.ref;
  }
  const firstNote="第一次付款失敗，請顧客重試。",secondNote="已協助顧客開啟第二次全支付。";
  const first=await completeAttempt(firstNote,"failed"),second=await completeAttempt(secondNote,"paid");
  expect(first).not.toBe(second);
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen/order-detail?id="+number);
  await page.getByText("歷次付款嘗試",{exact:true}).click();
  const attempts=page.getByRole("list",{name:"付款嘗試歷程"});
  const rows=attempts.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("第 2 次付款 · 已付款");
  await expect(rows.first()).toContainText("首次可接單");
  await expect(rows.last()).toContainText("第 1 次付款 · 付款失敗");
  await expect(attempts).not.toContainText(first);
  await expect(attempts).not.toContainText(second);
  await rows.last().getByRole("link",{name:"第 1 次付款備註（1 筆）"}).click();
  const notes=page.getByRole("list",{name:"付款交班備註歷程"});
  await expect(notes.getByText(firstNote,{exact:true})).toBeVisible();
  await expect(notes.getByText(secondNote,{exact:true})).toHaveCount(0);
  await expect(page.getByRole("textbox",{name:"交班備註"})).toHaveCount(0);
  await page.getByRole("link",{name:"查看全部付款備註"}).click();
  await expect(notes.getByText(firstNote,{exact:true})).toBeVisible();
  await expect(notes.getByText(secondNote,{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
});

test("mobile cash collection previews change and resumes the same operation after a lost request",async({page,request})=>{
  page.setDefaultTimeout(9000);
  const token=randomUUID(),ticket={"X-Ticket":token},endpoint="/api/kitchen/cash-receipt";
  const created=await request.post("/api/orders",{data:{token,mode:"pickup",note:"",items:[{id:"sencha",qty:1}]}});
  expect(created.ok()).toBe(true);
  const {id}=await created.json();
  const move=(from,to)=>request.patch("/api/kitchen/status",{headers:staff,data:{id,from,to}});
  expect((await move("pending","preparing")).ok()).toBe(true);
  expect((await move("preparing","ready")).ok()).toBe(true);
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  let sent,postCount=0;
  await page.route("**"+endpoint,route=>{
    postCount++;
    const payload=route.request().postDataJSON();
    expect(route.request().headers().authorization).toBe(staff.Authorization);
    expect(payload).toMatchObject({id,expectedTotal:45,tendered:100});
    if(postCount===1){
      sent=payload;
      return route.abort("connectionreset");
    }
    expect(payload).toEqual(sent);
    return route.continue();
  });

  await page.goto("/kitchen?pickup="+id);
  await page.getByText("登記現金收款",{exact:true}).click();
  const amount=page.getByLabel("實收金額");
  const confirm=page.getByRole("button",{name:"確認現金收款"});
  await amount.fill("40");
  await expect(confirm).toBeDisabled();
  await expect(page.getByText("尚差 NT$ 5")).toBeVisible();
  await amount.fill("100");
  await expect(page.getByText("應找零 NT$ 55")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText("尚未收到收款結果");
  await page.reload();
  await expect(amount).toHaveValue("100");
  await expect(amount).toBeDisabled();
  await page.getByRole("button",{name:"重試確認收款"}).click();
  const cash=page.getByRole("region",{name:"現金收款紀錄"});
  await expect(cash).toContainText("NT$ 55");
  await expect(cash).toContainText("NT$ 100");
  expect(postCount).toBe(2);
  await page.getByRole("button",{name:"完成交餐"}).click();
  await expect(page.getByText("已完成交餐。")).toBeVisible();
  await page.goto("/ticket#"+token);
  await expect(cash).toContainText("NT$ 55");
  const saved=await (await request.get("/api/ticket",{headers:ticket})).json();
  expect(saved).toMatchObject({status:"completed",cashReceipt:{amount:45,tendered:100,change:55}});
  expect(saved.cashReceipt.operationId).toBeUndefined();
  await page.goto("/kitchen?pickup="+id);
  await page.getByText("更正現金收款",{exact:true}).click();
  await page.getByLabel("更正後實收金額").fill("50");
  const correct=page.getByRole("button",{name:"確認更正"});
  await expect(correct).toBeDisabled();
  await page.getByLabel("更正原因").fill("更正櫃台輸入");
  await expect(page.getByText("更正後找零 NT$ 5",{exact:true})).toBeVisible();
  await correct.click();
  await expect(page.getByText("已保存第 1 版更正。")).toBeVisible();
  const history=page.getByRole("list",{name:"現金更正紀錄"});
  await expect(history).toContainText("NT$ 100 改為 NT$ 50");
  await expect(history).toContainText("更正櫃台輸入");
  await page.goto("/ticket#"+token);
  await expect(cash).toContainText("NT$ 5");
  await expect(cash).toContainText("收款金額已更正");
  await expect(page.getByText("更正櫃台輸入")).toHaveCount(0);
});

test("mobile cash close reconciles a count and downloads the displayed snapshot before a new collection",async({page,request})=>{
  page.setDefaultTimeout(9000);
  const date=businessDate(Date.now()),endpoint="/api/kitchen/cash-close";
  const collect=async tendered=>{
    const token=randomUUID();
    const created=await request.post("/api/orders",{data:{token,mode:"pickup",note:"日結不列訂單備註",items:[{id:"sencha",qty:1}]}});
    expect(created.ok()).toBe(true);
    const {id}=await created.json();
    const move=(from,to)=>request.patch("/api/kitchen/status",{headers:staff,data:{id,from,to}});
    expect((await move("pending","preparing")).ok()).toBe(true);
    expect((await move("preparing","ready")).ok()).toBe(true);
    const recorded=await request.post("/api/kitchen/cash-receipt",{
      headers:staff,data:{id,expectedTotal:45,tendered,operationId:randomUUID()},
    });
    expect(recorded.ok()).toBe(true);
    expect((await move("ready","completed")).ok()).toBe(true);
    return id;
  };
  const first=await collect(100);
  expect((await request.get(endpoint+"?date="+date)).status()).toBe(403);
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen");
  const response=page.waitForResponse(response=>new URL(response.url()).pathname===endpoint&&response.ok());
  await page.getByRole("link",{name:"現金日結",exact:true}).click();
  const shown=await (await response).json();
  expect(shown.date).toBe(date);
  const cashRows=page.getByRole("table",{name:"現金收款明細"});
  const row=id=>cashRows.getByRole("rowheader",{name:new RegExp("#"+String(id).padStart(4,"0"))});
  await expect(row(first)).toContainText("自取");
  await expect(page.getByText("日結不列訂單備註")).toHaveCount(0);
  const opening=200n,adjustments=-20n,expected=opening+BigInt(shown.totals.net)+adjustments;
  const counted=expected-3n;
  await page.getByLabel("開班現金").fill(String(opening));
  await page.getByLabel("其他現金淨額（選填）").fill(String(adjustments));
  await page.getByLabel("實點收班現金").fill(String(counted));
  await expect(page.getByText("盤點短少 NT$ 3")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);

  const second=await collect(50);
  await expect(row(second)).toHaveCount(0);
  const save=page.getByRole("button",{name:"下載現金日結 JSON"});
  const [file]=await Promise.all([page.waitForEvent("download"),save.click()]);
  expect(file.suggestedFilename()).toContain("hey-table-cash-close-"+date+"-");
  const contents=JSON.parse(await readFile(await file.path(),"utf8"));
  expect(contents).toEqual({...shown,reconciliation:{opening:String(opening),adjustments:String(adjustments),
    expected:String(expected),counted:String(counted),difference:"-3"}});
  await page.getByRole("button",{name:"重新擷取"}).click();
  await expect(row(second)).toBeVisible();
  await expect(page.getByText("盤點短少 NT$ 48")).toBeVisible();
  const store=page.getByRole("button",{name:"保存盤點版本"});
  let submitted,replayed=false;
  await page.route("**/api/kitchen/cash-close-versions",async route=>{
    if(replayed||route.request().method()!=="POST")return route.continue();
    if(submitted){
      expect(route.request().postDataJSON()).toEqual(submitted);
      replayed=true;
      return route.continue();
    }
    submitted=route.request().postDataJSON();
    expect((await route.fetch()).ok()).toBe(true);
    return route.abort("connectionreset");
  });
  await store.click();
  await expect(page.getByRole("alert")).toHaveText("尚未收到保存結果。可用同一筆資料重試。");
  await page.reload();
  await expect(page.getByLabel("實點收班現金")).toHaveValue(String(counted));
  await page.getByRole("button",{name:"重試保存盤點"}).click();
  await expect(page.getByText("已保存第 1 版盤點。")).toBeVisible();
  const history=page.getByRole("region",{name:"已保存的盤點版本"});
  await expect(history.getByRole("button",{name:"下載第 1 版"})).toBeVisible();
  const third=await collect(60);
  await store.click();
  await expect(page.getByRole("alert")).toHaveText("收款資料或盤點版本已更新，請重新擷取後再核對。");
  await expect(row(third)).toBeVisible();
  await page.getByLabel("實點收班現金").fill(String(expected+90n));
  await expect(page.getByText("盤點相符")).toBeVisible();
  await store.click();
  await expect(page.getByText("已保存第 2 版盤點。")).toBeVisible();
  await expect(history.getByRole("button",{name:"下載第 2 版"})).toBeVisible();
  const [archive]=await Promise.all([page.waitForEvent("download"),history.getByRole("button",{name:"下載第 1 版"}).click()]);
  expect(archive.suggestedFilename()).toContain("hey-table-cash-close-"+date+"-v1-");
  const frozen=JSON.parse(await readFile(await archive.path(),"utf8"));
  expect(frozen.revision).toBe(1);
  expect(frozen.report.receipts.some(record=>record.orderId===second)).toBe(true);
  expect(frozen.report.receipts.some(record=>record.orderId===third)).toBe(false);
  expect(frozen.report.reconciliation.difference).toBe("-48");
  await page.reload();
  await expect(history.getByRole("button",{name:"下載第 1 版"})).toBeVisible();
  await page.getByLabel("收款登記日期").fill("2001-01-01");
  await expect(page.getByText("這天沒有已登記的現金收款。")).toBeVisible();
  await expect(page.getByLabel("開班現金")).toHaveValue("");
});

test("mobile cash activity exports the visible day and links back to the original collection date",async({page})=>{
  const date="2026-11-25",previous="2026-11-24",start=Date.parse(date+"T00:00:00+08:00");
  const crossDay={orderId:410,mode:"pickup",amount:45,tendered:50,change:5,recordedAt:start+3600000,
    orderDate:previous,completedAt:start-1000};
  const correction={orderId:321,revision:2,previousTendered:100,tendered:70,
    correctedAt:start+7200000,recordedAt:start-60000,recordedDate:previous};
  const report={format:"hey-table.daily-cash.v1",date,timeZone:"Asia/Taipei",capturedAt:start+10800000,
    totals:{receipts:1,net:"45",tendered:"50",change:"5"},receipts:[crossDay],
    activity:{earlierOrders:1,afterHandoff:1,corrections:[correction]}};
  const original={...report,date:previous,totals:{receipts:1,net:"45",tendered:"70",change:"25"},
    receipts:[{orderId:321,mode:"table",amount:45,tendered:70,change:25,recordedAt:correction.recordedAt,orderDate:previous,correctionRevision:2}],
    activity:{earlierOrders:0,afterHandoff:0,corrections:[]}};
  const reads=[];
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.route("**/api/kitchen/cash-close?*",route=>{
    const url=new URL(route.request().url()),scope=url.searchParams.get("date");
    expect(url.searchParams.get("activity")).toBe("1");
    expect(route.request().headers().authorization).toBe(staff.Authorization);
    reads.push(scope);
    return route.fulfill({json:scope===date?report:original});
  });
  await page.route("**/api/kitchen/cash-close-versions?*",route=>route.fulfill({json:{versions:[]}}));
  await page.goto("/kitchen/cash-close?date="+date);
  const late=page.getByRole("rowheader",{name:/#0410/});
  await expect(late).toContainText("餐單成立 "+previous);
  await expect(late).toContainText("交餐後登記");
  await expect(late.locator("time").last()).toHaveAttribute("datetime",new Date(crossDay.completedAt).toISOString());
  const activity=page.getByRole("region",{name:"當日現金更正"});
  await expect(activity).toContainText("實收 NT$ 100 改為 NT$ 70");
  const [file]=await Promise.all([page.waitForEvent("download"),page.getByRole("button",{name:"下載現金日結 JSON"}).click()]);
  expect(JSON.parse(await readFile(await file.path(),"utf8"))).toEqual(report);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await activity.getByRole("link",{name:previous}).click();
  await expect(page.getByLabel("收款登記日期")).toHaveValue(previous);
  await expect(page.getByRole("row",{name:/#0321/})).toBeVisible();
  await expect(activity).toContainText("這天沒有現金更正。");
  expect(reads).toEqual([date,previous]);
});

test("mobile receipt shows the payment hold deadline and explains automatic release",async({page,request})=>{
  const token=randomUUID(),headers={"X-Ticket":token};
  const created=await request.post("/api/orders",{data:{token,mode:"pickup",note:"",items:[{id:"sencha",qty:1}],paymentMethod:"line_pay"}});
  expect(created.ok()).toBe(true);
  const order=await (await request.get("/api/ticket?progress=1",{headers})).json();
  expect(order.paymentDueAt-order.created).toBe(15*60*1000);
  await page.setViewportSize({width:360,height:780});
  await page.goto("/ticket#"+token);
  await expect(page.getByText(/付款保留至/).locator("time")).toHaveAttribute("datetime",new Date(order.paymentDueAt).toISOString());
  await page.route("**/api/ticket?progress=1&timing=1",route=>route.fulfill({json:{
    ...order,status:"cancelled",statusHistory:[...order.statusHistory,{status:"cancelled",at:order.paymentDueAt,actor:"payment_expiry"}],
  }}));
  await page.getByRole("button",{name:"更新進度"}).click();
  await expect(page.getByText("付款保留已到期",{exact:true})).toBeVisible();
  await expect(page.getByText(/餐點份數已釋回/)).toBeVisible();
  await expect(page.getByRole("region",{name:"線上付款"})).toHaveCount(0);
  await expect(page.getByRole("link",{name:"再次點餐"})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  expect((await request.post("/api/ticket/cancel",{headers,data:{}})).ok()).toBe(true);
});

test("customer cancellation releases daily portions and recovers when the reply was lost",async({page,request})=>{
  const date=businessDate(Date.now()),dish="gyoza",token=randomUUID();
  const limit="/api/kitchen/daily-limits",ticket={"X-Ticket":token};
  const data={token,mode:"pickup",note:"",items:[{id:dish,qty:1}],paymentMethod:"line_pay"};
  const config=async()=>(await (await request.get(limit+"?date="+date,{headers:staff})).json()).limits[dish];
  const save=(capacity,revision)=>request.patch(limit,{headers:staff,data:{date,dish,capacity,revision}});
  const initial=await config();
  expect((await save(initial.used+1,initial.revision)).ok()).toBe(true);
  try{
    const created=await request.post("/api/orders",{data});
    expect(created.ok()).toBe(true);
    expect((await request.post("/api/ticket/cancel",{headers:{"X-Ticket":randomUUID()},data:{}})).status()).toBe(404);
    expect((await (await request.get("/api/menu")).json()).remaining[dish]).toBe(0);
    await page.setViewportSize({width:360,height:780});
    await page.goto("/ticket#"+token);
    const cancel=page.getByRole("button",{name:"取消這張餐單"});
    await cancel.click();
    await page.getByRole("button",{name:"保留餐單"}).click();
    await expect(page.getByRole("button",{name:"確認取消餐單"})).toHaveCount(0);
    expect((await config()).used).toBe(initial.used+1);
    await cancel.click();
    let posted=0;
    await page.route("**/api/ticket/cancel",async route=>{
      posted++;
      const result=await route.fetch();
      expect(result.ok()).toBe(true);
      await route.abort("connectionreset");
    },{times:1});
    await page.getByRole("button",{name:"確認取消餐單"}).click();
    await expect(page.getByText("這張餐單已由顧客取消。")).toBeVisible();
    await expect(page.getByText("顧客已取消",{exact:true})).toBeVisible();
    await expect(page.getByRole("region",{name:"線上付款"})).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    expect(posted).toBe(1);
    expect((await request.post("/api/ticket/cancel",{headers:ticket,data:{}})).ok()).toBe(true);
    const receipt=await (await request.get("/api/ticket?progress=1",{headers:ticket})).json();
    expect(receipt.statusHistory.filter(event=>event.status==="cancelled")).toEqual([
      {status:"cancelled",at:expect.any(Number),actor:"customer"},
    ]);
    expect((await request.post("/api/payments/start",{headers:ticket,data:{}})).status()).toBe(409);
    expect((await config()).used).toBe(initial.used);
    expect((await (await request.get("/api/menu")).json()).remaining[dish]).toBe(1);
  }finally{
    await save(initial.capacity,(await config()).revision);
  }
});

test("payment claim and customer cancellation have a single winner",async({request})=>{
  async function create(paymentMethod="line_pay"){
    const token=randomUUID(),headers={"X-Ticket":token};
    const created=await request.post("/api/orders",{data:{token,mode:"pickup",note:"",items:[{id:"sencha",qty:1}],paymentMethod}});
    expect(created.ok()).toBe(true);
    return {headers,id:(await created.json()).id};
  }
  const cancel=headers=>request.post("/api/ticket/cancel",{headers,data:{}});
  const start=headers=>request.post("/api/payments/start",{headers,data:{}});
  const demo=(headers,ref,outcome)=>request.post("/api/payments/demo",{headers,data:{ref,outcome}});
  const status=headers=>request.get("/api/ticket?progress=1",{headers}).then(response=>response.json());
  const active=await create();
  const {attempt}=await (await start(active.headers)).json();
  expect((await cancel(active.headers)).status()).toBe(409);
  expect((await status(active.headers)).status).toBe("pending");
  expect((await demo(active.headers,attempt.ref,"failed")).ok()).toBe(true);
  expect((await cancel(active.headers)).status()).toBe(200);

  const paid=await create("px_pay_plus");
  const paidAttempt=(await (await start(paid.headers)).json()).attempt;
  expect((await demo(paid.headers,paidAttempt.ref,"paid")).ok()).toBe(true);
  expect((await cancel(paid.headers)).status()).toBe(409);
  for(const [from,to] of [["pending","preparing"],["preparing","ready"],["ready","completed"]])
    expect((await request.patch("/api/kitchen/status",{headers:staff,data:{id:paid.id,from,to}})).ok()).toBe(true);

  const cash=await create("cash");
  const move=(from,to)=>request.patch("/api/kitchen/status",{headers:staff,data:{id:cash.id,from,to}});
  expect((await move("pending","preparing")).ok()).toBe(true);
  expect((await cancel(cash.headers)).status()).toBe(409);
  expect((await move("preparing","ready")).ok()).toBe(true);
  expect((await move("ready","completed")).ok()).toBe(true);

  const race=await create();
  const [claimed,withdrawn]=await Promise.all([start(race.headers),cancel(race.headers)]);
  expect([claimed.status(),withdrawn.status()].sort()).toEqual([200,409]);
  const final=await status(race.headers);
  if(claimed.ok()){
    expect(final).toMatchObject({status:"pending",paymentState:"pending"});
    const {attempt}=await claimed.json();
    expect((await demo(race.headers,attempt.ref,"cancelled")).ok()).toBe(true);
    expect((await cancel(race.headers)).ok()).toBe(true);
  }else{
    expect(final).toMatchObject({status:"cancelled",paymentState:"unpaid"});
  }
});

test("staff can download a sandbox reconciliation snapshot on mobile",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto("/kitchen");
  await expect(page.getByRole("heading",{name:"店員登入"})).toBeVisible();
  await expect(page.getByText("匯出付款對帳快照",{exact:true})).toHaveCount(0);
  await page.evaluate(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.reload();
  await page.getByText("匯出付款對帳快照",{exact:true}).click();
  await expect(page.getByRole("combobox",{name:"金流環境"})).toHaveValue("sandbox");
  const download=page.waitForEvent("download");
  await page.getByRole("button",{name:"下載付款快照 JSON"}).click();
  const file=await download;
  expect(file.suggestedFilename()).toMatch(/^hey-table-payments-sandbox-.*\.json$/);
  expect(JSON.parse(await readFile(await file.path(),"utf8"))).toMatchObject({
    format:"hey-table.payment-snapshot.v1",environment:"sandbox",attempts:[],
  });
  await expect(page.getByText("已下載 0 筆付款嘗試。",{exact:true})).toBeVisible();
});

for(const [method,resume] of [["line_pay","online"],["px_pay_plus","visibilitychange"]]){
  test(method+" restores an interrupted receipt on "+resume,async({page,request})=>{
    const token=randomUUID(),headers={"X-Ticket":token};
    const order=await request.post("/api/orders",{data:{token,mode:"pickup",note:"",items:[{id:"oyakodon",qty:1}],paymentMethod:method}});
    expect(order.ok()).toBe(true);
    const started=await request.post("/api/payments/start",{headers,data:{}});
    const {attempt}=await started.json();
    let starts=0;
    page.on("request",r=>{if(new URL(r.url()).pathname==="/api/payments/start")starts++;});
    await page.goto("/ticket#"+token);
    await expect(page.getByRole("button",{name:"模擬付款成功"})).toBeVisible();
    const paid=await request.post("/api/payments/demo",{headers,data:{ref:attempt.ref,outcome:"paid"}});
    expect(paid.ok()).toBe(true);
    const checked=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/payments/check");
    await page.evaluate(type=>(type==="online"?window:document).dispatchEvent(new Event(type)),resume);
    const restored=await (await checked).json();
    expect(restored.attempt).toMatchObject({ref:attempt.ref,state:"paid"});
    await expect(page.getByText("已付款",{exact:true})).toBeVisible();
    expect(starts).toBe(0);
  });
}
test("staff can refund a ready demo pickup and the mobile receipt withdraws its collection QR",async({page,request})=>{
  const token=randomUUID(),ticket={"X-Ticket":token},refund="/api/kitchen/demo-refund";
  const created=await request.post("/api/orders",{data:{token,mode:"pickup",note:"",items:[{id:"sencha",qty:1}],paymentMethod:"line_pay"}});
  expect(created.ok()).toBe(true);
  const {id,total}=await created.json();
  const start=await request.post("/api/payments/start",{headers:ticket,data:{}});
  const {attempt}=await start.json();
  expect((await request.post("/api/payments/demo",{headers:ticket,data:{ref:attempt.ref,outcome:"paid"}})).ok()).toBe(true);
  const status=(from,to)=>request.patch("/api/kitchen/status",{headers:staff,data:{id,from,to}});
  expect((await status("pending","preparing")).ok()).toBe(true);
  expect((await status("preparing","ready")).ok()).toBe(true);
  const operator=await page.context().newPage();
  try{
    for(const browser of [page,operator])await browser.setViewportSize({width:360,height:780});
    await operator.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    await page.goto("/ticket#"+token);
    await expect(page.getByText("出示取餐 QR 碼",{exact:true})).toBeVisible();
    await expect(page.getByText("已付款",{exact:true})).toBeVisible();
    await operator.goto("/kitchen");
    await operator.getByRole("searchbox",{name:"取餐號碼"}).fill(String(id));
    const card=operator.locator(".kitchenTicket");
    const action=card.getByRole("button",{name:"模擬全額退款"});
    const payload={id,expectedTotal:total,expectedStatus:"ready"};
    expect((await request.patch(refund,{headers:ticket,data:payload})).status()).toBe(403);
    operator.once("dialog",dialog=>dialog.dismiss());
    await action.click();
    await expect(action).toBeEnabled();
    await operator.route("**"+refund,async route=>{
      expect(route.request().postDataJSON()).toEqual(payload);
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort("connectionreset");
    },{times:1});
    operator.once("dialog",dialog=>dialog.accept());
    await action.click();
    await expect(action).toHaveCount(0);
    await expect(page.getByText("已模擬全額退款 NT$ 45。",{exact:true})).toBeVisible();
    await expect(page.getByText("店家退款並取消",{exact:true})).toHaveCount(1);
    await expect(page.getByText("出示取餐 QR 碼",{exact:true})).toHaveCount(0);
    await expect(page.getByRole("button",{name:/開始模擬付款/})).toHaveCount(0);
    const replay=await request.patch(refund,{headers:staff,data:payload,maxRetries:1});
    expect(replay.ok()).toBe(true);
    expect(await replay.json()).toEqual({id,total,status:"cancelled",paymentState:"refunded"});
    expect((await status("ready","completed")).status()).toBe(409);
    await operator.getByRole("button",{name:"含近期結單"}).click();
    await expect(card.getByText("已退款",{exact:false})).toBeVisible();
    await page.reload();
    await expect(page.getByText("已模擬全額退款 NT$ 45。",{exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    const after=await (await request.get("/api/ticket?progress=1",{headers:ticket})).json();
    expect(after.statusHistory.filter(event=>event.actor==="demo_refund")).toHaveLength(1);
    const {refundedAt}=after.demoRefund;
    expect(refundedAt).toBe(after.statusHistory.at(-1).at);
    const payment=page.getByRole("region",{name:"線上付款"});
    await expect(payment.locator("time")).toHaveAttribute("datetime",new Date(refundedAt).toISOString());
    const endpoint="/api/ticket/refund-receipt";
    await page.route(url=>url.pathname===endpoint,route=>route.fulfill({status:503,body:"暫時中斷"}),{times:1});
    const download=payment.getByRole("button",{name:"下載示範退款收據"});
    await download.click();
    await expect(payment.getByRole("alert")).toHaveText("暫時無法下載退款收據，請再試一次。");
    const [file]=await Promise.all([page.waitForEvent("download"),download.click()]);
    expect(file.suggestedFilename()).toBe("hey-table-refund-"+String(id).padStart(4,"0")+".txt");
    const text=await readFile(await file.path(),"utf8");
    expect(text).toContain("示範付款，無實際退款。");
    expect(text).toContain("支付方式 LINE Pay");
    expect(text).toContain("退款金額 NT$ 45");
    expect(text).toContain(await payment.locator("time").textContent());
    expect(text).not.toContain(token);
    expect(text).not.toContain(attempt.ref);
  }finally{await operator.close();}
});

test("a refund reviewed before handoff cannot cancel an order completed by another terminal",async({request})=>{
  const token=randomUUID(),ticket={"X-Ticket":token};
  const order=await request.post("/api/orders",{data:{token,mode:"pickup",note:"",items:[{id:"sencha",qty:1}],paymentMethod:"px_pay_plus"}});
  expect(order.ok()).toBe(true);
  const {id,total}=await order.json();
  const pay=await (await request.post("/api/payments/start",{headers:ticket,data:{}})).json();
  expect((await request.post("/api/payments/demo",{headers:ticket,data:{ref:pay.attempt.ref,outcome:"paid"}})).ok()).toBe(true);
  const status=(from,to)=>request.patch("/api/kitchen/status",{headers:staff,data:{id,from,to}});
  const refund=expectedStatus=>request.patch("/api/kitchen/demo-refund",{headers:staff,data:{id,expectedStatus,expectedTotal:total}});
  expect((await status("pending","preparing")).ok()).toBe(true);
  expect((await status("preparing","ready")).ok()).toBe(true);
  const [refundAttempt,handoff]=await Promise.all([refund("ready"),status("ready","completed")]);
  expect([refundAttempt.status(),handoff.status()].sort()).toEqual([200,409]);
  if(handoff.ok()){
    expect((await refund("ready")).status()).toBe(409);
    expect(await (await refund("completed")).json()).toEqual({id,total,status:"completed",paymentState:"refunded"});
  }
  const stored=await (await request.get("/api/ticket?progress=1",{headers:ticket})).json();
  expect(stored).toMatchObject({status:handoff.ok()?"completed":"cancelled",paymentState:"refunded"});
  expect(stored.statusHistory.filter(event=>event.status===stored.status)).toHaveLength(1);
});

test("mobile staff can print and download the same dated refund handoff after a newer refund arrives",async({page,request})=>{
  const date=businessDate(Date.now()),endpoint="/api/kitchen/demo-refunds";
  async function refund(paymentMethod){
    const token=randomUUID(),ticket={"X-Ticket":token};
    const created=await request.post("/api/orders",{data:{token,mode:"pickup",note:"交班下載不可包含這段備註",
      paymentMethod,items:[{id:"sencha",qty:1}]}});
    expect(created.ok()).toBe(true);
    const {id,total}=await created.json();
    const started=await (await request.post("/api/payments/start",{headers:ticket,data:{}})).json();
    expect((await request.post("/api/payments/demo",{headers:ticket,data:{ref:started.attempt.ref,outcome:"paid"}})).ok()).toBe(true);
    expect((await request.patch("/api/kitchen/demo-refund",{headers:staff,
      data:{id,expectedStatus:"pending",expectedTotal:total}})).ok()).toBe(true);
    return id;
  }
  const first=await refund("line_pay");
  expect((await request.get(endpoint+"?date="+date)).status()).toBe(403);
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>{
    sessionStorage.setItem("he-ri-staff","local-test-kitchen");
    window.print=()=>document.body.dataset.printed="yes";
  });
  await page.goto("/kitchen");
  const loaded=page.waitForResponse(response=>new URL(response.url()).pathname===endpoint&&response.ok());
  await page.getByRole("link",{name:"示範退款紀錄"}).click();
  const snapshot=await (await loaded).json();
  expect(snapshot.date).toBe(date);
  const row=id=>page.getByRole("rowheader",{name:new RegExp("#"+String(id).padStart(4,"0"))});
  await expect(row(first)).toContainText("LINE Pay");
  await expect(page.getByText("交班下載不可包含這段備註")).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);

  const newer=await refund("px_pay_plus");
  await page.getByRole("button",{name:"列印退款紀錄"}).click();
  await expect(page.locator("body")).toHaveAttribute("data-printed","yes");
  await page.emulateMedia({media:"print"});
  await expect(page.getByLabel("退款日期")).toBeHidden();
  await expect(row(first)).toBeVisible();
  await expect(row(newer)).toHaveCount(0);
  await page.emulateMedia({media:"screen"});
  const download=page.getByRole("button",{name:"下載退款 JSON"});
  const [file]=await Promise.all([page.waitForEvent("download"),download.click()]);
  expect(file.suggestedFilename()).toContain("hey-table-demo-refunds-"+date+"-");
  expect(JSON.parse(await readFile(await file.path(),"utf8"))).toEqual(snapshot);

  await page.getByRole("button",{name:"重新擷取"}).click();
  await expect(row(newer)).toContainText("全支付");
  const number="#"+String(newer).padStart(4,"0");
  await row(newer).getByRole("link",{name:number}).click();
  await expect(page.getByRole("heading",{name:"示範退款餐單"})).toBeVisible();
  const refundInfo=page.getByRole("region",{name:"退款資料"});
  await expect(refundInfo).toContainText("全支付");
  await expect(refundInfo).toContainText("已退款");
  await expect(page.getByRole("region",{name:"餐單資料"})).toContainText("已取消");
  await expect(page.getByRole("region",{name:"原餐單品項"})).toContainText("日式熱煎茶");
  await expect(page.getByText("交班下載不可包含這段備註")).toHaveCount(0);
  const detailDownload=page.getByRole("button",{name:"下載退款餐單 JSON"});
  const [detailFile]=await Promise.all([page.waitForEvent("download"),detailDownload.click()]);
  const detailReport=JSON.parse(await readFile(await detailFile.path(),"utf8"));
  expect(detailFile.suggestedFilename()).toContain("hey-table-demo-refund-"+number.slice(1)+"-");
  expect(detailReport).toMatchObject({order:{id:newer,total:45,status:"cancelled",items:[{name:"日式熱煎茶",qty:1}]},
    refund:{amount:45,previousStatus:"pending",source:"recorded"}});
  await expect(refundInfo.getByText("全支付")).toBeVisible();
  await page.getByRole("button",{name:"列印退款餐單"}).click();
  await expect(page.locator("body")).toHaveAttribute("data-printed","yes");
  await page.emulateMedia({media:"print"});
  await expect(detailDownload).toBeHidden();
  await expect(refundInfo).toBeVisible();
  await page.emulateMedia({media:"screen"});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  const back=page.getByRole("link",{name:"返回示範退款交班紀錄"});
  await back.click();
  await expect(page.getByLabel("退款日期")).toHaveValue(date);
  await page.getByLabel("退款日期").fill("2001-01-01");
  await expect(page.getByText("這一天沒有可查詢的示範退款。")).toBeVisible();
  await expect(row(first)).toHaveCount(0);
  await page.getByLabel("退款餐號").fill(String(first));
  await page.getByRole("button",{name:"查詢餐號"}).click();
  await expect(refundInfo).toContainText("LINE Pay");
  await back.click();
  await expect(page.getByLabel("退款日期")).toHaveValue("2001-01-01");
  await expect(page.getByText("這一天沒有可查詢的示範退款。")).toBeVisible();
});

test("table checkout simulates failure, retries and restores the paid LINE Pay receipt",async({page,request})=>{
  await page.goto("/?table=A04");
  await page.getByRole("button",{name:"加入雞肉親子丼",exact:true}).click();
  await page.getByRole("combobox").selectOption("line_pay");
  await expect(page.getByText("示範模式・不扣款")).toBeVisible();
  await page.getByRole("button",{name:"確認送出訂單"}).click();
  await page.waitForURL("**/ticket#*");
  const order=await (await request.get("/api/ticket",{headers:{"X-Ticket":new URL(page.url()).hash.slice(1)}})).json();
  await expect(page.getByText("等待付款",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:/開始模擬付款/}).click();
  await page.getByRole("button",{name:"模擬付款失敗"}).click();
  await expect(page.getByText("付款失敗",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:/開始模擬付款/}).click();
  await page.getByRole("button",{name:"模擬付款成功"}).click();
  await page.reload();
  await expect(page.getByText("已付款",{exact:true})).toBeVisible();
  expect((await request.patch("/api/kitchen/status",{headers:staff,data:{id:order.id,from:"pending",to:"preparing"}})).status()).toBe(200);
});
for(const method of ["px_pay_plus","jko_pay","easy_wallet","pi_wallet","plus_pay","card"]){
  test(method+" checkout has one active attempt and independent kitchen/payment state",async({request})=>{
    const token=randomUUID(),headers={"X-Ticket":token};
    const post=(path,data={})=>request.post("/api/payments/"+path,{headers,data});
    const data={token,mode:"pickup",items:[{id:"oyakodon",qty:1}],note:"",paymentMethod:method,total:1};
    const order=await (await request.post("/api/orders",{data})).json();
    expect(order.total).toBeGreaterThan(1);
    expect((await request.post("/api/orders",{data:{...data,paymentMethod:"cash"}})).status()).toBe(409);
    const prepare=to=>request.patch("/api/kitchen/status",{headers:staff,data:{id:order.id,from:"pending",to}});
    expect((await prepare("preparing")).status()).toBe(409);
    expect((await (await request.get("/api/kitchen/prep",{headers:staff})).json()).orders.map(o=>o.id)).not.toContain(order.id);
    const [a,b]=await Promise.all([post("start"),post("start")].map(async r=>(await (await r).json()).attempt));
    expect(a.ref).toBe(b.ref);
    expect((await prepare("cancelled")).status()).toBe(409);
    expect((await request.post("/api/payments/demo",{headers:{"X-Ticket":randomUUID()},data:{ref:a.ref,outcome:"paid"}})).status()).toBe(404);
    await request.post("/api/payments/notify",{data:{bank_transaction_id:a.ref,status:0}});
    expect((await (await post("check")).json()).attempt.state).toBe("pending");
    await post("demo",{ref:a.ref,outcome:"cancelled"});
    const next=(await (await post("start")).json()).attempt;
    expect(next.ref).not.toBe(a.ref);
    expect((await post("demo",{ref:a.ref,outcome:"paid"})).status()).toBe(403);
    await post("demo",{ref:next.ref,outcome:"paid"});
    expect((await prepare("cancelled")).status()).toBe(409);
    expect((await prepare("preparing")).status()).toBe(200);
  });
}

for(const [method,label,table] of [["easy_wallet","悠遊付","A02"],["pi_wallet","Pi 拍錢包",null],["plus_pay","全盈+PAY","A06"]]){
  test(label+" can cancel then pay the same mobile demo receipt",async({page,request})=>{
    const externalPayments=[];
    page.on("request",r=>{if(new URL(r.url()).hostname.endsWith("tappaysdk.com"))externalPayments.push(r.url());});
    await page.setViewportSize({width:390,height:844});
    await page.goto(table?"/?table="+table:"/");
    await page.getByRole("button",{name:"加入滑蛋豬排丼",exact:true}).click();
    await page.getByRole("button",{name:"加入日式熱煎茶",exact:true}).click();
    await page.getByRole("button",{name:/我的餐單/}).click();
    await page.getByRole("checkbox",{name:/套用套餐優惠/}).check();
    await page.getByRole("combobox",{name:"付款方式"}).selectOption({label});
    await page.getByRole("button",{name:"確認送出訂單"}).click();
    await page.waitForURL("**/ticket#*");
    await expect(page.getByRole("heading",{name:label,exact:true})).toBeVisible();
    const start=page.getByRole("button",{name:"開始模擬付款 · NT$ 200"});
    await start.click();
    await page.getByRole("button",{name:"模擬取消"}).click();
    await expect(page.getByText("付款已取消",{exact:true})).toBeVisible();
    await start.click();
    await page.getByRole("button",{name:"模擬付款成功"}).click();
    await page.reload();
    await expect(page.getByText("已付款",{exact:true})).toBeVisible();
    const headers={"X-Ticket":new URL(page.url()).hash.slice(1)};
    const ticket=await (await request.get("/api/ticket",{headers})).json();
    expect(ticket).toMatchObject({table,paymentEnv:"demo",paymentMethod:method,total:200,paymentState:"paid"});
    expect(externalPayments).toEqual([]);
  });
}
