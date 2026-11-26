import {test,expect} from "@playwright/test";
import {execFileSync,spawn} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {once} from "node:events";

const modulePath=fileURLToPath(new URL("../modules/stockroom-reservations/",import.meta.url));
const python=process.env.QA_STOCKROOM_PYTHON??"python";
let directory,service,origin;

test.beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),"stockroom-workbench-"));
  const database=join(directory,"stockroom.sqlite");
  service=spawn(python,
    ["-m","uvicorn","stockroom.api:app","--host","127.0.0.1","--port","0"],
    {cwd:modulePath,env:{...process.env,STOCKROOM_DB:database,STOCKROOM_TTL_SECONDS:"5"},
      stdio:["ignore","ignore","pipe"],windowsHide:true});
  origin=await new Promise((resolve,reject)=>{
    let logs="";
    function failed(code){finish(new Error("Stockroom stopped during startup ("+code+")\n"+logs));}
    function data(chunk){
      logs=(logs+chunk).slice(-3000);
      const listener=logs.match(/http:\/\/127\.0\.0\.1:\d+/);
      if(listener)finish(null,listener[0]);
    }
    function finish(error,address){
      clearTimeout(timer);
      service.off("exit",failed);
      service.off("error",finish);
      service.stderr.off("data",data);
      if(error)reject(error);
      else resolve(address);
    }
    const timer=setTimeout(()=>finish(new Error("Stockroom startup timed out\n"+logs)),10000);
    service.once("error",finish);
    service.once("exit",failed);
    service.stderr.on("data",data);
  });
  execFileSync(python,["-c",`import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("INSERT INTO products VALUES ('WRAP-01', 2, 2)")
`,database],{windowsHide:true});
});

test.afterAll(async()=>{
  if(service?.pid&&service.exitCode===null&&service.signalCode===null){
    const stopped=once(service,"exit");
    service.kill();
    await stopped;
  }
  if(directory)await rm(directory,{recursive:true,force:true,maxRetries:4});
});

