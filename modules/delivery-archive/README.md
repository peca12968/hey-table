# Delivery Archive｜跨版本交貨事件匯出

早班的收貨站仍用 v1 格式，一筆回條代表一件貨。晚班升級到 v2，開始記錄卸貨月台，並允許一筆回條登記多件。Delivery Archive 把兩班的 Avro 二進位檔合併成同一份 UTF-8 JSON Lines，讓報表端可以獨立選擇升級時間。

## 從三筆回條重現格式升級

需要 Python 3.12 或 3.13。在乾淨的專案目錄執行以下指令。兩個輸入範例都是合成資料。

```sh
python -m pip install -r requirements.txt
mkdir build
python archive.py pack --writer v1 examples/morning.jsonl -o build/morning.avro
python archive.py pack --writer v2 examples/evening.jsonl -o build/evening.avro
python archive.py export --reader v2 build/morning.avro build/evening.avro -o build/receipts.jsonl
```

最後一行回報寫入 3 筆。在 `build/receipts.jsonl` 可看到以下結果。

| 回條 | 寫入格式 | 站點 | 月台 | 件數 |
| --- | --- | --- | --- | ---: |
| R-01 | v1 | 台中 | null | 1 |
| R-02 | v1 | 台南 | null | 1 |
| R-03 | v2 | 台南 | B2 | 4 |

前兩筆的件數來自範例的業務規則「舊制一張回條一件貨」。舊版沒有月台資訊，因此新版讀取時保留為 null。若仍要產生四欄的舊報表，將上一個指令的 `--reader` 改為 `v1`，並指定另一個輸出檔名。

## 讀寫相容性

每個 Avro Object Container File 都帶有自己的 writer schema。匯出工具從檔頭讀取它，先檢查是否能投影成指定的 reader schema，再逐筆解碼。下表列出兩版實際可觀察的結果。[Avro schema resolution 規格](https://avro.apache.org/docs/1.12.0/specification/#schema-resolution)

| 寫入端 | v1 讀取端 | v2 讀取端 |
| --- | --- | --- |
| v1 | 讀出原有四欄 | 保留四欄，加上預設月台與件數 |
| v2 | 只投影舊版四欄 | 保留六欄，包括實際月台與件數 |

若寫入端把既有的毫秒時間欄位改成字串，讀取端要求的 long 即與它不相容。即使這個封存檔沒有資料列，檔頭檢查仍會拒收，可避免空批次掩蓋契約錯誤。[兩版欄位定義](schemas)

## 批次寫入與重跑

CLI 依給定的檔案順序及各檔內的紀錄順序輸出，重複事件照原樣保留。輸出先寫到目的目錄的暫存檔，所有資料讀完並完成 flush 與 fsync 後，才透過 `os.replace` 替換目標。在檔案系統支援原子替換的前提下，讀者看到的是整批結果。多個程序若同時寫同一個目標，最後成功替換的結果會保留。

遇到不相容版本或檔尾同步標記截斷時，命令回傳 2，stderr 會指出問題檔案，既有輸出保留原內容。相同輸入重跑會得到相同的 JSON Lines 位元組。這項重跑保證適用於 JSON Lines 匯出，Avro 容器本身使用隨機同步標記。[CLI 實作](archive.py)

## 驗證與履歷

```sh
python -m pip install -r requirements-test.txt
python -m unittest -v
```

六項整合測試從 CLI 入口執行。相容性矩陣用 Apache Avro 寫、fastavro 讀，再用 fastavro 寫、Apache Avro 讀，逐欄核對四種版本配對。失敗情境先成功輸出一批，再把第二個檔案換成不相容或被截斷的檔案，核對輸出位元組是否保持原樣。[測試](test_archive.py) · [GitHub Actions](../../.github/workflows/system.yml)

**履歷用語**　以 Python 與 Apache Avro 實作跨版本交貨事件管線，透過兩套 Avro 實作驗證四種讀寫配對，並以原子檔案替換保護上一批成功匯出的報表。

本專案使用 AI 輔助開發。
