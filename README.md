# Stockroom Reservations｜庫存保留 API

兩個人同時搶最後一件商品時，誰能完成保留？付款頁遇到網路逾時而重送時，又該扣幾次庫存？這個 FastAPI 服務用 SQLite 交易處理這兩種情境。內附一個有 20 件庫存的示範商品 `KIT-01`。

## 三分鐘展示

在 Python 3.12 虛擬環境中執行：

```sh
python -m pip install -r requirements-dev.txt
python -m uvicorn stockroom.api:app
```

另開終端機執行 `python demo.py`。首次保留兩件會得到 HTTP 201，重送同一筆則得到 200。在全新資料庫中，接著查詢庫存會看到 18，釋放後恢復為 20。也可在瀏覽器開啟 [互動式 API 文件](http://127.0.0.1:8000/docs)。

| 操作 | 語意 |
| --- | --- |
| GET /inventory | 讀取商品總量與可用量 |
| POST /reservations | 傳入 sku、quantity 及 Idempotency-Key 標頭。相同鍵與內容可取得目前保留狀態 |
| DELETE /reservations/{key} | 釋放保留。重複取消只會歸還一次 |

庫存不足、同鍵不同內容回傳 409。未知商品或保留回傳 404。輸入格式錯誤回傳 422。失敗的請求不會占用鍵。

## 為什麼能防止超賣

每個請求各自開啟資料庫連線。`BEGIN IMMEDIATE` 讓寫入者依序取得鎖，然後在同一筆交易完成重送檢查、條件扣庫存及建立保留。任一步驟失敗都回滾。保留即使釋放也保留原鍵，延遲送達的舊請求因此不會重新扣貨。

SQLite 適合本機或單節點展示。所有寫入共用一把鎖。若服務擴到多個節點，可討論改用共用 PostgreSQL、列層級鎖，以及為保留加入明確的逾時狀態。此版本的使用情境是可信任的本機呼叫端。

## 驗證與容器

```sh
python -m pytest -q
docker build -t stockroom .
docker run --rm -p 127.0.0.1:8000:8000 -v stockroom-data:/app/data stockroom
```

[測試案例](tests/test_api.py)以 24 個各需 2 件庫存的請求競爭 20 件，驗證恰有 10 筆成功、14 筆衝突，並另測並行重送、重啟後持久性及重複釋放。GitHub Actions 也建置映像並透過 HTTP 讀取容器內的庫存。

**履歷用語**　以 FastAPI 與 SQLite 建立庫存保留服務，透過資料庫交易及冪等請求處理並行下單與網路重送，並以 HTTP 整合測試驗證庫存一致性。

本專案為使用 AI 輔助建立的作品集示範，測試使用合成資料。
