import {test,expect} from "@playwright/test";
import {execFileSync,spawn} from "node:child_process";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
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

test("the workbench imports a real scan export, enforces its window and shares one receipt with the CLI",async({page,request})=>{
  const cli=fileURLToPath(new URL("../modules/dispatch-window/execute.py",import.meta.url));
  const endpoint="/dispatch-batches",now=Date.now();
  const plan={start_ms:now-120_000,cutoff_ms:now+600_000,ship_units:3,scheduled:[]};
  const codes=[];
  for(const [id,opens,closes] of [["import-late",-90_000,-60_000],["import-ready",-30_000,120_000],["import-wait",300_000,480_000]]){
    const created=await request.post(origin+"/reservations",{headers:{"Idempotency-Key":id},data:{sku:"KIT-01",quantity:1}});
    expect(created.status()).toBe(201);
    const original=(await created.json()).expires_at_ms;
    const renewed=await request.post(origin+"/reservations/"+id+"/renewals",{headers:{"Idempotency-Key":"loading"},
      data:{expected_expires_at_ms:original,extend_seconds:600}});
    expect(renewed.status()).toBe(201);
    plan.scheduled.push({reservation_id:id,units:1,pack_start_ms:now+opens-1000,dispatch_ms:now+opens,deadline_ms:now+closes,
      dispatch:{boxes:[{reservation_id:id,shipment_id:"A",quantity:1}]}});
    codes.push("DW1/"+id+"/A/1");
  }
  const planPath=join(directory,"planned.json"),scanPath=join(directory,"packed.txt");
  await writeFile(planPath,JSON.stringify(plan));
  await writeFile(scanPath,codes.join("\n"));
  const exported=execFileSync(python,["-B",cli,planPath,"--scan-log",scanPath,"--export-workbench"],{windowsHide:true});
  const manifest=JSON.parse(exported);
  const target=manifest.jobs.find(job=>job.reservation_id==="import-ready");
  await page.setViewportSize({width:360,height:780});
  await page.goto(origin+"/workbench/dispatch");
  const file=page.getByLabel("掃碼核對檔");
  const upload=buffer=>file.setInputFiles({name:"ready-load.json",mimeType:"application/json",buffer});
  const invalid=structuredClone(manifest);
  invalid.load_check.verified_units++;
  await upload(Buffer.from(JSON.stringify(invalid)));
  await expect(page.getByRole("alert")).toContainText("無法匯入");
  await expect(page.getByLabel("排程訂單")).toBeHidden();
  await upload(exported);
  const options=page.getByLabel("排程訂單");
  const preview=page.getByRole("button",{name:"預覽交運"});
  const review=page.getByRole("region",{name:"核對交運"});
  const confirm=page.getByRole("button",{name:"確認整車交運"});
  const receipt=page.getByRole("region",{name:"交運收據",exact:true});
  async function choose(id){
    await options.selectOption({label:id+" · 1 箱"});
    await page.getByRole("button",{name:"載入選定箱單"}).click();
  }
  for(const [id,text] of [["import-wait","尚未到交運時間"],["import-late","交運已截止"]]){
    await choose(id);
    await preview.click();
    await expect(review).toContainText(text);
    await expect(confirm).toBeHidden();
  }
  await choose("import-ready");
  await expect(page.getByLabel("交運批號")).toHaveValue(target.batch_id);
  await expect(page.getByLabel("交運批號")).toBeDisabled();
  await expect(page.getByLabel("件數")).toBeDisabled();
  await preview.click();
  await expect(review).toContainText("目前在交運時窗內");
  let attempts=0;
  await page.route(url=>url.pathname===endpoint,async route=>{
    expect(route.request().headers()["idempotency-key"]).toBe(target.batch_id);
    expect(route.request().postDataJSON()).toEqual({boxes:target.boxes,window:target.window});
    if(++attempts===1)return route.abort("connectionreset");
    const response=await route.fetch();
    expect(response.status()).toBe(201);
    await route.fulfill({response});
  });
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText("尚未確認交運結果");
  await page.reload();
  await expect(review).toContainText("交運時窗");
  await page.getByRole("button",{name:"重試原交運批次"}).click();
  await expect(receipt).toContainText(target.batch_id);
  await expect(receipt).toContainText("import-ready/A · 已交運 1 件");
  expect(attempts).toBe(2);

  await writeFile(scanPath,codes[1]+"\n");
  const result=JSON.parse(execFileSync(python,["-B",cli,planPath,"--scan-log",scanPath,"--reservation","import-ready",
    "--stockroom",origin,"--confirm"],{windowsHide:true}));
  expect(result.results[0].state).toBe("recovered");
  expect(result.results[0].receipt).toEqual(await (await request.get(origin+endpoint+"/"+target.batch_id)).json());
  await upload(exported);
  await choose("import-ready");
  await preview.click();
  await expect(page.getByRole("status")).toHaveText("已取回同一份掃碼箱單的原交運收據。");
  await expect(receipt).toContainText(target.batch_id);
  expect(attempts).toBe(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
});

test("return workbench checks scanned labels, refreshes a stale batch and hands a recovered receipt to quarantine",async({page,request})=>{
  execFileSync(python,["-c",`import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("INSERT INTO products VALUES ('RTN-01', 8, 8)")
`,join(directory,"stockroom.sqlite")],{windowsHide:true});
  const endpoint="/return-inspections",batch="scanned-dock";
  const post=(path,key,data)=>request.post(origin+path,{headers:{"Idempotency-Key":key},data});
  for(const [order,quantity] of [["rtn-a",2],["rtn-b",3],["rtn-c",2]]){
    expect((await post("/reservations",order,{sku:"RTN-01",quantity})).status()).toBe(201);
    expect((await post("/reservations/"+order+"/fulfillments","box",{quantity})).status()).toBe(201);
  }
  const stock=async()=>((await (await request.get(origin+"/inventory")).json()).find(row=>row.sku==="RTN-01").available);
  expect(await stock()).toBe(1);

  await page.setViewportSize({width:360,height:780});
  const front=await page.goto(origin+"/workbench/returns");
  expect(front.headers()["cache-control"]).toBe("no-store");
  const batchInput=page.getByLabel("驗收批號",{exact:true});
  await batchInput.fill(batch);
  const first=page.getByRole("group",{name:"箱件 1"}),second=page.getByRole("group",{name:"箱件 2"});
  const preview=page.getByRole("button",{name:"預覽退貨驗收"});
  const confirm=page.getByRole("button",{name:"確認整批驗收"});
  await first.getByLabel("原出貨條碼").fill("DW1/rtn-a/box/3");
  await first.getByLabel("原出貨條碼").press("Enter");
  await expect(first.getByLabel("合格件數")).toBeFocused();
  await first.getByLabel("合格件數").fill("1");
  await first.getByLabel("隔離件數").fill("1");
  await page.getByRole("button",{name:"新增箱件"}).click();
  await second.getByLabel("原出貨條碼").fill("DW1/rtn-a/box/2");
  await second.getByLabel("合格件數").fill("1");
  await preview.click();
  await expect(page.getByRole("alert")).toContainText("已掃描");
  await second.getByLabel("原出貨條碼").fill("DW1/rtn-b/box/3");
  await preview.click();
  await expect(page.getByText("條碼標示 3 件，原出貨紀錄為 2 件",{exact:false})).toBeVisible();
  await expect(confirm).toBeDisabled();
  await first.getByLabel("原出貨條碼").fill("DW1/rtn-a/box/2");
  await preview.click();
  await expect(confirm).toBeEnabled();
  expect(await stock()).toBe(1);

  expect((await post(endpoint,"other-dock",{boxes:[
    {reservation_id:"rtn-b",shipment_id:"box",sellable:0,quarantined:3},
  ]})).status()).toBe(201);
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText("整批未登記");
  await expect(page.getByText("本次件數超過尚可驗收件數",{exact:false})).toBeVisible();
  expect((await request.get(origin+endpoint+"/"+batch)).status()).toBe(404);
  expect(await stock()).toBe(1);
  expect((await (await request.get(origin+"/reservations/rtn-a/fulfillments/box")).json()).returnable).toBe(2);

  await second.getByLabel("原出貨條碼").fill("DW1/rtn-c/box/2");
  await preview.click();
  await expect(confirm).toBeEnabled();
  let sends=0;
  await page.route(origin+endpoint,async route=>{
    sends++;
    expect((await route.fetch()).status()).toBe(201);
    await route.abort("failed");
  });
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText("尚未收到驗收結果");
  await page.reload();
  await expect(batchInput).toHaveValue(batch);
  await expect(batchInput).toBeDisabled();
  await page.getByRole("button",{name:"重試原驗收批次"}).click();
  await expect(page.getByRole("status")).toHaveText("已取回原驗收收據。");
  await expect(batchInput).toBeEnabled();
  expect(sends).toBe(1);
  expect(await stock()).toBe(3);
  await page.getByRole("button",{name:"取回驗收收據"}).click();
  await expect(page.getByRole("heading",{name:"退貨驗收收據"})).toBeVisible();
  const downloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"下載驗收收據 JSON"}).click();
  const download=await downloadPromise;
  expect(download.suggestedFilename()).toBe(batch+".json");
  const saved=JSON.parse(await readFile(await download.path(),"utf8"));
  expect(saved).toEqual({batch_id:batch,boxes:[
    {reservation_id:"rtn-a",shipment_id:"box",sellable:1,quarantined:1,returnable_after:0},
    {reservation_id:"rtn-c",shipment_id:"box",sellable:1,quarantined:0,returnable_after:1},
  ]});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await page.getByRole("link",{name:"開啟隔離品複驗"}).click();
  await expect(page.getByText(batch+" · 尚待處理 1 件")).toBeVisible();
});

