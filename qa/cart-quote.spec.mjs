import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";

const staff={Authorization:"Bearer local-test-kitchen"};
test("a receipt estimates its own place in the live queue and hides the estimate when ready",async({page,request})=>{
  async function create(qty,note,table=null){
    const token=randomUUID();
    const response=await request.post("/api/orders",{data:{token,mode:table?"table":"pickup",table,note,items:[{id:"oyakodon",qty}]}});
    expect(response.ok()).toBe(true);
    return {...await response.json(),token};
  }
  async function move(order,from,to){
    const response=await request.patch("/api/kitchen/status",{headers:staff,data:{id:order.id,from,to}});
    expect(response.ok()).toBe(true);
  }
  const earlier=await create(2,"僅廚房可見的前單", "A03");
  const own=await create(1,"");
  const later=await create(8,"僅廚房可見的後單");
  const headers={"X-Ticket":own.token};
  const url="/api/ticket?progress=1&timing=1";
  const read=()=>request.get(url,{headers}).then(response=>response.json());
  expect((await request.get(url)).status()).toBe(404);
  expect((await read()).kitchenQuote).toBeUndefined();
  for(const order of [earlier,own,later])await move(order,"pending","preparing");
  const response=await request.get(url,{headers});
  expect(response.headers()["cache-control"]).toBe("no-store");
  const body=await response.json();
  expect(body.kitchenQuote).toEqual({capturedAt:expect.any(Number),seconds:[480,600]});
  expect(JSON.stringify(body)).not.toContain("僅廚房可見");
  const old=await request.get("/api/ticket?progress=1",{headers}).then(r=>r.json());
  const {kitchenQuote,...legacy}=body;
  expect(legacy).toEqual(old);

  await page.setViewportSize({width:360,height:780});
  await page.goto("/ticket#"+own.token);
  const region=page.getByRole("region",{name:"餐單出餐估算"});
  await expect(region).toContainText("約 8–10 分鐘");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await move(earlier,"preparing","ready");
  await page.getByRole("button",{name:"更新進度"}).click();
  await expect(region).toContainText("約 4–5 分鐘");
  await move(own,"preparing","ready");
  await expect(region).toBeHidden({timeout:8000});
  await expect(page.getByText("出示取餐 QR 碼",{exact:true})).toBeVisible();
  const ready=await read();
  expect(ready.status).toBe("ready");
  expect(ready.kitchenQuote).toBeUndefined();
  await move(own,"ready","completed");
  await move(earlier,"ready","completed");
  await move(later,"preparing","ready");
  await move(later,"ready","completed");
});

test("cart reads the live kitchen, ignores unaccepted payments and releases finished work",async({page,request})=>{
  const create=async(items,paymentMethod="cash")=>{
    const r=await request.post("/api/orders",{data:{token:randomUUID(),mode:"pickup",note:"廚房備註",items,paymentMethod}});
    expect(r.status()).toBe(200);return (await r.json()).id;
  };
  const transition=async(id,from,to,expected=200)=>{
    const r=await request.patch("/api/kitchen/status",{headers:staff,data:{id,from,to}});expect(r.status()).toBe(expected);
  };
  const one=await create([{id:"oyakodon",qty:3},{id:"sencha",qty:2}]);
  const two=await create([{id:"karaage",qty:2}]);
  const unpaid=await create([{id:"oyakodon",qty:20}],"px_pay_plus");
  await transition(unpaid,"pending","preparing",409);
  await transition(one,"pending","preparing");await transition(two,"pending","preparing");
  const snapshot=()=>request.get("/api/kitchen",{headers:staff}).then(r=>r.json());
  const before=await snapshot();
  const publicQuote=await request.post("/api/quote",{data:{items:[{id:"oyakodon",qty:1},{id:"sencha",qty:3}]}});
  const body=await publicQuote.json();
  expect(Object.keys(body).sort()).toEqual(["capturedAt","seconds"]);
  expect(body.seconds).toEqual([660,840]);expect(body.capturedAt).toBeGreaterThan(0);
  await page.goto("/");
  await page.getByRole("button",{name:"加入雞肉親子丼",exact:true}).click();
  const region=page.getByRole("region",{name:"預估出餐時間"});
  await expect(region).toContainText("約 11–14 分鐘");
  expect(await snapshot()).toEqual(before);
  await transition(one,"preparing","ready");
  await region.getByRole("button",{name:"重新試算"}).click();
  await expect(region).toContainText("約 4–5 分鐘");
  await transition(one,"ready","completed");await transition(two,"preparing","ready");await transition(two,"ready","completed");
  await transition(unpaid,"pending","cancelled");
});
test("mobile table cart ignores old responses, retries and can still submit during quote failure",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  let firstRoute;
  const firstSeen=new Promise(resolve=>{firstRoute=resolve;});
  let release;
  const hold=new Promise(resolve=>{release=resolve;});
  let finished;
  const staleHandled=new Promise(resolve=>{finished=resolve;});
  let count=0;
  await page.route("**/api/quote",async route=>{
    if(++count===1){
      firstRoute();await hold;
      await route.fulfill({json:{capturedAt:Date.now(),seconds:[6000,6000]}}).catch(()=>{});
      finished();
    }else if(count===2||count===4){
      await route.continue();
    }else{
      await route.fulfill({status:503,json:{error:"暫時無法試算"}});
    }
  });
  await page.goto("/?table=A03");
  await page.getByRole("button",{name:"加入日式熱煎茶",exact:true}).click();
  await page.getByRole("button",{name:/我的餐單/}).click();
  await firstSeen;
  await page.getByRole("button",{name:"增加日式熱煎茶"}).click();
  const region=page.getByRole("region",{name:"預估出餐時間"});
  await expect(region).toContainText("約 1–2 分鐘");
  release();await staleHandled;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await expect(region).toContainText("約 1–2 分鐘");
  await region.getByRole("button",{name:"重新試算"}).click();
  await expect(region).toContainText("暫時無法試算，可繼續點餐。");
  await region.getByRole("button",{name:"重新試算"}).click();
  await expect(region).toContainText("約 1–2 分鐘");
  await region.getByRole("button",{name:"重新試算"}).click();
  await expect(region).toContainText("暫時無法試算，可繼續點餐。");
  await page.getByRole("button",{name:"確認送出訂單"}).click();
  await expect(page.getByRole("heading",{name:/取餐號碼/})).toBeVisible();
});
test("sold-out and malformed carts get no quote",async({request})=>{
  const quote=items=>request.post("/api/quote",{data:{items}});
  for(const items of [[],[{id:"sencha",qty:0}],[{id:"sencha",qty:21}],[{id:"no-menu-item",qty:1}],[{id:"sencha",qty:1},{id:"sencha",qty:2}]]){
    expect((await quote(items)).status()).toBe(400);
  }
  const stock=available=>request.patch("/api/kitchen/availability",{headers:staff,data:{id:"gyoza",available}});
  await stock(false);
  try{expect((await quote([{id:"gyoza",qty:1}])).status()).toBe(409);}
  finally{await stock(true);}
  expect((await quote([{id:"gyoza",qty:1}])).status()).toBe(200);
});
