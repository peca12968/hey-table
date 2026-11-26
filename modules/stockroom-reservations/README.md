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
| GET /inventory-snapshot | 回傳商品總量、可用量，以及同一交易的結算時間 |
| POST /reservations | 傳入 sku、quantity 及 Idempotency-Key 標頭。相同鍵與內容可取得目前保留狀態 |
| POST /reservation-batches | 以一個批號一次保留多種商品。所有品項共同提交 |
| GET /reservation-batches/{batch_id} | 依批號查回首次建立時的品項保留編號和原始期限 |
| GET /reservation-batches/{batch_id}/status | 依批號取得各品項的即時保留進度與同一時點的庫存 |
| DELETE /reservation-batches/{batch_id} | 一次放回該批所有尚在保留的數量 |
| GET /reservation-batches/{batch_id}/cancellation | 依批號查回取消時間與各品項放回數量 |
| DELETE /reservations/{key} | 釋放保留。重複取消只會歸還一次 |
| POST /release-batches | 以 Idempotency-Key 批次釋回多張保留單的未出貨數量 |
| GET /release-batches/{batch_id} | 查回首次批次減量時間、放回量與前後保留件數 |
| GET /reservations/{key}/releases | 按保留單查單筆與跨單減量紀錄，可分頁 |
| POST /reservations/{key}/renewals | 依目前期限延長仍有效的保留，以 Idempotency-Key 識別這次續期 |
| POST /reservations/{key}/releases | 以 Idempotency-Key 指定本次減量單號，將指定的 quantity 件釋放給其他訂單 |
| POST /reservations/{key}/fulfillments | 傳入本箱的 quantity 與 Idempotency-Key，登記實際出貨。不同保留可使用相同箱號 |
| POST /dispatch-batches | 用一個 Idempotency-Key 登記同車的多箱出貨，可跨保留單。所有箱子共同提交 |
| GET /dispatch-batches/{batch_id} | 用批號取回當時的整批收據，可在網路斷線後查詢 |
| GET /reservations/{key} | 查詢原始數量、已出貨數量、尚在保留數量與已歸還數量 |
| POST /reservations/{key}/replacement | 依到期時的剩餘量重新保留，同一來源只建立一次 |
| GET /reservations/{key}/replacement | 查原單與新保留編號、建立時間與新單初始期限 |
| POST /reservation-batches/{batch_id}/replacement | 以同一交易重新保留整批到期餘量 |
| GET /reservation-batches/{batch_id}/replacement | 查新批號、初始期限與各品項的新舊保留編號 |
| GET /reservation-batches/{batch_id}/replacement-preview | 在一份庫存快照預覽整批到期餘量、缺口與接續狀態 |
| POST /reservations/{key}/fulfillments/{box}/returns | 以 Idempotency-Key 當作本箱的退貨單號，將驗收合格的 quantity 件商品入庫 |
| POST /return-batches | 以驗收批號一次登記多箱退回，所有箱子共同入庫 |
| GET /return-batches/{batch_id} | 依驗收批號查詢原始收據 |
| POST /return-inspections | 以驗收批號一次登記各箱合格入庫與受損隔離的件數 |
| GET /return-inspections/{batch_id} | 查詢各箱的原始驗收明細 |
| GET /return-inspections/{batch_id}/quarantine | 查詢每箱隔離原件數、已回庫、已報廢及還待處理的件數 |
| GET /quarantine-queue | 依驗收時間跨批查看待複驗件數，可用 SKU 篩選 |
| POST /return-inspections/{batch_id}/dispositions | 用同一個複驗單號登記多箱回庫與報廢 |
| GET /return-inspections/{batch_id}/dispositions/{disposition_id} | 查原複驗收據與處理原因 |
| GET /return-inspections/{batch_id}/history | 同一份讀取快照列出原始驗收、目前餘額及可翻頁的複驗紀錄 |
| GET /reservations/{key}/fulfillments/{box} | 查詢該箱實際寄出的 dispatched、已重新入庫的 restocked，以及尚可退回的 returnable |
| GET /reservations/{key}/fulfillments | 一次查詢保留狀態、各箱出貨與退貨明細，以及全單已重新入庫和仍可退回的件數 |
| POST /packing-snapshots | 一次查詢多張訂單，從同一時點取得各單的箱單和對應商品庫存 |

庫存不足、同鍵不同內容回傳 409。未知商品或保留回傳 404。輸入格式錯誤回傳 422。失敗的請求不會占用鍵。

