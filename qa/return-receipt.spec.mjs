import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {quoteReturn,returnLots} from "../modules/receipt-returns/quote.mjs";
import {businessDate} from "../lib/business-day.mjs";

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
  const project=process.env.RECEIPT_RETURNS_PROJECT||fileURLToPath(new URL("../modules/receipt-returns/",import.meta.url));
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
  const preview=detail.getByRole("region",{name:"部分退餐試算"});
  const qty=preview.getByRole("textbox",{name:/海苔柴魚煎餃退餐份數/});
  const calculate=preview.getByRole("button",{name:"試算退餐金額"});
  const quote=preview.getByRole("region",{name:"本次退餐試算"});
  await qty.fill("1");
  await calculate.click();
  await expect(quote).toContainText("單點 · 1 份 × NT$ 85");
  await expect(quote).toContainText("NT$ 260");
  await qty.fill("2");
  await expect(quote).toHaveCount(0);
  await calculate.click();
  await expect(quote).toContainText("套餐分攤 · 1 份 × NT$ 72");
  await expect(quote).toContainText("NT$ 157");
  await expect(quote).toContainText("NT$ 188");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
  await qty.fill("3");
  await calculate.click();
  await expect(preview.getByRole("alert")).toHaveText("海苔柴魚煎餃最多可試算 2 份。");
  await expect(quote).toHaveCount(0);
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
  const pricing=returnLots(receipt);
  for(let main=0;main<=1;main++)for(let dumplings=0;dumplings<=2;dumplings++)for(let tea=0;tea<=1;tea++){
    const selection=[["oyakodon",main],["gyoza",dumplings],["sencha",tea]].filter(([,qty])=>qty>0);
    if(!selection.length)continue;
    const expected=cli("preview",id,...selection.map(([dish,qty])=>dish+"="+qty));
    expect(quoteReturn(pricing,new Map(selection))).toEqual({
      lines:expected.lines,amount:expected.amount,remainingValue:expected.remainingValue,
    });
  }
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

function combo(){
  return {mode:"pickup",note:"",items:[{id:"oyakodon",qty:1},{id:"gyoza",qty:2},{id:"sencha",qty:1}],
    paymentMethod:"px_pay_plus",comboVersion:"demo-v1",expectedTotal:345};
}

test("the D1 quote ledger guards overlapping entries, stale amounts and exact retries",async({request})=>{
  const {ticket,token}=await place(request,combo());
  const ledgerUrl=endpoint+"?"+new URLSearchParams({id:String(ticket.id),ledger:"1"});
  const original=await (await request.get("/api/ticket",{headers:{"X-Ticket":token}})).json();
  expect((await request.get(ledgerUrl)).status()).toBe(403);
  const view=async()=>(await request.get(ledgerUrl,{headers:staff})).json();
  expect((await view()).ledger).toEqual({revision:0,records:[]});
  const payload={id:ticket.id,revision:0,amount:85,operationId:randomUUID(),items:[{id:"gyoza",qty:1}]};
  const submit=data=>request.post(endpoint,{headers:staff,data});
  expect((await request.post(endpoint,{data:payload})).status()).toBe(403);
  expect((await submit({...payload,items:[payload.items[0],payload.items[0]]})).status()).toBe(400);
  const forms=[payload,{...payload,operationId:randomUUID()}];
  const responses=await Promise.all(forms.map(submit));
  expect(responses.map(res=>res.status()).sort()).toEqual([200,409]);
  const winner=responses[0].ok()?0:1;
  const saved=await responses[winner].json();
  expect(saved).toMatchObject({revision:1,amount:85,remainingValue:260,
    lines:[{dish:"gyoza",bundle:null,qty:1,unit:85,amount:85}]});
  expect(await (await submit(forms[winner])).json()).toEqual(saved);
  expect((await submit({...forms[winner],items:[{id:"gyoza",qty:2}]})).status()).toBe(409);
  const second={...payload,revision:1,operationId:randomUUID()};
  expect((await submit(second)).status()).toBe(409);
  const renewed=await submit({...second,amount:72});
  expect(renewed.status()).toBe(200);
  const next=await renewed.json();
  expect(next).toMatchObject({revision:2,amount:72,remainingValue:188,
    lines:[{dish:"gyoza",bundle:"chicken-gyoza",qty:1,unit:72,amount:72}]});
  expect((await submit({...payload,revision:2,operationId:randomUUID()})).status()).toBe(400);
  expect((await view()).ledger).toEqual({revision:2,records:[saved,next]});
  expect(await (await request.get("/api/ticket",{headers:{"X-Ticket":token}})).json()).toEqual(original);
});

