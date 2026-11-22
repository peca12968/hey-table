# Bay Signal｜斷線後接回裝卸月台的狀態更新

值班看板顯示各月台是待命、裝貨中，還是已關閉。瀏覽器斷線後，可用最後收到的事件編號向服務補取更新；若離線太久，服務會傳一份含版本號的完整快照，供看板取代舊狀態。

## 本機演練

使用 Node.js 24.12 或更新版本，在儲存庫根目錄執行：

```sh
npm ci
npm start
```

服務在 `127.0.0.1:8080` 接受本機操作，資料寫入 `board.db`。另開終端機執行 `curl -N http://127.0.0.1:8080/events` 觀察事件。再從有 Node 的終端機提交一筆異動：

```sh
node -e "fetch('http://127.0.0.1:8080/updates',{method:'POST',body:JSON.stringify({command:'shift-1',bay:'A',status:'loading'})}).then(r=>r.json()).then(console.log)"
```

訂閱者先收到 `snapshot`，再收到 A 月台的 `change`。初次提交的 HTTP 狀態碼為 201，以相同單號與內容重送會取得原始事件 ID 和 200；同單號改送其他狀態則為 409。月台狀態可取 ready、loading、closed。服務供受信任的本機操作環境使用。

## 先讀取快照，再訂閱即時異動

`GET /snapshot` 回傳與事件串流相同的 `{id, event, data}` JSON。看板可先顯示目前狀態，再用快照的 `id` 開啟串流。讀取與開始訂閱之間有其他人更新時，服務會補送這段期間的異動。

```js
const snapshot = await (await fetch("/snapshot")).json();
const feed = new EventSource("/events?since=" + encodeURIComponent(snapshot.id));
```

快照附有包含資料庫識別碼和版本的 ETag。瀏覽器再次讀取時可用條件式 GET 確認版本，版本相同時服務回覆 304，直接略過月台資料表讀取。版本與月台明細在同一筆 SQLite 讀取交易中取得。只需要表頭的客戶端也可使用 HEAD。

第一次連上串流時使用 `since`。瀏覽器斷線後，服務優先使用原生 `Last-Event-ID`，會從最近送達的事件接續。瀏覽器測試同時核對伺服器的 200 → 304 → 200 回應，以及快照之後兩筆事件只各收到一次。[瀏覽器演練](browser.test.ts)

## 續接規則

每個事件 ID 由資料庫識別碼與遞增版本組成。更新、月台狀態、單號回條與歷史清理在同一筆 SQLite 交易中提交。預設保留最近 256 筆異動，可用環境變數 `BAY_RETENTION` 調整；回條會持續保留，舊命令重送時仍可辨識。

- 瀏覽器使用原生 `EventSource`，重連時會帶上 `Last-Event-ID`。若中間的版本都還在，就依序送出漏掉的異動。短暫離線後最多每批讀取 64 筆，慢速訂閱者會等寫入緩衝區可用後繼續。
- 首次訂閱、游標超出範圍、來自另一份資料庫或已無法補齊時，改送同一個讀取交易中的月台快照與版本。前端應以快照取代狀態，之後依月台套用增量。
- 訂閱端每 150 毫秒檢查資料庫，因此其他服務程序寫入的異動也能被看見。閒置時每 15 秒傳遞註解以維持連線。[Server-sent events 規格](https://html.spec.whatwg.org/multipage/server-sent-events.html)

## 驗證真正的瀏覽器重連

```sh
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

瀏覽器測試將保留量設成 2。收到第 1 版後切斷 HTTP 連線，期間提交第 2、3 版，Chromium 自動送出第 1 版游標並依序收到兩筆。再次斷線時連續提交第 4、5、6 版，第 3 版游標已無法補齊，瀏覽器收到第 6 版快照與三個月台的末態。資料庫測試另核對程序重新開啟、過期命令重送與同鍵衝突。[瀏覽器演練](browser.test.ts) · [資料庫測試](board.test.ts)

本專案使用 AI 輔助開發，示範資料為合成月台狀態。
