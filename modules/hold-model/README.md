# Hold Model｜庫存 API 狀態模型測試

一筆 8 件的保留已經寄出 3 件，到期時應有 5 件回到可用庫存。這個測試工具用兩個 FastAPI 實例操作同一份暫存 SQLite 資料庫，將實際 HTTP 回應、庫存和每張保留單的進度與一個獨立模型逐步比對。模型用清單記下每一件貨的去向，從清單推算實體庫存與可用量。[模型](model.py) · [API 測試工具](check.py)

## 重跑案例

使用 Python 3.12 虛擬環境，在此專案目錄執行下列命令。工具預設從相鄰的 Stockroom 目錄載入服務，其他位置可用 `STOCKROOM_SOURCE` 指定。

```sh
git clone https://github.com/peca12968/hey-table ../stockroom-reservations
git -C ../stockroom-reservations checkout 34165f1adceb2baceaa53997b7a79a86656e959b
python -m pip install -r ../stockroom-reservations/requirements-dev.txt
python check.py --seed 1 --runs 24 --steps 48
python -m unittest -v
```

這 24 組合成操作共 1,152 步，包含 49 次建立續期收據、10 次重送取得收據、31 次續期衝突，以及 107 次服務重啟。公開的驗證流程在 Windows 和 Ubuntu 上重跑同一組種子。[跨平台 CI](../../.github/workflows/system.yml)

每步交替由一個實例送出操作，再從另一個實例查詢庫存與所有已建立的保留單。時鐘可由案例推進到到期邊界，重啟會重建兩個應用實例並重新開啟同一個資料庫。這組測試涵蓋有明確先後順序的跨實例操作。真正同時爭用寫入鎖的情境另見 [Stockroom 的並行測試](https://github.com/peca12968/hey-table/blob/34165f1adceb2baceaa53997b7a79a86656e959b/tests/test_api.py)。

## 把八步故障縮成三步

隨附案例重啟服務、重送請求並推進時間。開啟示範故障後，暫存資料庫在部分出貨的保留到期時漏還剩餘庫存。每次試跑都從一份全新的 20 件庫存開始。

```sh
python check.py --trace examples/partial-expiry.json --fault missed-expiry-credit --output failure.json
python check.py --trace failure.json --fault missed-expiry-credit
python check.py --trace failure.json
```

前兩次指令回傳結束碼 1。工具逐段移除操作，保留在同一操作類型、同一欄位出錯的序列。輸出會保留原本第 8 步的錯誤與縮減後的步驟。最後一次以正常版本重播，回傳 0。

| 縮減後的操作 | 模型預期的結果 |
| --- | --- |
| 保留 8 件 | 可用量由 20 降至 12 |
| 寄出其中 3 件 | 實體庫存降至 17，另有 5 件保留中 |
| 時間前進 5 秒，正好到期 | 5 件釋放，可用量回到 17。示範故障只回報 12 |

測試另逐一刪除三步中的任一步，檢查該差異是否消失。縮減保證的是單步刪除後無法保留相同失敗特徵，其他不同的操作序列仍可能觸發類似結果。[可重播的原始案例](examples/partial-expiry.json) · [重播與縮減測試](test_check.py) · [Delta Debugging 原始論文](https://www.st.cs.uni-saarland.de/publications/files/zeller-tse-2002.pdf)

## 兩個服務同時接單

庫存只有 20 件，午餐與晚餐各保留 13 件。顧客發出請求的順序和收到回應的順序可能不同。以下指令對共用暫存資料庫的兩個服務實例送出並行請求，記錄起訖順序、HTTP 狀態與內容，並在操作後查詢兩張保留單及剩餘庫存。

```sh
python history.py capture last-units --output history.json
python history.py verify history.json
python history.py verify examples/double-reserve.json
```

第一個情境中只有一筆保留能成功，可用量剩 7 件。第一、二個指令會根據同一份觀測找出相同的合法處理順序。第三個指令讀取刻意編寫的反例，兩筆都回報成功。若午餐已取走 13 件，晚餐應回 409，紀錄卻是 201，反過來排同樣矛盾。報表的 `blocked_next` 列出在其中一條最長可解釋前綴之後，下一筆應有及實際的回應。

另外可用 `capture packing` 讓分箱出貨、重送同一箱單、部分取消與查詢彼此競爭，也可用 `capture renew` 對同一舊期限送出兩種續期單號。每筆請求的開始和結束都取得唯一事件序號。若甲已回應才送出乙，搜尋必須將甲排在乙之前。時間重疊的請求則嘗試不同次序，由獨立模型核對每次回應與讀取結果。成功回應逐欄核對，業務錯誤核對 HTTP 狀態。[線性一致性的原始定義](https://www.cs.cmu.edu/~wing/publications/HerlihyWing90.pdf)

| 結果 | 如何讀取 |
| --- | --- |
| `linearizable`，結束碼 0 | `order` 列出一個可以解釋所有觀測的順序，以各請求的開始事件序號表示。 |
| `impossible`，結束碼 1 | 所有符合先後關係的候選順序都已排除。 |
| `inconclusive`，結束碼 3 | 搜尋達到步數上限，尚有候選順序待查，可提高 `--limit` 後重讀同一檔案。 |

離線驗證只需 Python 3.11 以上的標準函式庫。紀錄從全新的 20 件庫存開始，服務時鐘固定，只包含已回應的操作。結果適用於該份紀錄。測試實際擷取三種競爭情境各五次，另用枚舉全部排列的對照程式，查核 160 份四筆請求的合成紀錄。[驗證程式](history.py) · [並行與時序測試](test_history.py)
