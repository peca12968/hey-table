# Prep Sheet｜午餐的五碗丼飯，要煮幾批白飯？

禾日食堂有兩張待接訂單，共三碗豬排丼與兩碗親子丼。其中兩碗豬排丼在食譜改版前點餐，每碗配飯 180 g；新版改為 200 g。合計需要 920 g 白飯，現有可用白飯 220 g，每鍋產出 400 g，所以要煮 **2 鍋**，供餐後剩 100 g。店家取消第二張訂單後，重新匯入餐單，只需煮 **1 鍋**。

## 重跑午餐範例

Python 3.12 標準函式庫即可使用。輸出為 JSON，包含納入的訂單編號、各版食譜的份數，以及每項材料的需求、可用量、批量與餘量。

```sh
python prep.py --orders examples/orders.json --recipes examples/recipes.json --stock examples/stock.json
python -m unittest -v
```

| 項目 | 五碗需求 | 現有 | 每批或每包 | 需要準備或採購 | 供餐後剩餘 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 白飯 | 920 g | 220 g | 400 g | 2 鍋 | 100 g |
| 丼飯醬 | 150 ml | 30 ml | 80 ml | 2 批 | 40 ml |
| 高湯 | 170 ml | 50 ml | 120 ml | 1 批 | 0 ml |
| 豬排 | 3 片 | 1 片 | 4 片 | 1 包 | 2 片 |

高湯的 170 ml 包含兩批丼飯醬所需的 150 ml，以及親子丼直接使用的 20 ml。程式依配方的相依順序彙總所有用途，再扣庫存、向上取整。若已有足量的丼飯醬，它所消耗的原料也不必重備。

## 套用自己的庫存與食譜

- `--orders` 接受禾日食堂廚房 API 的 JSON 陣列。也可改用 `--database orders.db` 讀取本機 SQLite 副本的單一查詢快照，只取編號、建立時間、狀態和品項。計畫不會扣帳，每次輸出都以提供的資料為準。
- 預設僅納入 `pending`。盤點的是製作前可用庫存，且製作中訂單也尚未領料時，可加上 `--include-preparing`。已備妥、已交餐、已取消的單一律排除。
- 菜單版本的 `from_ms` 是含起點的 Unix 毫秒，依訂單建立時間選取。每種備料 ID 有固定的單位與批次配方。若半成品本身的配方或單位改變，建立新的材料 ID，讓對應版本的菜單指向它。
- 庫存以同單位的非負整數輸入；未列出的材料視為零。每種原料的 `pack` 是一個採購單位含量，半成品的 `yield` 與 `inputs` 描述一批可用成品與投入原料。循環相依、未知餐點、重複訂單編號與無適用食譜都會使計算失敗。

## 實際入庫、煮飯與領料

每個廚房可建立獨立的 SQLite 庫存帳。以下從空帳開始，驗收入庫 180 g 生米、240 ml 水與配菜，再將一鍋煮好的飯入帳。第一張訂單使用舊版食譜，兩碗共領 360 g 白飯。再次送出同一張領料單會取得原收據，鍋中仍有 40 g。

```sh
python ledger.py --db kitchen.db init
python ledger.py --db kitchen.db --recipes examples/recipes.json receive delivery-001 examples/delivery.json
python ledger.py --db kitchen.db --recipes examples/recipes.json make pot-001 rice 1
python ledger.py --db kitchen.db --recipes examples/recipes.json issue examples/orders.json 1
python ledger.py --db kitchen.db history
python prep.py --orders examples/orders.json --recipes examples/recipes.json --ledger kitchen.db
```

最後一行會用現有餘額為第二張待接訂單重算，跳過已領料的第一張。每次入庫或製作都使用可辨識的單號，訂單領料則使用點餐編號。每張收據保留當時的異動、單位和結餘。任何一項原料不足時，整張異動回滾，補足後可用同一單號重試。

在實際操作時，先到禾日食堂「店家接單台 → 查看備料單 → 重新擷取」，下載 JSON，以該檔案取代範例訂單。帳本按匯出當下的狀態領料，之後的取消或交餐不會自動更新本機庫存。不同店舖或重設過編號的訂單資料庫應分帳記錄。

## 與點餐服務一起驗證

下列演練在本機 Miniflare 與 D1 執行指定版本的點餐 API。建立自取單與 A03 桌單，驗證重送去重，再製造製作中、已出餐、已完成與已取消的單。從廚房 API 取出六筆，計算其中兩張待接單；取消 A03 桌單後再查一次。全程使用合成資料。

```sh
npm ci --prefix ../.. --include=optional
node kitchen-demo.mjs ../..
```

同一演練也會讀取備料頁所用的訂單匯出 API，在本機帳本實際入庫、煮飯、領料，核對三張收據與剩餘的 40 g 白飯。另一組測試讓八個獨立 SQLite 連線競領最後一份煎茶，只有一張單成功。程式另針對 120 組庫存與相依配方，枚舉可行的批數範圍，獨立核對每項原料及半成品的最少批數。這些數字來自示範配方與合成訂單。專案以 AI 輔助開發。[批數演算法](prep.py) · [領料競爭測試](test_ledger.py) · [跨專案演練](kitchen-demo.mjs)


## 從訂單匯出試算採購

從店家接單台開啟備料單，再下載訂單 JSON。在 `modules/prep-sheet` 執行以下指令，將 `examples/orders.json` 換成下載的檔案，並提供符合實際菜單的食譜與供應商資料。

```sh
python lunch.py --orders examples/orders.json --recipes examples/recipes.json --stock examples/stock.json --suppliers ../pantry-freight/examples/suppliers.json
```

範例輸出 `prep` 的備料批數與 `purchase` 的供應商包數、運費及總額，共 7 包、165 元。使用庫存帳時，可將 `--stock examples/stock.json` 換成 `--ledger kitchen.db`，試算會讀取帳上結餘並跳過已領料的訂單。指令只讀取資料。加上 `--purchase-only` 並將輸出存為 `purchase-report.json`，即可接續下方的開單與驗收。供應不足時會輸出缺口並以狀態碼 `3` 結束，輸入錯誤則回傳 `2`。

## 核對採購單與分批到貨

例如午餐採購單列了兩包醬油，每包 25 ml。上午先到一包，驗收後帳上增加 25 ml，下午仍可查到另一包待收。初次開單時會在既有的庫存帳加上採購單明細，保留原有收據與餘額。

```sh
python receiving.py --db kitchen.db --recipes examples/recipes.json open LUNCH purchase-report.json
python receiving.py --db kitchen.db --recipes examples/recipes.json accept LUNCH market AM morning.json
python receiving.py --db kitchen.db status LUNCH
```

`purchase-report.json` 使用 Pantry Freight 的完整 JSON 採購結果。`morning.json` 填寫實際收到的供應商 SKU 與整包數，例如 `{"market-soy": 1}`。同張採購單、供應商及送貨單號可安全重送，內容相同時會取回原收據。若任一品項超收，整張送貨單都會回滾。狀態輸出的每一列包含供應商、包裝規格、已收與待收包數。帳本追蹤實物數量，售價、運費和付款另由採購系統管理。

以下演練會建立暫存庫存帳，從五碗丼飯的原料缺口產生採購單，先收一包醬油，再收剩下六包，最後重新詢價。驗收完成後的追加採購金額為 0 元。

```sh
python receiving_demo.py ../pantry-freight
```
