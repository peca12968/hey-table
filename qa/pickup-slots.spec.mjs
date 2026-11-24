import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {businessDate} from "../lib/business-day.mjs";
import {pickupCalendar} from "../server/pickup-calendar.mjs";

test("mobile guest books a future day despite today's sellout and moves the receipt and kitchen prep to another date",async({page,request})=>{
  page.setDefaultTimeout(8000);
  const now=Date.now(),oneDay=86_400_000;
  const today=businessDate(now),tomorrow=businessDate(now+oneDay),later=businessDate(now+2*oneDay);
  const endpoint="/api/kitchen/daily-limits",staff={Authorization:"Bearer local-test-kitchen"},dish="sencha";
  const remaining=async date=>(await (await request.get(endpoint+"?date="+date,{headers:staff})).json()).limits[dish];
  const save=async(date,capacity)=>{
    const {revision}=await remaining(date);
    return request.patch(endpoint,{headers:staff,data:{date,dish,capacity,revision}});
  };
  const current=await remaining(today),tomorrowSupply=await remaining(tomorrow),laterSupply=await remaining(later);
  let token;
  try{
    expect((await save(today,current.used)).ok()).toBe(true);
    expect((await save(tomorrow,tomorrowSupply.used+1)).ok()).toBe(true);
    expect((await save(later,laterSupply.used+1)).ok()).toBe(true);
    await page.setViewportSize({width:360,height:780});
    await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    await page.goto("/");
    const add=page.getByRole("button",{name:"加入日式熱煎茶"});
    await expect(add).toHaveCount(0);
    await page.getByLabel("取餐日期",{exact:true}).selectOption(tomorrow);
    await expect(add).toBeEnabled();
    await expect(page.getByText("取餐日剩餘 1 份")).toBeVisible();
    await add.click();
    await page.getByRole("button",{name:/我的餐單/}).click();
    const submit=page.getByRole("button",{name:"確認送出訂單"});
    await expect(submit).toBeDisabled();
    const noon=Date.parse(tomorrow+"T12:00:00+08:00"),next=Date.parse(later+"T12:00:00+08:00");
    await page.getByLabel("自取時段").selectOption(String(noon));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    await submit.click();
    await page.waitForURL("**/ticket#*");
    token=new URL(page.url()).hash.slice(1);
    const lookup=async()=>(await (await request.get("/api/ticket?progress=1",{headers:{"X-Ticket":token}})).json());
    const accepted=await lookup();
    const prep=async(date="")=>(await (await request.get("/api/kitchen/prep"+(date?"?date="+date:""),{headers:staff})).json()).orders.map(order=>order.id);
    expect(accepted.pickupSlot).toBe(noon);
    expect(await prep()).not.toContain(accepted.id);
    expect(await prep(tomorrow)).toContain(accepted.id);
    await page.getByRole("button",{name:"更改取餐時段"}).click();
    await expect(page.getByLabel("新的取餐日期")).toHaveValue(tomorrow);
    await page.getByLabel("新的取餐日期").selectOption(later);
    await page.getByLabel("新的取餐時段").selectOption(String(next));
    await page.getByRole("button",{name:"確認改期"}).click();
    await expect(page.locator(".pickupSlotTime time")).toHaveAttribute("datetime",new Date(next).toISOString());
    await expect(page.getByText(/取餐時段已從.*12:00～12:15.*改到.*12:00～12:15/)).toBeVisible();
    expect((await lookup()).id).toBe(accepted.id);
    expect(await prep(tomorrow)).not.toContain(accepted.id);
    expect(await prep(later)).toContain(accepted.id);
    await page.goto("/kitchen/prep");
    await page.getByLabel("備料日期").selectOption(later);
    await expect(page.getByText("備料日期 "+later,{exact:true})).toBeVisible();
    await expect(page.getByRole("rowheader",{name:"日式熱煎茶"})).toBeVisible();
  }finally{
    if(token)await request.post("/api/ticket/cancel",{headers:{"X-Ticket":token},data:{}});
    await save(today,current.capacity);
    await save(tomorrow,tomorrowSupply.capacity);
    await save(later,laterSupply.capacity);
  }
});

