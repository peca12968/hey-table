# Plate Cost｜一張套餐收據，用了多少食材？

一張全支付示範餐單包含親子丼、兩份煎餃與煎茶。套餐折扣後，收據金額為 345 元。依範例供應商包價、配方與各批產量換算，這張單的標準食材成本為 **96.87 元**，扣除食材後剩 **248.13 元**。

| 餐點 | 折後收據金額 | 標準食材成本 | 扣食材後金額 |
| --- | ---: | ---: | ---: |
| 親子丼 1 碗 | 143.00 | 42.65 | 100.35 |
| 煎餃 2 份 | 157.00 | 48.00 | 109.00 |
| 煎茶 1 杯 | 45.00 | 6.22 | 38.78 |
| 合計（新台幣） | **345.00** | **96.87** | **248.13** |

## 重跑一張收據

Python 3.12 與標準函式庫即可執行。下列命令下載產生範例所需的兩個作品，固定版本可重現上表。

```sh
git clone https://github.com/peca12968/prep-sheet.git ../prep-sheet
git -C ../prep-sheet checkout --detach 00e56da3bf47a32819652a69bdcc9862fa6f56e7
git clone https://github.com/peca12968/receipt-returns.git ../receipt-returns
git -C ../receipt-returns checkout --detach 30c97e932f2a8b60144d583295e1983f9f2c086d
python demo.py ../prep-sheet ../receipt-returns
```

範例將禾日食堂的合成收據匯入暫存退餐帳，讀取成交時凍結的套餐單價，試算退一份單點煎餃 85 元，再撤銷該筆登記。假設原餐點皆已製作，退餐後帳面餘額為 260 元，食材成本仍為 96.87 元，扣食材後剩 163.13 元。撤銷後，報表恢復為上表。這是本機退餐試算，實際退款與入帳金額應以金流紀錄核對。

## 用店家的材料包價試算

將每項原料的計量單位、生效時間、每包含量與新台幣整包金額填入[包價範例](examples/prices.csv)。生效時間使用 Unix 毫秒，含起點。包裝大小可隨報價更換，計量單位要與食譜一致。指令接受 Receipt Returns 資料庫與餐單編號，從一個唯讀交易擷取原始份數及目前仍有效的退餐登記。

```sh
python ../receipt-returns/returns.py lunch.db import ../receipt-returns/examples/ticket.json
python plate_cost.py lunch.db 1 --recipes ../prep-sheet/examples/recipes.json --prices examples/prices.csv
python plate_cost.py lunch.db 1 --recipes ../prep-sheet/examples/recipes.json --prices examples/prices.csv --price-at-ms 1796000000000
```

第二個報表固定同張收據與原餐點配方，只換用指定時刻的原料報價。30 顆煎餃的包價從 120 元變成 150 元，兩份共用 12 顆，這張單的成本因此增加 **12 元**至 108.87 元。

## 從高湯追到昆布

親子丼的高湯來自兩處：每碗直接用 10 ml，另使用 25 ml 丼飯醬，而每批 80 ml 醬汁要用 75 ml 高湯。工具先將兩處用量合併，再按高湯每批 120 ml、使用 2 g 昆布的配方換算，得到每碗用 **107/192 g** 昆布。報表每道菜都列出原料用量、適用包價日期、單位成本與小計。

每道菜的食譜依下單時間選版，半成品配方與產量取自提供的食譜檔。重建歷史餐單時，應使用當時的半成品配方。工具依標準配方分攤耗用成本，未計入實際報廢、人工、運費或支付手續費。若缺適用包價、單位不符、配方循環，或退餐份數無法對回成交單價，指令會指出問題並以狀態碼 2 結束。

內部運算保留分數。整單食材成本四捨五入至「分」後，依各菜的小數餘額由大到小分配尾差，餘額相同則按菜色 ID 排序。JSON 欄位 `*_twd` 以元表示，`*_cents` 以分表示。

執行 `python -m unittest -v` 可驗證改價邊界、舊版退餐帳、成本高於餘額及 500 組尾差分配。跨專案範例另將餐點份數放大到半成品剛好做完整批的倍數，以 Prep Sheet 的獨立備料計算核對八項原料用量。[成本實作](plate_cost.py) · [單元測試](test_cost.py) · [跨專案範例](demo.py)
