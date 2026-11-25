import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {businessDate} from "../lib/business-day.mjs";
const staff={Authorization:"Bearer local-test-kitchen"};

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
    const replay=await request.patch(refund,{headers:staff,data:payload});
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
  await page.getByLabel("退款日期").fill("2001-01-01");
  await expect(page.getByText("這一天沒有可查詢的示範退款。")).toBeVisible();
  await expect(row(first)).toHaveCount(0);
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
