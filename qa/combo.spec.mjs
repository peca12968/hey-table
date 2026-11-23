import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";

test("mobile table applies the best bundles, pays with 全支付 and splits the discounted receipt",async({page,request})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto("/?table=A03");
  for(const name of ["滑蛋豬排丼","雞肉親子丼","海苔柴魚煎餃","日式熱煎茶"])
    await page.getByRole("button",{name:"加入"+name,exact:true}).click();
  const cart=page.getByRole("button",{name:/我的餐單/});
  await expect(cart).toContainText("NT$ 490");
  await cart.click();
  const choice=page.getByRole("checkbox",{name:/套用套餐優惠/});
  await expect(choice).not.toBeChecked();
  await choice.check();
  await expect(page.locator("aside .total")).toContainText("NT$ 415");
  await page.getByRole("button",{name:"減少日式熱煎茶"}).click();
  await expect(page.locator("aside .total")).toContainText("NT$ 400");
  await page.getByRole("button",{name:"關閉",exact:true}).click();
  await page.getByRole("button",{name:"加入日式熱煎茶",exact:true}).click();
  await page.reload();
  await expect(cart).toContainText("NT$ 415");
  await cart.click();
  await page.getByRole("combobox").selectOption("px_pay_plus");
  await page.getByRole("button",{name:"確認送出訂單"}).click();
  await page.waitForURL("**/ticket#*");
  const ticket=async()=> (await request.get("/api/ticket",{headers:{"X-Ticket":new URL(page.url()).hash.slice(1)}})).json();
  const first=await ticket();
  expect([first.table,first.paymentMethod,first.combo.quote.discount,first.total]).toEqual(["A03","px_pay_plus",75,415]);
  await expect(page.getByText("餐點原價 NT$ 490 · 套餐折抵 NT$ 75")).toBeVisible();
  await page.getByRole("button",{name:"開始模擬付款 · NT$ 415"}).click();
  await page.getByRole("button",{name:"模擬付款成功"}).click();
  await expect(page.getByText("已付款",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:/這張餐單怎麼分帳/}).click();
  const split=page.getByRole("region",{name:"每人應付"});
  const amounts=await split.locator("dd").allTextContents();
  expect(amounts.map(s=>Number(s.replace("NT$ ",""))).reduce((a,b)=>a+b,0)).toBe(415);
  expect(await ticket()).toEqual({...first,paymentState:"paid"});
});

test("order retries keep their agreed price and reject a different pricing intent",async({request})=>{
  const headers={Authorization:"Bearer local-test-kitchen"};
  const stock=available=>request.patch("/api/kitchen/availability",{headers,data:{id:"sencha",available}});
  const send=data=>request.post("/api/orders",{data});
  const raw={token:randomUUID(),mode:"pickup",note:"",paymentMethod:"line_pay",
    items:[{id:"katsudon",qty:1,price:1},{id:"sencha",qty:1}],total:1};
  const deal={...raw,comboVersion:"demo-v1",expectedTotal:200};
  for(const change of [{expectedTotal:1},{comboVersion:"unknown"},{items:[raw.items[0]]}])
    expect((await send({...deal,...change})).status()).toBe(409);
  const [first,second]=await Promise.all([send(deal),send(deal)].map(async p=>(await p).json()));
  expect(first.total).toBe(200);
  expect(first).toEqual(second);
  const legacy={...raw,token:randomUUID()};
  const original=await (await send(legacy)).json();
  expect(original.total).toBe(235);
  expect(original).not.toHaveProperty("combo");
  expect((await stock(false)).status()).toBe(200);
  try{
    expect(await (await send(deal)).json()).toEqual(first);
    expect(await (await send(legacy)).json()).toEqual(original);
    expect((await send({...deal,token:randomUUID()})).status()).toBe(409);
    expect((await send(raw)).status()).toBe(409);
    expect((await send({...deal,token:legacy.token})).status()).toBe(409);
  }finally{
    expect((await stock(true)).status()).toBe(200);
  }
});