test("mobile staff recover a lost quote receipt and continue from the saved portions after reloading",async({page,request})=>{
  const {ticket}=await place(request,combo());
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  const details=page.getByRole("region",{name:"部分退餐試算"}),result=details.getByRole("region",{name:"本次退餐試算"});
  async function openReceipt(){
    await page.getByText("匯出退餐試算收據",{exact:true}).click();
    await page.getByRole("textbox",{name:"取餐號碼",exact:true}).fill(String(ticket.id));
    await page.getByRole("button",{name:"查詢計價明細"}).click();
  }
  async function preview(){
    await details.getByRole("textbox",{name:/海苔柴魚煎餃退餐份數/}).fill("1");
    await details.getByRole("button",{name:"試算退餐金額"}).click();
  }
  await page.goto("/kitchen");
  await openReceipt();
  await preview();
  await expect(result).toContainText("NT$ 85");
  let originally;
  await page.route("**"+endpoint,async route=>{
    originally=route.request().postDataJSON();
    expect((await route.fetch()).status()).toBe(200);
    await route.abort();
  },{times:1});
  await result.getByRole("button",{name:"記入試算紀錄"}).click();
  await expect(details.getByRole("alert")).toHaveText("尚未收到登記結果，請重試同一筆試算。");
  const resent=page.waitForRequest(req=>req.method()==="POST"&&new URL(req.url()).pathname===endpoint);
  await result.getByRole("button",{name:"重試登記同一筆"}).click();
  expect((await resent).postDataJSON()).toEqual(originally);
  await expect(details.getByRole("status")).toHaveText("已記入第 1 筆試算。");
  await page.reload();
  await openReceipt();
  await expect(details.getByText("第 1 筆 · NT$ 85")).toBeVisible();
  await expect(details.getByText("原單 2 份 · 可試算 1 份")).toBeVisible();
  await preview();
  await expect(result).toContainText("NT$ 72");
  await expect(result).toContainText("NT$ 188");
  await result.getByRole("button",{name:"記入試算紀錄"}).click();
  await expect(details.getByText("第 2 筆 · NT$ 72")).toBeVisible();
  await expect(details.getByRole("textbox",{name:/海苔柴魚煎餃退餐份數/})).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
});

async function saveTwoQuotes(request,id){
  const results=[];
  for(const [revision,amount] of [85,72].entries()){
    const response=await request.post(endpoint,{headers:staff,data:{id,revision,amount,
      operationId:randomUUID(),items:[{id:"gyoza",qty:1}]}});
    expect(response.status()).toBe(200);
    results.push(await response.json());
  }
  return results;
}

test("voiding an entry restores its exact lot and shares the revision guard with new D1 entries",async({request})=>{
  const {ticket,token}=await place(request,combo());
  const receipt=await (await request.get("/api/ticket",{headers:{"X-Ticket":token}})).json();
  const [first,second]=await saveTwoQuotes(request,ticket.id);
  const read=async()=>(await (await request.get(endpoint+"?id="+ticket.id+"&ledger=1",{headers:staff})).json()).ledger;
  const cancel=data=>request.patch(endpoint,{headers:staff,data});
  const voidPayload={id:ticket.id,revision:2,targetRevision:1,reason:"店員誤登",operationId:randomUUID()};
  const third={id:ticket.id,revision:2,amount:45,items:[{id:"sencha",qty:1}],operationId:randomUUID()};
  expect((await request.patch(endpoint,{data:voidPayload})).status()).toBe(403);
  expect((await cancel({...voidPayload,reason:"  "})).status()).toBe(400);
  const [voidResponse,saveResponse]=await Promise.all([cancel(voidPayload),request.post(endpoint,{headers:staff,data:third})]);
  expect([voidResponse.status(),saveResponse.status()].sort()).toEqual([200,409]);
  const applied=voidResponse.ok()?voidPayload:{...voidPayload,revision:3};
  const result=voidResponse.ok()?voidResponse:await cancel(applied);
  expect(result.status()).toBe(200);
  const changed=await result.json(),balance=voidResponse.ok()?273:228;
  expect(changed).toMatchObject({revision:applied.revision+1,targetRevision:1,reason:"店員誤登",restoredAmount:85,remainingValue:balance});
  expect(await (await cancel({...applied,reason:"  店員誤登  "})).json()).toEqual(changed);
  expect((await cancel({...applied,reason:"另一個原因"})).status()).toBe(409);
  expect((await cancel({...applied,revision:changed.revision,operationId:randomUUID()})).status()).toBe(409);
  const view=await read();
  expect(view.revision).toBe(changed.revision);
  expect(view.records[0]).toEqual({...first,voided:changed});
  expect(view.records[1]).toEqual(second);
  const retryLot={id:ticket.id,revision:changed.revision,amount:85,items:[{id:"gyoza",qty:1}],operationId:randomUUID()};
  expect((await request.post(endpoint,{headers:staff,data:{...retryLot,operationId:applied.operationId}})).status()).toBe(409);
  const newQuote=await request.post(endpoint,{headers:staff,data:retryLot});
  expect(newQuote.status()).toBe(200);
  expect((await newQuote.json())).toMatchObject({amount:85,remainingValue:balance-85,
    lines:[{dish:"gyoza",bundle:null,qty:1,unit:85,amount:85}]});
  expect(await (await cancel(applied)).json()).toEqual(changed);
  expect(await (await request.get("/api/ticket",{headers:{"X-Ticket":token}})).json()).toEqual(receipt);
});