`GET /inventory-snapshot` 回傳 `captured_at_ms` 和依 SKU 排序的 `products`，兩者取自同一筆會結算到期保留的交易。結果包含全庫商品，可直接儲存為 JSON，當作 [Count Relay 實物盤點核對](../count-relay/README.md#核對實物盤點與-stockroom-庫存) 的帳面庫存依據。

### 核對實點後調整庫存

取得該 SKU 的盤點基準 `GET /inventory/KIT-01/count-basis`，記下實體庫存 `capacity` 和版次 `revision`。盤點與取得基準應使用同一個截止點。複點確認後，將實點值和場次帶到 `POST /inventory/KIT-01/count-adjustments`。標頭 `Idempotency-Key` 為調整單號。

```json
{"expected_revision":0,"counted":18,"count_session":"shift-1","reason":"實點複核短少兩件"}
```

SQLite 在同一筆交易核對實體庫存版次、結算到期保留並保存調整收據。出貨或入庫後即使庫存回到原數量，舊版次也會被退回。實點數不得低於仍在保留的件數。原本帳面 20 件且保留 6 件時，實點 18 件會把可用量改為 12 件。若實點吻合，仍可保存盤點收據。送出成功後可用 `GET /inventory/KIT-01/count-adjustments/{adjustment_id}` 查閱調整前後庫存、盤點原因與時間，原樣重送會取回同一份收據。兩份 SQLite 備份的盤點差異也會計入這項異動。[版次、舊庫及回滾測試](tests/test_stock_count.py)

#### 一起保存多品項盤點

將 `{"skus":["KIT-01","WRAP-01"]}` 送到 `POST /stock-count-basis`，取得同一份快照中的各品項庫存與版次。使用同一盤點場次與原因，將各品項的 `sku`、`expected_revision` 和 `counted` 裝入 `items`，送到 `POST /stock-count-batches`。每批接受 1 至 100 個不同 SKU，`Idempotency-Key` 用來辨識整批調整。

任一 SKU 找不到、庫存版次變更或實點低於保留量時，整批退回，回應會指出該 SKU。成功後可從 `GET /stock-count-batches/{batch_id}` 取回整批收據，其中包含各品項的調整單號。原內容換序重送會取得同一批，單張及批次調整共用版次與盤點差異稽核。[跨 SKU 回滾與並行測試](tests/test_stock_count.py)

##### 使用庫存盤點工作台

啟動 Stockroom 後開啟 [庫存盤點工作台](http://127.0.0.1:8000/workbench/stock-count)。逐行貼上或掃入 SKU，擷取同一份庫存基準。填寫場次、理由與現場實點件數後，可先預覽帳面差異、保留量及預估可用量，再確認整批入帳。實點低於保留量時，畫面會標出受影響品項。

若盤點期間有人先改了實體庫存，工作台會更新基準，清空版次已變的品項件數，等待重新複點。其餘品項的實點可沿用，送出前仍須再預覽。若送出後斷線，可在同一分頁重新整理，按原盤點批號取回收據或重送。已入帳的收據可另用批號查詢、下載 JSON。[手機瀏覽器測試](../../qa/stockroom-workbench.spec.mjs) · [私人 Demo](https://peca-github-demo.peca12968.chatgpt.site/?demo=inventory#demos)

##### 查詢盤點紀錄

從工作台進入「查看盤點紀錄」，可按台灣入帳日期與 SKU 篩選批次。每批顯示場次、整批品項數、差異品項數，以及原盤點或沖回單的連結。若原批是在另一天被沖回，原日期的清單仍會顯示關聯。從收據返回後會保留原日期、SKU 與頁次，也可下載畫面上的同一份 JSON。

`GET /stock-count-batches` 在一個 SQLite 讀取快照中取得整個篩選範圍的計數及本頁批次。續頁以入帳時間和批號排序，每頁反映擷取當下的沖回狀態。SKU 篩選會找到含該品項的批次，收據可核對整批內容。[跨日與同時入帳測試](tests/test_stock_count.py) · [手機續頁與下載測試](../../qa/stockroom-workbench.spec.mjs)

執行 `python stock_count_workbench_demo.py` 可重跑兩品項盤點、舊版退回、重新複點、入帳與取回原收據。

#### 沖回已入帳的盤點批次

發現已入帳的盤點批次讀錯數量時，向 `POST /stock-count-batches/{batch_id}/reversal` 送出原因，例如 `{"reason":"查明原先讀錯貨架"}`。用 `Idempotency-Key` 記下此次沖回操作。

SQLite 會核對每個 SKU 的原入帳後版次，並嘗試恢復原批次調整前的實體數量，同時保留目前已占用的件數。若任何 SKU 已有後續實體異動，或恢復的數量不足以支應保留，整批退回。成功會產生新的沖回批號和各品項收據，原批次仍可查閱。相同操作重送會取得原沖回收據，也可用 `GET /stock-count-batches/{batch_id}/reversal` 查回。庫存差異報表會保留原調整與沖回的兩筆異動。[沖回、重送與對帳測試](tests/test_stock_count.py)

## 一次保留多種商品

以 `POST /reservation-batches` 帶上 `Idempotency-Key: order-24`。請求可含一至 100 個不同 SKU。範例假設倉庫已有 `KIT-01` 與 `WRAP-01`。

```json
{"items":[{"sku":"KIT-01","quantity":4},{"sku":"WRAP-01","quantity":2}]}
```

若包材只剩一件，整批回傳 409，套件依然有 20 件可用。補貨後可沿用原批號，成功回傳 201，兩種商品同時保留。遇到連線中斷時，可用 `GET /reservation-batches/order-24` 取回收據，或以任意品項順序重送取得 200。已成功的批號改用不同的品項或數量會回傳 409。

收據中的商品保留編號可直接交給出貨快照，也可分別續期或放回。執行 `python -m pytest -q tests/test_reservation_batches.py` 可重跑補貨後重試、兩台服務爭用最後一批存貨、續期與舊資料庫相容的案例。[作品站示範結果](examples/reservation-batch-demo.json)

### 重新開啟批次，確認各品項的保留狀態

用 `GET /reservation-batches/order-24/status` 查詢。服務取得 SQLite 寫入鎖後，以 `captured_at_ms` 結算到期，並在同一筆交易讀取各單品及對應 SKU 的實體與可用庫存。各品項依 SKU 排序，包含最新期限與已出貨、尚在保留及已釋回件數。`initial_expires_at_ms` 是首次保留時的共同期限。`cancelled_at_ms` 只有在整批取消成功後才有值。查無批號回傳 404，成功的快照禁止快取。

執行 `python batch_status_demo.py` 可使用暫存資料庫產生四個實際 HTTP 快照。套件先寄出一件，包材續期十秒。到原期限時，套件尚未寄出的三件釋回，包材仍保留兩件。整批取消後，包材也放回庫存。並行測試另讓兩台服務在查詢中途競爭寫入鎖，核對取消前後的保留與可用量。[快照範例](examples/reservation-batch-status-demo.json) · [API 測試](tests/test_reservation_batches.py)

### 部分出貨後取消整批

套件已寄出一件時，呼叫 `DELETE /reservation-batches/order-24` 會一次放回剩下三件套件和兩件包材。已出貨的一件仍在出貨紀錄，套件實體庫存和可用量都為 19。取消會先結算到期保留。已過期、已放回或已全數出貨的品項，在取消收據上的 `quantity_released` 為 0。

取消收據附首次取消時間及各品項的實際放回量。再次送出 `DELETE` 或查詢 `GET /reservation-batches/order-24/cancellation` 可取得同一份收據。原保留收據仍可用原路徑查詢。出貨與取消以同一筆庫存寫入鎖依序執行，測試另外驗證最後一個品項的取消收據寫入失敗時，先前的品項也會回滾。[取消與併發測試](tests/test_reservation_batches.py)

## 一次擷取多張訂單給出貨排程

以 `POST /packing-snapshots` 傳入一至 100 個不同的保留編號，例如 `{"reservation_ids":["east","west"]}`。資料庫取得交易鎖後，以同一個時間點結算到期，再一起讀取各單保留、箱單、退貨與涉及的商品庫存。`captured_at_ms` 是結算使用的 Unix 毫秒，`holds` 依照請求順序回傳，每張單與原本的單張箱單 API 使用相同格式。`products` 依 SKU 排序。任一編號找不到時回傳 404 並列出缺少的編號。

從兩台服務的並行測試可看到，同車出貨的 5 件在快照建立前仍分別保留於兩張單，提交後的新快照則同時反映兩張箱單與減少的庫存。舊版無期限的保留仍可出現在同一快照。執行 `python demo.py --batch` 可透過本機 HTTP 看到跨訂單快照。[跨訂單並行測試](tests/test_packing_snapshots.py)

### 依 SKU 核對目前保留來源

`GET /inventory/KIT-01/allocations?limit=50` 會先回收到期保留，再從同一筆 SQLite 交易讀取 SKU 的實體庫存、可用件數與保留明細。匯總包含整個 SKU 的單數、尚在保留的件數、無期限的單數和件數，以及最早到期時間。各列列出原件數、已出貨、已減量、尚在保留、批號及期限。期限為 `null` 代表舊單無期限。查無 SKU 回傳 404。

每頁最多 100 筆，按不會被續期改動的保留編號排序。將 `next_after_id` 帶入 `after_id` 可取得下一頁。各頁都會按當時庫存重新擷取，匯總始終涵蓋該 SKU 的完整有效保留。執行 `python sku_allocation_demo.py` 可重建同一 SKU 的續頁、到期與出貨快照。[並行、升級與續頁測試](tests/test_sku_allocations.py) · [保留來源試玩（私人預覽）](https://peca-github-demo.peca12968.chatgpt.site/?demo=skuAllocations#demos)

### 先列出即將到期的保留

`GET /expiring-reservations?within_seconds=900&limit=50&sku=KIT-01` 先結算已到期保留，再以同一交易列出仍有保留量、在指定時間內到期的單品。結果依截止毫秒與保留編號排序，包含批號、已出貨與剩餘保留件數。省略 `sku` 可查全庫。查詢時間最長 24 小時，每頁最多 100 筆。

若回應含 `next`，沿用其中三個參數及原 SKU 查下一頁。截止範圍固定，各頁會按當下庫存重新結算。舊版無到期時間的單仍可由原查單 API 查閱。執行 `python batch_status_demo.py` 可看到包材續期後離開短期清單、套件到期後釋回庫存。[到期邊界、續頁與並行出貨測試](tests/test_expiry_queue.py)

### 查閱已到期的庫存回收

`GET /expired-reservations?sku=KIT-01&since_ms=700000&limit=50` 會先結算到期，再從同一筆 SQLite 交易查詢已回收的保留單。每張單列出原保留、已出貨、先前減量與此次釋回件數，有批號時一併顯示。截止時間使用 `expires_at_ms`。真正釋回庫存的時間使用 `reclaimed_at_ms`，舊單若未記錄則回傳 `null`。

首張回應會固定查詢的上限 `through_ms`。依 `next` 並保留原 `sku` 與 `since_ms`，可按到期時間及保留編號由新到舊翻頁。首查之後才釋回的保留會出現在新查詢。每次到期回收在同一筆交易更新庫存與回收時間，重查會沿用原時間。[跨服務回收與續頁測試](tests/test_expiry_queue.py) · [舊資料升級測試](tests/test_api.py)

### 將多張保留單一起續期

從到期清單選擇保留單後，向 `POST /renewal-batches` 傳送 `Idempotency-Key`、共用的 `extend_seconds`（1 至 86,400 秒），以及最多 100 筆 `items`。每筆填入 `reservation_id` 與清單上的 `expires_at_ms` 作為 `expected_expires_at_ms`。

服務先結算到期，再在同一筆交易核對期限、延長仍有效的保留並保存整批收據。任一筆不存在、已結單或期限過期，整批退回，回應會指出保留編號。首次回 201，改變順序重送相同內容回 200；同批號更換內容回 409。可用 `GET /renewal-batches/{batch_id}` 查回原收據。[並行續期與收據回滾測試](tests/test_renewal_batches.py)

### 按保留單查續期紀錄

`GET /reservations/{key}/renewals?limit=25` 回傳同一次 SQLite 交易中的保留現況，以及該單成功的單張與批次續期。每筆包含 `source`、`receipt_id` 和續期前後的截止時間。回應按新截止時間由晚到早排列；批次項可用收據 ID 再查整批。保留釋回或到期後仍可查紀錄。

若帶有 `next_before_expires_at_ms`，用該值作為 `before_expires_at_ms` 繼續查詢。後續新增續期會出現在更新的頁面，原游標仍能接續往前查。既有收據只保存期限，紀錄以截止時間呈現。[舊資料、重送及續頁測試](tests/test_renewal_batches.py)

## 同車退回的多箱商品一起驗收

倉庫同時收到東區和西區兩張訂單的退貨。在各箱驗收後，將可重新入庫的數量送到 `POST /return-batches`，以 `Idempotency-Key` 傳入此次驗收批號。以下範例假設兩張訂單各已有一箱出貨，箱號都叫 `box`。

```json
{"boxes":[
  {"reservation_id":"east","shipment_id":"box","quantity":1},
  {"reservation_id":"west","shipment_id":"box","quantity":2}
]}
```

任一箱不存在或超過該箱可退回的數量，整批回滾，回應指出訂單與箱號。成功後，每箱收據保留當時的剩餘可退數量。網路中斷時可依驗收批號查回原收據，也可原樣重送，箱子的排列次序可以不同。同批號改動箱號或件數會回傳 409。整批與單箱驗收共用退貨帳及每箱的可退上限。若原有單箱收據在同一箱已使用此批號，需使用新批號提交整批。

啟動本機服務後執行 `python demo.py --return-batch`，可重現兩張訂單各出貨一件，再一次驗收兩件。並行測試另用兩個服務實例送出 12 次請求，讓兩個驗收批和一張單箱驗收爭用同一箱，驗證只有其中一組能入庫。[跨單驗收測試](tests/test_return_batches.py)

### 區分合格入庫與受損隔離

送出 `POST /return-inspections` 時，用 `Idempotency-Key` 指定驗收批號。每箱帶原保留編號、箱號、`sellable` 和 `quarantined`。例如 `{"boxes":[{"reservation_id":"east","shipment_id":"box","sellable":1,"quarantined":2}]}` 會登記收到 3 件，將其中 1 件加回可販售庫存，另外 2 件記錄為隔離。箱別明細和整單快照會顯示已有隔離的件數，供倉庫核對實物。

每批最多 100 箱，合格與隔離加總須在各箱可退量內。任何一箱不符時，整批都會回滾。舊的單箱退貨、整批退貨和新版驗收共用同一個剩餘可退量。用原批號重送相同箱件與條件可查回原收據。SQLite 快照對帳會分列合格入庫與新增隔離，只有合格入庫影響可販售盤點。[舊資料、回滾與並行驗收測試](tests/test_return_inspections.py)

#### 用瀏覽器驗收退貨

啟動 Stockroom 後開啟 [退貨驗收工作台](http://127.0.0.1:8000/workbench/returns)。輸入驗收批號，掃描或貼上每箱的原出貨條碼，例如 `DW1/east/box/3`，再填合格、隔離件數。工作台透過 `POST /return-inspections/preview` 逐箱核對原出貨件數與目前可退量。確認時若有其他人先驗收，整批回滾並刷新各箱可退量。

送出後若斷線，可在同一分頁重新整理，再以原批號重試。工作台會取回原收據，或以同一批號重送。完成後可查詢和下載 JSON 收據，有隔離件時可直接開啟該批的複驗工作台。[手機瀏覽器對端測試](../../qa/stockroom-workbench.spec.mjs) · [退貨驗收試玩（私人預覽）](https://peca-github-demo.peca12968.chatgpt.site/?demo=returnReceiving#demos)

### 複驗隔離品並登記回庫或報廢

先用 `GET /return-inspections/{batch_id}/quarantine` 查原驗收批的待處理件數。複驗後把當時查到的 `remaining` 放進每箱的 `expected_remaining`，並記錄回庫、報廢及原因。依同一驗收批一次送 1 至 100 箱。以下 `decision.json` 將 2 件中的 1 件回庫、1 件報廢。

```json
{"boxes":[{"reservation_id":"east","shipment_id":"box","expected_remaining":2,"restock":1,"discard":1,"reason":"重新檢查外觀與包裝"}]}
```

```sh
curl http://127.0.0.1:8000/return-inspections/dock/quarantine
curl -X POST http://127.0.0.1:8000/return-inspections/dock/dispositions -H "Content-Type: application/json" -H "Idempotency-Key: review-1" --data-binary @decision.json
curl http://127.0.0.1:8000/return-inspections/dock/dispositions/review-1
```

若其間有其他人處理同一箱，任何一箱餘額改變都會拒絕整批，須重新查餘額。複驗合格才增加可販售庫存。箱別查詢的 `quarantined` 是仍待處理的件數，`discarded` 是累計報廢，`restocked` 含初驗回庫和複驗回庫。原退貨驗收收據保留初驗資料，複驗收據保存原因和當時餘額。相同複驗單號與內容可安全重送，且可在 SQLite 快照對帳中分別核對回庫與報廢。[升級、重試與並行複驗測試](tests/test_quarantine_dispositions.py)

### 用瀏覽器處理隔離品複驗

從本模組目錄安裝 `requirements.txt` 並啟動 Stockroom。開啟 `http://127.0.0.1:8000/workbench/quarantine`，輸入已有隔離品的驗收批號。

```sh
python -m pip install -r requirements.txt
python -m uvicorn stockroom.api:app --host 127.0.0.1 --port 8000
```

填寫各箱的回庫、報廢件數與原因，先按「核對複驗內容」，確認後再登記。其他人先改了餘額時，畫面會重新讀取各箱並請店員核對。若連線斷在送出後，原複驗單會暫存在同一分頁，重新整理後仍可用原單號重試。可憑驗收批號和複驗單號查原收據、下載 JSON。工作台使用同一個 Stockroom 服務與既有 API。[手機端對端測試](../../qa/stockroom-workbench.spec.mjs) · [私人試玩](https://peca-github-demo.peca12968.chatgpt.site/?demo=quarantineDisposition#demos)

#### 查看待複驗清單

開啟 [待複驗清單](http://127.0.0.1:8000/workbench/quarantine-queue)，可從退貨驗收或隔離品複驗工作台進入。清單會統計尚待複驗的批、箱與件數，依原驗收時間由早到晚排列。沒有驗收時間的舊批次排在最前，並標示「驗收時間未記錄」。可依 SKU 縮小範圍、下載本頁 JSON，或點驗收批號查看整批的即時餘額。

`GET /quarantine-queue?sku=KIT-01&limit=25` 在同一份 SQLite 讀取結果回傳全範圍統計與本頁批次。續頁保留原 SKU，並帶上 `next` 的 `after_received_at_ms`、`after_batch_id`。每頁會反映當下的複驗結果。即使上一頁的最後一批剛處理完，仍可用原游標接續查詢。相同驗收批號重送會沿用第一次驗收時間。[舊庫升級與續頁測試](tests/test_quarantine_dispositions.py) · [手機端對端測試](../../qa/stockroom-workbench.spec.mjs)

#### 查詢退貨驗收歷程

開啟 [退貨驗收歷程](http://127.0.0.1:8000/workbench/return-history) 後，輸入驗收批號，或從原驗收收據及複驗工作台點入。畫面分列初驗合格、隔離、複驗回庫、報廢及仍待複驗的件數。下方可按箱查看複驗單號、原因及當時剩餘量。切換箱件後，原驗收與目前餘額仍可核對整批。頁面可下載本次查詢的 JSON，包含全批餘額和本頁複驗明細。

API 在同一筆 SQLite 讀取交易擷取原驗收、全批餘額及該頁複驗紀錄。紀錄按時間和複驗單號由新到舊。續頁用 `next.before_recorded_at_ms` 和 `next.before_disposition_id`，有篩選時沿用 `reservation_id` 和 `shipment_id`。每一頁反映當下的全批複驗餘額。[並行讀取與續頁測試](tests/test_quarantine_dispositions.py) · [手機對端測試](../../qa/stockroom-workbench.spec.mjs) · [私人 Demo](https://peca-github-demo.peca12968.chatgpt.site/?demo=quarantineDisposition#demos)

## 兩次盤點都是 20 件，期間進出了多少貨？

以同一倉庫的期初 SQLite 備份與期末資料庫執行下列指令，即可依商品核對每一筆數量異動。期初檔應來自 SQLite 線上備份，例如在班前以 SQLite CLI 執行 `sqlite3 data/stockroom.db ".backup 'opening.db'"`，並使用新的備份檔名。請將資料庫路徑換成服務實際使用的檔案。

```sh
python -m stockroom.reconcile opening.db data/stockroom.db KIT-01
```

在可重跑的範例中，期初帳上有 20 件，舊版訂單保留其中 7 件，可用 13 件。期間有以下異動。

| 異動 | 件數 | 核對依據 |
| --- | ---: | --- |
| 進貨入庫 | +4 | 同一張進貨單重送後只計一次 |
| 兩箱出貨 | −5 | 舊單 A 箱 3 件、新單 A 箱 2 件，以訂單與箱號配對 |
| 已出貨商品驗收入庫 | +1 | 退貨收據指定舊單 A 箱 |
| 主動減少保留 | 1 | 釋放可用量，實體庫存增減為零 |

期末實體庫存仍是 20 件。服務結算新單到期後，只剩舊單保留的 4 件，期末可用 16 件。JSON 的 `new_receipts` 列出期間新增的單號與數量，`capacity_difference` 是期末帳上實體庫存減去按收據推算的數量。如果期初已存在的出貨收據被改量或消失，即使兩項錯誤互相抵銷，`issues` 仍會分別列出箱號。單箱退貨超過出貨量也會列出。

若要解釋可用量為何從 13 變成 16，查看 `available_changes`。新單先保留 6 件，期間進貨 4 件、退貨入庫 1 件，店員減量 1 件，最後到期釋回 3 件，合計為 `13 − 6 + 4 + 1 + 1 + 3 = 16`。出貨使用先前已保留的數量。`hold_events` 指出哪張單新建、哪張單取消或到期時還有餘量；整單已出完或已用減量單全數釋回，結單時就不會再加一次。

對帳指令用唯讀交易讀取每個快照，可在另一個服務實例寫入時執行。保留量按資料庫已提交的狀態計算，時間到了但服務尚未回收的保留仍會列入。初版資料庫可直接讀取。兩份資料庫的來源與先後順序由操作者確認，期初實體庫存作為推算起點；實地清點數仍需由倉庫提供。指令會在記憶體內比對該商品的所有收據。結束碼 0 代表這些檢查均吻合，1 代表發現差異，2 代表參數或快照無法讀取。

執行 `python -m pytest -q tests/test_reconcile.py` 可重現上述範例、抵銷的收據差異、跨箱退貨異常及讀取期間完成出貨的情境。[對帳實作](stockroom/reconcile.py) · [測試](tests/test_reconcile.py)

## 為什麼能防止超賣

客服收到一筆分箱出貨的退貨詢問時，可用 `python demo.py --packing` 重現整單查核。範例需要至少 10 件可用庫存。共保留 10 件，兩箱分別寄出 2 件與 3 件，其中 1 件驗收入庫，其餘未寄的 5 件釋放保留。報表依箱號列出明細，整單的 `restocked` 為 1、`returnable` 為 4；保留層的 `returned` 為 5，表示未出貨就已釋放的數量。查詢在同一筆交易內結算到期並讀取各箱，兩個服務實例同時處理出貨與退貨時，整單與箱別數字仍對應同一個時間點。

每個請求各自開啟資料庫連線。`BEGIN IMMEDIATE` 讓寫入者依序取得鎖，然後在同一筆交易完成重送檢查、條件扣庫存及建立保留。任一步驟失敗都回滾。保留即使釋放也保留原鍵，延遲送達的舊請求因此不會重新扣貨。

SQLite 適合本機或單節點展示。此版本的使用情境是可信任的本機呼叫端。

## 展示保留到期

新保留預設有效 15 分鐘。可在啟動前設定 `STOCKROOM_TTL_SECONDS`（1 至 86,400 秒）。例如在 PowerShell 設定 `$env:STOCKROOM_TTL_SECONDS = "3"`，啟動服務，透過互動文件保留兩件，三秒後以同一個鍵重送。回應會是 `200`、狀態 `expired`，查詢庫存可看到兩件都已歸還。

期限以 Unix 毫秒時間戳 `expires_at_ms` 寫入資料庫，重送及服務重啟都保留原期限。每次查庫存、下單或取消時，服務取得 SQLite 寫入鎖，再用同一個時間點結算已到期的保留。閒置時資料留待下次操作結算。到期瞬間若取消、重送及新買家同時抵達，舊保留只會歸還一次。提早取消則維持 `released`。

### 到期後重新保留剩餘件數

`POST /reservations/cart/replacement` 帶 `Idempotency-Key` 即可送出，件數由原單的數量扣除已出貨與先前減量的件數。假設保留 8 件、出貨 3 件、先釋回 2 件，庫存足夠時會另外建立 3 件的新保留，並從當次建立時間計算新期限。舊單仍可查到到期及出貨紀錄。已取消的單、已完成出貨的單或尚未到期的單無法重新保留，整批已取消的品項也會退回。

到期結算、可用量扣減及關聯收據在同一寫入交易。首次成功回 201，同鍵重送回 200，並可用 `GET /reservations/cart/replacement` 取得原收據。庫存不足或換鍵重複建立時回 409。新保留的續期、出貨與取消使用新編號，原收據保存新單的初始期限。[競爭、回滾與重啟測試](tests/test_replacements.py) · [Demo 收據](examples/reservation-batch-status-demo.json)

#### 多品項一起重新保留

原批次沒有仍在保留的品項時，可帶 `Idempotency-Key` 呼叫 `POST /reservation-batches/recover-set/replacement`。服務只接續實際到期的餘量，已完成或已釋回的品項維持原狀。任一品項缺貨、已被單獨接續，或原批次已取消，整批回 409。新批次和各品項都有新編號，可以接續原本的批次查詢及取消流程。

首次成功回 201，按原批號查詢或同鍵重送會取得含各品項關聯的原收據。兩台服務同時用單品與整批入口時，只有其中一方可接續同一品項。測試也注入最後一筆收據寫入失敗，驗證全部品項與可用量一起回滾。[舊庫與並行重跑](tests/test_batch_replacements.py)

送出前可用 `GET /reservation-batches/recover-set/replacement-preview` 查看擷取時間、整批狀態及各品項的到期餘量、目前可用量與缺口。如果已完成接續，回應會帶新批號。預覽會結算到期保留；正式提交時會在寫入交易重新核對最新庫存，再決定是否建立新批次。測試使用另一台服務在預覽後占用庫存，並核對同時缺貨的多個品項。[缺口與預覽後競爭測試](tests/test_batch_replacements.py)

#### 用瀏覽器重新保留

啟動 Stockroom 後，從 `/workbench/replacement` 輸入原批號。工作台列出每個品項的到期餘量、可用量及缺口。庫存足夠時可整批送出。如果另一張訂單先占用庫存，工作台會重新查詢，顯示受影響品項。

遇到連線中斷，可在同一分頁重新整理並以原請求編號重試；服務會以原收據應答或再次核對庫存。已完成的批次可用原批號查回新批號、品項對應及初始期限，並下載 JSON。[手機流程測試](../../qa/stockroom-workbench.spec.mjs) · [批次現況試玩（私人預覽）](https://peca-github-demo.peca12968.chatgpt.site/?demo=reservationStatus#demos)

升級時會保留既有資料。舊版沒有記錄建立時間，因此既有保留維持原有手動釋放規則，回傳的期限為 `null`。查庫存目前也要取得寫入鎖，這是用讀取吞吐量換取單節點交易一致性的取捨。

## 驗證與容器

### 付款等待期間延長保留

若付款仍待確認，可信任的呼叫端可讀取該筆保留的 `expires_at_ms`，再送一次續期。啟動服務後執行 `python demo.py --renew`，可看到保留 2 件、延長 30 秒、重送取得相同收據，最後取消並歸還庫存。此示範使用本機 API。

請求內容包含讀到的舊期限 `expected_expires_at_ms` 及從舊期限起算的 `extend_seconds`（每次 1 至 86,400 秒）。首次成功回 201，收據同列前後期限。已過期、已取消、已出完貨或舊版無期限的保留都無法新增續期。若另一個服務實例已更新期限，此次回 409；呼叫端可重新查詢保留狀態再決定是否需要延長。相同鍵及內容重送回 200，即使訂單已關閉，仍可取得第一次的收據。

在可重跑案例中，保留 8 件、寄出 3 件、取消 2 件後，續期只延長剩下 3 件。新期限到達時釋放這 3 件，倉庫可用量回到 17 件。另以兩個 API 實例同時送出 12 筆不同單號的續期，驗證同一舊期限只會更新一次。[交易實作](stockroom/store.py) · [續期與並行測試](tests/test_api.py)

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

### 同車多箱一起交運

北區訂單保留 4 件，南區訂單保留 2 件。司機要一次載走北區 A 箱 2 件、B 箱 1 件及南區 A 箱 2 件。如果誤把南區箱填成 3 件，服務會回傳 409 並標出失敗的訂單與箱號。兩張訂單都維持原來的保留量，批號可修正後再次使用。

啟動服務後，在有至少 6 件可用庫存的本機示範環境執行 `python demo.py --batch`。示範會建立兩張保留單、送出整車、依批號查詢收據，再將箱子反序重送。以下是 `POST /dispatch-batches` 的請求內容範例，`Idempotency-Key` 標頭為這次交運的批號。

```json
{"boxes":[
  {"reservation_id":"north","shipment_id":"A","quantity":2},
  {"reservation_id":"north","shipment_id":"B","quantity":1},
  {"reservation_id":"south","shipment_id":"A","quantity":2}
]}
```

每批可含 1 至 100 箱。同一訂單內的箱號必須唯一，不同訂單可各用 A 箱。收據依訂單、箱號排序，保留每箱登記當下的 `held_after`，範例中依序為 2、1、0。第一次成功回 201；內容相同、順序不同的重送回 200。原批號若增刪箱子或改數量，回 409。後續退貨或訂單到期時，仍可依批號查回原收據。

排程客戶端可另外提供 `"window": {"not_before_ms": 101000, "before_ms": 102000}`，以 Unix 毫秒指定最早送出與交運截止。新批次的服務端時間須大於等於開放時間、且早於截止時間。時窗外回 409，箱子會保留原狀。同批同內容若先前已成功，超過截止仍回原收據。[排程執行](../dispatch-window/README.md#確認包裝後交運與查回收據)

每箱沿用單箱出貨的扣庫與退貨流程。已經單獨出貨或由其他批次登記的箱子，無法再編入新批次。測試涵蓋兩個服務共用 SQLite、收據寫入中斷、到期重送、舊箱單升級，以及用戶端收不到成功回應後依批號復查。[整批出貨測試](tests/test_dispatch_batches.py)

#### 整車交運預覽

將同一份箱單送到 `POST /dispatch-batches/preview`。服務會先依目前時間回收到期保留，再從同一筆 SQLite 交易讀取各張保留單和既有箱單。回應包含擷取時間、整批是否可交運，以及每箱試算前後的保留量。查無保留單、箱號已登記出貨、或剩餘量不足時，會回傳對應原因與可計算的缺口。

預覽沿用正式交運的保留單及箱號排序。試算會依序扣除可出貨的箱子，跳過有問題的箱子。任一箱有問題時，整批不可交運。預覽不會建立出貨收據。正式送出時會重新核對，遇到預覽後到期或被另一車占用的保留量，整批退回。已成功的出貨仍可用原批號重送取回收據。

`python batch_status_demo.py` 會產生可重跑的預覽範例。可比較同一張單累計缺 1 件、修正後可出貨，以及另一車先出貨導致送出時整批退回。[預覽與並行測試](tests/test_dispatch_batches.py)

#### 用瀏覽器核對整車交運

啟動 Stockroom 後開啟 `/workbench/dispatch`，填交運批號及每箱的保留單號、箱號、件數。預覽會試算同一張保留單的逐箱餘量，標出重複出貨或缺件。修改箱單後須重新預覽。另一台車先扣減保留量時，畫面會刷新缺口供店員修正。

已送出但未收到結果時，可在同一分頁重新整理並重試原批次。若服務已有原收據，就按批號取回並比對箱單；找不到時，則以同一批號重送。交運完成可下載 JSON，也能另用批號查回。[手機操作測試](../../qa/stockroom-workbench.spec.mjs) · [批次現況試玩（私人預覽）](https://peca-github-demo.peca12968.chatgpt.site/?demo=reservationStatus#demos)

也可上傳 Dispatch Window 匯出的掃碼核對檔，從中選一張排程訂單。批號、箱件和交運時窗沿用原排程，預覽時以 Stockroom 的時間顯示是否開放交運。若另一端已交運，重新預覽會取回同一批的原收據。[匯出掃碼核對檔](../dispatch-window/README.md#把掃碼核對檔帶到交運工作台)

### 部分取消未出貨的保留量

部分取消未出貨數量時，可以保留其餘訂單。從有 20 件庫存的獨立示範資料庫執行 `python demo.py --reduce`，保留 8 件、寄出 3 件，再釋放 2 件。此時實體庫存 17 件，可用 14 件，原訂單仍保留 3 件。再取消訂單僅歸還最後 3 件。重送減量單仍取得當時記錄的 `held_after: 3`，查詢訂單可見最新的已出貨 3 件、保留 0 件及累計歸還 5 件。

同一減量單號改數量、超過剩餘保留量、或訂單關閉後送入新的減量單都會回傳 409。部分釋放沿用原期限。若一部分已釋放、其餘都出貨，訂單狀態為 `released`，可從 `shipped` 和 `returned` 區分兩種去向。升級前的訂單預設部分釋放量為 0。測試亦驗證兩個 API 實例爭用最後 6 件，以及收據寫入失敗時可安全重試。[交易測試](tests/test_api.py)

#### 一次核對並釋回多張保留單

先從裝箱快照讀取各單的 `held`，再將保留編號及預期剩餘量送到 `POST /release-batches`。以下假設兩張訂單分別保留 4 件與 2 件，各要釋回 2 件。以 `Idempotency-Key: remove-backorders` 辨識這次操作。

```json
{
  "items": [
    {"reservation_id": "order-east", "expected_held": 4, "quantity": 2},
    {"reservation_id": "order-west", "expected_held": 2, "quantity": 2}
  ]
}
```

服務在同一筆 SQLite 寫入交易結算到期、核對剩餘量、更新可用量並寫入減量收據。成功後東區仍保留 2 件，西區保留歸零，實體庫存與已出貨件數沿用原值。任一張的期望值過期或釋回量超過保留時整批回 409，查無保留則回 404。換序重送可取得相同的原始收據，也能按批號查回。新舊資料庫都沿用原減量帳供對帳。[重啟、並行與回滾測試](tests/test_release_batches.py) · [Demo 收據](examples/reservation-batch-status-demo.json)

#### 按保留單查減量紀錄

`GET /reservations/order-east/releases?limit=25` 回傳同一筆 SQLite 交易擷取的保留現況與減量收據。每筆包含操作來源、單號或批號、釋回量、操作前後的保留量和時間。舊版單筆收據的時間顯示為 `null`，原有數量與順序仍可查閱。跨單收據可用 `receipt_id` 查整批。

回應帶有 `next_after_held` 時，將它填入下一頁的 `after_held`。同一張單的保留量只會遞減，所以即使下一次請求前發生新的減量，原游標仍能接續查較早的收據。到期或結單後也可讀取減量紀錄。[舊資料、續頁與同一快照測試](tests/test_release_batches.py)

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
git worktree add --detach ../dock-outbox-verified 4da92c62b158b80f09f09285ce8e9a68e68d757a
python dock_drill.py ../dock-outbox-verified
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

## 從請求計數器重現事故告警

`GET /metrics` 提供 Prometheus 文字格式的 `http_requests_total{status}`。狀態碼按回應開始時計數；回應開始前的未處理例外計入 500。讀取指標本身會略過計數。每個服務程序有自己的 registry，請在抓取設定加上穩定的 `service` 與各程序的 `instance` 標籤，依部署目標清單另外提供 `slo_target_expected`。

演練用兩個 FastAPI 實例實際處理 842 個應用程式請求，從指標端點讀回計數器。暫存 SQLite 裡的測試觸發器讓其中 8 次保留交易失敗，逐筆回傳 HTTP 500，交易回滾後資料庫裡沒有留下訂單。將取樣對應到每分鐘一點的模擬時間線後，promtool 確認第 388 分鐘只剩慢速條件成立，410 分鐘檢查時告警已解除。稍後停抓其中一個實例，該實例單獨出現遙測缺口警告。這是加速重播，沒有等候七小時，也沒有對外發送通知。[重現程式](monitoring_drill.py) · [Burn Pair](https://github.com/peca12968/hey-table/tree/main/modules/burn-pair)

## 把結單明細交給收貨端

`GET /reservations/{key}/dispatch-manifest.csv` 會輸出 `box_id,units` 兩欄，表頭 `X-Box-Count` 提供接收端應收到的箱數。只要訂單仍保留庫存、或整張訂單都沒有寄出箱件，端點就回覆 409。最後一件出貨、取消或到期之後，可取得按箱號排序的原始出貨明細。日後退貨會更新裝箱對帳表，原始出貨 CSV 則可再次傳給收貨端核對。

跨專案演練保留 8 件，分兩箱寄出 2、3 件，取消其餘 3 件，再將 CSV 實際上傳至 gRPC 服務。之後一件退回庫房，裝箱對帳可查得客戶仍持有 4 件。此時重送出貨明細，收貨端仍辨識為原來的 2 箱、5 件並回傳相同摘要。CI 另外驗證部分出貨後剛好到期以及資料庫重開時，匯出仍一致。[交接演練](manifest_drill.py) · [Manifest Intake](https://github.com/peca12968/hey-table/tree/main/modules/manifest-intake)

**履歷用語**　以 FastAPI 與 SQLite 實作庫存保留、分批出貨及到期回收。用共用同一資料庫的兩個服務實例驗證重送只出貨一次，並注入收據寫入錯誤，確認出貨進度與實體庫存一起回滾。

本專案為使用 AI 輔助建立的作品集示範，測試使用合成資料。