test("the mobile stock count workbench recounts a changed SKU and recovers a committed batch after reload",async({page,request})=>{
  execFileSync(python,["-c",`import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.executemany("INSERT INTO products VALUES (?,6,6)", [("SCAN-01",),("SCAN-02",)])
`,join(directory,"stockroom.sqlite")],{windowsHide:true});
  const stock="/stock-count-batches",batch="aisle-count";
  const post=(path,key,data)=>request.post(origin+path,{headers:{"Idempotency-Key":key},data});
  const bases=async()=> (await (await request.post(origin+"/stock-count-basis",{data:{skus:["SCAN-01","SCAN-02"]}})).json()).products;
  const hold=await post("/reservations","count-hold",{sku:"SCAN-02",quantity:2});
  expect(hold.status()).toBe(201);
  expect((await post("/reservations/count-hold/renewals","count-hold-extend",{
    expected_expires_at_ms:(await hold.json()).expires_at_ms,extend_seconds:120,
  })).status()).toBe(201);
  await page.setViewportSize({width:360,height:780});
  const front=await page.goto(origin+"/workbench/stock-count");
  expect(front.headers()["cache-control"]).toBe("no-store");
  await page.getByRole("textbox",{name:"商品 SKU（每行一個）"}).fill("SCAN-02\nSCAN-01");
  await page.getByRole("button",{name:"擷取庫存基準"}).click();
  const first=page.getByRole("group",{name:"SCAN-01"}),second=page.getByRole("group",{name:"SCAN-02"});
  await expect(second).toContainText("已保留 2 件");
  await page.getByLabel("盤點批號",{exact:true}).fill(batch);
  await page.getByLabel("盤點場次").fill("早班");
  await page.getByLabel("盤點理由").fill("現場複點");
  await first.getByLabel("實點件數").fill("4");
  await second.getByLabel("實點件數").fill("1");
  const preview=page.getByRole("button",{name:"預覽盤點差異"});
  const confirm=page.getByRole("button",{name:"確認整批入帳"});
  await preview.click();
  await expect(page.getByText(/低於保留量 2 件/)).toBeVisible();
  await expect(confirm).toBeDisabled();
  await second.getByLabel("實點件數").fill("3");
  await preview.click();
  await expect(confirm).toBeEnabled();
  const initial=await bases();
  const competitor=await post("/inventory/SCAN-02/count-adjustments","shared-count",{
    expected_revision:initial[1].revision,counted:5,count_session:"另一位人員",reason:"盤點校正",
  });
  expect(competitor.status()).toBe(201);
  await confirm.click();
  await expect(page.getByRole("alert")).toHaveText("整批未入帳，基準已更新。請複點 SCAN-02。");
  await expect(first.getByLabel("實點件數")).toHaveValue("4");
  await expect(second.getByLabel("實點件數")).toHaveValue("");
  expect((await bases()).map(row=>row.capacity)).toEqual([6,5]);
  expect((await request.get(origin+stock+"/"+batch)).status()).toBe(404);
  await second.getByLabel("實點件數").fill("3");
  await preview.click();
  await expect(confirm).toBeEnabled();
  let writes=0;
  await page.route(url=>url.pathname===stock,async route=>{
    writes++;
    expect((await route.fetch()).status()).toBe(201);
    await route.abort("connectionreset");
  });
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText("尚未收到盤點結果");
  await page.reload();
  await expect(page.getByRole("heading",{name:"待確認盤點批次 "+batch})).toBeVisible();
  await page.getByRole("button",{name:"查詢或重試原盤點批次"}).click();
  await expect(page.getByRole("status")).toHaveText("已取回原盤點收據。");
  expect(writes).toBe(1);
  expect((await bases()).map(row=>[row.capacity,row.available])).toEqual([[4,4],[3,1]]);
  const file=page.waitForEvent("download");
  await page.getByRole("button",{name:"下載盤點收據 JSON"}).click();
  const exported=JSON.parse(await readFile(await (await file).path(),"utf8"));
  const authoritative=await (await request.get(origin+stock+"/"+batch)).json();
  expect(exported).toEqual(authoritative);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
});