test("mobile guests recover a full pickup slot and the kitchen sees when preparation can start",async({page})=>{
  const start=Date.parse("2026-11-25T12:00:00+08:00"),duration=900_000;
  const next=start+duration;
  let filled=false,firstToken,order,upcoming=true;
  const item={id:"sencha",name:"日式熱煎茶",price:45,qty:1};
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.route("**/api/pickup-slots",route=>route.fulfill({json:{slots:[
    {start,end:next,remaining:filled?0:1},{start:next,end:next+duration,remaining:12},
  ]}}));
  await page.route("**/api/orders",route=>{
    const payload=route.request().postDataJSON();
    expect(payload.items).toEqual([{id:"sencha",qty:1}]);
    expect(payload.note).toBe("放櫃台取餐");
    if(!filled){
      expect(payload.pickupSlot).toBe(start);
      firstToken=payload.token;
      filled=true;
      return route.fulfill({status:409,json:{code:"pickup_slot_full",error:"此時段剩餘份數不足，請改選時段或調整餐點。"}});
    }
    expect(payload.pickupSlot).toBe(next);
    expect(payload.token).not.toBe(firstToken);
    order={id:230,mode:"pickup",table:null,pickupSlot:next,note:payload.note,items:[item],status:"pending",
      created:start-3_600_000,paymentMethod:"cash",paymentEnv:"cash",paymentState:"unpaid",total:45};
    return route.fulfill({json:order});
  });
  await page.route(url=>url.pathname==="/api/ticket",route=>route.fulfill({json:order}));
  await page.route("**/api/kitchen",route=>{
    const {pickupSlot,...immediate}=order;
    return route.fulfill({json:[{...immediate,id:232},{...order,id:231,pickupSlot:pickupSlot+duration,pickupUpcoming:true},
      {...order,...(upcoming?{pickupUpcoming:true}:{})}]});
  });
  await page.goto("/");
  await page.getByRole("button",{name:"加入日式熱煎茶"}).click();
  const cart=page.getByRole("button",{name:/我的餐單/});
  await cart.click();
  await page.getByLabel(/訂單備註/).fill("放櫃台取餐");
  await page.getByRole("button",{name:"預約取餐時段"}).click();
  const chooser=page.getByLabel("自取時段");
  await expect(chooser.getByRole("option",{name:"12:00～12:15 · 剩 1 份"})).toHaveCount(1);
  await chooser.selectOption(String(start));
  await page.reload();
  await cart.click();
  await expect(chooser).toHaveValue(String(start));
  await page.getByRole("button",{name:"確認送出訂單"}).click();
  await expect(page.getByRole("alert")).toHaveText("此時段剩餘份數不足，請改選時段或調整餐點。");
  await expect(page.getByText("請重新選擇可容納這張餐單的時段。")).toBeVisible();
  await expect(page.getByLabel(/訂單備註/)).toHaveValue("放櫃台取餐");
  await chooser.selectOption(String(next));
  await expect(chooser.getByRole("option",{name:"12:00～12:15 · 剩 0 份"})).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await page.getByRole("button",{name:"確認送出訂單"}).click();
  await expect(page.locator(".pickupSlotTime")).toContainText("12:15～12:30");
  await expect(page.getByText("已保留取餐時段，店家會在接近取餐時間時準備。")).toBeVisible();

  await page.goto("/kitchen");
  await page.getByRole("button",{name:"預約自取",exact:true}).click();
  const cards=page.locator(".kitchenTicket");
  await expect(cards.getByRole("heading")).toHaveText(["#0230","#0231"]);
  await expect(cards.first().getByText("12:00 後可接單製作。")).toBeVisible();
  await expect(cards.first().getByRole("button",{name:"接單製作"})).toBeDisabled();
  upcoming=false;
  await page.getByRole("button",{name:"更新",exact:true}).click();
  await expect(cards.first().getByRole("button",{name:"接單製作"})).toBeEnabled();
  await expect(cards.last().getByRole("button",{name:"接單製作"})).toBeDisabled();
});

