import {test,expect} from "@playwright/test";

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
