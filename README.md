# Receipt Returns｜套餐部分退餐試算

同桌點了兩份煎餃，只有一份搭套餐，退一份應算多少？這個 Python 命令列工具讀取禾日食堂成交時的收據，依每份餐點當時分到的折扣計算金額。店員可先試算，再將確認的份數與金額登記在本機 SQLite，供下次退餐接續使用。

這是離線試算帳。每家店使用一個資料庫，輸入由店家取得的可信收據。工具不連線支付商，不查核實際入帳，也不辦理退款。登記紀錄只代表已在這份試算帳中使用的份數。

## 試一次分批退餐

A03 桌點一碗親子丼（170 元）、兩份煎餃（各 85 元）和一杯煎茶（45 元）。其中一碗丼飯搭一份煎餃折 40 元，全支付示範收據合計 **345 元**。

同品項有多個成交單價時，此作品先退實付較高的份數。同價時先用單點份數，再依套餐 ID 排序。這是示範採用的退餐規則。按原收據保留每份折扣，退餐後也不重配其他套餐。

| 退餐順序 | 當次計價 | 試算餘額 |
| --- | --- | --- |
| 第一份煎餃 | 單點 85 元 | 260 元 |
| 第二份煎餃 | 套餐分攤 13 元折扣，實付 72 元 | 188 元 |
| 親子丼與煎茶 | 143 + 45 = 188 元 | 0 元 |

在專案根目錄執行下列指令。日常使用只需 Python 3.10 以上與標準函式庫。

```sh
python returns.py demo.db import examples/ticket.json
python returns.py demo.db preview 1 gyoza=1
python returns.py demo.db record 1 gyoza=1 --request portion-1 --expected 85
python returns.py demo.db record 1 gyoza=1 --request portion-2 --expected 72
python returns.py demo.db record 1 oyakodon=1 sencha=1 --request rest --expected 188
python returns.py demo.db history 1
```

`preview` 回傳每個單價對應的份數、套餐 ID、當次金額與登記後的預估餘額。`record` 使用店員看過的報價，並在 SQLite 寫入交易內重新計算。其他人先登記而導致金額改變時，指令會要求重新試算。連線中斷可用相同請求 ID、份數與金額重送，取回先前結果。超量或任一品項無效時，整批不會登記。

匯入只保留餐單編號、成交時間、總額及每份價格所屬的套餐。一般收據使用當時的單價；套餐收據會核對成交份數、套餐兩邊折扣、逐菜淨額與總額。同一餐單可重複匯入，若編號相同但成交時間或計價資料不同，工具會拒絕覆蓋。

## 更正登錯的退餐

接續前面的三筆登記，若第一份煎餃登錯，可依原請求 ID 撤銷整筆，再查看目前帳面。

```sh
python returns.py demo.db void 1 --request portion-1 --reason "店員誤登第一份煎餃"
python returns.py demo.db statement 1
python returns.py demo.db preview 1 gyoza=1
```

此時仍有效的登記為 72 元與 188 元，合計 260 元，收據還有 85 元可登記。下一份煎餃取回單點的 85 元。若改撤銷 72 元的套餐份數，取回的是原本那份 72 元及其套餐編號。零元餐點同樣按份數恢復。

`statement` 以同一份資料庫快照列出目前有效金額、可登記餘額、各筆原登記與撤銷理由及時間。`history` 維持原始登記收據，裡面的餘額是各筆當時的數字。相同撤銷理由重送會取回第一次撤銷的收據。已撤銷的登記單號若再次送出，也只會取得當初的登記結果。重新登記餐點請用新單號。

這項更正只影響本機退餐試算帳。整合測試使用全支付與 LINE Pay 示範付款，另外讀取點餐平台原收據核對付款狀態。若已透過金流商辦理退款，實際款項須從商家金流紀錄查核。[更正與並行測試](test_voids.py)

## 重跑驗證

```sh
python -m unittest -v
```

單元測試枚舉這張餐單所有 **44 種**分次退餐順序與分組，逐次核對金額。另用兩個 SQLite 連線同時登記，檢查相同請求只留一筆、最後一份只能退一次，以及舊報價無法蓋過新報價。[定價實作](pricing.py) · [登記事務](returns.py) · [完整測試](test_returns.py)

整合演練需要 Node.js 24 和已安裝依賴的禾日食堂原始碼。它會在本機 Worker 和 D1 送出 A03 訂單並模擬全支付付款，從收據 API 取得 JSON，再呼叫本專案 CLI 分三批登記，最後重新讀取原收據確認仍為已付款。第二張 LINE Pay 自取單共 620 元，三碗豬排丼分別是單點、搭煎茶與搭煎餃，依序可退 190、162 與 159 元，剩下兩道配餐合計 109 元。[實際 API 演練](demo.mjs) · [固定的禾日食堂版本](https://github.com/peca12968/hey-table/tree/b93c0850bba0ce3350acffad5426b137953721b6)

```sh
git clone https://github.com/peca12968/hey-table ../hey-table
git -C ../hey-table checkout b93c0850bba0ce3350acffad5426b137953721b6
npm ci --prefix ../hey-table --include=optional
node demo.mjs ../hey-table
```
