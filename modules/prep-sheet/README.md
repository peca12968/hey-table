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

已有確定會到貨的採購單時，在 `--ledger kitchen.db` 後加上 `--incoming LUNCH`。可重複指定不同單號。報告的 `incoming` 列出這些單的未收數量，新採購會扣掉這些數量。廚房備料仍依可立即使用的庫存計算。驗收入庫與待收數會從同一份 SQLite 快照讀取。

## 試算現有庫存能做哪些單

在店員備料頁選取食譜 JSON 和盤點庫存 JSON，即可依目前日期、分站和範圍試算。預設只計待接單，可勾選「納入製作中餐單」。頁面會顯示可先做的餐單、備料順序和原料缺口，並可下載報告供同事重新匯入。檔案與試算都留在瀏覽器，實際庫存由店家的帳本管理。[食譜範例](examples/recipes.json) · [庫存範例](examples/stock.json)

完成本機試算後，在「預計到貨試算」填入一項或多項預計到貨的食材和數量。每次比較都從原始庫存依同一批餐單的成立順序重算。如果較早的餐單獲得缺料、開始占用原有食材，較晚的餐單可能反而出現缺料。頁面會標出兩種變化，原始庫存和原報告可繼續查閱。

`python prep.py --orders orders.json --recipes examples/recipes.json --ledger kitchen.db --readiness` 會依成立時間逐單試算，同時成立的餐單依餐號排序。可改用 `--stock stock.json` 提供盤點數量。每張可做餐單會附上實際的備料順序，例如先做高湯，再做用到高湯的丼飯醬。餘量可供後續餐單使用。缺料會列出該單輪到時所缺的原料與數量。

暫緩的餐單會保留所有模擬庫存給後續餐單。輸出的餘額是試算結果，領料與備料仍依店家的帳本操作。帳本模式會核對並跳過已登記領料的餐單。加上 `--include-preparing` 可納入製作中餐單。執行 `python readiness_demo.py` 可重建補入 280 g 雞肉前後的報告。[試玩現有庫存備料（私人預覽）](https://peca-github-demo.peca12968.chatgpt.site/?demo=prepReadiness#demos) · [範例資料](examples/readiness-demo.json)

要使用 SQLite 帳本試算，可從「備料試算報告」下載目前範圍的試算資料，再將指令的輸出存成 JSON。

```sh
python prep.py --orders prep-input.json --recipes examples/recipes.json --ledger kitchen.db --readiness > readiness.json
```

回到備料頁選取 `readiness.json`。頁面會比對日期、分站、範圍、餐單狀態及品項份數。重新擷取時，若這些內容相符，可以繼續查看報告。報告在瀏覽器內讀取，頁面顯示試算所用的擷取時間。原先的「下載訂單 JSON」可繼續用於採購指令。[下載、試算與重新匯入測試](../../qa/ordering.spec.mjs)

## 核對採購單與分批到貨

例如午餐採購單列了兩包醬油，每包 25 ml。上午先到一包，驗收後帳上增加 25 ml，下午仍可查到另一包待收。初次開單時會在既有的庫存帳加上採購單明細，保留原有收據與餘額。

```sh
python receiving.py --db kitchen.db --recipes examples/recipes.json open LUNCH purchase-report.json
python receiving.py --db kitchen.db --recipes examples/recipes.json accept LUNCH market AM morning.json
python receiving.py --db kitchen.db status LUNCH
```

`purchase-report.json` 使用 Pantry Freight 的完整 JSON 採購結果。`morning.json` 填寫實際收到的供應商 SKU 與整包數，例如 `{"market-soy": 1}`。同張採購單、供應商及送貨單號可安全重送，內容相同時會取回原收據。若任一品項超收，整張送貨單都會回滾。狀態輸出的每一列包含供應商、包裝規格、已收與待收包數。帳本追蹤實物數量，售價、運費和付款另由採購系統管理。

若供應商確認少供一包生米，將 `{"market-grain": 1}` 存成 `short-shipment.json`，再登記取消。採購單會保留取消單號、時間和各品項包數，試算會從待收數扣除已取消量。庫存與入庫收據維持原數量。已全部處理的訂單會依結果顯示 `received`（全數驗收）、`closed`（部分驗收、其餘取消）或 `cancelled`（全數取消）。

```sh
python receiving.py --db kitchen.db cancel LUNCH market OUT-OF-STOCK short-shipment.json
```

以下演練從五碗丼飯的原料缺口產生採購單，先收一包醬油，再取消一包生米、補買缺口，最後分別驗收剩餘五包與補買的一包。再次試算時，追加採購金額為 0 元。

```sh
python receiving_demo.py ../pantry-freight
```
