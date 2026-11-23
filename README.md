# Float Plan｜午餐班開店前要補多少零錢？

四位客人依序付現，應找 10、55、45、10 元。錢櫃開班時有三枚五元、一枚十元和一枚五十元，共 75 元。客人都拿百元鈔，每一筆找零又都小於百元，因此應找的 120 元都得從開班零錢支出。**至少要再備 45 元。** 從可調用的零錢中拿一枚五元、四枚十元，就能連續找完四筆，全班共交付十枚硬幣。

這個 Python CLI 讀取收款順序、每位客人實際交付的面額及庫房可補的數量，算出最低開班補款、每筆的找零方式與結帳後各面額餘量。適合以歷史班次重播或演練一組預估收款情境。若顧客改拿其他面額，應依新情境重算。

## 重跑午餐案例

使用 Python 3.12，建議在虛擬環境內執行。

```sh
python -m pip install -r requirements.txt
python float_plan.py examples/lunch.json examples/supply.json
python float_plan.py examples/lunch.json examples/no-supply.json
python -m unittest -v
```

| 情境 | 結果 |
| --- | --- |
| 可以從庫房調零錢 | `topUpValue` 為 45，四筆皆能完成，期末剩六張百鈔。 |
| 庫房無零錢可補 | 最長可連續完成前兩筆。第三筆 A05 毛豆應找 45 元，即使改選前兩筆的找零方式，也無法連續完成前三筆。 |
| 顧客交付款低於售價 | `firstBlocked.reason` 顯示 `underpaid`，並列出交付款減售價的負差額。 |

報表中的 `steps` 是建議的收款方案。`complete` 為假時，補款、找零枚數及期末錢櫃均對應**最長可連續完成的前段**。完整方案的結束碼為 0，中途受阻為 3，讀檔、輸入或求解錯誤為 2。

## 資料與決策

- 班次採用 Till Change 的 JSON 格式。`opening` 與各筆 `tender` 依 `denominations` 由小至大填寫紙鈔張數或硬幣枚數。`supply.json` 需列出相同的面額，`available` 是各面額開班前最多可補入的數量。範例中的面額為 1、5、10、50、100 元。
- 班內每一筆可使用原有零錢和當下收到的現金，所有面額的餘量皆須大於或等於零。先最小化開班補入的金額，再將該金額固定以最小化全班交出去的張數與枚數。若有多個同分方案，輸出其中一個。
- Till Change 的 `reserve` 是即時收銀時的面額偏好。這個班前模型接受同一份班次檔，以整班補款金額與找零枚數為決策條件。若店員按其他找零策略執行，某些班次可能得到不同結果。
- 使用 OR-Tools CP-SAT 的整數變數表示補款、每筆找零與各面額庫存。只有求解器證實最優才輸出最小值。整班無解時，依「前段無解，後續到款也無法補救」的性質，二分搜尋第一筆不能連續處理的收款。[CP-SAT 求解器與結果狀態](https://developers.google.com/optimization/cp/cp_solver)

## 驗證

獨立測試枚舉 128 個小班次的所有可用補款組合與逐筆找零選擇，比對最長可完成前段、最小補款、最少找零枚數，並核對每筆現金守恆。另有一例需在第一筆多找一枚，保留下一筆要用的面額，兩筆才都能完成。[窮舉測試](test_float_plan.py)

跨專案測試以固定版本的 C# Till Change 重播同一份合成午餐班次。原錢櫃可收三筆，第三筆被退回後仍能處理第四筆。依方案補入 45 元再跑，即時收銀程式可以收完四筆。若相鄰目錄已有該版本且已安裝 .NET 10，可執行 `python compare_register.py ../till-change` 重現。[原始班次](https://github.com/peca12968/till-change/blob/210ec2967f8c1394849fd68ae183c98d075ba9c8/examples/lunch.json) · [跨專案重播](compare_register.py)

本專案以 AI 輔助開發，範例與測試均使用合成交易。
