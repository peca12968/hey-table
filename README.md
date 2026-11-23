# Proto Relay Probe｜舊版服務轉送收據時，哪些欄位能留下？

新版倉儲服務在收據上加入人工覆核旗標，也替每筆商品加入實點數量。舊服務收到同一張收據時，畫面只看得到單號與商品。這個命令列工具讓真正的 Protobuf runtime 用舊版 descriptor 讀取位元組、轉送，再用原版 descriptor 讀回，比對欄位值與 presence。

| 舊服務的轉送方式 | 新版讀回本例的結果 |
| --- | --- |
| 解碼後直接以 binary 編碼 | 保留 `reviewed=false`、茶的 `checkedUnits=0`、米的 `checkedUnits=3` |
| 呼叫 `DiscardUnknownFields()` 後編碼 | 這三個明確設定的值皆消失 |
| 依舊版欄位轉成 ProtoJSON，讀回後編碼 | 同樣遺失這三個值 |

## 在自己的電腦重跑

使用 Python 3.12，在專案根目錄執行。兩版 schema 各自載入獨立的 descriptor pool，因此同名訊息可以使用不同欄位定義。

```sh
python -m pip install -r requirements.txt
python -m grpc_tools.protoc -Ischemas/v1 --include_imports --descriptor_set_out=v1.pb schemas/v1/parcel.proto
python -m grpc_tools.protoc -Ischemas/v2 --include_imports --descriptor_set_out=v2.pb schemas/v2/parcel.proto
python probe.py v2.pb v1.pb parcel.Receipt receipt.json --require binary
python -m unittest -v
```

換成自己的 descriptor sets、完整訊息名稱與一筆 ProtoJSON 輸入，即可對照每條路徑的 `relay_view` 與 `returned`。可重複傳入 `--require` 來指定 CI 必須保留原訊息的路徑。成功回傳 0，指定路徑有資料差異或轉送失敗回傳 1，輸入或 descriptor 載入失敗回傳 2。

## 為什麼要看中間服務讀到的值？

另一個測試讓發送端用 `uint32` 寫入 7，中間服務用相同欄號的 `sint32` 解出 −4。重新編碼後發送端卻仍讀回 7。若中間服務會依數量作決策，只檢查最後讀回的值就會漏掉這個問題。本工具重播的是指定訊息與輸入樣本，其他欄位、數值邊界及服務行為需要相應的測試資料。專案以 AI 輔助開發。[測試](test_probe.py) · [Protobuf 二進位相容性](https://protobuf.dev/programming-guides/proto3/) · [ProtoJSON 規格](https://protobuf.dev/programming-guides/json/)
