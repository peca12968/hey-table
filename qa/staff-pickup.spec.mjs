import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {businessDate} from "../lib/business-day.mjs";

const endpoint="/api/kitchen/create-pickup";
const headers={Authorization:"Bearer local-test-kitchen"};
const sencha=()=>({token:randomUUID(),note:"",items:[{id:"sencha",qty:1}],expectedTotal:45});
const create=(request,data)=>request.post(endpoint,{headers,data});
const guestOrder=(request,data)=>request.post("/api/orders",{data:{...data,mode:"pickup"}});
const advance=(request,id,from,to)=>request.patch("/api/kitchen/status",{headers,data:{id,from,to}});

test("mobile staff choose the date and book a future pickup payable at the counter",async({page,request})=>{
  page.setDefaultTimeout(8000);
  const tomorrow=businessDate(Date.now()+86_400_000);
  const start=Date.parse(tomorrow+"T14:00:00+08:00");
  let token;
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  try{
    await page.goto("/kitchen/create-pickup");
    await page.getByLabel("取餐日期",{exact:true}).selectOption(tomorrow);
    await page.getByRole("spinbutton",{name:/日式熱煎茶/}).fill("1");
    const submit=page.getByRole("button",{name:"確認建立自取單"});
    await expect(submit).toBeDisabled();
    await page.getByLabel("自取時段").selectOption(String(start));
    await submit.click();
    const href=await page.getByRole("link",{name:"開啟顧客收據"}).getAttribute("href");
    token=href.split("#")[1];
    const order=await (await request.get("/api/ticket",{headers:{"X-Ticket":token}})).json();
    expect(order).toMatchObject({source:"staff",pickupSlot:start,paymentMethod:"cash"});
    await expect(page.locator(".pickupSlotTime time")).toHaveAttribute("datetime",new Date(start).toISOString());
  }finally{
    if(token)await request.post("/api/ticket/cancel",{headers:{"X-Ticket":token},data:{}});
  }
});

test("mobile staff recover a lost pickup confirmation and share the same receipt",async({page,request})=>{
  expect((await request.get(endpoint)).status()).toBe(403);
  expect((await request.post(endpoint,{data:sencha()})).status()).toBe(403);
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/kitchen");
  await page.getByRole("link",{name:"代建自取單"}).click();
  const tea=page.getByRole("spinbutton",{name:/日式熱煎茶/});
  await tea.fill("2");
  await page.locator(".itemNotes summary").click();
  await page.getByLabel("日式熱煎茶備註").fill("兩杯分開包裝");
  await page.getByLabel("訂單備註").fill("不要餐具");
  await expect(page.locator(".total")).toHaveText("合計NT$ 90");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);

  let accepted,payload;
  await page.route("**"+endpoint,async route=>{
    if(route.request().method()!=="POST")return route.continue();
    if(!accepted){
      payload=route.request().postDataJSON();
      const response=await route.fetch();
      expect(response.status()).toBe(200);
      accepted=await response.json();
      await route.abort("connectionreset");
      return;
    }
    expect(route.request().postDataJSON()).toEqual(payload);
    await route.continue();
  });
  await page.getByRole("button",{name:"確認建立自取單"}).click();
  await expect(page.getByRole("alert")).toContainText("尚未收到送單結果");
  expect(accepted).toMatchObject({mode:"pickup",source:"staff",paymentMethod:"cash",note:"不要餐具",total:90});
  expect(accepted.items).toMatchObject([{id:"sencha",qty:2,note:"兩杯分開包裝"}]);
  const unavailable=available=>request.patch("/api/kitchen/availability",{headers,data:{id:"sencha",available}});
  expect((await unavailable(false)).ok()).toBe(true);
  try{
    await page.reload();
    await expect(tea).toBeDisabled();
    await expect(tea).toHaveValue("2");
    await expect(page.getByLabel("訂單備註")).toHaveValue("不要餐具");
    await page.getByRole("button",{name:"重試同一張自取單"}).click();
    const number=String(accepted.id).padStart(4,"0");
    await expect(page.getByRole("heading",{name:"取餐號碼 "+number})).toBeVisible();
    const link=page.getByRole("link",{name:"開啟顧客收據"});
    await expect(link).toHaveAttribute("href","/ticket#"+payload.token);
    await page.reload();
    await expect(link).toBeVisible();
    const [receipt]=await Promise.all([page.waitForEvent("popup"),link.click()]);
    await expect(receipt.getByText("店員代建自取",{exact:true})).toBeVisible();
    await expect(receipt.getByText(/兩杯分開包裝/)).toBeVisible();
    await expect(receipt.getByText("等待接單",{exact:true}).first()).toBeVisible();
    await receipt.close();

    const orders=await (await request.get("/api/kitchen",{headers})).json();
    expect(orders.filter(order=>order.source==="staff"&&order.note==="不要餐具").map(order=>order.id)).toEqual([accepted.id]);
    expect((await advance(request,accepted.id,"pending","preparing")).ok()).toBe(true);
    const stationResponse=await request.get("/api/kitchen/station-work?station=bar",{headers});
    expect(stationResponse.ok()).toBe(true);
    const station=await stationResponse.json();
    expect(station.orders.find(order=>order.id===accepted.id)).toMatchObject({source:"staff"});
    const ready=await request.patch("/api/kitchen/station-work",{headers,data:{id:accepted.id,station:"bar"}});
    expect(ready.ok()).toBe(true);
    expect(await ready.json()).toMatchObject({status:"ready"});
    const board=await (await request.get("/api/kitchen/pickup-display",{headers})).json();
    expect(board.ready).toContain(accepted.id);
    await page.getByRole("button",{name:"開始下一張"}).click();
    await expect(tea).toHaveValue("");
    await page.getByRole("link",{name:"返回店家接單台"}).click();
    await page.getByLabel("管道或桌號").selectOption("staff");
    const card=page.locator(".kitchenTicket").filter({has:page.getByRole("heading",{name:"#"+number,exact:true})});
    await expect(card.getByText("店員代建自取",{exact:true})).toBeVisible();
    await card.getByRole("button",{name:"完成交餐"}).click();
    await expect(card).toHaveCount(0);
  }finally{await unavailable(true);}
});