test("the mobile quarantine queue can page past a finished batch and open the remaining work",async({page,request})=>{
  execFileSync(python,["-c",`import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("INSERT INTO products VALUES ('QUEUE-01', 6, 6)")
`,join(directory,"stockroom.sqlite")],{windowsHide:true});
  const post=(path,key,data)=>request.post(origin+path,{headers:{"Idempotency-Key":key},data});
  for(const [order,batch,quantity] of [["queue-east","east-dock",2],["queue-west","west-dock",3]]){
    expect((await post("/reservations",order,{sku:"QUEUE-01",quantity})).status()).toBe(201);
    expect((await post("/reservations/"+order+"/fulfillments","box",{quantity})).status()).toBe(201);
    expect((await post("/return-inspections",batch,{boxes:[
      {reservation_id:order,shipment_id:"box",sellable:0,quarantined:quantity},
    ]})).status()).toBe(201);
  }
  await page.route(url=>url.pathname==="/quarantine-queue",async route=>{
    const url=new URL(route.request().url());
    url.searchParams.set("limit","1");
    await route.fulfill({response:await route.fetch({url:url.href})});
  });
  await page.setViewportSize({width:360,height:780});
  await page.goto(origin+"/workbench/returns");
  await page.getByRole("link",{name:"查看待複驗清單"}).click();
  const summary=page.getByRole("status");
  await expect(summary).toContainText("批、");
  await page.getByRole("textbox",{name:"商品 SKU"}).fill("QUEUE-01");
  await page.getByRole("button",{name:"更新清單"}).click();
  await expect(summary).toHaveText("QUEUE-01 · 2 批、2 箱、5 件");
  await expect(page.getByRole("link",{name:"east-dock"})).toBeVisible();
  const next=page.getByRole("button",{name:"下一頁"});
  await expect(next).toBeEnabled();

  expect((await post("/return-inspections/east-dock/dispositions","cleared",{boxes:[
    {reservation_id:"queue-east",shipment_id:"box",restock:1,discard:1,expected_remaining:2,reason:"人工複驗"},
  ]})).status()).toBe(201);
  await next.click();
  await expect(summary).toHaveText("QUEUE-01 · 1 批、1 箱、3 件");
  await expect(page.getByRole("link",{name:"east-dock"})).toHaveCount(0);
  const downloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"下載本頁 JSON"}).click();
  const download=await downloadPromise;
  const snapshot=JSON.parse(await readFile(await download.path(),"utf8"));
  expect(snapshot.sku).toBe("QUEUE-01");
  expect(snapshot.summary).toEqual({batches:1,boxes:1,units:3});
  expect(snapshot.batches).toEqual([{batch_id:"west-dock",pending_boxes:1,pending_units:3,received_at_ms:expect.any(Number)}]);
  expect(snapshot.next).toBeNull();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await page.getByRole("link",{name:"west-dock"}).click();
  await expect(page.getByText("west-dock · 尚待處理 3 件")).toBeVisible();
});

