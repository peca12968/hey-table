import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {test,expect} from "@playwright/test";
import jsQR from "jsqr";
import {PNG} from "pngjs";
import {cartShareLink,readCartShare} from "../lib/cart-share.mjs";

const openCart=page=>page.getByRole("button",{name:/我的餐單/}).click();
const cart=page=>page.getByRole("complementary",{name:"我的餐單"});
const preview=page=>page.getByRole("region",{name:"核對分享的餐點"});
const confirm=page=>preview(page).getByRole("button",{name:"確認加入清單餐點"});

test("a shared cart merges only available portions on another phone and keeps the receiver's notes",async({page,browser})=>{
  await page.setViewportSize({width:360,height:780});
  await page.goto("/?table=A05");
  await page.getByRole("button",{name:"加入日式熱煎茶"}).click();
  await page.getByRole("button",{name:"加入滑蛋豬排丼",exact:true}).click();
  await openCart(page);
  await cart(page).getByRole("button",{name:"增加日式熱煎茶"}).click();
  await page.locator(".itemNotes summary").click();
  await page.getByLabel("日式熱煎茶備註").fill("分享者的品項備註");
  await page.getByLabel(/訂單備註/).fill("分享者的餐單備註");
  await cart(page).getByRole("button",{name:"分享點餐清單"}).click();
  const link=await cart(page).getByRole("textbox",{name:"點餐清單連結",exact:true}).inputValue();
  const url=new URL(link);
  expect(url.search).toBe("");
  expect(readCartShare(new URLSearchParams(url.hash.slice(1)).get("cart"))).toEqual([
    {id:"katsudon",qty:1},{id:"sencha",qty:2},
  ]);
  await page.evaluate(()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:{
    writeText:async text=>{window.copiedShare=text;},
  }}));
  await cart(page).getByRole("button",{name:"複製清單連結"}).click();
  expect(await page.evaluate(()=>window.copiedShare)).toBe(link);

  const receiver=await browser.newContext({viewport:{width:360,height:780}});
  try{
    const other=await receiver.newPage();
    let submits=0;
    other.on("request",req=>{if(req.method()==="POST"&&new URL(req.url()).pathname==="/api/orders")submits++;});
    await other.route("**/api/menu",async route=>{
      const response=await route.fetch(),real=await response.json();
      await route.fulfill({response,json:{...real,unavailable:[...new Set([...real.unavailable,"katsudon"])],
        remaining:{...real.remaining,sencha:2}}});
    });
    await other.goto(url.origin+"/");
    await other.getByRole("button",{name:"加入日式熱煎茶"}).click();
    await openCart(other);
    await other.getByLabel(/訂單備註/).fill("接收者自取備註");
    await other.locator(".itemNotes summary").click();
    await other.getByLabel("日式熱煎茶備註").fill("接收者品項備註");
    await other.evaluate(hash=>{location.hash=hash;},url.hash);
    const review=preview(other);
    await expect(review.getByText("清單 2 份 · 可加入 1 份")).toBeVisible();
    await expect(review.getByText("已售完",{exact:true})).toBeVisible();
    await expect(review.getByText("加入後共 2 份")).toBeVisible();
    expect(await other.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
    expect(submits).toBe(0);
    await confirm(other).click();
    await expect(review).toHaveCount(0);
    expect(new URL(other.url()).hash).toBe("");
    await expect(cart(other).getByText("2 件")).toBeVisible();
    await expect(other.getByLabel(/訂單備註/)).toHaveValue("接收者自取備註");
    await expect(other.getByLabel("日式熱煎茶備註")).toHaveValue("接收者品項備註");
    await expect(other.getByRole("button",{name:"確認送出訂單"})).toBeEnabled();
    expect(submits).toBe(0);
    await other.reload();
    await openCart(other);
    await expect(cart(other).getByText("2 件")).toBeVisible();
  }finally{await receiver.close();}
});

test("another tab's edits and unresolved checkout take precedence over a shared cart preview",async({page,context,baseURL})=>{
  await page.setViewportSize({width:360,height:780});
  await page.goto(cartShareLink(baseURL,[{id:"sencha",qty:2}]));
  await expect(confirm(page)).toBeEnabled();
  const second=await context.newPage();
  const draft={token:randomUUID(),mode:"pickup",table:null,note:"保留原送單",items:[{id:"edamame",qty:1}]};
  try{
    await second.goto("/api/menu");
    await second.evaluate(()=>localStorage.setItem("he-ri-cart-v1:pickup:edit:initial",JSON.stringify({
      cart:{sencha:1},note:"另一個分頁加了一杯",
    })));
    await confirm(page).click();
    await expect(preview(page).getByRole("status")).toHaveText("另一個分頁已更新餐單，請核對加入後的份數。");
    await expect(preview(page).getByText("加入後共 3 份")).toBeVisible();
    await expect(page.getByLabel(/訂單備註/)).toHaveValue("另一個分頁加了一杯");
    await second.evaluate(value=>localStorage.setItem("he-ri-cart-v1:pickup",JSON.stringify({
      draft:value,cart:{edamame:1},note:value.note,
    })),draft);
    await confirm(page).click();
    await expect(preview(page).getByRole("status")).toHaveText("另一個分頁正在確認送單，已保留原餐單。");
    await expect(confirm(page)).toBeDisabled();
    await expect(cart(page).getByText("1 件")).toBeVisible();
    expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("he-ri-cart-v1:pickup")).draft)).toEqual(draft);
  }finally{await second.close();}
});

