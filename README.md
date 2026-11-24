# Wallet Observer｜五分鐘內有多少餐單記為已付款？

午餐時段有三張 LINE Pay 餐單，合計四次付款嘗試。第一分鐘有一張已付款。第六分鐘再看，有兩張已付款、一張仍待確認。只靠這兩次觀察，能確定五分鐘內付款的有 **1 至 2 張**。加入第四分鐘的快照後，可以確定是 **2 張**。

這個 Python 工具從禾日食堂的 SQLite 資料讀取付款狀態，按餐單計數。每張單從第一次付款嘗試開始計時，失敗重試沿用原期限。報表衡量平台何時已記錄付款；金流商實際請款或入帳的時間需要另外取得。

## 午餐範例

| 付款方式 | 餐單 | 付款嘗試 | 已觀察滿五分鐘的餐單 | 五分鐘內已付款張數 |
| --- | ---: | ---: | ---: | ---: |
| LINE Pay | 3 | 4 | 3 | 1～2，加入第四分鐘快照後為 2 |
| 全支付 | 3 | 4 | 2 | 1 |

全支付的第二張餐單第一次付款取消，五分半鐘後重試成功，仍算超過五分鐘。第三張到五分半鐘才開始付款，在第六分鐘結算時單列為觀察時間不足。

以下操作需要 Python 3.12 與 Node.js 24。整合範例會在暫存目錄套用禾日食堂的資料庫遷移，透過原有訂單及付款 API 產生上述六張示範單，再啟動 Python 指令讀取 SQLite。所有付款走本機示範模式。[禾日食堂原始碼](https://github.com/peca12968/hey-table)

```sh
git clone https://github.com/peca12968/hey-table.git hey-table
git -C hey-table checkout --detach 93a419a680280410c8b07a4c376bd541fa50ebb5
npm ci --include=optional --prefix hey-table
node demo.mjs hey-table
```

## 用自己的本機資料核對

Python 指令只用標準函式庫。在不同時間對同一個本機 SQLite 資料庫各取一次快照，再依時間順序交給報表。請使用新的輸出檔名。

```sh
python observer.py capture restaurant.sqlite > first.json
python observer.py capture restaurant.sqlite > later.json
python observer.py report --environment demo --seconds 300 first.json later.json
```

擷取透過唯讀交易讀取，並記錄 SQLite 快照建立前後的兩個毫秒時間。若輸入是備份檔，請用 `--as-of-ms` 指定**資料庫備份當時**的已知 Unix 毫秒時間。JSON 只包含本機餐單與嘗試的流水號、付款嘗試建立時間、環境、方式及狀態。若只想看某一班，報表可加 `--from-ms` 與 `--until-ms`，依首次付款嘗試篩選，含起點、排除終點。

## 如何解讀數字

- `eligible` 是最後一份快照已確定超過期限的餐單數。`immature` 保留觀察期不足的張數。現場付款及從未發起線上付款的餐單沒有金流嘗試，不在這個母體內。
- `certain` 表示期限內已看到付款證據。`paid`、`partial`、`refunded` 都表示平台已記錄付款或其後的退款階段。僅授權的 `authorized` 尚未達到這個條件。
- `missed` 包含已觀察滿時限仍無付款、成功的重試在期限後才建立，或期限過後仍觀察到該次嘗試尚未付款的餐單。`uncertain` 表示觀察間隔容許付款落在期限任一側。`on_time_count_range` 從確定準時數到確定準時數加未定數，描述這一批餐單可由紀錄支持的範圍。成功與查詢落在同一毫秒時，保留無法分辨的先後順序。
- `demo`、`sandbox`、`production` 分開查詢。支援 LINE Pay、全支付、街口支付、悠遊付、Pi 拍錢包、全盈+PAY 與信用卡。工具依據同一來源保存的完整付款嘗試，假設來源時鐘可比較。遇到舊嘗試消失、識別資料改變、狀態倒退或不合規則的重試會停止；不同資料庫若剛好使用相同流水號，仍需由操作者核對來源。

執行 `python -m unittest -v` 可獨立驗證分析規則。測試枚舉成功發生的時刻與快照可能讀取的先後順序，逐種對照報表的上下限，另涵蓋延遲提交、退款、跨班重試與資料不相容。[分析實作](observer.py) · [邊界測試](test_observer.py) · [付款 API 整合範例](demo.mjs)