test("the mobile return history joins original inspection and disposition pages, with a shareable box filter",async({page,request})=>{
  execFileSync(python,["-c",`import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("INSERT INTO products VALUES ('HISTORY-01', 5, 5)")
`,join(directory,"stockroom.sqlite")],{windowsHide:true});
  const post=(path,key,data)=>request.post(origin+path,{headers:{"Idempotency-Key":key},data});
  const batch="history-dock",root="/return-inspections/"+batch;
  const orders=["history-east","history-west"];
  for(const order of orders){
    expect((await post("/reservations",order,{sku:"HISTORY-01",quantity:2})).status()).toBe(201);
    expect((await post("/reservations/"+order+"/fulfillments","box",{quantity:2})).status()).toBe(201);
  }
  expect((await post("/return-inspections",batch,{boxes:orders.map(order=>({
    reservation_id:order,shipment_id:"box",sellable:0,quarantined:2,
  }))})).status()).toBe(201);
  const decision=(order,restock,discard,expected_remaining,reason)=>({
    reservation_id:order,shipment_id:"box",restock,discard,expected_remaining,reason,
  });
  expect((await post(root+"/dispositions","first-review",{boxes:[
    decision(orders[0],0,1,2,"外箱受損"),decision(orders[1],0,1,2,"商品破損"),
  ]})).status()).toBe(201);
  expect((await post(root+"/dispositions","second-review",{boxes:[
    decision(orders[0],1,0,1,"重新封裝"),
  ]})).status()).toBe(201);
  await page.route(url=>url.pathname===root+"/history",async route=>{
    const url=new URL(route.request().url());
    url.searchParams.set("limit","1");
    await route.fulfill({response:await route.fetch({url:url.href})});
  });
  await page.setViewportSize({width:360,height:780});
  await page.goto(origin+"/workbench/returns");
  await page.getByRole("textbox",{name:"收據批號"}).fill(batch);
  await page.getByRole("button",{name:"取回驗收收據"}).click();
  await page.getByRole("link",{name:"查看這批的驗收歷程"}).click();
  await expect(page.getByRole("heading",{name:"退貨驗收歷程"})).toBeVisible();
  await expect(page.getByText(/全批合計 · .*複驗回庫 1 件，報廢 2 件，仍待複驗 1 件/)).toBeVisible();
  const events=page.getByRole("list",{name:"複驗單"});
  await expect(events).toContainText("second-review");
  await expect(events).toContainText("重新封裝");
  await page.getByRole("button",{name:"下一頁"}).click();
  await expect(events).toContainText("first-review");
  await expect(events).toContainText("外箱受損");
  await expect(events).toContainText("商品破損");
  const filter=page.getByRole("combobox",{name:"複驗箱件"});
  await filter.selectOption("history-west/box");
  await expect(events).not.toContainText("外箱受損");
  await expect(events).toContainText("商品破損");
  await page.reload();
  await expect(filter).toHaveValue("history-west/box");
  const downloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"下載本頁 JSON"}).click();
  const download=await downloadPromise;
  const snapshot=JSON.parse(await readFile(await download.path(),"utf8"));
  expect(snapshot.box_filter).toEqual({reservation_id:"history-west",shipment_id:"box"});
  expect(snapshot.boxes).toHaveLength(2);
  expect(snapshot.dispositions[0].boxes.map(box=>box.reason)).toEqual(["商品破損"]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await page.getByRole("link",{name:"開啟這批的隔離品複驗"}).click();
  await expect(page.getByText(batch+" · 尚待處理 1 件")).toBeVisible();
});

