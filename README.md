# Pass Rail｜把一張桌單送到兩個廚房工作站

A03 桌點一碗雞肉親子丼、兩杯日式熱煎茶。店員接單後，熱台收到一張丼飯單，飲品台收到一張煎茶單，各自看得到桌號、數量與備註。若分站已經存單，但配送程序還來不及記下回覆就關閉，重啟後可以查回原來那張單。

這個本機工具包含一個配送程式與可獨立重啟的 HTTP 分站。每站用自己的 SQLite 收件匣保存單據，可匯出繁中 HTML 再以瀏覽器列印。系統確認的範圍到分站存單為止，實體印表機的紙張與出紙狀態由現場確認。

## 五分鐘重跑 A03

使用 Python 3.12 或更新版本，僅需標準函式庫。在兩個終端機分別啟動熱台與飲品台。服務只監聽本機。

```sh
python station.py --db hot.db serve hot --port 8765
```

```sh
python station.py --db bar.db serve bar --port 8766
```

在第三個終端機匯入隨附的合成訂單，並送到兩個分站。

```sh
python rail.py --db rail.db sync examples/kitchen.json examples/routes.json
python rail.py --db rail.db deliver hot http://127.0.0.1:8765
python rail.py --db rail.db deliver bar http://127.0.0.1:8766
python rail.py --db rail.db status
python station.py --db bar.db list
```

第 17 號 A03 餐單產生兩張分站單。第 18 號外帶單還在等候接單，所以這次不出單。再跑一次匯入與配送就能檢查兩站的收件匣各只有一張。複製飲品台清單輸出的 `key`，代入以下命令即可取得列印用檔案。

```sh
python station.py --db bar.db export KEY bar-ticket.html
```

## 回覆遺失時怎麼辦

| 配送狀態 | 店員可採取的動作 |
| --- | --- |
| `queued` 等候出單 | 執行該站的 `deliver`。送出前先在配送帳記錄這次嘗試。 |
| `review` 待確認 | 執行 `reconcile` 查詢分站是否存有相同單號與內容摘要。連不到分站時，該單繼續等待確認。 |
| `accepted` 已收件 | 可從該分站的 `list` 找到單據並匯出。 |
| `skipped` 已停止 | 訂單已出餐、結單或取消，待送的分站單停止配送。 |

```sh
python rail.py --db rail.db reconcile bar http://127.0.0.1:8766
```

若分站確認查無此單，而且廚房仍在製作，狀態回到 `queued`，可再執行 `deliver`。若已結單且先前嘗試過配送，分站會在同一交易中確認已有單據，或記下停發紀錄。就算舊的配送請求稍後才到，該站也會遵守這個結果。每個廚房及每個分站應持續使用自己的資料庫；去重需要保留這些紀錄。

## 從禾日食堂接單

可用 `pull` 讀取自架禾日食堂的完整店員 API。將該環境的店員金鑰放在 `HEY_TABLE_STAFF_KEY`，把下列網址換成自己的服務位址。配送前重新讀取廚房狀態，分站依最新一次觀測到的狀態出單。

```sh
python rail.py --db rail.db pull http://127.0.0.1:18841 examples/routes.json
```

在禾日食堂私人預覽中，店員可從接單台選擇「下載分站出單檔」，再以 `python rail.py --db rail.db sync 下載的檔案.json examples/routes.json` 匯入。檔案包含分站所需的桌號、餐點數量、備註與狀態。

完整 API 與店員匯出檔涵蓋所有處理中的訂單，以及最近 20 張結單。配送帳會保存完整清單已涵蓋的最大訂單編號，並停發範圍內已離開清單的工作。將昨天的檔案匯入今天的帳本時，後成立的新單可繼續配送，早已離開清單的舊單也不會復活。傳入普通 JSON 陣列時，程式只更新列出的編號。第一次接單時會保存當下的分站內容，後續改動分站設定不會把已成立的熱台單改派他站。

## 重跑故障與整合測試

```sh
python -m unittest -v
git clone https://github.com/peca12968/hey-table.git ../hey-table
git -C ../hey-table checkout 704617a3b3b02dff6ec10265aba04ddb8217a9a3
npm ci --prefix ../hey-table --include=optional
node kitchen-demo.mjs ../hey-table
```

整合演練使用 Node.js 24，在本機啟動點餐 Worker、D1 及兩個分站程序。它實際送單、接單、從 HTTP 匯入餐單、匯出分站 HTML，並建立 20 張較新的結單來核對舊單停發。故障測試另在分站寫入後強制終止配送子程序，讓八個配送者競領同一張待送單，並讓遲到的送單請求與停發請求同時抵達 16 次。[配送實作](rail.py) · [故障測試](test_rail.py) · [跨專案演練](kitchen-demo.mjs)

本專案以 AI 輔助開發。展示資料與分站均為本機演練環境。
