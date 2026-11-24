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

以下整合演練以 Stockroom 目前的 FastAPI 與 SQLite 實作建立訂單，依排程推進時鐘並實際提交三批。驗證合計出貨 9 件、A 到期釋回，以及倉庫從 20 件剩 11 件可用。[Stockroom](https://github.com/peca12968/stockroom-reservations)

```sh
git clone https://github.com/peca12968/stockroom-reservations.git stockroom-upstream
git -C stockroom-upstream checkout --detach 7b6a21c3e94f0ce44f9a179ea6a223150ecb7967
python -m pip install -r stockroom-upstream/requirements-dev.txt
python demo.py stockroom-upstream
```

## 排程規則

最多安排 17 張單，優先最大化出貨件數，再最大化完成訂單數，最後比較工作完成時間。每張單只能由同一個工作站連續包裝。完成時間須早於保留期限與裝車截止時間，符合 Stockroom 到期時刻即釋回的行為。工時可包含預留的裝車和服務提交時間。

動態規劃對每組已完成訂單只保留最早的完成時間，因為越早做完，就越有機會接下後續工作。N 張單最多有 2^N 個子集合，每個集合最多試 N 個下一張訂單。測試用獨立窮舉器比較 300 組小案例的所有順序與跳過方式。[排程實作](dispatch.py) · [獨立窮舉測試](test_dispatch.py) · [跨專案演練](demo.py)
