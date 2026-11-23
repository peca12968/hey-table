# Batch Clock｜廚房批次計時與工時校準

一批煎茶做一杯或兩杯，時間可能不同。Batch Clock 讓店員記錄每批餐點在哪個工作位開始、何時完成，再用過去的批次產生 [Pickup Window](https://github.com/peca12968/pickup-window) 可讀的廚房設定。店員可先用後來的紀錄核對估算，決定是否採用。Python 3.11 以上即可使用，不需另裝套件。

## 用合成紀錄重跑午餐班

```sh
python batch_clock.py --db tea.db import examples/tea.jsonl --kitchen examples/kitchen.json
python batch_clock.py --db tea.db calibrate --kitchen examples/kitchen.json --cutoff 2026-11-23T00:00:00+08:00
```

範例含 24 批煎茶。前一天做了 10 批一杯及 10 批兩杯，用來校準。隔天完成的四批工時為 52、80、92、50 秒，全部保留作驗證。報表中 `dishes.sencha` 的結果如下。

| 實際量測 | 原設定 | 校準後 |
| --- | ---: | ---: |
| 每批估算區間 | 60–90 秒 | 48–85 秒 |
| 次日落在區間內 | 1 / 4 | 3 / 4 |
| 次日比上界更慢 | 1 批，晚 2 秒 | 1 批，晚 7 秒 |

這組資料顯示取捨：更多批次落入區間，但最慢那批超出估算的時間增加。報表也列出各份數的驗證筆數與偏差，沒有觀測的菜品保留原設定。這些數字來自合成樣本。

要將結果交給 Pickup Window，將純設定另存新檔，再用既有試算指令讀取。在支援 UTF-8 重新導向的終端機可執行以下命令。

```sh
python batch_clock.py --db tea.db calibrate --kitchen examples/kitchen.json --cutoff 2026-11-23T00:00:00+08:00 --format kitchen > measured-kitchen.json
node ../pickup-window/cli.mjs ../pickup-window/examples/stations.json measured-kitchen.json --cart ../pickup-window/examples/cart.json
```

## 店員計時

```sh
python batch_clock.py --db shift.db start lunch-001 sencha --qty 2 --lane 1 --kitchen examples/kitchen.json
python batch_clock.py --db shift.db active
python batch_clock.py --db shift.db finish lunch-001
```

`start` 和 `finish` 預設記錄操作當時的整秒時間。批次中途作廢可執行 `discard lunch-001`，釋出工作位並保留紀錄。每批使用唯一編號，意外重送相同動作可取回原結果。兩位店員同時使用同站同一工作位時，只有一批可以開工。SQLite 的寫入交易與唯一索引共同維護這項限制。

補登可加上 `--at 2026-11-23T12:01:00+08:00`。同一工作位按時間順序登記，下一批可以在上一批結束的那一秒開工。整批匯入採 JSON Lines，每行都要帶含時區的 `at`。與已存資料衝突會回報行號，該次匯入全部回滾。使用不同批次編號才表示另一批工作。

## 如何選擇時間與樣本

- 切點前已完成的批次用來校準，切點當下或之後才開始的批次用來驗證。跨切點、作廢、尚在進行，以及分站或單批容量已改變的歷史紀錄分別計數。時間切分依原始事件時間。
- 每種菜按實作份數分組。預設每組至少 10 批，可用 `--min-batches N` 調整。對排序後的完整秒數，以最近秩計算經驗 P10、P90，再取各組下界的最小值與上界的最大值，轉成排程器使用的一個每批區間。若某種份數缺少樣本，原區間也納入合併。
- 驗證資料只用於對照新舊區間，報表保留區間寬度、提早或延遲的批數，以及超出上界的累計秒數。百分位描述歷史樣本，未來命中率仍須追蹤。工具在本機輸出設定，正式網站的工時由部署者決定。

## 驗證方式

```sh
python -m unittest -v
git clone https://github.com/peca12968/pickup-window.git ../pickup-window
git -C ../pickup-window checkout 1e86c05effd8ebd102ea92629df68dda6ab1bb6d
python pickup_demo.py ../pickup-window
```

六項測試涵蓋整批回滾、重送、八個 CLI 程序同時爭用一個工作位、跨切點排除、缺樣本與留後資料隔離。跨專案演練把輸出交給真正的 Pickup Window CLI，在飲品台空閒時試算三杯煎茶，兩批共需的估算從 120–180 秒變為 96–170 秒。[計時與校準程式](batch_clock.py) · [回歸測試](test_batch_clock.py) · [跨專案演練](pickup_demo.py)

本專案使用 AI 輔助開發。示範沒有使用真實商店或顧客資料。
