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

test("guest and staff see cross-day dish shortages before confirmation and can continue after restock",async({page,request})=>{
  const today=Date.now(),tomorrow=businessDate(today+86_400_000),later=businessDate(today+2*86_400_000);
  const start=Date.parse(tomorrow+"T15:45:00+08:00"),target=Date.parse(later+"T16:15:00+08:00");
  const staff={Authorization:"Bearer local-test-kitchen"},token=randomUUID(),ticket={"X-Ticket":token};
  const endpoint="/api/kitchen/daily-limits",dish="sencha";
  const setting=async()=>(await (await request.get(endpoint+"?date="+later,{headers:staff})).json()).limits[dish];
  const set=(capacity,revision)=>request.patch(endpoint,{headers:staff,data:{date:later,dish,capacity,revision}});
  const previous=await setting();
  const operator=await page.context().newPage();
  let booked=false;
  try{
    expect((await set(previous.used+1,previous.revision)).ok()).toBe(true);
    const created=await request.post("/api/orders",{data:{token,mode:"pickup",note:"",pickupSlot:start,items:[{id:dish,qty:2}]}});
    expect(created.ok()).toBe(true);
    booked=true;
    const {id}=await created.json();
    await page.setViewportSize({width:360,height:780});
    await operator.setViewportSize({width:360,height:780});
    await operator.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    await page.goto("/ticket#"+token);
    await operator.goto("/kitchen?booking="+id);
    const blocked="取餐日份數不足的餐點為 日式熱煎茶。原預約仍有效。";
    for(const browser of [page,operator]){
      await browser.getByRole("button",{name:"更改取餐時段"}).click();
      await browser.getByLabel("新的取餐日期").selectOption(later);
      await browser.getByLabel("新的取餐時段").selectOption(String(target));
      await expect(browser.getByText(blocked,{exact:true})).toBeVisible();
      await expect(browser.getByRole("button",{name:"確認改期"})).toBeDisabled();
      await expect(browser.locator(".pickupSlotTime time")).toHaveAttribute("datetime",new Date(start).toISOString());
      expect(await browser.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    }
    const another=businessDate(today+3*86_400_000),suggested=Date.parse(another+"T11:00:00+08:00");
    for(const browser of [page,operator]){
      await browser.getByRole("button",{name:"找下一個可用日期"}).click();
      await expect(browser.getByLabel("新的取餐日期")).toHaveValue(another);
      await expect(browser.getByLabel("新的取餐時段")).toHaveValue(String(suggested));
      await expect(browser.getByRole("button",{name:"確認改期"})).toBeEnabled();
      await expect(browser.locator(".pickupSlotTime time")).toHaveAttribute("datetime",new Date(start).toISOString());
      await browser.getByLabel("新的取餐日期").selectOption(later);
      await browser.getByLabel("新的取餐時段").selectOption(String(target));
      await expect(browser.getByRole("button",{name:"確認改期"})).toBeDisabled();
    }
    const current=await setting();
    expect((await set(current.used+2,current.revision)).ok()).toBe(true);
    for(const browser of [page,operator]){
      await browser.evaluate(()=>window.dispatchEvent(new Event("online")));
      await expect(browser.getByText(blocked,{exact:true})).toHaveCount(0);
      await expect(browser.getByLabel("新的取餐時段")).toHaveValue(String(target));
      await expect(browser.getByRole("button",{name:"確認改期"})).toBeEnabled();
    }
    await operator.getByRole("button",{name:"確認改期"}).click();
    await expect(operator.locator(".pickupSlotTime time")).toHaveAttribute("datetime",new Date(target).toISOString());
    await page.getByRole("button",{name:"更新進度"}).click();
    await expect(page.locator(".pickupSlotTime time")).toHaveAttribute("datetime",new Date(target).toISOString());
    expect((await setting()).used).toBe(current.used+2);
  }finally{
    if(booked)await request.post("/api/ticket/cancel",{headers:ticket,data:{}});
    const current=await setting();
    if(current.capacity!==previous.capacity)await set(previous.capacity,current.revision);
    await operator.close();
  }
});

test("customer and staff pickup recheck the selected slot before sending while preserving both drafts",async({page,request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"};
  const date=businessDate(Date.now()+86_400_000),start=Date.parse(date+"T18:45:00+08:00");
  const limit="/api/kitchen/pickup-slots",slots="/api/pickup-slots";
  const setting=async()=>(await (await request.get(limit+"?date="+date,{headers})).json()).slots.find(slot=>slot.start===start);
  const set=(capacity,revision)=>request.patch(limit,{headers,data:{date,start,capacity,revision}});
  const original=await setting();
  const operator=await page.context().newPage();
  const booking={token:randomUUID(),mode:"pickup",table:null,note:"",items:[{id:"sencha",qty:1}],pickupSlot:start};
  const cancel=()=>request.post("/api/ticket/cancel",{headers:{"X-Ticket":booking.token},data:{}});
  let acquired=false;
  try{
    expect((await set(original.used+2,original.revision)).ok()).toBe(true);
    await page.setViewportSize({width:360,height:780});
    await operator.setViewportSize({width:360,height:780});
    await operator.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    await page.goto("/");
    await page.getByLabel("取餐日期",{exact:true}).selectOption(date);
    const tea=page.getByRole("button",{name:"加入日式熱煎茶",exact:true});
    await tea.click();
    await tea.click();
    await page.getByRole("button",{name:/我的餐單/}).click();
    const guestNote=page.getByPlaceholder("例如：餐具數量");
    await guestNote.fill("外帶餐具兩份");
    const guestSlot=page.getByLabel("自取時段"),submit=page.getByRole("button",{name:"確認送出訂單"});
    await guestSlot.selectOption(String(start));
    await expect(submit).toBeEnabled();

    await operator.goto("/kitchen/create-pickup");
    await operator.getByLabel("取餐日期",{exact:true}).selectOption(date);
    await operator.getByRole("spinbutton",{name:/日式熱煎茶/}).fill("2");
    const staffNote=operator.getByLabel("訂單備註");
    await staffNote.fill("來店自取");
    const staffSlot=operator.getByLabel("自取時段"),create=operator.getByRole("button",{name:"確認建立自取單"});
    await staffSlot.selectOption(String(start));
    await expect(create).toBeEnabled();

    expect((await request.post("/api/orders",{data:booking})).ok()).toBe(true);
    acquired=true;
    await page.bringToFront();
    await page.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await operator.evaluate(()=>window.dispatchEvent(new Event("online")));
    for(const [browser,chooser,button,note,value] of [[page,guestSlot,submit,guestNote,"外帶餐具兩份"],
      [operator,staffSlot,create,staffNote,"來店自取"]]){
      await expect(browser.getByText("請重新選擇可容納這張餐單的時段。")).toBeVisible();
      await expect(chooser).toHaveValue(String(start));
      await expect(button).toBeDisabled();
      await expect(note).toHaveValue(value);
    }
    await page.route(url=>url.pathname===slots,route=>route.fulfill({status:503,json:{error:"暫時中斷"}}),{times:1});
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await expect(page.getByText("暫時無法讀取自取時段。")).toBeVisible();
    await expect(submit).toBeDisabled();
    expect((await cancel()).ok()).toBe(true);
    acquired=false;
    await page.getByRole("button",{name:"重讀時段"}).click();
    await expect(submit).toBeEnabled();
    await operator.evaluate(()=>window.dispatchEvent(new Event("online")));
    await expect(create).toBeEnabled();
    await expect(guestSlot).toHaveValue(String(start));
    await expect(staffSlot).toHaveValue(String(start));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  }finally{
    if(acquired)await cancel();
    const current=await setting();
    if(current.capacity!==original.capacity)await set(original.capacity,current.revision);
    await operator.close();
  }
});

test("new guest and staff pickup drafts keep their contents when adopting the next suggested slot",async({page,request})=>{
  const now=Date.now(),date=businessDate(now+86_400_000),next=businessDate(now+2*86_400_000);
  const start=Date.parse(date+"T15:00:00+08:00"),alternative=Date.parse(next+"T11:00:00+08:00");
  const headers={Authorization:"Bearer local-test-kitchen"},endpoint="/api/kitchen/daily-limits",dish="sencha";
  const read=async day=>(await (await request.get(endpoint+"?date="+day,{headers})).json()).limits[dish];
  const set=async(day,capacity)=>request.patch(endpoint,{headers,data:{date:day,dish,capacity,revision:(await read(day)).revision}});
  const prior=await read(date),priorNext=await read(next);
  const operator=await page.context().newPage();
  let ticket;
  try{
    expect((await set(date,prior.used+2)).ok()).toBe(true);
    expect((await set(next,priorNext.used+3)).ok()).toBe(true);
    await page.setViewportSize({width:360,height:780});
    await operator.setViewportSize({width:360,height:780});
    await operator.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    await page.goto("/");
    await page.getByLabel("取餐日期",{exact:true}).selectOption(date);
    const tea=page.getByRole("button",{name:"加入日式熱煎茶",exact:true});
    await tea.click();
    await tea.click();
    await page.getByRole("button",{name:/我的餐單/}).click();
    await page.getByPlaceholder("例如：餐具數量").fill("保留外帶備註");
    await page.getByLabel("付款方式").selectOption("line_pay");
    await page.getByLabel("自取時段").selectOption(String(start));
    const submit=page.getByRole("button",{name:"確認送出訂單"});
    await expect(submit).toBeEnabled();

    await operator.goto("/kitchen/create-pickup");
    await operator.getByLabel("取餐日期",{exact:true}).selectOption(date);
    const qty=operator.getByRole("spinbutton",{name:/日式熱煎茶/});
    await qty.fill("2");
    await operator.getByLabel("訂單備註").fill("保留電話預訂備註");
    await operator.getByLabel("自取時段").selectOption(String(start));
    const create=operator.getByRole("button",{name:"確認建立自取單"});
    await expect(create).toBeEnabled();

    expect((await set(date,prior.used+1)).ok()).toBe(true);
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await operator.getByRole("button",{name:"更新供應"}).click();
    for(const [browser,confirm] of [[page,submit],[operator,create]]){
      const panel=browser.getByRole("region",{name:"其他可用取餐日期"});
      await expect(confirm).toBeDisabled();
      await panel.getByRole("button",{name:"找下一個可用日期"}).click();
      await expect(panel.getByText(next+" · 11:00～11:15",{exact:true})).toBeVisible();
      await expect(browser.getByLabel("取餐日期",{exact:true})).toHaveValue(date);
      await panel.getByRole("button",{name:"使用此時段"}).click();
      await expect(browser.getByLabel("取餐日期",{exact:true})).toHaveValue(next);
      await expect(browser.getByLabel("自取時段")).toHaveValue(String(alternative));
      await expect(confirm).toBeEnabled();
      expect(await browser.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    }
    await expect(page.getByPlaceholder("例如：餐具數量")).toHaveValue("保留外帶備註");
    await expect(page.getByLabel("付款方式")).toHaveValue("line_pay");
    await expect(operator.getByLabel("訂單備註")).toHaveValue("保留電話預訂備註");
    await expect(qty).toHaveValue("2");
    expect((await read(next)).used).toBe(priorNext.used);
    await submit.click();
    await page.waitForURL("**/ticket#*");
    ticket={"X-Ticket":new URL(page.url()).hash.slice(1)};
    const receipt=await (await request.get("/api/ticket",{headers:ticket})).json();
    expect(receipt).toMatchObject({pickupSlot:alternative,note:"保留外帶備註",paymentMethod:"line_pay",items:[{id:dish,qty:2}]});
  }finally{
    if(ticket)await request.post("/api/ticket/cancel",{headers:ticket,data:{}});
    await set(date,prior.capacity);
    await set(next,priorNext.capacity);
    await operator.close();
  }
});

test("mobile checkout compares same-day and later windows and rechecks a stale choice",async({page,request})=>{
  const now=Date.now(),date=businessDate(now+4*86_400_000),next=businessDate(now+5*86_400_000);
  const start=Date.parse(date+"T11:00:00+08:00"),nearest=start+900_000,alternative=start+1_800_000;
  const staff={Authorization:"Bearer local-test-kitchen"},endpoint="/api/kitchen/pickup-slots";
  const read=async at=>(await (await request.get(endpoint+"?date="+date,{headers:staff})).json()).slots.find(row=>row.start===at);
  const remember=await Promise.all([read(start),read(nearest)]);
  const cap=async(at,capacity)=>request.patch(endpoint,{headers:staff,data:{date,start:at,capacity,revision:(await read(at)).revision}});
  const operator=await page.context().newPage();
  let ticket;
  try{
    for(const browser of [page,operator])await browser.setViewportSize({width:360,height:780});
    await page.goto("/");
    await page.getByLabel("取餐日期",{exact:true}).selectOption(date);
    const add=page.getByRole("button",{name:"加入日式熱煎茶",exact:true});
    await add.click();await add.click();
    await page.getByRole("button",{name:/我的餐單/}).click();
    await page.getByPlaceholder("例如：餐具數量").fill("同一天取餐");
    await page.getByLabel("付款方式").selectOption("line_pay");
    await page.getByLabel("自取時段").selectOption(String(start));

    await operator.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    await operator.goto("/kitchen/create-pickup");
    await operator.getByLabel("取餐日期",{exact:true}).selectOption(date);
    await operator.getByRole("spinbutton",{name:/日式熱煎茶/}).fill("2");
    await operator.getByLabel("訂單備註").fill("保留原電話備註");
    await operator.getByLabel("自取時段").selectOption(String(start));
    const customerSubmit=page.getByRole("button",{name:"確認送出訂單"});
    const staffSubmit=operator.getByRole("button",{name:"確認建立自取單"});
    await expect(customerSubmit).toBeEnabled();
    await expect(staffSubmit).toBeEnabled();
    expect((await cap(start,1)).ok()).toBe(true);
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await operator.getByRole("button",{name:"更新供應"}).click();
    const compare=browser=>browser.getByRole("button",{name:"比較可用取餐時段"});
    const choices=browser=>browser.getByRole("list",{name:"可用取餐時段",exact:true});
    const closest="選擇 "+date+" · 11:15～11:30",second="選擇 "+date+" · 11:30～11:45";
    for(const [browser,submit] of [[page,customerSubmit],[operator,staffSubmit]]){
      await expect(submit).toBeDisabled();
      await compare(browser).click();
      await expect(choices(browser).getByRole("listitem")).toHaveCount(6);
      await expect(choices(browser).getByRole("button").first()).toHaveAccessibleName(closest);
      await expect(choices(browser).getByRole("button",{name:"選擇 "+next+" · 11:00～11:15",exact:true})).toBeVisible();
    }

    expect((await cap(nearest,1)).ok()).toBe(true);
    await choices(page).getByRole("button",{name:closest,exact:true}).click();
    await expect(page.getByLabel("自取時段")).toHaveValue(String(nearest));
    await expect(page.getByText("請重新選擇可容納這張餐單的時段。",{exact:true})).toBeVisible();
    await expect(customerSubmit).toBeDisabled();
    await compare(page).click();
    await expect(choices(page).getByRole("button",{name:closest,exact:true})).toHaveCount(0);
    for(const [browser,submit] of [[page,customerSubmit],[operator,staffSubmit]]){
      await choices(browser).getByRole("button",{name:second,exact:true}).click();
      await expect(browser.getByLabel("取餐日期",{exact:true})).toHaveValue(date);
      await expect(browser.getByLabel("自取時段")).toHaveValue(String(alternative));
      await expect(submit).toBeEnabled();
      expect(await browser.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    }
    await expect(page.getByPlaceholder("例如：餐具數量")).toHaveValue("同一天取餐");
    await expect(page.getByLabel("付款方式")).toHaveValue("line_pay");
    await expect(operator.getByLabel("訂單備註")).toHaveValue("保留原電話備註");
    await expect(operator.getByRole("spinbutton",{name:/日式熱煎茶/})).toHaveValue("2");
    await customerSubmit.click();
    await page.waitForURL("**/ticket#*");
    ticket={"X-Ticket":new URL(page.url()).hash.slice(1)};
    const receipt=await (await request.get("/api/ticket",{headers:ticket})).json();
    expect([receipt.pickupSlot,receipt.paymentMethod,receipt.note,receipt.items[0].qty])
      .toEqual([alternative,"line_pay","同一天取餐",2]);
  }finally{
    if(ticket)await request.post("/api/ticket/cancel",{headers:ticket,data:{}});
    for(const row of remember)await cap(row.start,row.capacity);
    await operator.close();
  }
});

test("receipt and kitchen recheck a selected reschedule against shared capacity",async({page,request})=>{
  const staff={Authorization:"Bearer local-test-kitchen"};
  const date=businessDate(Date.now()+86_400_000);
  const first=Date.parse(date+"T18:00:00+08:00"),next=Date.parse(date+"T19:00:00+08:00");
  const capacity="/api/kitchen/pickup-slots",slots="/api/pickup-slots";
  const setting=async()=>(await (await request.get(capacity+"?date="+date,{headers:staff})).json()).slots.find(slot=>slot.start===next);
  const set=(limit,revision)=>request.patch(capacity,{headers:staff,data:{date,start:next,capacity:limit,revision}});
  const booking=(pickupSlot,qty)=>({token:randomUUID(),mode:"pickup",table:null,note:"",items:[{id:"sencha",qty}],pickupSlot});
  const original=booking(first,2),competing=booking(next,1);
  const cancel=order=>request.post("/api/ticket/cancel",{headers:{"X-Ticket":order.token},data:{}});
  const receipt=async()=>(await (await request.get("/api/ticket?progress=1",{headers:{"X-Ticket":original.token}})).json());
  const previous=await setting();
  const operator=await page.context().newPage();
  let booked=false,held=false;
  try{
    expect((await set(previous.used+2,previous.revision)).ok()).toBe(true);
    expect((await request.post("/api/orders",{data:original})).ok()).toBe(true);
    booked=true;
    const {id}=await receipt();
    await page.setViewportSize({width:360,height:780});
    await operator.setViewportSize({width:360,height:780});
    await operator.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    await page.goto("/ticket#"+original.token);
    await operator.goto("/kitchen");
    await operator.getByRole("searchbox",{name:"取餐號碼"}).fill(String(id).padStart(4,"0"));
    const views=[page,operator.locator(".kitchenTicket")];
    for(const view of views){
      await view.getByRole("button",{name:"更改取餐時段"}).click();
      await view.getByLabel("新的取餐時段").selectOption(String(next));
      await expect(view.getByRole("button",{name:"確認改期"})).toBeEnabled();
    }
    expect((await request.post("/api/orders",{data:competing})).ok()).toBe(true);
    held=true;
    await page.bringToFront();
    await page.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await operator.evaluate(()=>window.dispatchEvent(new Event("online")));
    for(const view of views){
      await expect(view.getByText("新時段目前無法容納這張餐單，原預約仍有效。")).toBeVisible();
      await expect(view.getByLabel("新的取餐時段")).toHaveValue(String(next));
      await expect(view.getByRole("button",{name:"確認改期"})).toBeDisabled();
      await expect(view.locator(".pickupSlotTime")).toContainText("18:00～18:15");
    }
    expect((await receipt()).pickupSlot).toBe(first);
    await page.route(url=>url.pathname===slots,route=>route.fulfill({status:503,json:{error:"暫時中斷"}}),{times:1});
    await page.getByRole("button",{name:"重新檢查時段"}).click();
    await expect(page.getByText("暫時無法讀取自取時段。")).toBeVisible();
    await expect(page.getByRole("button",{name:"確認改期"})).toBeDisabled();
    expect((await cancel(competing)).ok()).toBe(true);
    held=false;
    await page.getByRole("button",{name:"重讀時段"}).click();
    await operator.evaluate(()=>window.dispatchEvent(new Event("online")));
    for(const view of views){
      await expect(view.getByLabel("新的取餐時段")).toHaveValue(String(next));
      await expect(view.getByRole("button",{name:"確認改期"})).toBeEnabled();
    }
    for(const browser of [page,operator])expect(await browser.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    await page.getByRole("button",{name:"確認改期"}).click();
    await expect(page.locator(".pickupSlotTime")).toContainText("19:00～19:15");
    expect((await receipt()).pickupSlot).toBe(next);
  }finally{
    if(held)await cancel(competing);
    if(booked)await cancel(original);
    const current=await setting();
    if(current.capacity!==previous.capacity)await set(previous.capacity,current.revision);
    await operator.close();
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
  await page.clock.setFixedTime(new Date(base.created));
  await page.setViewportSize({width:360,height:780});
  await page.route(url=>url.pathname==="/api/ticket",route=>route.fulfill({json:readBack?moved:base}));
  await page.route("**/api/pickup-slots",route=>route.fulfill({json:{slots:[
    {start:first,end:offered,remaining:10},{start:offered,end:next,remaining:full?0:2},{start:next,end:next+interval,remaining:attempt?0:12},
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
  await page.clock.setFixedTime(new Date(order.created));
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

test("mobile staff preview a slot batch, recover a conflict and preserve existing bookings",async({page,request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"},endpoint="/api/kitchen/pickup-slots";
  const date=businessDate(Date.now()+86_400_000),first=Date.parse(date+"T17:00:00+08:00"),second=first+900_000,third=second+900_000;
  const order={token:randomUUID(),mode:"pickup",table:null,note:"",pickupSlot:first,items:[{id:"sencha",qty:1}]};
  const settings=async()=>new Map((await (await request.get(endpoint+"?date="+date,{headers})).json()).slots.map(slot=>[slot.start,slot]));
  const change=(start,capacity,revision)=>request.patch(endpoint,{headers,data:{date,start,capacity,revision}});
  const before=await settings();
  let booked=false;
  try{
    expect((await request.post("/api/orders",{data:order})).ok()).toBe(true);
    booked=true;
    await page.setViewportSize({width:360,height:780});
    await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    await page.goto("/kitchen/pickup-slots");
    await page.getByLabel("取餐日期").fill(date);
    const panel=page.locator(".batchSlotLimits");
    await panel.getByText("批次調整時段上限",{exact:true}).click();
    const firstChoice=panel.getByRole("checkbox",{name:"17:00～17:15"});
    const secondChoice=panel.getByRole("checkbox",{name:"17:15～17:30"});
    await firstChoice.check();
    await secondChoice.check();
    const input=panel.getByLabel("新的份數上限"),preview=panel.getByRole("button",{name:"預覽調整"});
    await input.fill("0");
    await preview.click();
    await expect(panel.getByRole("heading",{name:"確認調整 2 個時段"})).toBeVisible();
    await expect(panel.getByText(/17:00～17:15 · 已占用 1 份/)).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    expect((await change(second,7,before.get(second).revision)).ok()).toBe(true);
    const confirm=panel.getByRole("button",{name:"確認批次儲存"});
    await confirm.click();
    await expect(page.getByRole("alert")).toHaveText("部分時段已截止或上限已變更，整批未儲存。請重新核對。");
    expect((await settings()).get(first)).toMatchObject({capacity:before.get(first).capacity,revision:before.get(first).revision,used:1});
    await expect(firstChoice).toBeChecked();
    await expect(secondChoice).toBeChecked();
    await preview.click();
    await expect(panel.getByText(/17:15～17:30 · 已占用 0 份 · 原上限 7 份/)).toBeVisible();
    await confirm.click();
    await expect(page.getByText("已批次儲存 2 個時段。",{exact:true})).toBeVisible();
    const after=await settings();
    expect(after.get(first)).toMatchObject({capacity:0,remaining:0,used:1});
    expect(after.get(second)).toMatchObject({capacity:0,remaining:0,used:0});
    expect(after.get(third)).toEqual(before.get(third));
    const receipt=await (await request.get("/api/ticket",{headers:{"X-Ticket":order.token}})).json();
    expect(receipt).toMatchObject({pickupSlot:first,status:"pending"});
    await page.getByText("查看預約調整紀錄",{exact:true}).click();
    const history=page.getByRole("region",{name:"預約調整紀錄"});
    const batch=history.getByRole("heading",{name:"批次調整 · 2 個時段"});
    await expect(batch).toHaveCount(1);
    await expect(batch).toBeVisible();
    await expect(history.getByText("17:00～17:15 · 預設 12 份 → 0 份",{exact:true})).toBeVisible();
    await expect(history.getByText("17:15～17:30 · 7 份 → 0 份",{exact:true})).toBeVisible();
    const source=history.locator("ol > li").filter({has:page.getByRole("heading",{name:"批次調整 · 2 個時段",exact:true})});
    const previewRestore=source.getByRole("button",{name:"預覽還原變更前設定"});
    await previewRestore.click();
    const restoreReview=history.getByRole("region",{name:"核對還原設定"});
    const restore=restoreReview.getByRole("button",{name:"確認還原"});
    await expect(restoreReview.getByText("17:00～17:15 · 0 份 → 預設 12 份 · 已占用 1 份",{exact:true})).toBeVisible();
    expect((await change(second,3,after.get(second).revision)).ok()).toBe(true);
    await restore.click();
    await expect(page.getByRole("alert")).toHaveText("預約狀態已更新、截止或已是目標設定，請重新核對後再還原。");
    expect((await settings()).get(first)).toMatchObject({capacity:0,revision:after.get(first).revision,used:1});
    await previewRestore.click();
    await expect(restoreReview.getByText("17:15～17:30 · 3 份 → 7 份 · 已占用 0 份",{exact:true})).toBeVisible();
    await restore.click();
    await expect(page.getByText("已還原 2 個時段的上限。",{exact:true})).toBeVisible();
    await expect(history.getByRole("heading",{name:"還原 · 批次調整 · 2 個時段",exact:true})).toBeVisible();
    await expect(history.getByText(/依第 \d+ 筆還原/)).toBeVisible();
    const restored=await settings();
    expect(restored.get(first)).toMatchObject({capacity:null,used:1,remaining:11});
    expect(restored.get(second)).toMatchObject({capacity:7,used:0,remaining:7});
    expect(await (await request.get("/api/ticket",{headers:{"X-Ticket":order.token}})).json()).toMatchObject({pickupSlot:first,status:"pending"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  }finally{
    if(booked)await request.post("/api/ticket/cancel",{headers:{"X-Ticket":order.token},data:{}});
    const current=await settings();
    for(const slot of [first,second]){
      if(current.get(slot).capacity!==before.get(slot).capacity)await change(slot,before.get(slot).capacity,current.get(slot).revision);
    }
  }
});

test("mobile staff compare seven days and follow date-scoped roster and settings links",async({page,request})=>{
  page.setDefaultTimeout(9000);
  const date=businessDate(Date.now()+5*86_400_000),paused=businessDate(Date.now()+6*86_400_000);
  const start=Date.parse(date+"T14:00:00+08:00"),end=start+900_000;
  const headers={Authorization:"Bearer local-test-kitchen"},endpoint="/api/kitchen/pickup-slots",token=randomUUID();
  const snapshot=async day=>(await (await request.get(endpoint+"?date="+day,{headers})).json());
  const write=(slot,capacity,revision)=>request.patch(endpoint,{headers,data:{date,start:slot,capacity,revision}});
  const pause=(accepting,revision)=>request.patch("/api/kitchen/pickup-day",{headers,data:{date:paused,accepting,revision}});
  const find=(report,slot)=>report.slots.find(item=>item.start===slot);
  const before=await snapshot(date),intake=(await snapshot(paused)).intake;
  let booked=false;
  try{
    expect((await write(start,1,find(before,start).revision)).ok()).toBe(true);
    expect((await write(end,0,find(before,end).revision)).ok()).toBe(true);
    expect((await pause(false,intake.revision)).ok()).toBe(true);
    const response=await request.post("/api/orders",{data:{token,mode:"pickup",note:"",pickupSlot:start,items:[{id:"sencha",qty:1}]}});
    expect(response.ok()).toBe(true);
    booked=true;
    await page.setViewportSize({width:360,height:780});
    await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    await page.route("**/api/kitchen/pickup-week",route=>route.fulfill({status:503,json:{error:"總覽暫時無法讀取。"}}),{times:1});
    await page.goto("/kitchen");
    await page.getByRole("link",{name:"七天自取預約總覽"}).click();
    await expect(page.getByRole("heading",{name:"七天自取預約總覽"})).toBeVisible();
    await expect(page.getByRole("alert")).toHaveText("總覽暫時無法讀取。");
    await page.getByRole("button",{name:"重新擷取"}).click();
    const rows=page.locator(".pickupWeekList > li");
    await expect(rows).toHaveCount(7);
    const selected=rows.filter({has:page.locator(`time[datetime="${date}"]`)});
    const suspended=rows.filter({has:page.locator(`time[datetime="${paused}"]`)});
    await expect(selected.locator("dl")).toHaveText("有效預約1 張已占用1 份可預約時段34滿額時段1停收時段1");
    await expect(suspended.getByText("整日停收",{exact:true})).toBeVisible();
    await page.getByText(/七天備料需求 ·/).click();
    const prep=page.getByRole("region",{name:"七天備料需求"});
    const tea=prep.getByRole("table",{name:date+" 備料需求"}).getByRole("row",{name:/日式熱煎茶/});
    await expect(tea.getByRole("cell")).toHaveText(["1","0"]);
    const capturedAt=await page.locator(".pickupWeekControls time").getAttribute("datetime");
    const [file]=await Promise.all([page.waitForEvent("download"),prep.getByRole("button",{name:"下載備料 CSV"}).click()]);
    expect(file.suggestedFilename()).toBe("hey-table-pickup-prep-"+businessDate(Date.parse(capturedAt))+"-"+capturedAt.replaceAll(":","-")+".csv");
    const bytes=await readFile(await file.path());
    expect([...bytes.subarray(0,3)]).toEqual([0xef,0xbb,0xbf]);
    expect(bytes.toString("utf8").slice(1).split("\r\n")).toEqual([
      '"取餐日期","品項編號","餐點","待接單份數","製作中未完成份數","合計份數","擷取時間（UTC）"',
      '"'+date+'","sencha","日式熱煎茶",1,0,1,"'+capturedAt+'"',
      "",
    ]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    await selected.getByRole("link",{name:/的預約清單$/}).click();
    await expect(page).toHaveURL(new RegExp("/kitchen/pickup-roster\\?date="+date+"$"));
    await expect(page.getByRole("region",{name:"14:00～14:15",exact:true})).toBeVisible();
    await page.getByRole("link",{name:"七天自取預約總覽"}).click();
    await selected.getByRole("link",{name:/的時段設定$/}).click();
    await expect(page).toHaveURL(new RegExp("/kitchen/pickup-slots\\?date="+date+"$"));
    await page.reload();
    await expect(page.getByLabel("取餐日期")).toHaveValue(date);
    await expect(page.getByRole("article",{name:"14:00～14:15",exact:true}).getByText("已占用 1 份 · 剩餘 0 份")).toBeVisible();
  }finally{
    if(booked)await request.post("/api/ticket/cancel",{headers:{"X-Ticket":token},data:{}});
    const current=await snapshot(date);
    for(const slot of [start,end]){
      const prior=find(before,slot),next=find(current,slot);
      if(prior.capacity!==next.capacity)await write(slot,prior.capacity,next.revision);
    }
    const currentIntake=(await snapshot(paused)).intake;
    if(currentIntake.accepting!==intake.accepting)await pause(intake.accepting,currentIntake.revision);
  }
});

test("mobile staff copy selected limits across dates and recompare after a source change",async({page,request})=>{
  page.setDefaultTimeout(9000);
  const sourceDate=businessDate(Date.now()+4*86_400_000),date=businessDate(Date.now()+5*86_400_000);
  const src=Date.parse(sourceDate+"T15:00:00+08:00"),dst=Date.parse(date+"T15:00:00+08:00"),later=900_000;
  const headers={Authorization:"Bearer local-test-kitchen"},endpoint="/api/kitchen/pickup-slots",token=randomUUID();
  const snapshot=async day=>(await (await request.get(endpoint+"?date="+day,{headers})).json());
  const find=(report,start)=>report.slots.find(slot=>slot.start===start);
  const write=(day,start,capacity,revision)=>request.patch(endpoint,{headers,data:{date:day,start,capacity,revision}});
  const before=await snapshot(date),sourceBefore=await snapshot(sourceDate);
  let booked=false;
  try{
    expect((await write(sourceDate,src,0,find(sourceBefore,src).revision)).ok()).toBe(true);
    expect((await write(sourceDate,src+later,3,find(sourceBefore,src+later).revision)).ok()).toBe(true);
    expect((await request.post("/api/orders",{data:{token,mode:"pickup",pickupSlot:dst,note:"",items:[{id:"sencha",qty:1}]}})).ok()).toBe(true);
    booked=true;
    await page.setViewportSize({width:360,height:780});
    await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    await page.goto("/kitchen/pickup-slots");
    await page.getByLabel("取餐日期").fill(date);
    await page.getByText("從其他日期複製時段上限",{exact:true}).click();
    await page.getByLabel("來源日期").fill(sourceDate);
    const compare=page.getByRole("button",{name:"比較時段上限"});
    const comparison=page.getByRole("region",{name:"比較預約時段上限"});
    const choice=comparison.getByRole("checkbox",{name:"15:00～15:15"});
    const apply=comparison.getByRole("button",{name:"套用已選時段上限"});
    await compare.click();
    await expect(comparison.getByText("預設 12 份 → 0 份",{exact:true})).toBeVisible();
    await expect(comparison.getByText("目的日已占用 1 份 · 套用後暫停新增預約",{exact:true})).toBeVisible();
    await choice.check();
    const changed=await snapshot(sourceDate);
    expect((await write(sourceDate,src,1,find(changed,src).revision)).ok()).toBe(true);
    await apply.click();
    await expect(page.getByRole("alert")).toHaveText("來源或目的上限已更新、相同或截止，請重新讀取兩天設定。");
    expect(find(await snapshot(date),dst).capacity).toBe(find(before,dst).capacity);
    await compare.click();
    await expect(comparison.getByText("預設 12 份 → 1 份",{exact:true})).toBeVisible();
    await choice.check();
    await apply.click();
    await expect(page.getByText("已複製 1 個時段的上限。",{exact:true})).toBeVisible();
    await page.getByText("查看預約調整紀錄",{exact:true}).click();
    const history=page.getByRole("region",{name:"預約調整紀錄"});
    await expect(history.getByRole("heading",{name:"跨日複製 · 1 個時段",exact:true})).toBeVisible();
    await expect(history.getByText(new RegExp("來源日 "+sourceDate))).toBeVisible();
    const after=await snapshot(date);
    expect(find(after,dst)).toMatchObject({capacity:1,used:1,remaining:0});
    expect(find(after,dst+later)).toEqual(find(before,dst+later));
    expect(after.intake).toEqual(before.intake);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  }finally{
    if(booked)await request.post("/api/ticket/cancel",{headers:{"X-Ticket":token},data:{}});
    for(const [day,prior,starts] of [[date,before,[dst]],[sourceDate,sourceBefore,[src,src+later]]]){
      const current=await snapshot(day);
      for(const start of starts){
        const priorLimit=find(prior,start),currentLimit=find(current,start);
        if(priorLimit.capacity!==currentLimit.capacity)await write(day,start,priorLimit.capacity,currentLimit.revision);
      }
    }
  }
});

test("mobile staff pause and reopen a date without displacing orders or erasing a slot limit",async({page,request})=>{
  page.setDefaultTimeout(9000);
  const day=businessDate(Date.now()+3*86_400_000),start=Date.parse(day+"T12:00:00+08:00");
  const headers={Authorization:"Bearer local-test-kitchen"};
  const settings="/api/kitchen/pickup-day",limits="/api/kitchen/pickup-slots";
  const inspect=async()=>(await (await request.get(limits+"?date="+day,{headers})).json());
  const token=randomUUID();
  const setDay=(accepting,revision)=>request.patch(settings,{headers,data:{date:day,accepting,revision}});
  const setLimit=(capacity,revision)=>request.patch(limits,{headers,data:{date:day,start,capacity,revision}});
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  const setup=await inspect(),preset=setup.slots.find(slot=>slot.start===start);
  const openSettings=async()=>{
    await page.goto("/kitchen/pickup-slots");
    await page.getByLabel("取餐日期").fill(day);
  };
  try{
    expect((await setLimit(5,preset.revision)).status()).toBe(200);
    const ordered=await request.post("/api/orders",{data:{token,mode:"pickup",pickupSlot:start,note:"",items:[{id:"sencha",qty:1}]}});
    expect(ordered.status()).toBe(200);
    await openSettings();
    const dayPanel=page.getByRole("region",{name:"整日預約"});
    const pause=dayPanel.getByRole("button",{name:"暫停整日預約"});
    const slot=page.getByRole("article",{name:"12:00～12:15",exact:true});
    await expect(slot.getByText("已占用 1 份 · 剩餘 4 份")).toBeVisible();
    expect((await setDay(true,setup.intake.revision)).status()).toBe(200);
    await pause.click();
    await expect(page.getByRole("alert")).toHaveText("整日預約狀態已由其他店員更新，請重新載入。");
    await pause.click();
    await expect(dayPanel.getByRole("button",{name:"恢復整日預約"})).toBeVisible();
    await expect(slot.getByText("已占用 1 份 · 剩餘 0 份")).toBeVisible();
    await expect(slot.getByLabel("份數上限")).toHaveValue("5");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);

    await page.goto("/");
    await page.getByRole("combobox",{name:"取餐日期",exact:true}).selectOption(day);
    await expect(page.getByText("這個日期已暫停預約，請改選日期。")).toBeVisible();
    await page.getByRole("button",{name:"加入日式熱煎茶"}).click();
    await page.getByRole("button",{name:/我的餐單/}).click();
    await expect(page.getByText("這個日期已暫停時段預約。")).toBeVisible();
    await expect(page.getByRole("button",{name:"確認送出訂單"})).toBeDisabled();
    await openSettings();
    await dayPanel.getByRole("button",{name:"恢復整日預約"}).click();
    await expect(slot.getByText("已占用 1 份 · 剩餘 4 份")).toBeVisible();
    const response=await request.get("/api/ticket",{headers:{"X-Ticket":token}});
    expect(await response.json()).toMatchObject({pickupSlot:start,status:"pending"});
  }finally{
    await request.post("/api/ticket/cancel",{headers:{"X-Ticket":token},data:{}});
    const current=await inspect();
    if(current.intake.accepting!==setup.intake.accepting)await setDay(setup.intake.accepting,current.intake.revision);
    const currentSlot=current.slots.find(slot=>slot.start===start);
    if(currentSlot.capacity!==preset.capacity)await setLimit(preset.capacity,currentSlot.revision);
  }
});

test("staff can print the selected pickup date with the same mobile roster and status filter",async({page,request})=>{
  page.setDefaultTimeout(9000);
  const date=businessDate(Date.now()+4*86_400_000),early=Date.parse(date+"T11:30:00+08:00");
  const later=early+900_000,endpoint="/api/kitchen/pickup-roster";
  const staff={Authorization:"Bearer local-test-kitchen"},tokens=[];
  const submit=async(pickupSlot,{byStaff=false,paymentMethod="cash"}={})=>{
    const token=randomUUID();
    tokens.push(token);
    const response=await request.post(byStaff?"/api/kitchen/create-pickup":"/api/orders",{
      headers:byStaff?staff:{},data:{token,mode:"pickup",note:"內部備註勿列印",pickupSlot,paymentMethod,
        items:[{id:"sencha",qty:1}],expectedTotal:45},
    });
    expect(response.ok()).toBe(true);
    return {id:(await response.json()).id,headers:{"X-Ticket":token}};
  };
  const assertReceipt=order=>page.getByRole("rowheader",{name:new RegExp("#"+String(order.id).padStart(4,"0"))});
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>{
    sessionStorage.setItem("he-ri-staff","local-test-kitchen");
    window.print=()=>document.body.setAttribute("data-print-invoked","yes");
  });
  try{
    const phone=await submit(later,{byStaff:true});
    const wallet=await submit(early,{paymentMethod:"px_pay_plus"});
    const cancelled=await submit(later);
    expect((await request.post("/api/ticket/cancel",{headers:cancelled.headers,data:{}})).status()).toBe(200);
    const started=await request.post("/api/payments/start",{headers:wallet.headers,data:{}});
    expect(started.ok()).toBe(true);
    const {attempt}=await started.json();
    expect((await request.post("/api/payments/demo",{headers:wallet.headers,data:{ref:attempt.ref,outcome:"paid"}})).ok()).toBe(true);
    expect((await request.get(endpoint+"?date="+date)).status()).toBe(403);

    await page.goto("/kitchen");
    await page.getByRole("link",{name:"自取預約清單"}).click();
    const selector=page.getByLabel("取餐日期");
    await selector.fill(date);
    await expect(selector).toHaveValue(date);
    await expect(page.locator(".rosterWindow h2")).toHaveText(["11:30～11:45預約 1 份","11:45～12:00預約 1 份"]);
    await expect(page.getByText("2 張有效預約 · 2 份", {exact:false})).toBeVisible();
    await expect(assertReceipt(wallet)).toContainText("線上自取");
    await expect(page.getByText("已付款",{exact:true})).toBeVisible();
    await expect(assertReceipt(phone)).toContainText("店員代建");
    await expect(assertReceipt(cancelled)).toHaveCount(0);
    await expect(page.getByText("內部備註勿列印")).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    await page.getByRole("checkbox",{name:"顯示 1 張已取消餐單"}).check();
    await expect(assertReceipt(cancelled)).toBeVisible();
    const print=page.getByRole("button",{name:"列印預約清單"});
    await print.click();
    await expect(page.locator("body")).toHaveAttribute("data-print-invoked","yes");
    await page.emulateMedia({media:"print"});
    await expect(page.getByLabel("取餐日期")).toBeHidden();
    await expect(assertReceipt(cancelled)).toBeVisible();
    await expect(page.locator("time")).toBeVisible();
    await page.emulateMedia({media:"screen"});

    let failure=true;
    await page.route(url=>url.pathname===endpoint&&url.searchParams.get("date")===date,route=>{
      if(!failure)return route.continue();
      failure=false;
      return route.fulfill({status:503,json:{error:"暫時無法讀取清單"}});
    });
    const refresh=page.getByRole("button",{name:"重新擷取"});
    await refresh.click();
    await expect(page.getByRole("alert")).toHaveText("暫時無法讀取清單");
    await expect(print).toBeDisabled();
    await expect(assertReceipt(phone)).toHaveCount(0);
    await refresh.click();
    await expect(assertReceipt(phone)).toBeVisible();

    await page.goto("/kitchen/pickup-slots");
    await page.getByLabel("取餐日期").fill(date);
    const target=page.getByRole("article",{name:"11:45～12:00"});
    await target.getByRole("link",{name:"查看此時段預約"}).click();
    expect(new URL(page.url()).searchParams.get("date")).toBe(date);
    expect(new URL(page.url()).searchParams.get("slot")).toBe(String(later));
    const time=page.getByLabel("取餐時段");
    await expect(time).toHaveValue(String(later));
    await expect(page.getByText(date+" · 11:45～12:00")).toBeVisible();
    await expect(page.getByText("1 張有效預約 · 1 份",{exact:false})).toBeVisible();
    await expect(assertReceipt(phone)).toBeVisible();
    await expect(assertReceipt(wallet)).toHaveCount(0);
    await page.getByRole("checkbox",{name:"顯示 1 張已取消餐單"}).check();
    await print.click();
    await page.emulateMedia({media:"print"});
    await expect(time).toBeHidden();
    await expect(page.getByText(date+" · 11:45～12:00")).toBeVisible();
    await expect(assertReceipt(cancelled)).toBeVisible();
    await expect(assertReceipt(wallet)).toHaveCount(0);
    await page.emulateMedia({media:"screen"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);

    const bookingPath="/api/kitchen/pickup-booking";
    expect((await request.get(bookingPath+"?id="+phone.id)).status()).toBe(403);
    const loaded=page.waitForResponse(response=>new URL(response.url()).pathname===bookingPath&&response.ok());
    await assertReceipt(phone).getByRole("link").click();
    expect((await (await loaded).json()).pickupRevision).toBe(0);
    await expect(page.getByRole("heading",{name:"自取預約餐單"})).toBeVisible();
    await expect(page.locator(".kitchenTicket")).toHaveCount(1);
    await expect(page.getByRole("button",{name:"接單製作"})).toBeDisabled();
    await expect(page.getByText("備註　內部備註勿列印")).toBeVisible();
    await page.getByRole("button",{name:"更改取餐時段"}).click();
    const next=later+900_000;
    await page.getByLabel("新的取餐時段").selectOption(String(next));
    await page.getByRole("button",{name:"確認改期"}).click();
    await expect(page.locator(".pickupSlotTime")).toContainText("12:00～12:15");
    await expect(page.getByText("店員已將取餐時段從 11:45～12:00 改到 12:00～12:15。")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    await page.getByRole("link",{name:"返回自取預約清單"}).click();
    await expect(time).toHaveValue(String(later));
    await expect(page.getByText("這個時段沒有有效的自取預約。",{exact:true})).toBeVisible();
    await page.getByRole("checkbox",{name:"顯示 1 張已取消餐單"}).check();
    await assertReceipt(cancelled).getByRole("link").click();
    await expect(page.getByText("已取消",{exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"更改取餐時段"})).toHaveCount(0);
    await expect(page.getByRole("button",{name:"接單製作"})).toHaveCount(0);
    await page.getByRole("link",{name:"返回自取預約清單"}).click();
    await time.selectOption(String(early));
    await expect(assertReceipt(wallet)).toBeVisible();
    await expect(assertReceipt(phone)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("slot")).toBe(String(early));
    await page.reload();
    await expect(time).toHaveValue(String(early));
    await expect(assertReceipt(wallet)).toBeVisible();
    await time.selectOption("");
    await expect(assertReceipt(phone)).toBeVisible();

    await page.goto("/kitchen/pickup-roster?date="+date+"&slot="+(later+86_400_000));
    await expect(page.getByRole("alert")).toHaveText("請選擇這個日期的取餐時段。");
    await expect(print).toBeDisabled();
    await expect(assertReceipt(phone)).toHaveCount(0);
    await time.selectOption("");
    await expect(assertReceipt(phone)).toBeVisible();
    await page.getByLabel("取餐日期").fill("2001-01-01");
    await expect(page.getByText("這天沒有有效的自取預約。")).toBeVisible();
    await expect(print).toBeDisabled();
  }finally{
    for(const token of tokens)await request.post("/api/ticket/cancel",{headers:{"X-Ticket":token},data:{}});
  }
});

test("mobile pickup roster follows arrivals and downloads the selected snapshot",async({page})=>{
  const fixture=JSON.parse(await readFile(new URL("../examples/pickup-roster-followup-demo.json",import.meta.url),"utf8"));
  const snapshot=fixture.scenes[1].snapshot,slot=snapshot.windows[0].start,date=snapshot.date;
  const path="/kitchen/pickup-roster?date="+date+"&slot="+slot,api="/api/kitchen/pickup-roster";
  const [unreported,arrived,recent]=snapshot.windows[0].orders;
  let captures=0,current=snapshot;
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.route(url=>url.pathname===api,route=>{
    expect(new URL(route.request().url()).searchParams.get("followUp")).toBe("1");
    captures++;
    return route.fulfill({json:current});
  });
  const row=id=>page.getByRole("rowheader",{name:new RegExp("#"+String(id).padStart(4,"0"))});
  await page.goto(path);
  await expect(row(recent.id)).toBeVisible();
  const review=page.getByLabel("取餐追蹤");
  await review.selectOption("unreported");
  await expect(page).toHaveURL(path+"&review=unreported");
  await expect(row(unreported.id)).toBeVisible();
  await expect(row(arrived.id)).toHaveCount(0);
  await expect(row(recent.id)).toHaveCount(0);
  expect(captures).toBe(1);
  const [file]=await Promise.all([page.waitForEvent("download"),page.getByRole("button",{name:"下載追蹤清單 CSV"}).click()]);
  const csv=await readFile(await file.path(),"utf8");
  expect(csv).toContain('"逾時未回報到店"');
  expect(csv).toContain('"'+String(unreported.id).padStart(4,"0")+'"');
  expect(csv).toContain(new Date(snapshot.capturedAt).toISOString());
  expect(csv).not.toContain('"'+String(arrived.id).padStart(4,"0")+'"');
  await review.selectOption("arrived");
  await expect(row(arrived.id)).toBeVisible();
  await expect(row(unreported.id)).toHaveCount(0);
  expect(captures).toBe(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  const booking="/api/kitchen/pickup-booking";
  await page.route(url=>url.pathname===booking,route=>route.fulfill({json:{...arrived,mode:"pickup",
    created:slot-3600_000,pickupSlot:slot,total:45,items:[{id:"sencha",name:"煎茶",qty:1}]}}));
  await row(arrived.id).getByRole("link").click();
  await expect(page.getByRole("heading",{name:"自取預約餐單"})).toBeVisible();
  await page.getByRole("link",{name:"返回自取預約清單"}).click();
  await expect(page).toHaveURL(path+"&review=arrived");
  await expect(review).toHaveValue("arrived");
  await expect(row(arrived.id)).toBeVisible();
  current=fixture.scenes[2].snapshot;
  await page.getByRole("button",{name:"重新擷取"}).click();
  await expect(page.getByText("這個時段沒有符合此追蹤條件的餐單。")).toBeVisible();
  await expect(page.getByRole("button",{name:"下載追蹤清單 CSV"})).toBeDisabled();
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