test("mobile stock count history filters, pages and opens both receipts from one snapshot",async({page,request})=>{
  const sku="COUNT-HISTORY-01";
  execFileSync(python,["-c",`import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("INSERT INTO products VALUES (?, 5, 5)", (sys.argv[2],))
`,join(directory,"stockroom.sqlite"),sku],{windowsHide:true});
  const date=new Date(Date.now()+28_800_000).toISOString().slice(0,10);
  const create=batch=>request.post(origin+"/stock-count-batches",{
    headers:{"Idempotency-Key":batch},data:{count_session:"晚班複點",reason:"核對盤點",items:[
      {sku,expected_revision:0,counted:5},
    ]},
  });
  const oldest="history-00-opening";
  expect((await create(oldest)).status()).toBe(201);
  for(let index=1;index<=25;index++)expect((await create("history-"+String(index).padStart(2,"0"))).status()).toBe(201);
  const reversed=await request.post(origin+"/stock-count-batches/"+oldest+"/reversal",{
    headers:{"Idempotency-Key":"history-correction"},data:{reason:"交班撤銷"},
  });
  expect(reversed.status()).toBe(201);
  const correction=(await reversed.json()).batch_id;
  await page.setViewportSize({width:360,height:780});
  await page.goto(origin+"/workbench/stock-count");
  await page.getByRole("link",{name:"查看盤點紀錄"}).click();
  await page.getByLabel("入帳日期（台灣）").fill(date);
  await page.getByLabel("商品 SKU").fill(sku);
  await page.getByRole("button",{name:"查詢盤點紀錄"}).click();
  await expect(page.getByRole("status")).toHaveText(date+" · "+sku+" · 27 批 · 沖回單 1 批 · 已沖回 1 批");
  await expect(page.getByRole("link",{name:"原盤點 "+oldest})).toBeVisible();
  const capture=page.waitForResponse(response=>new URL(response.url()).pathname==="/stock-count-batches"&&
    new URL(response.url()).searchParams.has("before_batch_id")&&response.ok());
  await page.getByRole("button",{name:"下一頁"}).click();
  const snapshot=await (await capture).json();
  await expect(page).toHaveURL(/before_batch_id=/);
  const pageUrl=page.url();
  const original=page.getByRole("listitem").filter({has:page.getByRole("link",{name:oldest,exact:true})});
  await expect(original).toContainText("盤點入帳 · 已沖回");
  expect(snapshot.batches).toHaveLength(2);
  const downloading=page.waitForEvent("download");
  await page.getByRole("button",{name:"下載本頁 JSON"}).click();
  const download=await downloading;
  expect(JSON.parse(await readFile(await download.path(),"utf8"))).toEqual(snapshot);
  await original.getByRole("link",{name:"沖回單 "+correction}).click();
  const receipt=page.getByRole("region",{name:"盤點收據",exact:true});
  await expect(receipt).toContainText(correction);
  await expect(receipt).toContainText(sku);
  await page.getByRole("link",{name:"查看盤點紀錄"}).click();
  await expect(page).toHaveURL(pageUrl);
  await original.getByRole("link",{name:oldest,exact:true}).click();
  await expect(receipt).toContainText(oldest);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
});