test("quarantine workbench refreshes a stale batch and recovers the original receipt after a lost reply",async({page,request})=>{
  const path="/return-inspections/dock",endpoint=path+"/dispositions";
  const post=(path,key,data)=>request.post(origin+path,{headers:{"Idempotency-Key":key},data});
  const boxes=[];
  for(const reservation of ["east","west"]){
    expect((await post("/reservations",reservation,{sku:"KIT-01",quantity:2})).status()).toBe(201);
    expect((await post("/reservations/"+reservation+"/fulfillments","box-"+reservation,{quantity:2})).status()).toBe(201);
    boxes.push({reservation_id:reservation,shipment_id:"box-"+reservation,sellable:0,quarantined:2});
  }
  expect((await post("/return-inspections","dock",{boxes})).status()).toBe(201);
  const stock=async()=>((await (await request.get(origin+"/inventory")).json())[0].available);
  expect(await stock()).toBe(16);
  await page.setViewportSize({width:360,height:780});
  const front=await page.goto(origin+"/workbench/quarantine");
  expect(front.status()).toBe(200);
  expect(front.headers()["cache-control"]).toBe("no-store");
  const script=await request.get(origin+"/workbench/assets/quarantine.mjs");
  expect(script.headers()["content-type"]).toMatch(/^text\/javascript\b/);
  await expect(page.getByRole("heading",{name:"隔離品複驗"})).toBeVisible();
  await page.getByLabel("驗收批號",{exact:true}).fill("dock");
  await page.getByRole("button",{name:"查詢隔離品"}).click();
  await expect(page.getByText("dock · 尚待處理 4 件")).toBeVisible();
  const east=page.getByRole("group",{name:"east 單／box-east 箱"}),west=page.getByRole("group",{name:"west 單／box-west 箱"});
  async function enterDecisions(){
    await east.getByLabel("回庫件數").fill("1");
    await east.getByLabel("複驗原因").fill("重新檢查後合格");
    await west.getByLabel("報廢件數").fill("1");
    await west.getByLabel("複驗原因").fill("包裝破損");
    await page.getByRole("button",{name:"核對複驗內容"}).click();
  }
  await enterDecisions();
  const review=page.getByRole("region",{name:"確認複驗內容"});
  await expect(review).toContainText("box-east 箱 · 回庫 1 件");
  await expect(review).toContainText("box-west 箱 · 回庫 0 件 · 報廢 1 件");
  expect(await stock()).toBe(16);
  expect((await post(endpoint,"other-operator",{boxes:[{reservation_id:"west",shipment_id:"box-west",
    restock:0,discard:1,expected_remaining:2,reason:"Concurrent review"}]})).status()).toBe(201);
  await review.getByRole("button",{name:"確認登記"}).click();
  await expect(page.getByRole("alert")).toHaveText("隔離餘額有變，整批未登記。請重新核對。");
  await expect(page.getByText("dock · 尚待處理 3 件")).toBeVisible();
  expect(await stock()).toBe(16);
  await expect(review).toBeHidden();

  await enterDecisions();
  let committed,operation,posts=0;
  await page.route(url=>url.pathname===endpoint,async route=>{
    if(route.request().method()!=="POST")return route.continue();
    posts++;
    operation=route.request().headers()["idempotency-key"];
    const sent=route.request().postDataJSON();
    expect(sent.boxes.map(box=>box.expected_remaining)).toEqual([2,1]);
    const response=await route.fetch();
    expect(response.status()).toBe(201);
    committed=await response.json();
    return route.abort("connectionreset");
  });
  await review.getByRole("button",{name:"確認登記"}).click();
  await expect(page.getByRole("alert")).toContainText("尚未收到複驗結果");
  await page.reload();
  await expect(review).toContainText(operation);
  await expect(page.getByLabel("驗收批號",{exact:true})).toBeDisabled();
  await review.getByRole("button",{name:"重試原複驗單"}).click();
  const receipt=page.getByRole("region",{name:"複驗收據"});
  await expect(receipt).toContainText(operation);
  await expect(receipt).toContainText("重新檢查後合格");
  await expect(receipt).toContainText("包裝破損");
  await expect(page.getByRole("status")).toHaveText("已取回原複驗收據。");
  await expect(page.getByText("dock · 尚待處理 1 件")).toBeVisible();
  expect(posts).toBe(1);
  expect(await stock()).toBe(17);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  const [file]=await Promise.all([page.waitForEvent("download"),receipt.getByRole("button",{name:"下載複驗收據 JSON"}).click()]);
  expect(file.suggestedFilename()).toBe("dock-"+operation+".json");
  expect(JSON.parse(await readFile(await file.path(),"utf8"))).toEqual(committed);
  await page.reload();
  await page.getByLabel("收據驗收批號").fill("dock");
  await page.getByLabel("複驗單號").fill(operation);
  await page.getByRole("button",{name:"查詢收據"}).click();
  await expect(receipt).toContainText(operation);
});

