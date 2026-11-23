import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
const staff={Authorization:"Bearer local-test-kitchen"};
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
for(const method of ["px_pay_plus","jko_pay","card"]){
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
