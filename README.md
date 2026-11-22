# WAL Lantern｜SQLite 最後提交到哪一頁？

收貨站中斷寫入後，SQLite 的預寫日誌（WAL）可能有完整的頁面，卻缺少該筆交易的提交標記。WAL Lantern 讀取靜止的 WAL 副本，驗證表頭、世代識別值與連續校驗和，輸出最後一筆可辨識提交的位置，以及後面仍有效的頁面數。

## 跑一次實際復原

需要 Go 1.22 以上及含 SQLite 的 Python 3。以下指令在 Windows、Linux 均可使用。

```sh
go build -o wal-lantern.exe .
python replay_demo.py wal-lantern.exe
```

演練將 80、2,500、5,000 bytes 的三筆收據分別提交。以 1,024 bytes 頁面執行，本機樣本有 13 個 frame。在每個 frame 的結尾與結尾前一個 byte 各取一份副本，再加入校驗和損壞、世代改變及相反位元組序的案例。程式將 WAL 與配對的主資料庫放入獨立目錄，讓 SQLite 自行開啟，再比較實際可見的收據與頁數。本次共比對 31 份副本，其中一份在最後提交後已有 7 個有效 frame，讀者仍只能看到較早的交易。不同 SQLite 版本可能使用不同頁面配置。

演練也真正執行一次 RESTART checkpoint，在同一份 WAL 檔覆寫新交易。檔尾留下前一世代的頁面時，分析器停在第一個世代識別值不符處。SQLite 開啟對應副本後能讀到新交易的 70 bytes 收據。[完整演練](replay_demo.py)

## 讀取既有日誌副本

```sh
go run . checkout.db-wal
```

| JSON 欄位 | 如何解讀 |
| --- | --- |
| `commits`、`last_commit_frame` | 本世代累計提交筆數，以及最後提交所在的 frame（從 1 起算） |
| `last_commit_end_offset` | 最後提交 frame 結束後的第一個 byte 位置。沒有提交時為 0 |
| `database_pages_at_last_commit` | 最後提交標記記載的資料庫頁數 |
| `valid_frames_after_last_commit` | 通過校驗但後面沒有提交標記的 frame 數 |
| `stop`、`stop_offset` | 讀到檔尾、頁面不完整、世代或校驗和不符等原因，以及第一個未納入 frame 的起始位置 |

程式逐頁讀取，記憶體用量由頁面大小決定。有效表頭後的中斷會產生 JSON，無法解讀的表頭會傳回結束碼 2。輸入應是寫入已停止的檔案或一致快照。WAL 只記錄本世代的異動，查詢完整資料需要配對的主資料庫；工具本身只開啟 WAL 供讀取。[SQLite WAL 檔案規格](https://www.sqlite.org/fileformat2.html#walformat)

本專案使用 AI 輔助開發。演練只操作臨時建立的合成資料庫。
