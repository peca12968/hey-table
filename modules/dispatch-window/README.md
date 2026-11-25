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

## 排程規則

最多安排 17 張單，優先最大化出貨件數，再最大化完成訂單數，最後比較工作完成時間。每張單只能由同一個工作站連續包裝。完成時間須早於保留期限與裝車截止時間，符合 Stockroom 到期時刻即釋回的行為。工時可包含預留的裝車和服務提交時間。

動態規劃對每組已完成訂單只保留最早的完成時間，因為越早做完，就越有機會接下後續工作。N 張單最多有 2^N 個子集合，每個集合最多試 N 個下一張訂單。測試用獨立窮舉器比較 300 組小案例的所有順序與跳過方式。[排程實作](dispatch.py) · [獨立窮舉測試](test_dispatch.py) · [跨專案演練](demo.py)

## 部分出貨後重排

重新抓取 `POST /packing-snapshots` 的回應，將完整箱單和新的開工時間帶入 `python dispatch.py snapshot.json --resume`。已登記且件數相同的箱子列入 `already_dispatched`。重排只估算未出貨箱，並再次核對剩餘保留量、期限及裝車時間。已全部出貨的訂單會標記為 `already_dispatched`。若箱號相同但件數不符，該單暫緩，`shipment_conflicts` 會列出規劃和已登記的件數。

若同一張單的每箱都提供 `pack_ms`，排程可扣除已出貨箱的工時。原訂單總工時扣掉各箱工時的差額仍計入每次進場需要的準備時間。只提供訂單總工時時，剩餘箱沿用該工時。重排結果的 `dispatch` 可用新批號送到 Stockroom，`ship_units` 只計算新安排出貨的件數。

`python resume_demo.py ../stockroom-reservations` 會用實際 Stockroom API 建立並出貨 A1，讀取快照後比較原排程、部分出貨後重排及件數衝突。重排多安排 A2 的兩件商品，並以兩筆實際交運驗證。再次擷取後，報表可核對原箱號都已登記。[重排測試](test_dispatch.py) · [重排試玩（私人預覽）](https://peca-github-demo.peca12968.chatgpt.site/?demo=dispatchResume#demos)
