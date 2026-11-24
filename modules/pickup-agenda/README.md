# Pickup Agenda｜自取餐點行事曆

17 號客人點餐後，廚房估計中午 12:08～12:10 可以取餐。店員可以先將估算匯入行事曆，與客人約定 12:15 後確認，再依需要改期。每次更新沿用同一個事件識別碼與訂閱網址。取消取餐安排只更新行事曆，原始訂單與付款紀錄仍由點餐平台管理。

禾日食堂的預約收據也可下載 `.ics` 檔。整合測試以 ICAL.js 讀取收據匯出的確認、改期與取消版本，核對固定事件識別碼與 UTC 起訖時間。[收據下載流程](../../README.md#預約當天自取時段)

## 用範例重跑

以下 PowerShell 範例使用 Python 3.12、全新的本機資料庫與合成餐單。時間均為台灣時間。

```powershell
python -m pip install -r requirements.txt
$event = python pickup.py lunch.db propose demo 17 examples/stations.json examples/estimate.json | ConvertFrom-Json
python pickup.py lunch.db confirm $event.uid --expect 0 --start 2026-11-23T12:15:00+08:00 --end 2026-11-23T12:20:00+08:00
python pickup.py lunch.db confirm $event.uid --expect 1 --start 2026-11-23T12:25:00+08:00 --end 2026-11-23T12:30:00+08:00
python pickup.py lunch.db export $event.uid pickup.ics
"http://127.0.0.1:8080/calendar/$($event.uid).ics"
python pickup.py lunch.db serve --port 8080
```

將印出的網址交給同一台電腦上的行事曆用戶端訂閱。也可直接開啟匯出的 `pickup.ics` 查看單次快照。服務只監聽本機，雲端行事曆伺服器無法直接讀取這個網址。訂閱端實際更新的時間取決於其重新整理頻率。

按 Ctrl+C 停止服務後，在同一個 PowerShell 工作階段執行下列命令，再開啟同一訂閱。事件的第四個版本會帶有取消狀態。

```powershell
python pickup.py lunch.db cancel $event.uid --expect 2
python pickup.py lunch.db serve --port 8080
```

## 資料與同步行為

- 輸入包含同一擷取時刻的廚房快照與取餐估算。工具逐筆核對餐號、製作狀態、自取方式，以及估算秒數與實際時間是否一致。門市、餐號和下單時刻共同辨識一張單，支援不同門市及重用餐號。[Hey Table](../../README.md) · [Pickup Window](../pickup-window/README.md)
- 初次估算為暫定。店員確認後，後續廚房估算無法蓋掉已約定的時間。每次實質改動會在 SQLite 交易內追加一版。兩位店員同時提交不同改期時，只有符合預期版本的修改會生效。重送已成功建立該版的原命令可取回原結果。
- 行事曆事件使用固定的 `UID` 和遞增的 `SEQUENCE`。起訖時間轉為 UTC，結束時間為區間的排除端點。整秒的單點估算只帶開始時間。訂閱端可透過 ETag 檢查版本，內容未變時收到 HTTP 304。[iCalendar 格式規範 RFC 5545](https://www.rfc-editor.org/rfc/rfc5545)
- 事件摘要只含取餐號。廚房備註、明細與付款資料均不寫入行事曆。訂閱網址與資料庫應保存在使用者自己的裝置。

## 驗證

執行 `python -m unittest -v` 核對重送、資料衝突、門市區隔及八個寫入者同時搶改同一版本。整合測試從實際估算器產生範例，啟動本機 HTTP 訂閱端點，再用另一套函式庫 ICAL.js 解析四個版本，比對時間、狀態、固定識別碼、條件式請求與檔案匯出。

```powershell
$env:PICKUP_WINDOW = "../pickup-window"
npm ci
npm test
```