test("staff and guest pickup share the last serving but only staff can order during the online pause",async({request})=>{
  const date=businessDate(Date.now()),dish="sencha",caps="/api/kitchen/daily-limits",intake="/api/kitchen/intake";
  const currentCap=async()=>{
    const {limits}=await (await request.get(caps+"?date="+date,{headers})).json();
    return limits[dish];
  };
  const saveCap=(capacity,revision)=>request.patch(caps,{headers,data:{date,dish,capacity,revision}});
  const currentIntake=async()=> (await (await request.get(intake,{headers})).json()).pickup;
  const toggle=async accepting=>request.patch(intake,{headers,data:{mode:"pickup",accepting,revision:(await currentIntake()).revision}});
  const initial=await currentCap(),wasOpen=(await currentIntake()).accepting;
  const staff=sencha(),guest=sencha();
  expect((await saveCap(initial.used+1,initial.revision)).ok()).toBe(true);
  try{
    expect((await toggle(false)).ok()).toBe(true);
    const paused=await guestOrder(request,guest);
    expect(paused.status()).toBe(409);
    expect((await paused.json()).code).toBe("intake_paused");
    expect((await create(request,{...staff,expectedTotal:1})).status()).toBe(409);
    const response=await create(request,{...staff,mode:"table",table:"A01",paymentMethod:"line_pay"});
    expect(response.ok()).toBe(true);
    const accepted=await response.json();
    expect(accepted).toMatchObject({mode:"pickup",table:null,source:"staff",paymentMethod:"cash",total:45});
    expect((await create(request,sencha())).status()).toBe(409);
    expect((await guestOrder(request,staff)).status()).toBe(409);
    expect((await (await create(request,staff)).json()).id).toBe(accepted.id);
    expect((await advance(request,accepted.id,"pending","cancelled")).ok()).toBe(true);

    expect((await toggle(true)).ok()).toBe(true);
    const results=await Promise.all([create(request,sencha()),guestOrder(request,guest)]);
    expect(results.map(result=>result.status()).sort()).toEqual([200,409]);
    expect((await results.find(result=>!result.ok()).json()).code).toBe("portion_limit");
    const winner=await results.find(result=>result.ok()).json();
    expect((await advance(request,winner.id,"pending","cancelled")).ok()).toBe(true);
  }finally{
    expect((await saveCap(initial.capacity,(await currentCap()).revision)).ok()).toBe(true);
    if((await currentIntake()).accepting!==wasOpen)expect((await toggle(wasOpen)).ok()).toBe(true);
  }
});

