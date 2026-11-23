import {test, expect} from "@playwright/test";
import {randomUUID} from "node:crypto";

const staff = {Authorization: "Bearer local-test-kitchen"};
const lines = (...ids) => ids.map(id => ({id, qty: 1}));

test("completed kitchen orders inform mobile table add-ons; stock, quantity and totals stay authoritative", async ({page, request}) => {
  const lookup = async items => {
    const response = await request.post("/api/add-on", {data: {items}});
    expect(response.status()).toBe(200);
    return response.json();
  };
  const stock = async available => {
    const response = await request.patch("/api/kitchen/availability", {headers: staff, data: {id: "gyoza", available}});
    expect(response.status()).toBe(200);
  };
  const move = async (id, from, to) => {
    expect((await request.patch("/api/kitchen/status", {headers: staff, data: {id, from, to}})).status()).toBe(200);
  };
  const complete = async items => {
    const response = await request.post("/api/orders", {data: {token: randomUUID(), mode: "pickup", items, note: "測試備註"}});
    expect(response.status()).toBe(200);
    const {id} = await response.json();
    await move(id, "pending", "preparing");
    await move(id, "preparing", "ready");
    await move(id, "ready", "completed");
  };
  expect((await request.post("/api/add-on", {data: {items: []}})).status()).toBe(400);
  expect(await lookup(lines("katsudon"))).toEqual({suggestion: {id: "sencha", source: "menu"}});
  for (let i = 0; i < 3; i++) await complete(lines("katsudon", "gyoza"));
  for (let i = 0; i < 2; i++) await complete(lines("sencha"));
  expect(await lookup(lines("katsudon"))).toEqual({suggestion: {id: "gyoza", source: "pair"}});
  expect(await lookup(lines("oyakodon"))).toEqual({suggestion: {id: "gyoza", source: "popular"}});
  expect(await lookup(lines("gyoza"))).toEqual({suggestion: null});
  await stock(false);
  try {
    expect(await lookup(lines("katsudon"))).toEqual({suggestion: {id: "sencha", source: "popular"}});
    expect(await lookup(lines("katsudon", "gyoza"))).toEqual({suggestion: null});
  } finally { await stock(true); }
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/?table=A03");
  await page.getByRole("button", {name:"加入滑蛋豬排丼", exact:true}).click();
  await page.getByRole("button", {name:/我的餐單/}).click();
  const region = page.getByRole("region", {name:"搭配加點"});
  await expect(region).toContainText("常一起點");
  await region.getByRole("button", {name:"加點海苔柴魚煎餃，NT$ 85"}).click();
  await expect(page.getByRole("button", {name:"增加海苔柴魚煎餃"})).toBeVisible();
  await expect(region.getByRole("button", {name:/海苔柴魚煎餃/})).toHaveCount(0);
  await page.getByRole("combobox").selectOption("line_pay");
  await page.getByRole("button", {name:"確認送出訂單"}).click();
  await page.waitForURL("**/ticket#*");
  const ticket = await (await request.get("/api/ticket", {headers: {"X-Ticket": new URL(page.url()).hash.slice(1)}})).json();
  expect([ticket.table, ticket.paymentMethod, ticket.total]).toEqual(["A03", "line_pay", 275]);
  expect(ticket.items.map(({id, qty}) => ({id, qty}))).toEqual(lines("katsudon", "gyoza"));
  await move(ticket.id, "pending", "cancelled");
});

test("a stale add-on reply and a lookup outage cannot change a pickup order", async ({page}) => {
  let started, release, done;
  const pending = new Promise(resolve => {started = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const finished = new Promise(resolve => {done = resolve;});
  let requests = 0;
  await page.route("**/api/add-on", async route => {
    if (++requests === 1) {
      started(); await gate;
      await route.fulfill({json: {suggestion: {id:"edamame", source:"menu"}}}).catch(() => {});
      done();
    } else {
      await route.fulfill({status:503, json:{error:"暫時無法推薦"}});
    }
  });
  await page.goto("/");
  await page.getByRole("button", {name:"加入雞肉親子丼", exact:true}).click();
  await pending;
  const failed = page.waitForResponse(r => r.url().endsWith("/api/add-on") && r.status() === 503);
  await page.getByRole("button", {name:"增加雞肉親子丼"}).click();
  await failed;
  release(); await finished;
  await expect(page.getByRole("region", {name:"搭配加點"})).toHaveCount(0);
  await page.getByRole("button", {name:"確認送出訂單"}).click();
  await expect(page.getByRole("heading", {name:/取餐號碼/})).toBeVisible();
});
