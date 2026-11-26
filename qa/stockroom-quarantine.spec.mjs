import {test,expect} from "@playwright/test";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {once} from "node:events";

const modulePath=fileURLToPath(new URL("../modules/stockroom-reservations/",import.meta.url));
let directory,service,origin;

test.beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),"stockroom-quarantine-"));
  service=spawn(process.env.QA_STOCKROOM_PYTHON??"python",
    ["-m","uvicorn","stockroom.api:app","--host","127.0.0.1","--port","0"],
    {cwd:modulePath,env:{...process.env,STOCKROOM_DB:join(directory,"stockroom.sqlite")},
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
