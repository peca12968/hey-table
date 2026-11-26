# Dispatch Window｜庫存到期前的出貨安排

一座包裝台同時只能處理一張單。A 單現在就能包裝，也最早到期，但若先包 A，就來不及趕上四件商品的 B 單。這個工具把每張單的備妥時間、包裝工時、目前保留量與到期時間一起計算，找出能準時裝車的最大件數。

## 重跑四張訂單

需要 Python 3.12，排程指令只用標準函式庫。

```sh
python dispatch.py examples/morning.json
python -m unittest -v
```

| 訂單 | 件數 | 備妥（相對開工） | 所需工時 | 最晚出貨時間，須早於 | 最佳安排 |
| --- | ---: | ---: | ---: | ---: | --- |
| A | 1 | 0 秒 | 4 秒 | 5 秒 | 待改派 |
| B | 4 | 2 秒 | 5 秒 | 8 秒 | 2–7 秒 |
| C | 3 | 7 秒 | 2 秒 | 10 秒 | 7–9 秒 |
| D | 2 | 9 秒 | 1 秒 | 11 秒 | 9–10 秒 |

若先包最早到期的 A，就得等到第 4 秒才能開工 B，屆時 B 已來不及。這條路線至多出貨 6 件。排程先等 2 秒再包 B，搭配 C、D 合計出貨 **9 件**。D 來自舊版無到期日的保留，依裝車截止時間安排。

## 接上 Stockroom

以 `POST /packing-snapshots` 傳入整批 `reservation_ids`，將回應的 `holds` 和 `captured_at_ms` 放進規劃檔。回應的 `products` 也可一起保留供人工核對。Stockroom 會在同一時點結算所有保留並讀取箱單。工作清單 `work` 為每張單提供訂單編號、備妥時間、總包裝工時與各箱件數。Unix 時間與工時均用毫秒，`start_ms` 可選快照時點或之後。若訂單已到期、剩餘保留量不足，或計畫的箱號已用過，報表會列出原因。舊規劃檔也可只提供 `holds`。

每張單的規劃箱數最多 100 箱。包完該單才一次提交它的箱子。排程的 `dispatch` 欄位可傳給 `POST /dispatch-batches`，並以現場唯一批號作為 `Idempotency-Key`。出貨時由 Stockroom 再次核對當下的庫存與期限。排程假設庫存在包裝期間維持可用，若中途有取消、到期或工時變動，可重新擷取資料試算。

以下整合演練以 Stockroom 目前的 FastAPI 與 SQLite 實作建立訂單，依排程推進時鐘並實際提交三批。驗證合計出貨 9 件、A 到期釋回，以及倉庫從 20 件剩 11 件可用。[Stockroom](../stockroom-reservations/README.md)

```sh
python -m pip install -r ../stockroom-reservations/requirements-dev.txt
python demo.py ../stockroom-reservations
```

## 確認包裝後交運與查回收據

以 `dispatch.py` 的輸出當成計畫檔。用 `execute.py plan.json` 預覽，再對已確認包裝完成的訂單加上 `--confirm`。可重複指定 `--reservation` 選多張單。省略選單時會處理計畫中所有已到排定時間且尚未截止的訂單。每次指令立即核對一次，現場可在下一批包完後重新執行。

```sh
python execute.py plan.json
python execute.py plan.json --stockroom http://127.0.0.1:8000 --confirm --reservation B
python demo.py ../stockroom-reservations --execute-plan
```

預覽按本機時間把訂單列為 `waiting`、`due` 或 `expired`。正式執行會先用由箱號、保留編號和件數計算的批號查收據。查到時列為 `recovered`，換台重排或重排時間仍可取回同一份收據。沒有收據且已到時間才送出，Stockroom 在同一筆交易核對時窗、到期保留和箱子。開始時間包含在內，截止時間一到即拒絕新增出貨，已完成的批號仍可查回。網路中斷或收據無法核對會列為 `retry`。服務拒絕會列為 `rejected` 並附 HTTP 狀態，需核對現場後再試。輸出逐單寫出結果，遇到待重試、拒絕或已截止會回傳結束碼 1。