test("mobile stock count reversal refreshes changed reservations and retries the original operation after reload",async({page,request})=>{
  const py = `import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.executemany("INSERT INTO products VALUES (?, ?, ?)", [("REV-KIT", 9, 9), ("REV-WRAP", 5, 5)])
`;
  execFileSync(python,["-c",py,join(directory,"stockroom.sqlite")],{windowsHide:true});
  const batch="reversal-original",endpoint="/stock-count-batches/"+batch+"/reversal";
  const posted=await request.post(origin+"/stock-count-batches",{
    headers:{"Idempotency-Key":batch},data:{count_session:"交班盤點",reason:"覆盤",items:[
      {sku:"REV-KIT",expected_revision:0,counted:10},{sku:"REV-WRAP",expected_revision:0,counted:8},
    ]},
  });
  expect(posted.status()).toBe(201);
  await page.setViewportSize({width:360,height:780});
  const source=origin+"/workbench/stock-count?batch="+batch;
  await page.goto(source);
  await page.getByRole("link",{name:"預覽或查詢沖回"}).click();
  const review=page.getByRole("region",{name:"核對沖回內容"});
  const confirm=review.getByRole("button",{name:"確認整批沖回"});
  await expect(review).toContainText("REV-WRAP · 目前 8 → 恢復 5 件 · 已保留 0 件 · 恢復後可用 5 件");
  await review.getByLabel("沖回原因").fill("盤點區域選錯");
  expect((await request.post(origin+"/reservations",{
    headers:{"Idempotency-Key":"reversal-new-hold"},data:{sku:"REV-WRAP",quantity:6},
  })).status()).toBe(201);
  await confirm.click();
  await expect(page.getByRole("alert")).toHaveText("這次操作未入帳，請核對最新資料。");
  await expect(review).toContainText("恢復後低於保留量");
  await expect(confirm).toBeDisabled();
  expect((await request.get(origin+endpoint)).status()).toBe(404);
  expect((await request.delete(origin+"/reservations/reversal-new-hold")).ok()).toBe(true);
  await page.getByRole("button",{name:"擷取沖回預覽"}).click();
  await expect(confirm).toBeEnabled();
  const writes=[],results=[];
  await page.route(origin+endpoint,async route=>{
    if(route.request().method()!=="POST")return route.continue();
    writes.push([route.request().headers()["idempotency-key"],route.request().postDataJSON()]);
    const response=await route.fetch();
    results.push([response.status(),await response.json()]);
    if(writes.length===1)return route.abort();
    await route.fulfill({response});
  });
  try{
    await confirm.click();
    await expect(page.getByRole("alert")).toContainText("尚未收到沖回結果");
    await page.reload();
    await expect(page.getByRole("region",{name:"待確認沖回"})).toContainText(batch);
    await page.getByRole("button",{name:"重試原沖回操作"}).click();
    await expect(page.getByRole("status")).toHaveText("已確認原沖回操作。");
    expect(writes).toEqual([writes[0],writes[0]]);
    expect(results).toEqual([[201,results[0][1]],[200,results[0][1]]]);
    const downloading=page.waitForEvent("download");
    await page.getByRole("button",{name:"下載沖回收據 JSON"}).click();
    const download=await downloading;
    expect(JSON.parse(await readFile(await download.path(),"utf8"))).toEqual(results[0][1]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    await page.getByRole("link",{name:"返回庫存盤點"}).click();
    await expect(page).toHaveURL(source);
    await expect(page.getByRole("region",{name:"盤點收據",exact:true})).toContainText(batch);
  }finally{await page.unrouteAll({behavior:"wait"});}
});
