import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";

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