test("replacement workbench refreshes shortages and retries the original batch after a lost reply",async({page,request})=>{
  const original="expired-checkout",root="/reservation-batches/"+original,endpoint=root+"/replacement";
  const post=(path,key,data)=>request.post(origin+path,{headers:{"Idempotency-Key":key},data});
  const inventory=async()=>(await (await request.get(origin+"/inventory")).json());
  const batch=await post("/reservation-batches",original,{items:[{sku:"KIT-01",quantity:2},{sku:"WRAP-01",quantity:2}]});
  expect(batch.status()).toBe(201);
  await page.setViewportSize({width:360,height:780});
  const response=await page.goto(origin+"/workbench/replacement?batch="+original);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  await expect(page.getByRole("heading",{name:"到期訂單重新保留"})).toBeVisible();
  const preview=page.getByRole("region",{name:"庫存與到期餘量"});
  const confirm=page.getByRole("region",{name:"確認重新保留"});
  const receipt=page.getByRole("region",{name:"重新保留收據"});
  await expect(preview).toContainText("原批次仍有有效保留");
  await expect(confirm).toBeHidden();

  await expect.poll(async()=>{
    const response=await request.get(origin+endpoint+"-preview");
    return (await response.json()).status;
  },{timeout:10_000}).toBe("ready");
  await page.getByRole("button",{name:"查詢批次"}).click();
  await expect(confirm).toContainText("接續 4 件到期餘量");
  expect((await request.get(origin+endpoint)).status()).toBe(404);

  const competitor=await post("/reservations","second-cart",{sku:"WRAP-01",quantity:2});
  expect(competitor.status()).toBe(201);
  const deadline=(await competitor.json()).expires_at_ms;
  expect((await post("/reservations/second-cart/renewals","hold-open",{expected_expires_at_ms:deadline,extend_seconds:60})).status()).toBe(201);
  const occupied=await inventory();
  await confirm.getByRole("button",{name:"整批重新保留"}).click();
  await expect(page.getByRole("alert")).toHaveText("整批未建立，請按最新結果核對。");
  await expect(preview).toContainText("WRAP-01 · 到期餘量 2 件 · 可用 0 件 · 缺 2 件");
  await expect(confirm).toBeHidden();
  expect(await inventory()).toEqual(occupied);
  expect((await request.get(origin+endpoint)).status()).toBe(404);

  expect((await request.delete(origin+"/reservations/second-cart")).status()).toBe(200);
  await page.getByRole("button",{name:"查詢批次"}).click();
  await expect(confirm).toBeVisible();
  const before=await inventory(),operations=[];
  let committed;
  await page.route(url=>url.pathname===endpoint,async route=>{
    if(route.request().method()!=="POST")return route.continue();
    operations.push(route.request().headers()["idempotency-key"]);
    const reply=await route.fetch();
    if(operations.length===1){
      expect(reply.status()).toBe(201);
      committed=await reply.json();
      await route.abort("connectionreset");
    }else{
      expect(reply.status()).toBe(200);
      expect(await reply.json()).toEqual(committed);
      await route.fulfill({response:reply});
    }
  });
  await confirm.getByRole("button",{name:"整批重新保留"}).click();
  await expect(page.getByRole("alert")).toContainText("尚未確認重新保留結果");
  await page.reload();
  await expect(confirm).toContainText(operations[0]);
  await expect(page.getByLabel("原批號")).toBeDisabled();
  await confirm.getByRole("button",{name:"重試原重新保留請求"}).click();
  await expect(receipt).toContainText(committed.batch_id);
  await expect(receipt).toContainText("WRAP-01 · 新保留 2 件");
  await expect(page.getByRole("status")).toHaveText("已確認原請求並取回收據。");
  expect(operations).toEqual([operations[0],operations[0]]);
  expect((await inventory()).map(product=>product.available)).toEqual(before.map(product=>product.available-2));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  const [file]=await Promise.all([page.waitForEvent("download"),receipt.getByRole("button",{name:"下載收據 JSON"}).click()]);
  expect(file.suggestedFilename()).toBe(original+"-replacement.json");
  expect(JSON.parse(await readFile(await file.path(),"utf8"))).toEqual(committed);
  await page.reload();
  await expect(receipt).toContainText(committed.batch_id);
  expect(operations).toHaveLength(2);
});

