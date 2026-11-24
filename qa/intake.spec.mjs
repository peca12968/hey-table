import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";

const staff={Authorization:"Bearer local-test-kitchen"};
const config="/api/kitchen/intake";
const patch=(request,mode,accepting,revision)=>request.patch(config,{headers:staff,data:{mode,accepting,revision}});
async function read(request){
  const response=await request.get(config,{headers:staff});
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function ensureOpen(request,mode){
  const {accepting,revision}=(await read(request))[mode];
  if(!accepting)expect((await patch(request,mode,true,revision)).ok()).toBeTruthy();
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