整合演練在 Stockroom 寫入 B 單後模擬回覆中斷。重新執行會取回 B 單原收據並交運 C 單，共確認 7 件，B 單只送出一次。D 單隨後因服務端已到裝車截止遭拒，兩件庫存保留待重排。[交運演練（私人預覽）](https://peca-github-demo.peca12968.chatgpt.site/?demo=dispatchExecution#demos)

## 裝車掃碼核對

用 `--labels` 匯出箱件 CSV，將 `code` 欄交給標籤軟體印成可掃描的條碼或 QR 碼。掃描器可輸出為每行一個條碼的 UTF-8 文字檔。條碼包含保留編號、箱號和計畫件數，例如 `DW1/B/B2/2`。

```sh
python execute.py plan.json --labels --reservation B > labels.csv
python execute.py plan.json --scan-log scans.txt --reservation B
python execute.py plan.json --scan-log scans.txt --reservation B --stockroom http://127.0.0.1:8000 --confirm
```

核對會列出漏掃箱件，以及掃描紀錄裡的重複、錯箱、件數不符和格式錯誤。每個問題會標出原始行號。使用 `--scan-log` 時，整份選取清單通過後才執行交運，Stockroom 會照常核對交運時窗及保留量。同一份正確紀錄可重試查回交運收據。[裝車掃碼核對（私人預覽）](https://peca-github-demo.peca12968.chatgpt.site/?demo=dispatchScan#demos)

## 接續下一車

將原始的完整 `work` 箱單和新車時窗交給 `replan.py`。新時窗檔必須提供 Unix 毫秒 `cutoff_ms`，可選填 `start_ms`、`stations`、`station_ready_ms` 與 `station_pauses`。省略開始時間就從 Stockroom 快照時間起算。指定開始時間時須等於或晚於快照，裝車截止則須晚於開始時間。

```sh
python replan.py packing-work.json next-truck.json --stockroom http://127.0.0.1:8000 > next-plan.json
python execute.py next-plan.json
```

重排會從同一份即時快照讀回所有保留單和既有箱號。原箱單仍提供各箱件數、工時和允許的台別，已登記箱子會列入 `already_dispatched`，件數不同的箱號列入 `shipment_conflicts`。已到期的單會標記為 `hold_closed`，仍保留的剩餘箱可依新時窗重排。輸出的 `captured_at_ms` 可供交班核對，包完後可用上一節的確認指令交運。

演練切到「下一車重排」時，A 單已到期，B、C 已出貨，D 的 2 件安排到第二台。確認交運後，在第一車的報告也能用同一批號查回 D 的收據。

## 跨車出貨對帳

```sh
python audit.py first-plan.json next-plan.json --stockroom http://127.0.0.1:8000
```

按參數順序帶入各車的排程結果，以同一份 Stockroom 快照核對箱號、原出貨件數與退回件數。保留編號和箱號相同時只核對一次，並列出各車規劃件數。結果標示已核對、尚未出貨、計畫間件數衝突，以及計畫與 Stockroom 件數不符。待交運箱還會帶出保留狀態，便於判斷該繼續交運或重排。單次可核對最多 100 張不同保留單，由 Stockroom 的整批快照上限決定。全部核對一致時結束碼為 0，尚有未出貨或衝突時為 1，讀取或輸入錯誤時為 2。

演練中，D1 箱列在兩車計畫內。第二車出發前對帳顯示已確認 7 件、待出 2 件；出發後已確認 9 件。若其中一份把 D1 填成 1 件，報告會列出計畫差異與實際登記的 2 件。[跨車出貨對帳（私人預覽）](https://peca-github-demo.peca12968.chatgpt.site/?demo=dispatchAudit#demos)

## 比較交班前後的對帳快照

```sh
python compare_audits.py earlier-audit.json later-audit.json
```

帶入同一個 Stockroom 依時間先後保存的兩份 `audit.py` JSON。報告逐箱比較新增出貨、退回、保留狀態及件數差異。各車計畫修改後，可查回前後規劃數量和已排除的差異。只有兩份快照都出現的箱件才能核對這段期間的出貨和退回；新增或移出的箱件會列為範圍變更。若擷取時間倒序、摘要和明細不符，或後一份的出貨紀錄與第一份矛盾，程式會報錯。

同一個示範延伸到交班後，D1 新增出貨 2 件，B1 退回 1 件。從錯填 D1 的報告比較，可看到件數差異已排除、D1 的原出貨量仍為 2 件。

## 掃描退回箱件並批次入庫

驗收後把原出貨條碼和可重新販售的件數填入 UTF-8 CSV。第一欄辨識原保留單、箱號和出貨量，第二欄是這次驗收合格件數。每箱填一行，最多 100 箱。

```csv
code,quantity
DW1/B/B1/2,1
DW1/D/D1/2,1
```

```sh
python receive_returns.py inspection.csv --batch-id dock-early --stockroom http://127.0.0.1:8000
python receive_returns.py inspection.csv --batch-id dock-early --stockroom http://127.0.0.1:8000 --confirm
```

先從同一份 Stockroom 快照核對原出貨量與尚可退量。重複掃到同箱、條碼件數與原出貨不符，或任一箱超過可退量，都會擋下整批。加上 `--confirm` 才送出入庫。其他人若在預覽後用掉額度，Stockroom 會拒絕整批，請重新核對。若收不到入庫回應，保留原批號與原內容重試，已入庫的批次會取回原收據。預覽可入庫、確認完成或取回收據的結束碼為 0，核對未通過、衝突或需重試為 1，檔案或讀取失敗為 2。

`demo.py --execute-plan` 會演練 B1 已退回一件後，錯報兩件時整批停下。修正後與 D1 一起入庫，模擬回應遺失，再用原批號取回兩箱收據。[實際整合資料](examples/execution-demo.json)

## 排程規則

最多安排 17 張單，優先最大化出貨件數，再最大化完成訂單數，最後比較工作完成時間。每張單只能由同一個工作站連續包裝。完成時間須早於保留期限與裝車截止時間，符合 Stockroom 到期時刻即釋回的行為。工時可包含預留的裝車和服務提交時間。

動態規劃對每組已完成訂單只保留最早的完成時間，因為越早做完，就越有機會接下後續工作。N 張單最多有 2^N 個子集合，每個集合最多試 N 個下一張訂單。測試用獨立窮舉器比較 300 組小案例的所有順序與跳過方式。[排程實作](dispatch.py) · [獨立窮舉測試](test_dispatch.py) · [跨專案演練](demo.py)

## 兩座包裝台同時作業

`python dispatch.py examples/morning.json --stations 2` 使用兩座工時相同的包裝台。輸出每張單的 `station`，並按預計交運時間排序。同一張單的所有箱子由同一座台包完，同一台每次只處理一張。原有單台指令維持其 JSON 格式，`--stations 2` 可與 `--resume` 一起使用。

規劃器先計算各子集合在一座台上的最早完成時間，再為第一座台找出剩餘訂單的最佳子集合。雙台總體按出貨件數、訂單數與最晚完成時間比較。額外的子集合比對需 O(N × 2^N) 時間，最多仍支援 17 張單。測試以獨立窮舉器比較 180 組案例，核對雙台所有分配及順序。

在早班示範，A 和 B 在第 2 至第 4 秒分別於兩座台包裝，裝車前可出 10 件。單台排程可出 9 件。[雙台出貨試玩（私人預覽）](https://peca-github-demo.peca12968.chatgpt.site/?demo=dispatchParallel#demos) · [可重建範例](examples/parallel-demo.json)

各包裝台開工時間不同時，可提供 `"station_ready_ms": [100000, 104000]`。陣列依台號排列，每個時間都須等於或晚於 `start_ms`，也可晚於裝車截止以表示該台趕不上這一車。排程會分別核對可行路線，並保留每座台實際的開工時間。範例第二台晚四秒開工時可出 9 件，A 到期釋回，其他訂單仍按期限交運。執行 `python demo.py ../stockroom-reservations --compare-stations` 可透過實際 Stockroom API 核對各情境的出貨和庫存，單元測試則以獨立窮舉比較 160 組開工時間不同的小案例。

保養、換班等暫停時段可指定為 `"station_pauses": [[], [{"start_ms": 108000, "end_ms": 109000}]]`。排程會合併同一台重疊或相鄰的區間，整張訂單須在一段連續可用時間包完。包裝可在暫停開始時剛好完工，也可於暫停結束時開工。第二台在第 8 至 9 秒暫停時，示範的 C 單改到第一台，兩台仍共出 10 件。整合演練另核對此情境的實際出貨與庫存。

需要專用設備的訂單可在 `work` 的該筆資料設定 `"allowed_stations": [2]`。省略時兩台均可包裝。若只開第一台，指定第二台的訂單會列為 `no_eligible_station`；有指定的台可用但趕不上期限時，會列為 `cannot_finish_before_deadline`。報告列出每筆明示限制，`--resume` 也會把限制套用在剩餘箱。對照演練中，C 單若限用暫停保養的第二台，其他三單出 7 件，C 單的 3 件在保留到期後回到可用庫存。測試獨立窮舉 300 組暫停時段案例，其中 150 組同時限制訂單台別。

## 部分出貨後重排

重新抓取 `POST /packing-snapshots` 的回應，將完整箱單和新的開工時間帶入 `python dispatch.py snapshot.json --resume`。已登記且件數相同的箱子列入 `already_dispatched`。重排只估算未出貨箱，並再次核對剩餘保留量、期限及裝車時間。已全部出貨的訂單會標記為 `already_dispatched`。若箱號相同但件數不符，該單暫緩，`shipment_conflicts` 會列出規劃和已登記的件數。

若同一張單的每箱都提供 `pack_ms`，排程可扣除已出貨箱的工時。原訂單總工時扣掉各箱工時的差額仍計入每次進場需要的準備時間。只提供訂單總工時時，剩餘箱沿用該工時。重排結果的 `dispatch` 可用新批號送到 Stockroom，`ship_units` 只計算新安排出貨的件數。

`python resume_demo.py ../stockroom-reservations` 會用實際 Stockroom API 建立並出貨 A1，讀取快照後比較原排程、部分出貨後重排及件數衝突。重排多安排 A2 的兩件商品，並以兩筆實際交運驗證。再次擷取後，報表可核對原箱號都已登記。[重排測試](test_dispatch.py) · [重排試玩（私人預覽）](https://peca-github-demo.peca12968.chatgpt.site/?demo=dispatchResume#demos)
