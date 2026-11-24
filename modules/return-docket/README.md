# Return Docket｜退貨收據交接簽章

北倉早班共驗收 2 批、4 筆箱別紀錄、6 件商品。兩批都包含東區的同一箱，第一批退 2 件，第二批再退 1 件。交接檔保存兩次各自的原始收據，晚班只用事先取得的公鑰和預期班次，就能離線核對並查看每次驗收當時的剩餘可退量。

## 重跑合成的交班範例

需要 .NET 10 SDK 與 Python 3.12。指令使用暫存資料庫、暫存金鑰與固定版本的 Stockroom。整合程式會出貨、登記退貨、重啟服務取回原收據、封裝並離線驗證，然後列出批次及箱別明細。

```sh
python -m pip install -r ../stockroom-reservations/requirements-dev.txt
dotnet build -c Release
python demo.py ../stockroom-reservations
```

## 對已取得的收據簽章

在保管金鑰的裝置產生私鑰，透過既有的可信管道將公鑰交給接班人。Windows 上請將私鑰放在只有簽章者帳號有權讀取的資料夾。Linux 上產生的私鑰使用擁有者讀寫權限。從 Stockroom 的 `GET /return-batches/{batch_id}` 各取一次原始 JSON。

```sh
dotnet run -c Release --no-build -- generate-key north-private.pem
dotnet run -c Release --no-build -- public-key north-private.pem > north-public.pem
dotnet run -c Release --no-build -- pack north-private.pem north-2026-11-24-am handoff.json morning-1.json morning-2.json
dotnet run -c Release --no-build -- verify north-public.pem north-2026-11-24-am handoff.json
```

每份交接檔可帶 1 至 50 個批次。批號在交接檔內唯一，同一箱在不同批次可各保留一筆收據。封裝會保留原始箱號、件數與剩餘可退量，並按批號、訂單及箱號排序。命令會先將完整檔案寫入同一資料夾，再移到指定檔名。若目的檔已存在，請使用新檔名。

## 簽章範圍與驗證

檔案格式 `return-docket.v1` 使用 Base64 封裝確切的 UTF-8 內容與 DER 簽章。簽章採 ECDSA P-256 和 SHA-256，涵蓋格式版本、班次與全部收據欄位。驗證端使用自行指定的公鑰，確認班次相符後才輸出明細。驗證成功回傳 0，簽章或班次不符回傳 1，無法讀取或格式錯誤回傳 2。[.NET ECDsa 簽章 API](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.ecdsa.signdata?view=net-10.0)

簽章證明交接檔由對應私鑰簽出，且已簽內容完整。批次是否齊全、私鑰的持有人，以及同班次是否另有一份更新的交接檔，仍須依現場交班紀錄核對。檔案可由持有者讀取，應沿用倉庫的資料傳送權限。

執行 `python -m unittest -v` 可重現件數遭改、錯班次、錯公鑰及八個寫入者同時發布。環境若有 OpenSSL，會再測試兩套實作互驗同一格式的簽章。CI 在 Windows 與 Ubuntu 執行 Stockroom 整合範例。[封裝與驗證實作](Program.cs) · [跨服務測試](demo.py)