test("mobile staff switch a newly full pickup window and recover the accepted reservation after reload",async({page})=>{
  const first=Date.parse("2026-11-25T12:00:00+08:00"),interval=900_000,next=first+interval;
  const order={id:720,source:"staff",mode:"pickup",pickupSlot:next,note:"電話取餐",status:"pending",
    total:90,created:first-3_600_000,paymentMethod:"cash",paymentEnv:"cash",paymentState:"unpaid",
    items:[{id:"sencha",name:"日式熱煎茶",price:45,qty:2,note:"分開包裝"}]};
  let full=false,firstToken,attempt;
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.route("**/api/pickup-slots",route=>route.fulfill({json:{slots:[
    {start:first,end:next,remaining:full?0:2},{start:next,end:next+interval,remaining:12},
  ]}}));
  await page.route("**"+endpoint,route=>{
    if(route.request().method()!=="POST")return route.continue();
    const payload=route.request().postDataJSON();
    expect(route.request().headers().authorization).toBe(headers.Authorization);
    expect(payload.note).toBe(order.note);
    expect(payload.expectedTotal).toBe(order.total);
    expect(payload.items).toEqual([{id:"sencha",qty:2,note:"分開包裝"}]);
    if(!full){
      expect(payload.pickupSlot).toBe(first);
      firstToken=payload.token;
      full=true;
      return route.fulfill({status:409,json:{code:"pickup_slot_full",error:"此時段剩餘份數不足，請改選時段或調整餐點。"}});
    }
    expect(payload.pickupSlot).toBe(next);
    expect(payload.token).not.toBe(firstToken);
    if(!attempt){
      attempt=payload;
      return route.abort("connectionreset");
    }
    expect(payload).toEqual(attempt);
    return route.fulfill({json:order});
  });
  await page.context().route(url=>url.pathname==="/api/ticket",route=>{
    expect(route.request().headers()["x-ticket"]).toBe(attempt.token);
    return route.fulfill({json:order});
  });
  await page.goto("/kitchen/create-pickup");
  const tea=page.getByRole("spinbutton",{name:/日式熱煎茶/});
  await tea.fill("2");
  await page.locator(".itemNotes summary").click();
  await page.getByLabel("日式熱煎茶備註").fill("分開包裝");
  await page.getByLabel("訂單備註").fill(order.note);
  await page.getByRole("button",{name:"預約取餐時段"}).click();
  const chooser=page.getByLabel("自取時段");
  const submit=page.getByRole("button",{name:"確認建立自取單"});
  await chooser.selectOption(String(first));
  await submit.click();
  await expect(page.getByRole("alert")).toHaveText("此時段剩餘份數不足，請改選時段或調整餐點。");
  await expect(page.getByText("請重新選擇可容納這張餐單的時段。")).toBeVisible();
  await expect(tea).toHaveValue("2");
  await expect(page.getByLabel("訂單備註")).toHaveValue(order.note);
  await chooser.selectOption(String(next));
  await submit.click();
  await expect(page.getByRole("alert")).toContainText("尚未收到送單結果");
  await page.reload();
  await expect(chooser).toBeDisabled();
  await expect(chooser).toHaveValue(String(next));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await page.getByRole("button",{name:"重試同一張自取單"}).click();
  await expect(page.getByRole("heading",{name:"取餐號碼 0720"})).toBeVisible();
  await expect(page.locator(".pickupSlotTime")).toContainText("12:15～12:30");
  const link=page.getByRole("link",{name:"開啟顧客收據"});
  await expect(link).toHaveAttribute("href","/ticket#"+attempt.token);
  const [receipt]=await Promise.all([page.waitForEvent("popup"),link.click()]);
  await expect(receipt.locator(".pickupSlotTime")).toContainText("12:15～12:30");
  await expect(receipt.getByRole("button",{name:"下載取餐行事曆檔"})).toBeVisible();
});