test("a mobile receipt preserves its booking across a full slot and retries one uncertain change",async({page})=>{
  const first=Date.parse("2026-11-25T12:00:00+08:00"),interval=900_000;
  const offered=first+interval,next=offered+interval,token=randomUUID();
  const base={id:231,mode:"pickup",table:null,pickupSlot:first,pickupChanges:[],canReschedulePickup:true,
    note:"",items:[{id:"sencha",name:"日式熱煎茶",price:45,qty:2}],status:"pending",
    created:first-3_600_000,paymentMethod:"cash",paymentEnv:"cash",paymentState:"unpaid",total:90};
  let full=false,attempt,readBack=false;
  const moved={...base,pickupSlot:next,pickupChanges:[{from:first,to:next,at:first-3_500_000}]};
  await page.setViewportSize({width:360,height:780});
  await page.route(url=>url.pathname==="/api/ticket",route=>route.fulfill({json:readBack?moved:base}));
  await page.route("**/api/pickup-slots",route=>route.fulfill({json:{slots:[
    {start:first,end:offered,remaining:10},{start:offered,end:next,remaining:full?0:2},{start:next,end:next+interval,remaining:12},
  ]}}));
  await page.route("**/api/ticket/reschedule",route=>{
    const data=route.request().postDataJSON();
    expect(route.request().headers()["x-ticket"]).toBe(token);
    if(!full){
      expect(data).toEqual({from:first,to:offered,revision:0});
      full=true;
      return route.fulfill({status:409,json:{code:"pickup_slot_full",error:"此時段剩餘份數不足，原預約仍有效。"}});
    }
    if(!attempt){
      expect(data).toEqual({from:first,to:next,revision:0});
      attempt=data;
      return route.abort("connectionreset");
    }
    expect(data).toEqual(attempt);
    readBack=true;
    return route.fulfill({json:{pickupSlot:next,pickupChanges:moved.pickupChanges,canReschedulePickup:true}});
  });
  await page.goto("/ticket#"+token);
  await page.getByRole("button",{name:"更改取餐時段"}).click();
  const selector=page.getByLabel("新的取餐時段");
  await selector.selectOption(String(offered));
  await page.getByRole("button",{name:"確認改期"}).click();
  await expect(page.getByRole("alert")).toHaveText("此時段剩餘份數不足，原預約仍有效。");
  await expect(page.locator(".pickupSlotTime")).toContainText("12:00～12:15");
  await expect(selector.getByRole("option",{name:/12:15/})).toHaveCount(0);
  await selector.selectOption(String(next));
  await page.getByRole("button",{name:"確認改期"}).click();
  await expect(page.getByRole("alert")).toHaveText("尚未收到改期結果。可用原資料重試。");
  await expect(selector).toBeDisabled();
  await page.getByRole("button",{name:"重試同一次改期"}).click();
  await expect(page.getByText("取餐時段已從 12:00～12:15 改到 12:30～12:45。")).toBeVisible();
  await expect(page.locator(".pickupSlotTime")).toContainText("12:30～12:45");
  await expect(page.getByRole("heading",{name:"取餐號碼 0231"})).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#"+token);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
});

test("mobile staff find a booking by number, recover a full slot and reconcile a lost reschedule reply",async({page})=>{
  const first=Date.parse("2026-11-25T12:00:00+08:00"),interval=900_000,token=randomUUID();
  const full=first+interval,next=full+interval;
  const immediate={id:242,mode:"pickup",source:"staff",table:null,
    note:"電話預約",items:[{id:"sencha",name:"日式熱煎茶",price:45,qty:1}],status:"pending",total:45,
    created:first-3_600_000,paymentMethod:"cash",paymentEnv:"cash",paymentState:"unpaid"};
  const order={...immediate,id:241,pickupSlot:first,pickupRevision:0,pickupUpcoming:true};
  const change={from:first,to:next,at:first-2_400_000,actor:"staff"};
  const moved={...order,pickupSlot:next,pickupRevision:1,latestPickupChange:change};
  let closed=false,accepted=false;
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.route("**/api/kitchen",route=>route.fulfill({json:[immediate,accepted?moved:order]}));
  await page.route("**/api/pickup-slots",route=>route.fulfill({json:{slots:[
    {start:full,end:next,remaining:closed?0:1},{start:next,end:next+interval,remaining:12},
  ]}}));
  await page.route("**/api/kitchen/pickup-reschedule",route=>{
    const req=route.request();
    expect(req.method()).toBe("PATCH");
    expect(req.headers().authorization).toBe("Bearer local-test-kitchen");
    expect(req.headers()["x-ticket"]).toBeUndefined();
    if(!closed){
      expect(req.postDataJSON()).toEqual({id:241,from:first,to:full,revision:0});
      closed=true;
      return route.fulfill({status:409,json:{error:"此時段剩餘份數不足，原預約仍有效。",code:"pickup_slot_full"}});
    }
    expect(req.postDataJSON()).toEqual({id:241,from:first,to:next,revision:0});
    accepted=true;
    return route.abort("connectionreset");
  });
  await page.route(url=>url.pathname==="/api/ticket",route=>{
    expect(route.request().headers()["x-ticket"]).toBe(token);
    return route.fulfill({json:{...moved,pickupChanges:[change],canReschedulePickup:true}});
  });
  await page.goto("/kitchen");
  const number=page.getByRole("searchbox",{name:"取餐號碼"});
  await number.fill("0241");
  const card=page.locator(".kitchenTicket");
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("heading",{name:"#0241"})).toBeVisible();
  await card.getByRole("button",{name:"更改取餐時段"}).click();
  const selector=card.getByLabel("新的取餐時段");
  await selector.selectOption(String(full));
  await card.getByRole("button",{name:"確認改期"}).click();
  await expect(card.getByRole("alert")).toHaveText("此時段剩餘份數不足，原預約仍有效。");
  await expect(card.locator(".pickupSlotTime")).toContainText("12:00～12:15");
  await expect(selector.getByRole("option",{name:/12:15/})).toHaveCount(0);
  await selector.selectOption(String(next));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await card.getByRole("button",{name:"確認改期"}).click();
  await expect(card.locator(".pickupSlotTime")).toContainText("12:30～12:45");
  await expect(card.getByText("店員已將取餐時段從 12:00～12:15 改到 12:30～12:45。")).toBeVisible();
  await expect(selector).toHaveCount(0);
  await page.goto("/ticket#"+token);
  await expect(page.getByRole("heading",{name:"取餐號碼 0241"})).toBeVisible();
  await expect(page.getByText("店家已將取餐時段從 12:00～12:15 改到 12:30～12:45。")).toBeVisible();
  await expect(page.getByRole("button",{name:"下載取餐行事曆檔"})).toBeVisible();
});

