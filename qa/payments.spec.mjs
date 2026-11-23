import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
const staff={Authorization:"Bearer local-test-kitchen"};
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