test("dispatch workbench rechecks the entire truck, then recovers the committed batch after a lost reply",async({page,request})=>{
  const endpoint="/dispatch-batches",batch="packed-van";
  const post=(path,key,data)=>request.post(origin+path,{headers:{"Idempotency-Key":key},data});
  for(const [reservation,quantity] of [["north",4],["south",2]]){
    const reply=await post("/reservations",reservation,{sku:"KIT-01",quantity});
    expect(reply.status()).toBe(201);
    const deadline=(await reply.json()).expires_at_ms;
    expect((await post("/reservations/"+reservation+"/renewals","loading",{
      expected_expires_at_ms:deadline,extend_seconds:600,
    })).status()).toBe(201);
  }
  const inventory=async()=>(await (await request.get(origin+"/inventory")).json()).find(row=>row.sku==="KIT-01");
  const lookup=()=>request.get(origin+endpoint+"/"+batch);
  await page.setViewportSize({width:360,height:780});
  expect((await page.goto(origin+"/workbench/dispatch")).status()).toBe(200);
  await page.getByLabel("交運批號").fill(batch);
  for(const [index,[reservation,box,count]] of [["north","A",2],["north","B",3],["south","A",2]].entries()){
    if(index)await page.getByRole("button",{name:"新增箱件"}).click();
    const row=page.getByRole("group",{name:"箱件 "+(index+1),exact:true});
    await row.getByLabel("保留單號").fill(reservation);
    await row.getByLabel("箱號").fill(box);
    await row.getByLabel("件數").fill(String(count));
  }
  const review=page.getByRole("region",{name:"核對交運"});
  const receipt=page.getByRole("region",{name:"交運收據",exact:true});
  const preview=page.getByRole("button",{name:"預覽交運"});
  const confirm=review.getByRole("button",{name:"確認整車交運"});
  await preview.click();
  await expect(review).toContainText("north/B · KIT-01 · 3 件 · 保留量 2 · 缺 1 件");
  await expect(confirm).toBeHidden();
  expect((await lookup()).status()).toBe(404);

  await page.getByRole("group",{name:"箱件 2",exact:true}).getByLabel("件數").fill("1");
  await expect(review).toBeHidden();
  await preview.click();
  await expect(confirm).toBeVisible();
  expect((await post(endpoint,"earlier-truck",{boxes:[{reservation_id:"south",shipment_id:"previous",quantity:1}]})).status()).toBe(201);
  const before=await inventory();
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText("未登記這份箱單");
  await expect(review).toContainText("south/A · KIT-01 · 2 件 · 保留量 1 · 缺 1 件");
  expect(await inventory()).toEqual(before);
  expect((await lookup()).status()).toBe(404);
  expect((await request.get(origin+"/reservations/north/fulfillments/A")).status()).toBe(404);

  await page.getByRole("group",{name:"箱件 3",exact:true}).getByLabel("件數").fill("1");
  await preview.click();
  let attempts=0,writes=0,committed;
  await page.route(url=>url.pathname===endpoint,async route=>{
    expect(route.request().headers()["idempotency-key"]).toBe(batch);
    if(++attempts===1)return route.abort("connectionreset");
    writes++;
    const response=await route.fetch();
    expect(response.status()).toBe(201);
    committed=await response.json();
    await route.abort("connectionreset");
  });
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText("尚未確認交運結果");
  expect((await lookup()).status()).toBe(404);
  await page.reload();
  await expect(page.getByLabel("交運批號")).toBeDisabled();
  await review.getByRole("button",{name:"重試原交運批次"}).click();
  await expect(page.getByRole("alert")).toContainText("尚未確認交運結果");
  await page.reload();
  await expect(page.getByLabel("交運批號")).toBeDisabled();
  await review.getByRole("button",{name:"重試原交運批次"}).click();
  await expect(receipt).toContainText("south/A · 已交運 1 件");
  await expect(page.getByRole("status")).toHaveText("已確認原交運批次。");
  expect(attempts).toBe(2);
  expect(writes).toBe(1);
  expect((await inventory()).capacity).toBe(before.capacity-4);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  const [file]=await Promise.all([page.waitForEvent("download"),receipt.getByRole("button",{name:"下載交運收據 JSON"}).click()]);
  expect(file.suggestedFilename()).toBe(batch+"-dispatch.json");
  expect(JSON.parse(await readFile(await file.path(),"utf8"))).toEqual(committed);
  await page.reload();
  await page.getByLabel("收據批號").fill(batch);
  await page.getByRole("button",{name:"取回交運收據"}).click();
  await expect(receipt).toContainText(batch);
  expect(writes).toBe(1);
});