test("mobile staff refresh a stale slot limit, close it and restore the default",async({page,request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"};
  const now=Date.now(),tomorrow=businessDate(now+86_400_000),yesterday=businessDate(now-86_400_000);
  const start=Date.parse(tomorrow+"T12:00:00+08:00"),endpoint="/api/kitchen/pickup-slots";
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen");
  await page.getByRole("link",{name:"管理預約時段"}).click();
  const date=page.getByLabel("取餐日期");
  await date.fill(tomorrow);
  await expect(date).toHaveValue(tomorrow);
  const slot=page.getByRole("article",{name:"12:00～12:15",exact:true});
  const capacity=slot.getByLabel("份數上限"),save=slot.getByRole("button",{name:"儲存上限"});
  await expect(slot.getByText("已占用 0 份 · 剩餘 12 份")).toBeVisible();
  await capacity.fill("0");
  expect((await request.patch(endpoint,{headers,data:{date:tomorrow,start,capacity:9,revision:0}})).status()).toBe(200);
  await save.click();
  await expect(page.getByRole("alert")).toHaveText("上限已由其他店員更新，請重新載入。");
  await expect(capacity).toHaveValue("9");
  await capacity.fill("0");
  await save.click();
  await expect(slot.getByText("已占用 0 份 · 剩餘 0 份")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("12:00～12:15 的份數上限已儲存。");
  await capacity.fill("");
  await save.click();
  await expect(slot.getByText("已占用 0 份 · 剩餘 12 份")).toBeVisible();
  const publicSlots=await (await request.get("/api/pickup-slots")).json();
  expect(publicSlots.slots.some(slot=>slot.start===start)).toBe(false);
  await date.fill(yesterday);
  await expect(date).toHaveValue(yesterday);
  await expect(page.getByText("這天目前沒有可調整的時段。")).toBeVisible();
  await page.getByLabel("顯示已截止時段").check();
  await expect(slot.getByText("已停止預約 · 上限 12 份")).toBeVisible();
  await expect(capacity).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
});

test("a mobile pickup receipt downloads the current calendar file and its cancellation",async({page})=>{
  const token=randomUUID(),start=Date.parse("2026-11-25T12:00:00+08:00"),created=start-3_600_000;
  const order={id:233,mode:"pickup",table:null,pickupSlot:start,pickupChanges:[],canReschedulePickup:true,
    note:"私人備註",items:[{id:"sencha",name:"日式熱煎茶",price:45,qty:1}],status:"pending",created,
    paymentMethod:"cash",paymentEnv:"cash",paymentState:"unpaid",total:45};
  let cancelled=false;
  await page.setViewportSize({width:360,height:780});
  await page.route(url=>url.pathname==="/api/ticket",route=>route.fulfill({json:cancelled?
    {...order,status:"cancelled",canReschedulePickup:false}:order}));
  await page.route("**/api/ticket/calendar",async route=>{
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers()["x-ticket"]).toBe(token);
    expect(new URL(route.request().url()).search).toBe("");
    const body=await pickupCalendar({id:order.id,token,created,start,modified:created+(cancelled?60_000:0),
      status:cancelled?"CANCELLED":"CONFIRMED",revision:cancelled?1:0});
    await route.fulfill({status:200,contentType:"text/calendar; charset=utf-8",body});
  });
  await page.goto("/ticket#"+token);
  async function download(name){
    const started=page.waitForEvent("download");
    await page.getByRole("button",{name}).click();
    const file=await started;
    expect(file.suggestedFilename()).toBe("hey-table-pickup-0233.ics");
    return readFile(await file.path(),"utf8");
  }
  const first=await download("下載取餐行事曆檔");
  expect(first).toContain("STATUS:CONFIRMED");
  expect(first).not.toContain("私人備註");
  expect(first).not.toContain(token);
  cancelled=true;
  await page.getByRole("button",{name:"更新進度"}).click();
  const next=await download("下載取消行事曆檔");
  expect(next).toContain("STATUS:CANCELLED");
  expect(next).toContain("SEQUENCE:1");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
});
