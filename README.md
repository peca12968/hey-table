# Payout Ledger｜訂單與入帳對帳工具

電商訂單可能分兩次入帳、發生退款，或被支付平台重複列入檔案。這個 Python CLI 將兩種 CSV 載入 SQLite，按訂單與幣別彙總，列出需要追查的差異。只使用 Python 標準函式庫。

## 禾日食堂的電子支付日結

若客人第一次付款顯示失敗、重試後成功，店員可以用這個指令確認金流端到底收了幾筆。指令以唯讀方式開啟禾日食堂的 SQLite 備份，逐次比對付款參考號、金流交易號、支付工具、原始金額與狀態。適用於 LINE Pay、全支付、街口支付及信用卡。另支援下方的通用電商 CSV 月結。

從空白目錄名稱開始，產生合成交易，再跑一次離線日結。

```sh
python examples/restaurant_demo.py dinner-demo
python restaurant_close.py dinner-demo/restaurant.db --day 2026-11-23 --merchant demo-restaurant --environment sandbox --snapshot dinner-demo/records.json
```

這份報表有四筆當日金流交易，退款後合計 **NT$360**。其中有三個值得追查的情況。

| 報表裡的交易 | 店員會看到什麼 |
| --- | --- |
| 餐單 2 的 L1、L2 | 第一次在店內是失敗，金流卻有兩個不同交易號，各收了 120 元。兩筆都列在同一張餐單下。 |
| P1 | 店內餐單是 90 元；全支付原始交易是 95 元，部分退款後剩下 80 元。金額差異按原始交易比，日結合計採退款後金額。 |
| J1、X1 | J1 只有店內待付紀錄；X1 只有金流交易。各自保留參考號，方便逐筆追查。 |

### 哪一種支付工具收了多少錢？

同一份日結 JSON 的 `gateway_by_method` 按金流端回報的支付工具分組。每組包含交易筆數、各狀態筆數、原收款、已退金額與剩餘淨額。午餐範例可核得下表。

| 支付工具 | 金流交易 | 原收款 | 已退 | 淨額 |
| --- | ---: | ---: | ---: | ---: |
| LINE Pay | 2 | 240 | 0 | 240 |
| 全支付 | 1 | 95 | 15 | 80 |
| 街口支付 | 1 | 40 | 0 | 40 |
| 合計（新台幣） | 4 | 375 | 15 | 360 |

若信用卡只有授權，`direct_pay` 組會列出授權筆數，收款金額為零。全額退款會同時顯示原收款及退回金額。交易按金流交易號去重，店內付款方式與金流紀錄不一致時會保留差異供追查。信用卡示範交易在前一天發起，可用前一天的日結快照核對。

### 同一家餐廳有兩個商店編號

商店更換 LINE Pay 的收款編號後，顧客重試付款，舊、新商店各留下一筆 NT$120 的收款。各看各的日結時，兩邊都只看到一筆。以下用合成資料產生兩份金流快照，再以同一份店內 SQLite 備份核對。

```sh
python examples/restaurant_demo.py dinner-split --split-merchants
python restaurant_close.py dinner-split/restaurant.db --day 2026-11-23 --environment sandbox --merchant demo-restaurant --merchant demo-wallet --snapshot dinner-split/records.json --snapshot dinner-split/wallet.json
```

範例中，兩個商店編號的淨額分別為 NT$160 與 NT$200。合計 NT$360，其中 LINE Pay NT$240、全支付 NT$80、街口支付 NT$40。查看 `multiple_collections` 的餐單 2，可看到兩筆各自的商店編號、店內付款參考號與金流交易號。若收款跨午夜，報表保留另一日的交易線索，`in_day` 標出該筆是否計入當日合計。

`--merchant` 列出本次核帳範圍。離線模式每個編號各需一份同環境、同日期範圍的快照，順序可互換。線上模式以同一個具備相應查詢權限的 Partner Key 逐一查詢各編號。任何一個編號缺頁或金流交易號跨商店衝突，整份日結會以結束碼 2 中止。所有店內資料在同一筆唯讀交易中讀取。各商店的金流狀態以各自取得快照時為準。

