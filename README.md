# Stockroom Reservations｜庫存保留 API

兩個人同時搶最後一件商品時，誰能完成保留？付款頁遇到網路逾時而重送時，又該扣幾次庫存？這個 FastAPI 服務用 SQLite 交易處理這兩種情境。內附一個有 20 件庫存的示範商品 `KIT-01`。

## 三分鐘展示

在 Python 3.12 虛擬環境中執行：

```sh
python -m pip install -r requirements-dev.txt
python -m uvicorn stockroom.api:app
```

另開終端機執行 `python demo.py`。首次保留兩件會得到 HTTP 201，重送同一筆則得到 200。在全新資料庫中，接著查詢庫存會看到 18，釋放後恢復為 20。也可在瀏覽器開啟 [互動式 API 文件](http://127.0.0.1:8000/docs)。

| 操作 | 語意 |
| --- | --- |
| GET /inventory | 讀取商品總量與可用量 |
| POST /reservations | 傳入 sku、quantity 及 Idempotency-Key 標頭。相同鍵與內容可取得目前保留狀態 |
| DELETE /reservations/{key} | 釋放保留。重複取消只會歸還一次 |
| POST /reservations/{key}/releases | 以 Idempotency-Key 指定本次減量單號，將指定的 quantity 件釋放給其他訂單 |
| POST /reservations/{key}/fulfillments | 傳入本箱的 quantity 與 Idempotency-Key，登記實際出貨。不同保留可使用相同箱號 |
| GET /reservations/{key} | 查詢原始數量、已出貨數量、尚在保留數量與已歸還數量 |
| POST /reservations/{key}/fulfillments/{box}/returns | 以 Idempotency-Key 當作本箱的退貨單號，將驗收合格的 quantity 件商品入庫 |
| GET /reservations/{key}/fulfillments/{box} | 查詢該箱實際寄出的 dispatched、已重新入庫的 restocked，以及尚可退回的 returnable |
| GET /reservations/{key}/fulfillments | 一次查詢保留狀態、各箱出貨與退貨明細，以及全單已重新入庫和仍可退回的件數 |

庫存不足、同鍵不同內容回傳 409。未知商品或保留回傳 404。輸入格式錯誤回傳 422。失敗的請求不會占用鍵。

## 為什麼能防止超賣

客服收到一筆分箱出貨的退貨詢問時，可用 `python demo.py --packing` 重現整單查核。範例需要至少 10 件可用庫存。共保留 10 件，兩箱分別寄出 2 件與 3 件，其中 1 件驗收入庫，其餘未寄的 5 件釋放保留。報表依箱號列出明細，整單的 `restocked` 為 1、`returnable` 為 4；保留層的 `returned` 為 5，表示未出貨就已釋放的數量。查詢在同一筆交易內結算到期並讀取各箱，兩個服務實例同時處理出貨與退貨時，整單與箱別數字仍對應同一個時間點。

每個請求各自開啟資料庫連線。`BEGIN IMMEDIATE` 讓寫入者依序取得鎖，然後在同一筆交易完成重送檢查、條件扣庫存及建立保留。任一步驟失敗都回滾。保留即使釋放也保留原鍵，延遲送達的舊請求因此不會重新扣貨。

SQLite 適合本機或單節點展示。此版本的使用情境是可信任的本機呼叫端。

## 展示保留到期

新保留預設有效 15 分鐘。可在啟動前設定 `STOCKROOM_TTL_SECONDS`（1 至 86,400 秒）。例如在 PowerShell 設定 `$env:STOCKROOM_TTL_SECONDS = "3"`，啟動服務，透過互動文件保留兩件，三秒後以同一個鍵重送。回應會是 `200`、狀態 `expired`，查詢庫存可看到兩件都已歸還。

期限以 Unix 毫秒時間戳 `expires_at_ms` 寫入資料庫，重送及服務重啟都保留原期限。每次查庫存、下單或取消時，服務取得 SQLite 寫入鎖，再用同一個時間點結算已到期的保留。閒置時資料留待下次操作結算。到期瞬間若取消、重送及新買家同時抵達，舊保留只會歸還一次。提早取消則維持 `released`。

升級時會保留既有資料。舊版沒有記錄建立時間，因此既有保留維持原有手動釋放規則，回傳的期限為 `null`。查庫存目前也要取得寫入鎖，這是用讀取吞吐量換取單節點交易一致性的取捨。

## 驗證與容器

### 分批出貨及重送

在單獨的示範資料庫啟動服務，執行 `python demo.py --fulfill`。範例會實際扣除 3 件商品，開始前需至少有 8 件可用庫存。從全新的 20 件庫存開始，可以依序看到下列結果。

| 操作 | 現有實體庫存 capacity | 可供新訂單使用 available | 這筆訂單仍保留 |
| --- | ---: | ---: | ---: |
| 保留 8 件 | 20 | 12 | 8 |
| 第一箱寄出 3 件 | 17 | 12 | 5 |
| 以同一箱號重送相同請求 | 17 | 12 | 5 |
| 取消剩餘訂單 | 17 | 17 | 0 |

每箱的出貨收據、保留數量更新與實體庫存扣減在同一筆交易完成。首次登記回傳 201。相同箱號與數量重送會回傳 200 和當時的原始收據，即使其後已寄出另一箱或保留已到期。`held_after` 是該箱登記當下的剩餘保留量，最新進度請查詢訂單。相同箱號改數量、超出剩餘保留量或對已關閉訂單新增出貨，會回傳 409。

部分寄出後，尚未出貨的單位保留原期限。取消或到期只歸還剩餘數量。全部寄出時顯示 `fulfilled`。升級前的訂單初始已出貨量為零。每筆訂單的原始數量始終等於已出貨、尚在保留與已歸還數量之和。

### 部分取消未出貨的保留量

部分取消未出貨數量時，可以保留其餘訂單。從有 20 件庫存的獨立示範資料庫執行 `python demo.py --reduce`，保留 8 件、寄出 3 件，再釋放 2 件。此時實體庫存 17 件，可用 14 件，原訂單仍保留 3 件。再取消訂單僅歸還最後 3 件。重送減量單仍取得當時記錄的 `held_after: 3`，查詢訂單可見最新的已出貨 3 件、保留 0 件及累計歸還 5 件。

同一減量單號改數量、超過剩餘保留量、或訂單關閉後送入新的減量單都會回傳 409。部分釋放沿用原期限。若一部分已釋放、其餘都出貨，訂單狀態為 `released`，可從 `shipped` 和 `returned` 區分兩種去向。升級前的訂單預設部分釋放量為 0。測試亦驗證兩個 API 實例爭用最後 6 件，以及收據寫入失敗時可安全重試。[交易測試](tests/test_api.py)

### 已寄出商品的退貨入庫

在獨立的示範資料庫執行 `python demo.py --restock` 可重現已出貨商品退回倉庫的流程。從 20 件庫存開始，保留 8 件、寄出 3 件、取消其餘 5 件。此時倉庫有 17 件，驗收退回的 2 件後，實體與可用庫存都回到 19 件。重送同一退貨單會取得原始收據，箱內尚有 1 件可以辦退。

退貨額度按原訂單與箱號計算，已取消或已到期的訂單也可以接收先前實際寄出的商品。訂單的 `shipped` 保存累計出貨量，`returned` 保存未出貨就釋放的保留量。每箱的 `restocked` 才是驗收後實際回庫的件數。服務只接受可重新販售的實物入庫。

收據上的 `returnable_after` 是登記當時的餘額。重送同一退貨單號但改數量，或嘗試退回超過該箱餘額的商品，會得到 HTTP 409。升級後可直接對舊箱單辦退。測試讓兩個 API 實例共用資料庫，先重送同一份兩件退貨單 12 次，再用 12 個不同單號競爭最後 3 件額度。另以收據寫入失敗驗證庫存同步回滾。[交易與並行測試](tests/test_api.py)

### 從 Dock Outbox 收貨補庫存

收貨員在 Dock Outbox 按下「送出收貨」，伺服器確認後才會留下可匯入的收據。Stockroom 以收據的 UUID 去重，每筆新收貨會同時增加實體庫存與可用庫存。既有訂單保留的件數繼續保留。

在 Stockroom 專案根目錄執行以下命令。第一個路徑是 Dock Outbox 的收據資料庫，第二個是 Stockroom 服務使用的資料庫。請使用與服務相同的目的路徑，首次指定新檔時會建立含預設商品的 Stockroom 資料庫。

```sh
python -m stockroom.import_receipts ../dock-outbox/.dock-data/receipts.sqlite3 data/stockroom.db
```

每次從來源的同一個唯讀視圖逐筆掃描收據。JSON 結果以 `applied`、`replayed`、`units_added` 分別列出新收據數、已處理的收據數和新增件數。不同批貨即使料號與數量相同，只要識別碼不同，仍會分別入庫。來源在匯入期間新提交的收據可在下次執行時讀取。

目的資料庫會在同一筆寫入交易記錄收據並增加庫存。遇到未知料號、同一識別碼對應不同內容或無效數量時，指令回報錯誤並回滾該批變更。補齊商品資料或修正來源後可再次執行。這個版本逐次檢查完整收據歷史，大批匯入期間其他 Stockroom 寫入會等待。[匯入指令](stockroom/import_receipts.py) · [交易實作](stockroom/store.py)

要在暫存資料庫重現並行與失敗情境，需要 Python 3.12 和 Node.js 24 以上。

```sh
git clone https://github.com/peca12968/dock-outbox.git ../dock-outbox
git -C ../dock-outbox checkout --detach 4da92c62b158b80f09f09285ce8e9a68e68d757a
python dock_drill.py ../dock-outbox
```

| 操作 | KIT-01 實體庫存 | KIT-01 可用庫存 |
| --- | ---: | ---: |
| 原有 20 件，訂單先保留 7 件 | 20 | 13 |
| 兩張收據共 10 件，8 個程序同時匯入 | 30 | 23 |
| 接著收貨 4 件 KIT-01 與 2 件未建檔的 TOTE-02，整批回滾 | 30 | 23 |
| 建立 TOTE-02 後重試，另有 2 件 TOTE-02 入庫 | 34 | 27 |
| 解除原訂單保留 | 34 | 34 |

演練會向實際 Dock Outbox HTTP 服務送件並重送，核對首次與重送的收據內容。八個獨立 Stockroom 程序中，恰有一個匯入兩張收據，另外七個各辨識出兩張重送。測試也涵蓋舊資料庫升級、批次尾端的衝突與 SQLite 整數上限。[跨專案演練](dock_drill.py) · [回滾測試](tests/test_import_receipts.py)

### 執行測試

```sh
python -m pytest -q
docker build -t stockroom .
docker run --rm -p 127.0.0.1:8000:8000 -v stockroom-data:/app/data stockroom
```

[測試案例](tests/test_api.py)以 24 個各需 2 件庫存的請求競爭 20 件，驗證恰有 10 筆成功、14 筆衝突，並另測並行重送、重啟後持久性及重複釋放。GitHub Actions 也建置映像並透過 HTTP 讀取容器內的庫存。

**履歷用語**　以 FastAPI 與 SQLite 實作庫存保留、分批出貨及到期回收。用共用同一資料庫的兩個服務實例驗證重送只出貨一次，並注入收據寫入錯誤，確認出貨進度與實體庫存一起回滾。

本專案為使用 AI 輔助建立的作品集示範，測試使用合成資料。
