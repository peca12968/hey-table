# 禾日食堂｜線上自取與桌邊掃碼點餐

客人從首頁送自取單，或掃描桌牌進入該桌菜單，加購餐點、填備註並取得取餐號碼。店家在另一台裝置接單、製作、交餐或標示售完，客人的收據會自動更新。這是繁中示範餐廳，菜單價格採新台幣，付款方式為現場付款。

[私人點餐預覽](https://hey-table-peca12968.peca12968.chatgpt.site) · [可列印桌牌](https://hey-table-peca12968.peca12968.chatgpt.site/tables) · [店家後台](https://hey-table-peca12968.peca12968.chatgpt.site/kitchen)

![桌面點餐菜單與餐單](docs/menu.png)

## 用兩台裝置試點一單

1. 在 `/tables` 列印 A01 到 A08 桌牌。掃描 A03 後，菜單與收據顯示「A03 桌內用」。從首頁開啟則預設線上自取。託管預覽與桌牌連結都需有網站存取權。
2. 加入滑蛋豬排丼 NT$190，可增減數量、加備註，再確認送單。保留收據連結即可查這張餐單；同一裝置也能從「查詢餐單」找回最近一單。
3. 店主在 `/kitchen` 接單，依序切換製作中、可取餐、已完成。待接單時也能取消。收據每五秒更新一次，可手動更新。後台可暫停售餐，再恢復供應。

## 廚房備料單

從店家接單台選「查看備料單」，可分欄查看待接單與製作中的份數，列印當下的需求，或下載同一批訂單的 JSON。取消、可取餐與已完成的訂單均排除。按「重新擷取」才會更新畫面與下載內容。需要核對食材時，將下載檔交給 [Prep Sheet](https://github.com/peca12968/prep-sheet)，搭配食譜和現有備料量換算要煮幾鍋、要補幾包。下載檔只含訂單編號、時間、狀態、品項代碼與份數。

## 技術與一致性

React、Vinext、Cloudflare Workers、D1 SQLite 與 Drizzle 遷移。訂單與售完狀態由資料庫共用，裝置只保存草稿與最近的查單憑證。伺服器按菜單定價，使用同一個 SQL 寫入檢查售完狀態；每次確認送單使用唯一識別碼，重送可找回原單。廚房更新會比對舊狀態，兩台裝置同時接單只有一台成功。查單使用隨機憑證，取餐號碼可顯示給客人。

託管後台以 Sites 提供的已驗證身分及 `STAFF_EMAIL` 授權。自架時請使用 `STAFF_KEY`，或使用能移除外部身分標頭並重新注入可信身分的代理。正式金鑰與店主電子郵件皆由執行環境提供。

## 本機重跑

使用 Node.js 24 和 npm。在專案目錄建置，初始化本機 D1，再啟動服務。資料庫遷移在新的本機資料庫上執行一次。

```sh
npm ci --include=optional
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_fresh_white_tiger.sql
npm start
```

要在自己的機器測店員流程，可用 `npm start -- --var STAFF_KEY:local-demo-only` 啟動，並在店家後台的「使用自架店員金鑰」輸入相同值。這個範例值僅用於本機演練。

## 端對端驗證

```sh
npm ci --prefix qa
cd qa
npx playwright install chromium
npx playwright test
```

測試會啟動獨立的本機 Worker 與 D1。它把桌牌在瀏覽器渲染後的 PNG 交給獨立 QR 解碼器，再用 390 px 手機畫面實際開啟碼內網址、送單，並從另一個瀏覽器身分交餐。另一個案例涵蓋線上自取、三次並發重送、售完時送單、改價輸入、後台權限及兩名店員搶接一張單。[瀏覽器測試](qa/ordering.spec.mjs) · [手機畫面](docs/table.png)

專案以 AI 輔助開發，餐點圖片為生成的示意照片。[圖片說明](public/food/CREDITS.md)
