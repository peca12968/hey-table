import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {join} from "node:path";

const endpoint="/api/kitchen/return-receipt";
const staff={Authorization:"Bearer local-test-kitchen"};
async function place(request,data={}) {
  const token=randomUUID();
  const response=await request.post("/api/orders",{data:{token,mode:"pickup",note:"",
    items:[{id:"sencha",qty:1}],...data}});
  expect(response.status()).toBe(200);
  return {ticket:await response.json(),token};
}
async function move(request,id,from,to) {
  expect((await request.patch("/api/kitchen/status",{headers:staff,data:{id,from,to}})).status()).toBe(200);
}

test("staff lookup returns frozen prices for plain receipts and rejects invalid order numbers",async({request})=>{
  const {ticket,token}=await place(request,{note:"外帶備註",paymentMethod:"line_pay"});
  const url=endpoint+"?id="+ticket.id;
  expect((await request.get(url)).status()).toBe(403);
  expect((await request.get(url,{headers:{"X-Ticket":token}})).status()).toBe(403);
  for(const id of ["","0","-1","1e2","9007199254740992"])
    expect((await request.get(endpoint+"?id="+id,{headers:staff})).status()).toBe(400);
  expect((await request.get(endpoint+"?id=9007199254740991",{headers:staff})).status()).toBe(404);
  const response=await request.get(url,{headers:staff});
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toEqual({id:ticket.id,created:ticket.created,items:ticket.items,total:45});
});

test("staff finds an archived combo receipt on mobile and imports its download into Receipt Returns",async({request,page})=>{
  const project=process.env.RECEIPT_RETURNS_PROJECT;
  test.skip(!project,"Set RECEIPT_RETURNS_PROJECT to exercise the actual offline CLI");
  const {ticket,token}=await place(request,{mode:"table",table:"A03",note:"另放餐具",
    items:[{id:"oyakodon",qty:1},{id:"gyoza",qty:2},{id:"sencha",qty:1}],
    paymentMethod:"px_pay_plus",comboVersion:"demo-v1",expectedTotal:345});
  const headers={"X-Ticket":token};
  const start=await request.post("/api/payments/start",{headers,data:{}});
  expect(start.ok()).toBe(true);
  const {attempt}=await start.json();
  expect((await request.post("/api/payments/demo",{headers,data:{ref:attempt.ref,outcome:"paid"}})).ok()).toBe(true);
  for(const [from,to] of [["pending","preparing"],["preparing","ready"],["ready","completed"]])
    await move(request,ticket.id,from,to);
  for(let i=0;i<20;i++) {
    const newer=await place(request);
    await move(request,newer.ticket.id,"pending","cancelled");
  }
  const queue=await (await request.get("/api/kitchen",{headers:staff})).json();
  expect(queue.map(row=>row.id)).not.toContain(ticket.id);
  const before=await (await request.get("/api/ticket",{headers})).json();

  await page.setViewportSize({width:390,height:844});
  await page.goto("/kitchen");
  await expect(page.getByRole("heading",{name:"店員登入"})).toBeVisible();
  await expect(page.getByText("匯出退餐試算收據")).toHaveCount(0);
  await page.evaluate(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.reload();
  await page.getByText("匯出退餐試算收據",{exact:true}).click();
  const number=page.getByRole("textbox",{name:"取餐號碼"});
  const find=page.getByRole("button",{name:"查詢計價明細"});
  const save=page.getByRole("button",{name:"下載試算收據 JSON"});
  await number.fill("9007199254740991");
  await find.click();
  await expect(page.getByRole("alert")).toContainText("找不到");
  const label=String(ticket.id).padStart(4,"0");
  await number.fill(label);
  await find.click();
  const detail=page.getByRole("region",{name:"收據計價明細"});
  await expect(detail.getByRole("listitem").filter({hasText:"海苔柴魚煎餃"})).toContainText("NT$ 157");
  await expect(detail).toContainText("餐點原價 NT$ 385 · 套餐折抵 NT$ 40");
  await expect(detail.locator(".total")).toContainText("NT$ 345");
  const event=page.waitForEvent("download");
  await save.click();
  const file=await event;
  expect(file.suggestedFilename()).toBe("hey-table-return-"+label+"-"+new Date(ticket.created).toISOString().replace(/:/g,"-")+".json");
  const path=await file.path();
  const receipt=JSON.parse(await readFile(path,"utf8"));
  expect(receipt).toEqual({id:ticket.id,created:ticket.created,items:ticket.items,total:345,combo:ticket.combo});
  const cli=(...args)=>JSON.parse(execFileSync(process.env.PYTHON||(process.platform==="win32"?"python":"python3"),
    [join(project,"returns.py"),test.info().outputPath("returns.db"),...args],{encoding:"utf8"}));
  const id=String(ticket.id);
  expect(cli("import",path)).toEqual({receipt:ticket.id,total:345});
  const first=cli("record",id,"gyoza=1","--request","one","--expected","85");
  expect(first.remainingValue).toBe(260);
  expect(cli("import",path)).toEqual({receipt:ticket.id,total:345});
  expect(cli("preview",id,"gyoza=1")).toMatchObject({amount:72,remainingValue:188});
  expect(cli("history",id)).toEqual([first]);
  await number.fill(id+"0");
  await expect(save).toHaveCount(0);
  const after=await (await request.get("/api/ticket",{headers})).json();
  expect(after).toEqual(before);
  expect(after.paymentState).toBe("paid");
});