**查實際商店。** 準備包含 `orders` 和 `payment_attempts` 的一致性 SQLite 備份；若資料庫使用 WAL，請用 SQLite backup 功能取得已提交的完整資料。選擇與備份相符的商店編號和環境，將 Partner Key 注入本機環境變數 `TAPPAY_PARTNER_KEY`，以 `--fetch` 取代 `--snapshot FILE`。程式只呼叫 TapPay 的交易查詢端點，並以交易號核對總筆數。缺頁、分頁中途變動或兩筆同號交易的內容矛盾，都會中止並回傳結束碼 2。加上 `--strict` 時，成功產生報表但有待查項目會回傳 3。[TapPay Record API](https://docs.tappaysdk.com/px-pay-plus/zh/back.html) · [金額與交易狀態欄位](https://docs.tappaysdk.com/px-pay-plus/zh/reference.html)

**日界與金額。** 有對應付款嘗試的交易，歸入店內發起付款的台灣日期；沒有對應餐單的交易，採金流端日期。查詢範圍前後各延伸一天，讓午夜前送出、午夜後確認的同筆付款只算一次。跨日重試若在這個範圍內出現兩次實收，會在餐單下列出兩個交易號。報表列出查詢當時的狀態；後續退款可以用更新後的資料重新核對。金流合計涵蓋該商戶該環境的 TWD 已請款金額與退款餘額；銀行撥款手續費另由撥款明細核對。

**資料範圍。** 每次核對指定環境中列入的商店編號，商店編號與其他通路共用時，其他通路交易也可能出現在 `provider_only`。本機示範付款和現金單皆排除。報表只輸出對帳欄位。保留在本機的 SQLite 備份與原始金流檔仍可能含顧客資料。CI 會在禾日食堂實際的資料庫遷移上建表，驗證跨午夜、重複收款、缺頁和付款重試等情境。[日結程式](restaurant_close.py) · [跨專案測試](test_restaurant_close.py)

## 跑一次電商月結

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

比較基準是該資料庫上次成功載入的快照，舊版本建立的資料庫也能使用。新資料庫的基準為空。輸入錯誤會回滾，並行執行則依取得 SQLite 寫入鎖的順序比較。再次載入同一份快照時，持續存在的差異會歸入 ongoing。需要保存每一期的調查軌跡時，可把每次產生的 JSON 留存。

### 找出造成差額變動的來源列

要解釋「USD 差額為什麼從 −31.50 變為 −24.50」，可在匯入第二份快照時加上 `--explain`。以下兩行可依序重跑，第一行會把基準設回範例的第一份快照。

```sh
python ledger.py examples/orders.csv examples/postings.csv --db demo.db
python ledger.py examples/orders.csv examples/postings-followup.csv --db demo.db --explain
```

`movements_by_currency` 逐幣別列出期初差額、期末差額，以及來源列對兩者差距的影響。範例中的 USD 差額等於實收減應收，以下數字皆為美分。

| 入帳 ID | 訂單 | 兩份快照之間的變化 | 對 USD 差額的影響 |
| --- | --- | --- | ---: |
| P-05 | O-999 | 前次列有 800，本次來源未列 | −800 |
| P-07 | O-101 | 本次新增入帳列 | +200 |
| P-08 | O-103 | 本次新增入帳列 | +1,000 |
| P-09 | O-777 | 本次新增入帳列 | +300 |

四列合計 +700，期初 −3,150 加上 +700 等於期末 −2,450。EUR 維持 +1,250，TWD 維持 0，各自的變動明細為空。這份報表解釋來源快照之間的差異。判斷 P-05 消失的業務原因，仍需回查原始入帳紀錄。

訂單應收增加會降低差額，入帳增加會提高差額。相同入帳 ID 改列其他訂單或幣別時，原歸屬與新歸屬各有一列。即使兩列互抵，仍可追查移轉。明細中 `null` 表示該版本沒有這筆資料，`0` 表示確有零元紀錄。每個幣別都會核對明細合計是否等於期末減期初，金額全程使用整數。

`--explain` 與 `--changes` 可單獨或合併使用，兩者均需指定持久化資料庫。來源列比較會在本次交易內暫存前一版，報表的記憶體用量隨變動列數增加。未指定兩個選項時沿用原有報表格式。

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

**履歷用語**　以 Python 和 SQL 實作逐幣別對帳，將兩次快照的淨差額變動追溯到個別訂單與入帳 ID，並用整數運算、交易回滾及並行匯入測試驗證報表一致性。

本專案為使用 AI 輔助建立的作品集示範，範例資料均為虛構。
