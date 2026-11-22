# Payout Ledger｜訂單與入帳對帳工具

電商訂單可能分兩次入帳、發生退款，或被支付平台重複列入檔案。這個 Python CLI 將兩種 CSV 載入 SQLite，按訂單與幣別彙總，列出需要追查的差異。只使用 Python 標準函式庫。

## 跑一次月結

需要 Python 3.11 或更新版本。資料夾內附虛構的訂單與入帳明細。

```sh
python ledger.py examples/orders.csv examples/postings.csv
python -m unittest -v
```

範例有 5 張訂單。其中 2 張完全相符，1 筆重複入帳列被排除，共產生 5 筆待查項目。訂單 O-104 應收 USD、實收 EUR，因而各產生一筆差異。USD 合計應收 17,950、實收 14,800，差額為 **−3,150 個最小貨幣單位**（−31.50 USD）。TWD、EUR 的差額分開計算。

| 差異類別 | 會計人員可以追查什麼 |
| --- | --- |
| amount_mismatch | 同一訂單、同一幣別的合計入帳與應收金額不同 |
| missing_posting | 訂單存在，該幣別尚無入帳紀錄 |
| orphan_posting | 已有入帳，但找不到對應幣別的訂單 |

## 輸入與執行模式

### 追蹤兩次對帳之間的變化

從新的示範資料庫開始，將兩份完整的入帳快照依序交給同一個資料庫：

```sh
python ledger.py examples/orders.csv examples/postings.csv --db demo.db
python ledger.py examples/orders.csv examples/postings-followup.csv --db demo.db --changes
```

第二份 JSON 報表中的 `changes` 以「訂單＋幣別」追蹤下表四種結果。

| 欄位 | 示範結果 | 判斷依據 |
| --- | --- | --- |
| new | 1 筆。O-777 有一筆 USD 入帳待查 | 本次首次出現差異，或前次已匹配、本次又出現差異 |
| ongoing | 3 筆。O-103 已部分入帳，USD 差額由 −2,500 縮至 −1,500 | 前後兩次都有差異，保留 before 與 after，可追蹤金額或類型變動 |
| resolved | 1 筆。O-101 補入 200，現已匹配 4,200 | 本次應收與入帳兩側都存在，金額相符 |
| absent | 1 筆。O-999 本次從來源消失 | 兩側都沒有本次資料，尚無結清證據 |

比較基準是該資料庫上次成功載入的快照，舊版本建立的資料庫也能使用。新資料庫的基準為空。輸入錯誤會回滾，並行執行則依取得 SQLite 寫入鎖的順序比較。再次載入同一份快照時，持續存在的差異會歸入 ongoing。需要保存每一期的調查軌跡時，可把每次產生的 JSON 留存。未傳入 `--changes` 時沿用原有報表格式。

### CSV 與結束碼

訂單欄位為 `order_id,currency,amount_minor`。入帳欄位為 `posting_id,order_id,currency,amount_minor`。每張訂單對應一個幣別。兩份完整快照必須使用同樣的金額單位約定。負數可表示退款。相同主鍵且內容相同的列會計入重複次數，主鍵相同但內容衝突會中止匯入並回報行號。

```sh
python ledger.py examples/orders.csv examples/postings.csv --db snapshot.db --strict
```

預設使用記憶體。指定 `--db` 會把兩張來源表以同一筆交易完整替換。若第二份檔案中途出錯，仍可查詢上次成功匯入的兩張表。每份檔案最多一百萬列，每筆金額最多十二位數，以控制 SQLite 聚合的整數範圍。差異清單在記憶體中組成，適合批次對帳。

| 結束碼 | 意義 |
| --- | --- |
| 0 | 報表已產生 |
| 2 | 輸入、檔案或資料庫錯誤，說明輸出至 stderr |
| 3 | 開啟 strict 模式且存在差異，完整 JSON 報表仍輸出至 stdout |

面試可直接從[對帳 SQL](reconcile.sql)說明為什麼先聚合、再比對兩側所有訂單與幣別，以及為什麼零元入帳和缺少紀錄需要不同處理。[回歸測試](test_ledger.py)包含退款、重複列、跨幣別、整批回滾、空快照與重跑一致性。

**履歷用語**　以 Python 和 SQL 整合訂單與入帳快照，支援分批入帳、退款及跨幣別差異追蹤，並以交易回滾及重跑測試驗證對帳結果。

本專案為使用 AI 輔助建立的作品集示範，範例資料均為虛構。