test("a table QR keeps its table when a shared list is pasted and manually submitted",async({page,baseURL})=>{
  await page.setViewportSize({width:360,height:780});
  await page.goto("/tables");
  const qr=page.getByRole("img",{name:"A06 桌點餐 QR Code"});
  await expect(qr).toBeVisible();
  const image=PNG.sync.read(await qr.screenshot());
  const scanned=jsQR(new Uint8ClampedArray(image.data),image.width,image.height);
  expect(new URL(scanned?.data).searchParams.get("table")).toBe("A06");
  await page.goto(scanned.data);
  const payloads=[];
  page.on("request",req=>{
    if(req.method()==="POST"&&new URL(req.url()).pathname==="/api/orders")payloads.push(req.postDataJSON());
  });
  await openCart(page);
  await cart(page).getByRole("button",{name:"貼上點餐清單"}).click();
  const input=cart(page).getByRole("textbox",{name:"分享清單連結"});
  const inspect=cart(page).getByRole("button",{name:"在A06桌預覽"});
  const shared=new URL(cartShareLink(baseURL,[{id:"sencha",qty:2}]));
  await input.fill("https://example.com/"+shared.hash);
  await inspect.click();
  await expect(cart(page).getByRole("alert")).toHaveText("請貼上這個點餐網站產生的分享清單連結。");
  shared.searchParams.set("table","A08");
  await input.fill(shared.href);
  await inspect.click();
  await expect(preview(page).getByRole("heading")).toBeFocused();
  await expect(preview(page).getByText("A06 桌內用",{exact:true})).toBeVisible();
  await expect(preview(page).getByText("清單 2 份 · 可加入 2 份")).toBeVisible();
  expect(payloads).toHaveLength(0);
  await confirm(page).click();
  await expect(preview(page)).toHaveCount(0);
  await expect(cart(page).getByText("2 件")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("table")).toBe("A06");
  expect(new URL(page.url()).hash).toBe("");
  expect(payloads).toHaveLength(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await page.getByRole("button",{name:"確認送出訂單"}).click();
  await page.waitForURL("**/ticket#*");
  await expect(page.getByText("A06 桌內用",{exact:true})).toBeVisible();
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({mode:"table",table:"A06",items:[{id:"sencha",qty:2}]});
});

test("a shared cart QR and its downloaded image follow the current list across phones",async({page,browser})=>{
  await page.setViewportSize({width:360,height:780});
  await page.goto("/?table=A05");
  await page.getByRole("button",{name:"加入日式熱煎茶"}).click();
  await page.getByRole("button",{name:"加入滑蛋豬排丼",exact:true}).click();
  await openCart(page);
  await page.getByLabel(/訂單備註/).fill("分享時保留在原手機");
  await cart(page).getByRole("button",{name:"分享點餐清單"}).click();
  const image=cart(page).getByRole("img",{name:"點餐清單 QR 碼",exact:true});
  await expect(image).toHaveCount(0);
  await cart(page).getByRole("button",{name:"顯示清單 QR 碼"}).click();
  await expect(image).toBeVisible();
  const decode=async()=>{
    const png=PNG.sync.read(await image.screenshot());
    return jsQR(new Uint8ClampedArray(png.data),png.width,png.height)?.data;
  };
  const textbox=cart(page).getByRole("textbox",{name:"點餐清單連結",exact:true});
  const original=await decode();
  expect(original).toBe(await textbox.inputValue());
  await cart(page).getByRole("button",{name:"增加日式熱煎茶"}).click();
  await expect(textbox).not.toHaveValue(original);
  const link=await decode();
  expect(link).toBe(await textbox.inputValue());
  expect(new URL(link).search).toBe("");
  expect(readCartShare(new URLSearchParams(new URL(link).hash.slice(1)).get("cart"))).toEqual([
    {id:"katsudon",qty:1},{id:"sencha",qty:2},
  ]);
  const [file]=await Promise.all([page.waitForEvent("download"),cart(page).getByRole("link",{name:"下載清單 QR 碼"}).click()]);
  expect(file.suggestedFilename()).toBe("heri-order-list.gif");
  const src=await image.getAttribute("src");
  expect(await readFile(await file.path())).toEqual(Buffer.from(src.split(",")[1],"base64"));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  const receiver=await browser.newContext({viewport:{width:360,height:780}});
  try{
    const other=await receiver.newPage();
    let submitted=false;
    other.on("request",req=>{if(req.method()==="POST"&&new URL(req.url()).pathname==="/api/orders")submitted=true;});
    await other.goto(link);
    const check=preview(other);
    await expect(check.getByText("線上自取",{exact:true})).toBeVisible();
    await expect(check.getByText("清單 2 份 · 可加入 2 份")).toBeVisible();
    await expect(cart(other).getByText("0 件")).toBeVisible();
    await confirm(other).click();
    await expect(cart(other).getByText("3 件")).toBeVisible();
    await expect(other.getByLabel(/訂單備註/)).toBeEmpty();
    expect(submitted).toBe(false);
  }finally{await receiver.close();}
  await cart(page).getByRole("button",{name:"收起 QR 碼"}).click();
  await expect(image).toHaveCount(0);
  await expect(textbox).toHaveValue(link);
});
