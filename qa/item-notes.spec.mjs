import {test,expect} from "@playwright/test";

test("item notes survive a mobile retry and stay with the correct station and printed line",async({page,request})=>{
  const staff={Authorization:"Bearer local-test-kitchen"};
  const dumplings="醬另外放",tea="分兩杯，標記 <熱>";
  await page.setViewportSize({width:360,height:780});
  await page.addInitScript(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
  await page.goto("/?table=A03");
  await page.getByRole("button",{name:"加入海苔柴魚煎餃"}).click();
  await page.getByRole("button",{name:"加入日式熱煎茶"}).click();
  await page.getByRole("button",{name:/我的餐單/}).click();
  const notes=page.locator(".itemNotes summary");
  await notes.click();
  await page.getByLabel("海苔柴魚煎餃備註").fill(dumplings);
  const cups=page.getByLabel("日式熱煎茶備註");
  await cups.fill("清除這段");
  await page.getByRole("button",{name:"減少日式熱煎茶"}).click();
  await page.getByRole("button",{name:"關閉",exact:true}).click();
  await page.getByRole("button",{name:"加入日式熱煎茶"}).click();
  await page.getByRole("button",{name:/我的餐單/}).click();
  await expect(cups).toHaveValue("");
  await cups.fill(tea);
  await page.getByRole("button",{name:"增加日式熱煎茶"}).click();
  await page.getByLabel(/訂單備註/).fill("放同一托盤");
  await page.reload();
  await page.getByRole("button",{name:/我的餐單/}).click();
  await notes.click();
  await expect(cups).toHaveValue(tea);
  await expect(page.getByLabel("海苔柴魚煎餃備註")).toHaveValue(dumplings);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);

  let submitted,accepted;
  await page.route("**/api/ticket",route=>route.abort("internetdisconnected"));
  await page.route("**/api/orders",async route=>{
    if(!accepted){
      submitted=route.request().postDataJSON();
      expect(submitted.items).toEqual([{id:"gyoza",qty:1,note:dumplings},{id:"sencha",qty:2,note:tea}]);
      const response=await route.fetch();
      expect(response.status()).toBe(200);
      accepted=await response.json();
      await route.abort("connectionreset");
    }else{
      expect(route.request().postDataJSON()).toEqual(submitted);
      await route.continue();
    }
  });
  await page.getByRole("button",{name:"確認送出訂單"}).click();
  const retry=page.getByRole("button",{name:"重試同一張訂單"});
  await expect(retry).toBeEnabled();
  const original={...submitted,items:submitted.items.map(line=>({...line,note:" "+line.note+" "}))};
  const replay=await request.post("/api/orders",{data:original});
  expect(await replay.json()).toEqual(accepted);
  const different=await request.post("/api/orders",{data:{...submitted,
    items:submitted.items.map(line=>line.id==="sencha"?{...line,note:"換一個做法"}:line)}});
  expect(different.status()).toBe(409);
  for(const invalid of [true,"字".repeat(81)]){
    const bad=await request.post("/api/orders",{data:{...submitted,items:[{id:"sencha",qty:1,note:invalid}]}});
    expect(bad.status()).toBe(400);
  }
  await page.unroute("**/api/ticket");
  await retry.click();
  await expect(page.locator(".orderLines li").filter({hasText:"日式熱煎茶"}).getByText(/分兩杯，標記 <熱>/)).toBeVisible();
  await expect(page.locator(".orderLines li").filter({hasText:"海苔柴魚煎餃"}).getByText(/醬另外放/)).toBeVisible();

  const id=accepted.id,number=String(id).padStart(4,"0");
  const advance=(from,to)=>request.patch("/api/kitchen/status",{headers:staff,data:{id,from,to}});
  expect((await advance("pending","preparing")).ok()).toBe(true);
  await page.goto("/kitchen/station-work");
  const card=page.locator(".kitchenTicket").filter({has:page.getByRole("heading",{name:"#"+number,exact:true})});
  await expect(card.getByText(/醬另外放/)).toBeVisible();
  await expect(card.getByText(/分兩杯/)).toHaveCount(0);
  await card.getByRole("button",{name:"本站已備妥"}).click();
  await page.getByRole("button",{name:"飲品台"}).click();
  await expect(card.getByText(/分兩杯，標記 <熱>/)).toBeVisible();
  await expect(card.getByText(/醬另外放/)).toHaveCount(0);
  const snapshot=await (await request.get("/api/kitchen/stations",{headers:staff})).json();
  expect(snapshot.orders.find(order=>order.id===id).items.map(({note})=>note)).toEqual([dumplings,tea]);
  await card.getByRole("button",{name:"本站已備妥"}).click();
  await expect(page.getByRole("status")).toContainText("各站已備妥");
  await page.goto("/kitchen/handoff?id="+number);
  await page.emulateMedia({media:"print"});
  await expect(page.locator(".orderLines li").filter({hasText:"日式熱煎茶"}).getByText(/分兩杯，標記 <熱>/)).toBeVisible();
  await expect(page.locator(".orderLines li").filter({hasText:"海苔柴魚煎餃"}).getByText(/醬另外放/)).toBeVisible();
  expect((await advance("ready","completed")).ok()).toBe(true);
});
