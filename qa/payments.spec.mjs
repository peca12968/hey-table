import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {businessDate} from "../lib/business-day.mjs";
const staff={Authorization:"Bearer local-test-kitchen"};

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
    await page.getByRole("combobox").selectOption({label});
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
