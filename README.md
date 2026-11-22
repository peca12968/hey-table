# SQLite Recovery Drill｜線上備份與還原演練

庫存有 20 件，訂單保留 7 件後建立備份。接著取消訂單，正式庫存回到 20。此時從備份啟動另一份服務，應看到哪個數字？這個專案會真的還原資料庫、讀取庫存、重送訂單，再解除保留。只需要 Python 3.12 或 3.13 的標準函式庫。

## 重現庫存還原

在本專案目錄執行以下指令。演練將合成資料放在暫存目錄，使用和 CI 相同版本的 Stockroom。

```sh
git clone https://github.com/peca12968/stockroom-reservations.git ../stockroom-demo
git -C ../stockroom-demo checkout --detach 1bec99199cf0ee8ed9d9b3d34ddbaad10dc01930
python stockroom_drill.py ../stockroom-demo
python -m unittest -v
```

| 驗證點 | 預期結果 |
| --- | --- |
| 原服務在備份完成後取消訂單 | 可用庫存 20 |
| 兩份備份都可用，還原取消訂單後的版本 | 可用庫存 20 |
| 損壞較新的備份，再次還原 | 找回保留訂單時的版本，可用庫存 13 |
| 用原請求鍵重送保留 7 件 | 讀回原保留，庫存仍為 13 |
| 在還原的服務解除保留 | 可用庫存回到 20 |

## 備份自己的 SQLite 檔

```sh
python recovery.py snapshot live.db backup.db
python recovery.py restore backup.db restored.db --sha256 <備份時輸出的64位十六進位摘要>
```

請將第二行的佔位符連同角括號換成實際摘要。第一行以 JSON 輸出路徑、檔案大小和 SHA-256。將這筆紀錄獨立保存，還原時用它比對備份。目的路徑的上層目錄須已存在，並支援硬連結，例如 NTFS 或 ext4。請還原至新的資料庫路徑。

## 最新備份損壞時回到哪一版

在兩個不同的備份時間點各執行一次 `snapshot`，保存各自的 JSON 收據。以下範例適用於 sh 或 PowerShell 7。每組候選檔都應來自同一個應用程式的同一份資料庫，收據可與備份分開保存。

```sh
python recovery.py snapshot live.db first.db > first.json
python recovery.py snapshot live.db second.db > second.json
python recovery.py restore-latest recovered.db --candidate first.db first.json --candidate second.db second.json
```

程式先驗證所有收據，再依 `captured_at` 由新到舊嘗試。這是來源讀取視圖確立時在備份主機記錄的 UTC 時間。若較新的檔案遺失、摘要不符、資料庫損壞或有外鍵違規，就試下一版。成功的 JSON 會指出實際使用的檔案、時間、摘要，以及 `skipped` 中逐份略過的原因。既有目的檔、磁碟或權限問題會直接報錯。

如果業務只接受某時間之後的資料，可加上 `--not-before 2026-04-01T04:00:00Z`。剛好等於界線的版本仍可還原，所有版本皆不可用或過舊時不會建立目的檔。收據時間須包含時區，若兩份收據對應同一個瞬間則會回報排序歧義。早期收據只有摘要時，可繼續使用單檔 `restore --sha256`。

## 如何確認可復原

- 來源以唯讀方式開啟。程式先讀取頁數以固定交易視圖，再用 SQLite Online Backup API 分頁複製。WAL 模式的測試在複製兩批頁面之間透過另一條連線提交一筆資料，並確認還原結果仍是先前的已提交狀態。[SQLite Online Backup API](https://www.sqlite.org/backup.html)
- 備份和還原都會對獨立副本執行 `integrity_check` 與 `foreign_key_check`，分別檢查 SQLite 結構與外鍵關聯。還原另核對 SHA-256。庫存演練透過服務本身檢查業務行為。[SQLite 完整性檢查](https://www.sqlite.org/pragma.html#pragma_integrity_check)
- 副本在目的地所在磁碟產生。通過檢查後以硬連結發佈完整檔案。測試平行啟動四個獨立 CLI 程序還原至相同路徑，只有一個成功。既有目的檔或殘留的 SQLite 日誌檔會讓操作失敗。指令失敗時傳回非零結束碼。

此工具備份指定的單一 SQLite 主資料庫。WAL 模式適合示範讀寫並行，傳統回滾日誌模式下，備份的讀取交易可能延後寫入提交。演練使用本機暫存磁碟，跨機房保存與實際服務復原時間需在部署環境另外量測。

**履歷用語**　實作 SQLite 線上備份與還原 CLI，以跨專案整合演練驗證庫存與訂單冪等性，並以分頁備份中的並行寫入、損壞副本及競爭還原測試驗證失敗行為。

本作品使用 AI 輔助開發。庫存數字來自隨附的合成演練。
