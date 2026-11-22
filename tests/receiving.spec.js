import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";

const test = base.extend({
  station: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), "dock-test-"));
    const path = join(dir, "test.sqlite3");
    const child = spawn(process.execPath, ["server.mjs"], {
      env: { ...process.env, PORT: "0", DOCK_DB: path }, stdio: ["ignore", "pipe", "inherit"]
    });
    const finished = once(child, "exit");
    const output = createInterface({ input: child.stdout });
    try {
      const [line] = await Promise.race([
        once(output, "line"), finished.then(() => { throw new Error("Server exited before startup"); })
      ]);
      const url = line.split(" ").at(-1);
      const rows = () => {
        const db = new DatabaseSync(path, { readOnly: true });
        try { return db.prepare("SELECT sku,quantity FROM receipts ORDER BY rowid").all(); }
        finally { db.close(); }
      };
      await use({ url, rows });
    } finally {
      child.kill();
      await finished;
      output.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});
const send = page => page.getByRole("button", { name: "送出收貨" });
async function open(page, url) {
  await page.goto(url);
  await expect(page.getByText("離線頁面已就緒")).toBeVisible();
}
async function add(page, sku, quantity) {
  await page.getByLabel("料號").fill(sku);
  await page.getByLabel("收貨數量").fill(String(quantity));
  await page.getByRole("button", { name: "加入待送清單" }).click();
  await expect(page.getByRole("status")).toHaveText(sku.toUpperCase() + " 已存入本機。");
}

test("offline reopen, lost acknowledgement and replay preserve one receipt per operation", async ({ page, context, station }, info) => {
  await open(page, station.url);
  await context.setOffline(true);
  await add(page, "bx-19", 7);
  await add(page, "CR-42", 3);
  await expect(page.getByText("目前離線")).toBeVisible();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(station.url);
  await expect(reopened.locator("tbody tr")).toHaveCount(2);
  await expect(reopened.locator("tbody tr").first()).toContainText("BX-19");
  await reopened.screenshot({ path: info.outputPath("offline.png") });
  await context.setOffline(false);
  const replies = [];
  await reopened.route("**/api/receipts", async route => {
    const response = await route.fetch();
    replies.push(response.status());
    await route.abort("failed");
  });
  await send(reopened).click();
  await expect(reopened.getByRole("status")).toContainText("未收到確認");
  expect(replies).toEqual([201]);
  expect(station.rows()).toEqual([{ sku: "BX-19", quantity: 7 }]);
  await reopened.reload();
  await expect(reopened.locator("tbody tr")).toHaveCount(2);
  await reopened.unroute("**/api/receipts");
  reopened.on("response", response => {
    if (response.url().endsWith("/api/receipts")) replies.push(response.status());
  });
  await send(reopened).click();
  await expect(reopened.getByRole("status")).toHaveText("已確認 2 筆收貨。");
  await expect(reopened.getByText("清單目前是空的")).toBeVisible();
  expect(replies).toEqual([201, 200, 201]);
  expect(station.rows()).toEqual([{ sku: "BX-19", quantity: 7 }, { sku: "CR-42", quantity: 3 }]);
});

test("a conflicting receipt stops the queue and leaves the unsent tail intact", async ({ page, request, station }) => {
  await open(page, station.url);
  await add(page, "BX-19", 4);
  await add(page, "CR-42", 6);
  await add(page, "AX-21", 8);
  const records = await page.evaluate(async () => {
    const queue = await import("/outbox.js");
    const db = await queue.openOutbox();
    try { return await queue.pending(db); } finally { db.close(); }
  });
  const seeded = await request.post(station.url + "/api/receipts", { data: { ...records[1], quantity: 2 } });
  expect(seeded.status()).toBe(201);
  await send(page).click();
  await expect(page.getByRole("status")).toContainText("HTTP 409");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  expect(station.rows()).toEqual([{ sku: "CR-42", quantity: 2 }, { sku: "BX-19", quantity: 4 }]);
  await expect(page.getByText("本機 CR-42 × 6 件。已入帳 CR-42 × 2 件。")).toBeVisible();
  await page.getByRole("button", { name: "採用已入帳資料並移除此待送項目" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await send(page).click();
  await expect(page.getByRole("status")).toHaveText("已確認 1 筆收貨。");
  expect(station.rows()).toEqual([{ sku: "CR-42", quantity: 2 }, { sku: "BX-19", quantity: 4 }, { sku: "AX-21", quantity: 8 }]);
});

test("independent entries for the same SKU survive narrow-screen entry and cross-tab updates", async ({ page, context, station }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await open(page, station.url);
  const other = await context.newPage();
  await open(other, station.url);
  await add(page, "BX-19", 7);
  await add(other, "BX-19", 7);
  await expect(page.locator("tbody tr")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  await send(page).click();
  await expect(other.getByText("清單目前是空的")).toBeVisible();
  expect(station.rows()).toEqual([{ sku: "BX-19", quantity: 7 }, { sku: "BX-19", quantity: 7 }]);
});
