import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import jsQR from "jsqr";
import {PNG} from "pngjs";

test("decode the printed table card and send a mobile order to an independent kitchen",async({browser,page})=>{
  await page.goto("/tables");
  const code=page.getByRole("img",{name:"A03 桌點餐 QR Code"});
  await expect(code).toBeVisible();
  const png=PNG.sync.read(await code.screenshot());
  const scanned=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);
  expect(scanned?.data).toBe("http://127.0.0.1:18841/?table=A03");
  const guest=await browser.newContext({viewport:{width:390,height:844}});
  try{
    const mobile=await guest.newPage();await mobile.goto(scanned.data);
    await mobile.getByRole("button",{name:"加入滑蛋豬排丼",exact:true}).click();
    await mobile.getByRole("button",{name:"我的餐單",exact:false}).click();
    await mobile.getByRole("textbox").fill("不用餐具");
    await mobile.getByRole("button",{name:"確認送出訂單"}).click();
    await expect(mobile.getByRole("heading",{name:/取餐號碼/})).toBeVisible();
    await expect(mobile.getByText("A03 桌內用")).toBeVisible();
    await page.goto("/kitchen");
    await page.getByText("使用自架店員金鑰").click();
    await page.getByLabel("店員金鑰",{exact:true}).fill("local-test-kitchen");
    await page.getByRole("button",{name:"登入",exact:true}).click();
    const ticket=page.locator(".kitchenTicket").filter({hasText:"不用餐具"});
    await ticket.getByRole("button",{name:"接單製作"}).click();
    await ticket.getByRole("button",{name:"完成製作"}).click();
    await mobile.getByRole("button",{name:"更新進度"}).click();
    await expect(mobile.getByText("可取餐",{exact:true})).toBeVisible();
    await ticket.getByRole("button",{name:"完成交餐"}).click();
    await mobile.getByRole("button",{name:"更新進度"}).click();
    await expect(mobile.getByText("已完成",{exact:true})).toBeVisible();
  }finally{await guest.close();}
});

test("pickup, retries, price authority, sold-out race and stale state transitions",async({page,request})=>{
  await page.goto("/");
  await page.getByRole("button",{name:"飲品",exact:true}).click();
  await page.getByRole("button",{name:"加入日式熱煎茶",exact:true}).click();
  await page.getByRole("button",{name:"確認送出訂單"}).click();
  await expect(page.getByRole("heading",{name:/取餐號碼/})).toBeVisible();
  await expect(page.getByText("線上自取",{exact:true})).toBeVisible();
  const admin={Authorization:"Bearer local-test-kitchen"};
  expect((await request.get("/api/kitchen")).status()).toBe(403);
  const data={token:randomUUID(),mode:"pickup",table:null,note:"",total:1,items:[{id:"gyoza",qty:2,price:1}]};
  const posts=await Promise.all([1,2,3].map(()=>request.post("/api/orders",{data})));
  const rows=await Promise.all(posts.map(r=>r.json()));
  expect(new Set(rows.map(r=>r.id)).size).toBe(1);expect(rows[0].total).toBe(170);
  expect((await request.post("/api/orders",{data:{...data,note:"不同"}})).status()).toBe(409);
  expect((await request.get("/api/ticket",{headers:{"X-Ticket":randomUUID()}})).status()).toBe(404);
  await request.patch("/api/kitchen/availability",{headers:admin,data:{id:"gyoza",available:false}});
  expect((await request.post("/api/orders",{data:{...data,token:randomUUID()}})).status()).toBe(409);
  expect((await request.post("/api/orders",{data})).status()).toBe(200);
  await request.patch("/api/kitchen/availability",{headers:admin,data:{id:"gyoza",available:true}});
  const change={id:rows[0].id,from:"pending",to:"preparing"};
  const race=await Promise.all([1,2].map(()=>request.patch("/api/kitchen/status",{headers:admin,data:change})));
  expect(race.map(r=>r.status()).sort()).toEqual([200,409]);
  expect((await request.post("/api/orders",{data:{...data,mode:"table",table:"Z99",token:randomUUID()}})).status()).toBe(400);
});