test("mobile staff give a reason, safely retry a void and quote the restored portion",async({page,request})=>{
  const {ticket}=await place(request,combo());
  await saveTwoQuotes(request,ticket.id);
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  async function openReceipt(){
    await page.getByText("匯出退餐試算收據",{exact:true}).click();
    await page.getByRole("textbox",{name:"取餐號碼",exact:true}).fill(String(ticket.id));
    await page.getByRole("button",{name:"查詢計價明細"}).click();
  }
  await page.goto("/kitchen");
  await openReceipt();
  const preview=page.getByRole("region",{name:"部分退餐試算"});
  await preview.getByRole("button",{name:"更正第 1 筆"}).click();
  const correction=preview.getByRole("region",{name:"撤銷第 1 筆試算"});
  const confirm=correction.getByRole("button",{name:"確認撤銷試算"});
  await expect(confirm).toBeDisabled();
  await expect(correction).toContainText("恢復 NT$ 85");
  await correction.getByRole("textbox",{name:"撤銷原因"}).fill("登記了未退的煎餃");
  let first;
  await page.route("**"+endpoint,async route=>{
    first=route.request().postDataJSON();
    expect((await route.fetch()).status()).toBe(200);
    await route.abort();
  },{times:1});
  await confirm.click();
  await expect(preview.getByRole("alert")).toHaveText("尚未收到撤銷結果，請重試撤銷同一筆。");
  const retry=page.waitForRequest(req=>req.method()==="PATCH"&&new URL(req.url()).pathname===endpoint);
  await correction.getByRole("button",{name:"重試撤銷同一筆"}).click();
  expect((await retry).postDataJSON()).toEqual(first);
  await expect(preview.getByRole("status")).toContainText("已撤銷第 1 筆試算");
  await page.reload();
  await openReceipt();
  await expect(preview.getByText("已撤銷 · 登記了未退的煎餃")).toBeVisible();
  await expect(preview.getByText("第 2 筆 · NT$ 72")).toBeVisible();
  await expect(preview.getByText(/目前試算餘額/)).toContainText("NT$ 273");
  await preview.getByRole("textbox",{name:/海苔柴魚煎餃退餐份數/}).fill("1");
  await preview.getByRole("button",{name:"試算退餐金額"}).click();
  await expect(preview.getByRole("region",{name:"本次退餐試算"})).toContainText("單點 · 1 份 × NT$ 85");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
});

test("mobile handoff downloads the displayed ledger capture and opens the audited receipt by number",async({page,request})=>{
  const {ticket}=await place(request,combo());
  await saveTwoQuotes(request,ticket.id);
  const cancelled=await request.patch(endpoint,{headers:staff,data:{id:ticket.id,revision:2,targetRevision:1,
    reason:"交班確認更正",operationId:randomUUID()}});
  expect(cancelled.ok(),await cancelled.text()).toBe(true);
  const {recordedAt}=await cancelled.json(),date=businessDate(recordedAt);
  const api="/api/kitchen/return-ledger-report";
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  const incoming=page.waitForResponse(response=>new URL(response.url()).pathname===api);
  await page.goto("/kitchen/return-ledger?date="+date);
  const report=await (await incoming).json();
  expect(report.events.filter(row=>row.orderId===ticket.id).map(row=>[row.kind,row.amount]))
    .toEqual([["voided",85],["recorded",72],["recorded",85]]);
  const displayed=page.getByRole("region",{name:date+" 試算簿異動"});
  const correction=displayed.getByRole("listitem").filter({hasText:"交班確認更正"});
  await expect(correction).toContainText("撤銷第 1 筆 · NT$ 85");
  const label=String(ticket.id).padStart(4,"0");
  const receiptLink=correction.getByRole("link",{name:"餐單 #"+label});
  await expect(receiptLink).toBeVisible();
  const extra=await request.post(endpoint,{headers:staff,data:{id:ticket.id,revision:3,amount:45,
    operationId:randomUUID(),items:[{id:"sencha",qty:1}]}});
  expect(extra.ok(),await extra.text()).toBe(true);
  const [file]=await Promise.all([page.waitForEvent("download"),page.getByRole("button",{name:"下載試算交班 JSON"}).click()]);
  expect(file.suggestedFilename()).toContain("hey-table-return-ledger-"+date+"-");
  expect(JSON.parse(await readFile(await file.path(),"utf8"))).toEqual(report);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await page.emulateMedia({media:"print"});
  await expect(page.getByRole("button",{name:"下載試算交班 JSON"})).toBeHidden();
  await expect(correction).toBeVisible();
  await page.emulateMedia({media:"screen"});
  await receiptLink.click();
  await expect(page.locator(".returnReceipt")).toHaveJSProperty("open",true);
  await expect(page.getByRole("textbox",{name:"取餐號碼",exact:true})).toHaveValue(label);
  const original=page.getByRole("region",{name:"部分退餐試算"});
  await expect(original.getByText("已撤銷 · 交班確認更正")).toBeVisible();
  await expect(original.getByText("第 4 筆 · NT$ 45")).toBeVisible();
});
