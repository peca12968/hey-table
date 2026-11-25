import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {businessDate} from "../lib/business-day.mjs";

const staff={Authorization:"Bearer local-test-kitchen"};
const config="/api/kitchen/intake";
const patch=(request,mode,accepting,revision)=>request.patch(config,{headers:staff,data:{mode,accepting,revision}});
const patchTable=(request,table,accepting,revision)=>request.patch(config,{headers:staff,data:{table,accepting,revision}});
async function read(request){
  const response=await request.get(config,{headers:staff});
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function ensureOpen(request,mode){
  const {accepting,revision}=(await read(request))[mode];
  if(!accepting)expect((await patch(request,mode,true,revision)).ok()).toBeTruthy();
}
async function ensureOpenTable(request,table){
  const {accepting,revision}=(await read(request)).tables[table];
  if(!accepting)expect((await patchTable(request,table,true,revision)).ok()).toBeTruthy();
}
const order=(mode,fields={})=>({token:randomUUID(),mode,table:mode==="table"?"A03":null,
  note:"",items:[{id:"katsudon",qty:1}],...fields});

test("daily portions serialize the last serving across pickup and tables and release it on cancellation",async({page,browser,request})=>{
  const date=businessDate(Date.now()),tomorrow=businessDate(Date.now()+86400000),dish="gyoza";
  const endpoint="/api/kitchen/daily-limits";
  const settings=async day=>(await request.get(endpoint+"?date="+day,{headers:staff})).json();
  const save=(day,capacity,revision)=>request.patch(endpoint,{headers:staff,data:{date:day,dish,capacity,revision}});
  const menu=async()=>(await request.get("/api/menu")).json();
  const post=data=>request.post("/api/orders",{data});
  const cancel=id=>request.patch("/api/kitchen/status",{headers:staff,data:{id,from:"pending",to:"cancelled"}});
  expect((await request.get(endpoint+"?date="+date)).status()).toBe(403);
  expect((await request.get(endpoint+"?date=2026-02-30",{headers:staff})).status()).toBe(400);
  expect((await save(tomorrow,0,0)).ok()).toBe(true);
  expect((await menu()).remaining?.[dish]).toBeUndefined();
  const initial=(await settings(date)).limits[dish],one=initial.used+1;

  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen");
  await page.getByRole("link",{name:"每日限量供應"}).click();
  const card=page.getByRole("article",{name:"海苔柴魚煎餃"});
  await card.getByLabel("供應上限").fill(String(one));
  await card.getByRole("button",{name:"儲存上限"}).click();
  await expect(card.getByText("已占用 "+initial.used+" 份 · 剩餘 1 份")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  expect((await save(date,one+1,initial.revision)).status()).toBe(409);
  const guest=await browser.newContext({viewport:{width:360,height:780}});
  try{
    const mobile=await guest.newPage();
    await mobile.goto("/");
    const available=mobile.locator(".dish").filter({has:mobile.getByRole("heading",{name:"海苔柴魚煎餃"})});
    await expect(available.getByText("今日剩餘 1 份")).toBeVisible();
    await available.getByRole("button",{name:"加入海苔柴魚煎餃"}).click();
    await mobile.getByRole("button",{name:/我的餐單/}).click();
    await expect(mobile.getByRole("button",{name:"增加海苔柴魚煎餃"})).toBeDisabled();
    const [pickup,table]=["pickup","table"].map(mode=>order(mode,{items:[{id:dish,qty:1}]}));
    const attempted=await Promise.all([post(pickup),post(table)]);
    expect(attempted.map(response=>response.status()).sort()).toEqual([200,409]);
    const accepted=attempted.findIndex(response=>response.ok());
    const winner=await attempted[accepted].json(),loser=[pickup,table][1-accepted];
    expect((await attempted[1-accepted].json()).code).toBe("portion_limit");
    expect(await (await post([pickup,table][accepted])).json()).toEqual(winner);
    expect((await menu()).remaining[dish]).toBe(0);
    expect((await request.post("/api/quote",{data:{items:[{id:dish,qty:1}]}})).status()).toBe(409);
    await mobile.evaluate(()=>window.dispatchEvent(new Event("online")));
    await expect(mobile.getByText("部分餐點已超過今日剩餘份數，請調整餐單。")).toBeVisible();
    await expect(mobile.getByRole("button",{name:"確認送出訂單"})).toBeDisabled();
    expect((await cancel(winner.id)).ok()).toBe(true);
    const released=await post(loser);
    expect(released.status()).toBe(200);
    expect((await cancel((await released.json()).id)).ok()).toBe(true);
    const {revision}= (await settings(date)).limits[dish];
    const concurrent=await Promise.all([save(date,null,revision),save(date,one+2,revision)]);
    expect(concurrent.map(result=>result.status()).sort()).toEqual([200,409]);
    const current=(await settings(date)).limits[dish];
    if(current.capacity!==null)expect((await save(date,null,current.revision)).ok()).toBe(true);
    expect((await menu()).remaining?.[dish]).toBeUndefined();
  }finally{
    await save(tomorrow,null,1);
    await guest.close();
  }
});

test("mobile restocking resumes a lost reply and preserves newer supply revisions",async({page,request})=>{
  const date=businessDate(Date.now()),dish="gyoza",endpoint="/api/kitchen/daily-limits";
  const settings=async()=>(await (await request.get(endpoint+"?date="+date,{headers:staff})).json()).limits[dish];
  const save=(capacity,revision)=>request.patch(endpoint,{headers:staff,data:{date,dish,capacity,revision}});
  const refill=(quantity,revision,operationId=randomUUID())=>request.post(endpoint+"/restock",{
    headers:staff,data:{date,dish,quantity,revision,operationId},
  });
  const sale=await request.post("/api/orders",{data:order("pickup",{items:[{id:dish,qty:1}]})});
  expect(sale.ok(),await sale.text()).toBe(true);
  const {id}=await sale.json();
  try{
    const before=await settings();
    expect(before.used).toBeGreaterThanOrEqual(1);
    const paused=await save(0,before.revision);
    expect(paused.ok()).toBe(true);
    const revision=(await paused.json()).revision;
    expect((await request.post(endpoint+"/restock",{data:{date,dish,quantity:2,revision,operationId:randomUUID()}})).status()).toBe(403);
    expect((await refill(0,revision)).status()).toBe(400);
    expect((await refill(Number.MAX_SAFE_INTEGER,revision)).status()).toBe(409);

    await page.setViewportSize({width:360,height:780});
    await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    const sent=[];
    let first;
    await page.route("**"+endpoint+"/restock",async route=>{
      if(route.request().method()!=="POST")return route.continue();
      sent.push(route.request().postDataJSON());
      if(sent.length!==1)return route.continue();
      const response=await route.fetch();
      expect(response.status(),await response.text()).toBe(200);
      first=await response.json();
      await route.abort("failed");
    });
    await page.goto("/kitchen/daily-limits");
    const card=page.getByRole("article",{name:"海苔柴魚煎餃"});
    await card.getByText("補貨增加可售份數",{exact:true}).click();
    await card.getByLabel("補貨份數").fill("2");
    await card.getByRole("button",{name:"確認補貨"}).click();
    await expect(page.getByRole("alert")).toContainText("尚未收到補貨結果");
    expect(first).toMatchObject({date,dish,quantity:2,previousCapacity:0,used:before.used,capacity:before.used+2,revision:revision+1});
    expect((await (await request.get("/api/menu")).json()).remaining[dish]).toBe(2);

    const competing=await Promise.all([refill(1,first.revision),refill(1,first.revision)]);
    expect(competing.map(result=>result.status()).sort()).toEqual([200,409]);
    const latest=await settings();
    expect(latest).toEqual({capacity:before.used+3,used:before.used,revision:revision+2});
    expect((await refill(3,revision,sent[0].operationId)).status()).toBe(409);

    await page.reload();
    await expect(card.getByLabel("補貨份數")).toBeDisabled();
    await card.getByRole("button",{name:"重試補貨"}).click();
    await expect(page.getByText(/補貨 2 份。/)).toBeVisible();
    expect(sent[1]).toEqual(sent[0]);
    await expect(card.getByText("已占用 "+before.used+" 份 · 剩餘 3 份")).toBeVisible();
    expect(await settings()).toEqual(latest);
    expect((await save(null,latest.revision)).ok()).toBe(true);
    await page.reload();
    await expect(card.getByText("已占用 "+before.used+" 份 · 剩餘 不限量")).toBeVisible();
    await card.getByText("查看供應變更紀錄",{exact:true}).click();
    const region=card.getByRole("region",{name:"海苔柴魚煎餃供應變更紀錄"});
    const records=region.getByRole("listitem");
    await expect(records.first()).toContainText("手動儲存");
    await expect(records.first()).toContainText("供應上限 "+latest.capacity+" → 不限量");
    await expect(records.nth(2)).toContainText("補貨 2 份");
    const historyResponse=page.waitForResponse(response=>{
      const url=new URL(response.url());
      return url.pathname===endpoint+"/restock"&&response.request().method()==="GET"&&url.searchParams.get("dish")===dish;
    });
    await region.getByLabel("紀錄範圍").selectOption("restock");
    const history=await (await historyResponse).json();
    expect(history.records.map(record=>record.revision)).toEqual([first.revision+1,first.revision]);
    expect(history.records[1]).toEqual(first);
    expect(history.nextBefore).toBeNull();
    await expect(records).toHaveCount(2);
    await expect(records.last()).toContainText("補貨 2 份");
    await expect(records.last()).toContainText("供應上限 0 → "+first.capacity+" · 當時已占用 "+before.used+" 份");
    const [file]=await Promise.all([page.waitForEvent("download"),region.getByRole("button",{name:"下載這頁 JSON"}).click()]);
    expect(file.suggestedFilename()).toMatch(/^hey-table-restock-/);
    expect(JSON.parse(await readFile(await file.path(),"utf8"))).toEqual(history);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  }finally{
    const current=await settings();
    if(current.capacity!==null)await save(null,current.revision);
    await request.patch("/api/kitchen/status",{headers:staff,data:{id,from:"pending",to:"cancelled"}});
  }
});

test("staff copy selected daily caps together and a stale source or destination never leaves a partial copy",async({page,request})=>{
  const sourceDate="2001-03-07",date="2001-03-08",endpoint="/api/kitchen/daily-limits";
  const read=async day=>(await (await request.get(endpoint+"?date="+day,{headers:staff})).json()).limits;
  const set=(day,dish,capacity,revision)=>request.patch(endpoint,{headers:staff,data:{date:day,dish,capacity,revision}});
  for(const [day,caps] of [[sourceDate,{gyoza:12,sencha:0,edamame:8}],[date,{gyoza:3,sencha:5,edamame:2}]]){
    const before=await read(day);
    for(const [dish,capacity] of Object.entries(caps))expect((await set(day,dish,capacity,before[dish].revision)).ok()).toBe(true);
  }
  const initial=await read(date);
  const source=await read(sourceDate);
  const selected=[{dish:"gyoza",sourceRevision:source.gyoza.revision,targetRevision:initial.gyoza.revision}];
  const send=(payload,headers=staff)=>request.post(endpoint+"/copy",{headers,data:payload});
  expect((await send({sourceDate,date,items:selected},{})).status()).toBe(403);
  for(const invalid of [{sourceDate:date,date,items:selected},{sourceDate,date,items:[]},
    {sourceDate,date,items:[selected[0],selected[0]]},{sourceDate,date,items:[{...selected[0],targetRevision:-1}]}]){
    expect((await send(invalid)).status()).toBe(400);
  }

  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen/daily-limits");
  await page.getByLabel("供應日期").fill(date);
  await page.getByText("從其他日期複製上限",{exact:true}).click();
  await page.getByLabel("來源日期").fill(sourceDate);
  const readSource=page.getByRole("button",{name:"讀取來源設定"});
  const compare=page.getByRole("region",{name:"複製上限比較"});
  const confirm=compare.getByRole("button",{name:"套用已選上限"});
  const gyoza=compare.getByRole("checkbox",{name:/海苔柴魚煎餃/});
  const tea=compare.getByRole("checkbox",{name:/日式熱煎茶/});
  const beans=compare.getByRole("checkbox",{name:/鹽味毛豆/});
  await readSource.click();
  await expect(gyoza).toHaveAccessibleName(/目的上限 3 份 → 12 份/);
  await expect(confirm).toBeDisabled();
  await gyoza.check();
  await tea.check();
  expect((await set(sourceDate,"sencha",7,source.sencha.revision)).ok()).toBe(true);
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText("這次沒有套用任何品項");
  expect(await read(date)).toEqual(initial);

  await readSource.click();
  await expect(tea).toHaveAccessibleName(/目的上限 5 份 → 7 份/);
  await compare.getByRole("button",{name:"選取全部差異"}).click();
  await beans.uncheck();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await confirm.click();
  await expect(page.getByText("已複製 2 個品項上限。")).toBeVisible();
  const copied=await read(date);
  expect(copied.gyoza).toEqual({...initial.gyoza,capacity:12,revision:initial.gyoza.revision+1});
  expect(copied.sencha).toEqual({...initial.sencha,capacity:7,revision:initial.sencha.revision+1});
  expect(copied.edamame).toEqual(initial.edamame);
  const latestSource=await read(sourceDate);
  expect((await set(sourceDate,"gyoza",18,latestSource.gyoza.revision)).ok()).toBe(true);
  const items=[{dish:"gyoza",sourceRevision:latestSource.gyoza.revision+1,targetRevision:copied.gyoza.revision},
    {dish:"edamame",sourceRevision:latestSource.edamame.revision,targetRevision:copied.edamame.revision}];
  const [copy,manual]=await Promise.all([send({sourceDate,date,items}),set(date,"gyoza",20,copied.gyoza.revision)]);
  expect([copy.status(),manual.status()].sort()).toEqual([200,409]);
  const finished=await read(date);
  expect(finished.gyoza.capacity).toBe(copy.ok()?18:20);
  expect(finished.edamame.capacity).toBe(copy.ok()?8:2);
  expect((await read(sourceDate)).edamame.capacity).toBe(8);
  const history=async dish=>(await (await request.get(endpoint+"/history?date="+date+"&dish="+dish,{headers:staff})).json()).records;
  expect((await history("gyoza")).map(({kind,previousCapacity,capacity,sourceDate:from})=>[kind,previousCapacity,capacity,from]))
    .toEqual([[copy.ok()?"copy":"manual",12,copy.ok()?18:20,copy.ok()?sourceDate:null],
      ["copy",3,12,sourceDate],["manual",null,3,null]]);
  expect((await history("edamame")).map(({kind,capacity})=>[kind,capacity]))
    .toEqual(copy.ok()?[["copy",8],["manual",2]]:[["manual",2]]);
});

test("mobile guest keeps a draft through a pause and a second staff browser needs a fresh revision",async({browser,context,page,request})=>{
  const guest=await browser.newContext({viewport:{width:390,height:844}});
  try{
    await context.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    const colleague=await context.newPage();
    for(const view of [page,colleague]){
      await view.goto("/kitchen");
      await view.getByRole("button",{name:"管理接單管道"}).click();
      await expect(view.getByRole("button",{name:"暫停掃碼內用"})).toBeEnabled();
    }
    const mobile=await guest.newPage();
    let previousMenu,postSeen=false;
    await mobile.route("**/api/menu",async route=>{
      if(previousMenu&&!postSeen)return route.fulfill({json:previousMenu});
      const response=await route.fetch();
      previousMenu=await response.json();
      return route.fulfill({response,json:previousMenu});
    });
    await mobile.route("**/api/orders",route=>{postSeen=true;return route.continue();});
    await mobile.goto("/?table=A03");
    await mobile.getByRole("button",{name:"加入滑蛋豬排丼",exact:true}).click();
    await mobile.getByRole("button",{name:/我的餐單/}).click();
    await mobile.getByRole("textbox").fill("恢復後再送出");
    await expect(mobile.getByRole("button",{name:"確認送出訂單"})).toBeEnabled();

    await page.getByRole("button",{name:"暫停掃碼內用"}).click();
    await expect(page.getByRole("button",{name:"恢復掃碼內用"})).toBeEnabled();
    await expect(page.getByRole("button",{name:"暫停線上自取"})).toBeEnabled();
    await colleague.getByRole("button",{name:"暫停掃碼內用"}).click();
    await expect(colleague.getByRole("alert").filter({hasText:"接單設定已由其他店員更新"})).toBeVisible();
    await colleague.getByRole("button",{name:"載入最新接單設定"}).click();
    await expect(colleague.getByRole("button",{name:"恢復掃碼內用"})).toBeEnabled();

    const rejected=mobile.waitForResponse(response=>response.url().endsWith("/api/orders"));
    await mobile.getByRole("button",{name:"確認送出訂單"}).click();
    const blocked=await rejected;
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toMatchObject({code:"intake_paused"});
    await expect(mobile.getByRole("button",{name:"暫停接單",exact:true})).toBeDisabled();
    await expect(mobile.getByText("餐單已保留，恢復接單後可再送出。")).toBeVisible();
    await expect(mobile.getByRole("textbox")).toHaveValue("恢復後再送出");
    await expect(mobile.getByRole("textbox")).toBeEditable();
    const fresh=await guest.newPage();
    await fresh.goto("/?table=A07");
    await expect(fresh.getByText(/掃碼內用暫停接單/)).toBeVisible();
    expect(await (await request.get("/api/menu")).json()).toMatchObject({accepting:{table:false,pickup:true}});

    await colleague.getByRole("button",{name:"恢復掃碼內用"}).click();
    await expect(colleague.getByRole("button",{name:"暫停掃碼內用"})).toBeEnabled();
    await mobile.evaluate(()=>window.dispatchEvent(new Event("online")));
    await mobile.getByRole("button",{name:"確認送出訂單"}).click();
    await expect(mobile.getByRole("heading",{name:/取餐號碼/})).toBeVisible();
    await expect(mobile.getByText("A03 桌內用",{exact:true})).toBeVisible();
    await expect(mobile.getByText(/恢復後再送出/)).toBeVisible();
  }finally{
    await ensureOpen(request,"table");
    await guest.close();
  }
});

test("D1 orders racing with a pickup pause are atomic and earlier receipts can still pay and prepare",async({request})=>{
  expect((await request.get(config)).status()).toBe(403);
  expect((await request.patch(config,{data:{mode:"pickup",accepting:false,revision:0}})).status()).toBe(403);
  const previous=order("pickup",{paymentMethod:"line_pay"});
  const post=data=>request.post("/api/orders",{data});
  const old=await post(previous);
  expect(old.ok()).toBeTruthy();
  const saved=await old.json();
  const ticket=token=>request.get("/api/ticket",{headers:{"X-Ticket":token}});
  const revision=(await read(request)).pickup.revision;
  const attempts=Array.from({length:8},()=>order("pickup"));
  try{
    const [paused,...outcomes]=await Promise.all([patch(request,"pickup",false,revision),...attempts.map(post)]);
    expect(paused.ok()).toBeTruthy();
    const denied=order("pickup");
    expect(await (await post(denied)).json()).toMatchObject({code:"intake_paused"});
    expect((await ticket(denied.token)).status()).toBe(404);
    expect((await post(order("table"))).ok()).toBeTruthy();
    for (const [index,response] of outcomes.entries()){
      const data=attempts[index],receipt=await ticket(data.token);
      if(response.status()===200){
        const accepted=await response.json();
        expect(await receipt.json()).toEqual(accepted);
        expect(await (await post(data)).json()).toEqual(accepted);
      }else{
        expect(response.status()).toBe(409);
        expect(await response.json()).toMatchObject({code:"intake_paused"});
        expect(receipt.status()).toBe(404);
      }
    }
    expect(await (await post(previous)).json()).toEqual(saved);
    expect((await post({...previous,note:"不同的內容"})).status()).toBe(409);
    const headers={"X-Ticket":previous.token};
    const {attempt}=await (await request.post("/api/payments/start",{headers,data:{}})).json();
    expect((await request.post("/api/payments/demo",{headers,data:{ref:attempt.ref,outcome:"paid"}})).ok()).toBeTruthy();
    expect((await request.patch("/api/kitchen/status",{headers:staff,data:{id:saved.id,from:"pending",to:"preparing"}})).ok()).toBeTruthy();
    expect(await (await ticket(previous.token)).json()).toMatchObject({paymentState:"paid",status:"preparing"});
    expect((await patch(request,"pickup",true,revision)).status()).toBe(409);
    expect((await patch(request,"pickup",true,revision+1)).ok()).toBeTruthy();
    expect((await post(denied)).ok()).toBeTruthy();
    const contenders=await Promise.all([patch(request,"pickup",true,revision+2),patch(request,"pickup",false,revision+2)]);
    expect(contenders.map(response=>response.status()).sort()).toEqual([200,409]);
    const winner=await contenders.find(response=>response.ok()).json();
    expect((await read(request)).pickup).toEqual({accepting:winner.accepting,revision:revision+3});
  }finally{
    await ensureOpen(request,"pickup");
  }
});

test("a paused table keeps a mobile cart while another table and pickup can submit",async({browser,context,page,request})=>{
  const guest=await browser.newContext({viewport:{width:390,height:844}});
  try{
    await context.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    const colleague=await context.newPage();
    for(const view of [page,colleague]){
      await view.goto("/kitchen");
      await view.getByRole("button",{name:"管理接單管道"}).click();
      await view.getByLabel("單桌接單設定").selectOption("A03");
      await expect(view.getByRole("button",{name:"暫停A03 桌"})).toBeEnabled();
    }
    const mobile=await guest.newPage();
    let oldMenu,submitting=false;
    await mobile.route("**/api/menu",async route=>{
      if(oldMenu&&!submitting)return route.fulfill({json:oldMenu});
      const response=await route.fetch();
      oldMenu=await response.json();
      return route.fulfill({response,json:oldMenu});
    });
    await mobile.route("**/api/orders",route=>{submitting=true;return route.continue();});
    await mobile.goto("/?table=A03");
    await mobile.getByRole("button",{name:"加入日式熱煎茶",exact:true}).click();
    await mobile.getByRole("button",{name:/我的餐單/}).click();
    await mobile.getByRole("textbox").fill("單桌恢復後再送");
    await mobile.getByLabel("付款方式").selectOption("line_pay");

    await page.getByRole("button",{name:"暫停A03 桌"}).click();
    await expect(page.getByRole("button",{name:"恢復A03 桌"})).toBeEnabled();
    await colleague.getByRole("button",{name:"暫停A03 桌"}).click();
    await expect(colleague.getByRole("alert").filter({hasText:"接單設定已由其他店員更新"})).toBeVisible();
    await colleague.getByRole("button",{name:"載入最新接單設定"}).click();
    await expect(colleague.getByRole("button",{name:"恢復A03 桌"})).toBeEnabled();

    const denied=mobile.waitForResponse(response=>response.url().endsWith("/api/orders"));
    await mobile.getByRole("button",{name:"確認送出訂單"}).click();
    const blocked=await denied;
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toMatchObject({code:"table_paused"});
    await expect(mobile.getByText(/A03 桌暫停接單/)).toBeVisible();
    await expect(mobile.getByRole("button",{name:"暫停接單",exact:true})).toBeDisabled();
    await expect(mobile.getByRole("textbox")).toHaveValue("單桌恢復後再送");
    await expect(mobile.getByLabel("付款方式")).toHaveValue("line_pay");
    const menu=await (await request.get("/api/menu")).json();
    expect(menu).toMatchObject({accepting:{table:true,pickup:true},acceptingTables:{A03:false,A04:true}});
    for(const data of [order("table",{table:"A04"}),order("pickup")]){
      const response=await request.post("/api/orders",{data});
      expect(response.ok()).toBeTruthy();
      expect(await response.json()).toMatchObject({mode:data.mode,table:data.table});
    }

    await colleague.getByRole("button",{name:"恢復A03 桌"}).click();
    await expect(colleague.getByRole("button",{name:"暫停A03 桌"})).toBeEnabled();
    await mobile.evaluate(()=>window.dispatchEvent(new Event("online")));
    await mobile.getByRole("button",{name:"確認送出訂單"}).click();
    await expect(mobile.getByRole("heading",{name:/取餐號碼/})).toBeVisible();
    await expect(mobile.getByText("A03 桌內用",{exact:true})).toBeVisible();
    await expect(mobile.getByText(/單桌恢復後再送/)).toBeVisible();
    await expect(mobile.getByRole("button",{name:"開始模擬付款"})).toBeVisible();
  }finally{
    await ensureOpenTable(request,"A03");
    await guest.close();
  }
});

test("table controls use staff authorization, atomic writes and both levels of intake",async({request})=>{
  const target="A06";
  const dataForTable=()=>order("table",{table:target,paymentMethod:"line_pay"});
  const post=data=>request.post("/api/orders",{data});
  const ticket=token=>request.get("/api/ticket",{headers:{"X-Ticket":token}});
  expect((await request.patch(config,{data:{table:target,accepting:false,revision:0}})).status()).toBe(403);
  expect((await patchTable(request,"A99",false,0)).status()).toBe(400);
  expect((await request.patch(config,{headers:staff,data:{mode:"pickup",table:target,accepting:false,revision:0}})).status()).toBe(400);
  const before=await read(request);
  expect(before.tables[target]).toEqual({accepting:true,revision:0});
  const previous=dataForTable();
  const response=await post(previous);
  expect(response.ok()).toBeTruthy();
  const saved=await response.json();
  const pending=Array.from({length:6},dataForTable);
  try{
    const [closed,...outcomes]=await Promise.all([patchTable(request,target,false,0),...pending.map(post)]);
    expect(await closed.json()).toEqual({table:target,accepting:false,revision:1});
    for(const [index,outcome] of outcomes.entries()){
      const receipt=await ticket(pending[index].token);
      if(outcome.ok())expect(await receipt.json()).toEqual(await outcome.json());
      else{
        expect(outcome.status()).toBe(409);
        expect(await outcome.json()).toMatchObject({code:"table_paused"});
        expect(receipt.status()).toBe(404);
      }
    }
    const retry=dataForTable();
    const blocked=await post(retry);
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toMatchObject({code:"table_paused"});
    expect((await ticket(retry.token)).status()).toBe(404);
    expect(await (await post(previous)).json()).toEqual(saved);
    const headers={"X-Ticket":previous.token};
    const {attempt}=await (await request.post("/api/payments/start",{headers,data:{}})).json();
    expect((await request.post("/api/payments/demo",{headers,data:{ref:attempt.ref,outcome:"paid"}})).ok()).toBeTruthy();
    const transition=(from,to)=>request.patch("/api/kitchen/status",{headers:staff,data:{id:saved.id,from,to}});
    expect((await transition("pending","preparing")).ok()).toBeTruthy();
    expect((await transition("preparing","ready")).ok()).toBeTruthy();
    expect((await transition("ready","completed")).ok()).toBeTruthy();
    expect(await (await ticket(previous.token)).json()).toMatchObject({paymentState:"paid",status:"completed"});

    const modeClosed=await patch(request,"table",false,before.table.revision);
    expect(modeClosed.ok()).toBeTruthy();
    expect(await (await post(retry)).json()).toMatchObject({code:"intake_paused"});
    expect((await patchTable(request,target,true,1)).ok()).toBeTruthy();
    expect(await (await post(retry)).json()).toMatchObject({code:"intake_paused"});
    await ensureOpen(request,"table");
    const contenders=await Promise.all([patchTable(request,target,true,2),patchTable(request,target,true,2)]);
    expect(contenders.map(result=>result.status()).sort()).toEqual([200,409]);
    expect((await read(request)).tables[target]).toEqual({accepting:true,revision:3});
    expect((await post(retry)).ok()).toBeTruthy();
  }finally{
    await ensureOpen(request,"table");
    await ensureOpenTable(request,target);
  }
});
