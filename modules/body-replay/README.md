# Body Replay｜發布前找出哪些舊請求會被拒絕

庫存服務新增整批出貨，舊客戶端還會照原來的方式保留、寄送及退回商品。Body Replay 讀取發布前後的 OpenAPI 3.1 文件，用同一批具體請求核對各版接受的 JSON 內容。若改版收緊限制，報告會留下受影響的路徑、完整請求內容、欄位位置與範例出現次數，方便開發者重跑。

## Stockroom 的兩次發布比較

以下使用七個合成範例，各自附上模擬出現次數，合計 75 筆。整合測試讓每個不同範例在三個本機 FastAPI 版本各實際送出一次，將 HTTP 回覆與離線判定逐筆核對。

| 比較對象 | 仍受支援 | 舊版接受、候選版拒絕 | 服務實測 |
| --- | ---: | ---: | --- |
| 已發布的整批出貨版本 | 75 | 0 | 七個範例全部收到 HTTP 201。新增的整批出貨端點列在未覆蓋清單。 |
| 將每筆保留上限改為 5 件的本機演練版 | 60 | 15 | 保留 6 件與 10 件的兩個範例收到 HTTP 422，其餘五個仍收到 201。 |

其中一筆反例是 `POST /reservations` 的 `{"sku":"KIT-01","quantity":6}`。範例中它出現 12 次，另一筆 10 件的出現 3 次。兩筆的錯誤位置都是 `/quantity`，觸犯的規則都是 `maximum`。這些次數是演練權重，實際發布影響取決於所提供的請求樣本。[範例資料](examples/requests.json) · [兩個 Stockroom 版本的差異](https://github.com/peca12968/hey-table/compare/34165f1adceb2baceaa53997b7a79a86656e959b...d6d5139e2b4413fea49f83d15b3928c7e97be6da)

## 自己跑

使用 Python 3.12。若已有兩份規格與請求檔，只需安裝本工具的依賴並執行比較。

```sh
python -m pip install -r requirements.txt
python replay.py old-openapi.json new-openapi.json requests.json
```

請求檔是一個 JSON 陣列。每筆填入唯一的 `id`、HTTP `method`、具體的 `path`、選用的 `body` 與正整數 `count`（預設一次）。省略 `body` 和明確提供 JSON `null` 會分別驗證。報表會原樣留下失敗範例的請求內容，因此適合使用可公開重現的測試資料。

若要從 Stockroom 的 Git 歷史實際產生規格與回應紀錄，在新虛擬環境執行下列命令。若已有相鄰的完整 checkout，可直接使用。演練在暫存目錄載入兩版來源，合成的限制變更也只寫入該目錄。

```sh
git worktree add --detach ../stockroom-reservations-verified d6d5139e2b4413fea49f83d15b3928c7e97be6da
python -m pip install -r requirements.txt -r ../stockroom-reservations-verified/requirements-dev.txt
python demo.py ../stockroom-reservations-verified results
python replay.py results/published.json results/rehearsal.json examples/requests.json
python -m unittest -v
```

`demo.py` 需指定新的輸出目錄。它保存三份 OpenAPI 文件與 `runtime-statuses.json`。各請求使用獨立的暫存 SQLite 資料庫，退貨案例預先建立已出貨箱，續期案例使用固定時鐘。上面的演練版比較會產生兩個反例並回傳結束碼 1。

## 如何判讀

- `preserved` 是樣本符合新舊兩版請求規格的次數；`regressed` 是僅符合舊版的次數；`baselineRejected` 表示樣本原本就不符合舊契約，應先檢查基準或資料。若新版不再記載此路徑、方法或 JSON 格式，也會保留原因。
- `uncoveredCandidateBodyOperations` 列出候選版中有宣告請求內容、卻沒有舊版有效樣本觸及的操作。即使樣本全部通過，這些操作仍需要自己的測試。
- 核對範圍是路徑、方法、JSON 內容的必填性及結構。固定路徑優先於樣板路徑，樣板占位符比對單一路徑片段。JSON 媒體型別優先順序為 `application/json`、`application/*`、`*/*`。輸入使用應用程式內部的路徑，不含部署前綴、查詢字串或 URL 片段。
- 以 JSON Schema Draft 2020-12 驗證，支援文件內的 JSON Pointer 引用與巢狀結構。驗證器將 `format` 視為註記。外部引用、錨點、替代方言、引用式 Path Item 或有歧義的路徑樣板會要求修正輸入。權限、標頭、參數內容、資料庫狀態與自訂驗證須靠服務測試另行核對。[OpenAPI 3.1 規格](https://spec.openapis.org/oas/v3.1.1.html) · [JSON Schema 引用](https://python-jsonschema.readthedocs.io/en/stable/referencing/)
- 結束碼 0 表示這批範例全數保留；1 表示找到舊請求相容性退化；2 表示輸入、基準或工具支援範圍有問題。

本專案以 AI 輔助開發，資料及演練版限制均為合成案例。
