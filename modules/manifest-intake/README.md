# Manifest Intake｜貨單傳到一半，收貨端看得到幾箱？

傳送端先宣告整張貨單的箱數，再用 gRPC 串流逐箱傳送箱號與件數。服務將各箱寫進連線專屬的 SQLite 暫存表。收到正常結尾並核對箱數後，才以同一筆交易發佈箱件和收據。等待慢速用戶端期間，其他服務實例仍可提交另一張貨單。

## 跑一次真實的串流傳輸

使用 Python 3.12。在儲存庫目錄產生 Python 的 Protobuf 訊息與 gRPC 用戶端程式，再啟動本機服務。

```sh
python -m pip install --only-binary=:all: -r requirements.txt
python -m grpc_tools.protoc -I . --python_out=. --grpc_python_out=. manifest.proto
python service.py receipts.db
```

在另一個終端機執行兩次相同的指令。

```sh
python client.py morning 2 examples/boxes.csv
```

第一次收到 2 箱、11 件的收據；第二次沿用同一份摘要並回報 `replayed=true`。服務預設在本機明文連線上演練，資料庫與暫存表皆由 SQLite 管理。

## 交易語意

### 新舊服務怎麼區分「每箱件數不同」與「尚未檢查」？

收據的選用欄位 `uniform_box_units` 有三種狀態。舊版服務回傳時這個欄位缺席。新版收到 3 件和 5 件兩箱時明確回傳 false，收到 4 件和 4 件則回傳 true。讀取舊貨單時，服務按已儲存的逐箱數量計算，既有 SQLite 資料庫可直接開啟。

以下演練啟動固定版本的舊服務，實際上傳兩箱，再由新版服務開啟同一份資料庫，核對查詢、倒序重送與原始收據摘要。將新版收據交給舊版轉送者，二進位往返仍可辨識明確的 false，經舊版 ProtoJSON 轉送時該欄位會消失。

```sh
git worktree add --detach ../manifest-legacy 3ba0fc554334ed236300b66423e7c6301eb8fabd
git worktree add --detach ../proto-relay-probe-verified a757e62362a9bab547c94fad8b5609be5adb8a37
python upgrade_demo.py ../manifest-legacy ../proto-relay-probe-verified/probe.py
```

### 上傳與重送

- 箱號在一張貨單內唯一。先依箱號排序，再將具有長度欄位的箱號及件數納入 SHA-256；改變傳送順序仍可取得原收據。同一貨單編號搭配不同箱件內容回傳 `ALREADY_EXISTS`。
- 如果正常結束卻缺箱，傳送端收到 `FAILED_PRECONDITION`；重複箱號或超過宣告箱數也會被拒絕。未完整送達的串流不會發佈。若完整送完卻沒收到回應，可查詢 `Lookup` 或用原內容重送，涵蓋回應與提交之間斷線的情況。
- `Upload` 的第一個訊息必須是非空貨單表頭，其後都是箱件。編號可含 ASCII 英數、點、底線與連字號，最多 96 字元，箱數及每箱件數必須大於零。[Protobuf 契約](manifest.proto)

## 重現斷線與並行重送

執行 `python -m unittest -v`。測試用兩台獨立 gRPC 服務共用一份資料庫，等待第一箱真的抵達暫存表，再由另一台服務查詢，確認原單尚未發佈。此時另一張 7 件貨單成功提交；取消原串流後再重送完整的兩箱，才取得 3 件收據。

另一個案例向兩台服務同時傳送六份相同貨單，其中三份倒序。最後只建立一張 128 箱、8,256 件的貨單。交換兩箱的件數後，儘管總件數相同，服務仍拒絕衝突內容；測試逐箱讀回資料庫核對原始數量。[服務程式](service.py) · [實際連線測試](test_stream.py)

本專案使用 AI 輔助開發，貨單與箱件均為合成資料。
