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

## 把線上快照存成增量備份

若需保存同一資料庫的多個版本，可以讓 Shift Vault 共用版本之間的區塊。從本專案根目錄下載 CI 使用的版本，然後執行演練。

```sh
git clone https://github.com/peca12968/shift-vault.git ../shift-vault
git -C ../shift-vault checkout --detach 9e09bbd0e92ee666c4007f3a6fcfaae1b0bf9598
python vault_drill.py ../shift-vault
```

要備份自己的資料庫，可在服務仍開啟時執行以下命令。將第一行輸出的 JSON 收據獨立保存，還原時以收據裡的 `sha256` 取代第二行的 `SNAPSHOT_ID`。目的檔請指定新路徑。若 Shift Vault 放在其他目錄，在任一命令後加上 `--shift-vault 路徑`。

```sh
python recovery.py vault-snapshot live.db ./backup-store
python recovery.py vault-restore ./backup-store recovered.db --sha256 SNAPSHOT_ID
```

備份先用 SQLite Online Backup API 取得包含已提交 WAL 交易的獨立副本，通過資料庫與外鍵檢查後交給 Shift Vault 分塊。還原時先在目的地所在磁碟重組並驗證區塊與整檔摘要，再檢查 SQLite 結構與外鍵，最後發佈可直接開啟的資料庫。兩個方向都需要足以容納一份完整快照的暫存空間。[SQLite 整合](recovery.py) · [Shift Vault 固定版本](https://github.com/peca12968/shift-vault/tree/9e09bbd0e92ee666c4007f3a6fcfaae1b0bf9598)

演練保留一條開啟的寫入連線，在第 2,001 筆掃描提交前後各備份一次。兩次還原分別讀回 2,000 與 2,001 筆，並逐筆比對流水號與原始內容。第二版備份時還有一筆未提交的寫入，兩份快照都排除了該筆紀錄。本機合成範例的第二版共 921,600 位元組，其中新增 8,218、沿用 913,382。這兩個數字只計分塊內容，SQLite 版本與資料頁配置會影響結果。

演練最後破壞第二版專用的區塊，確認新版本無法發佈，接著用第一版的摘要取回完整的 2,000 筆。若損壞的是共用區塊，引用它的版本都會受影響。[跨專案整合測試](vault_drill.py)

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

若最新備份已含誤操作，請用 `restore-latest --not-after` 指定最後可接受的備份時間。上、下限皆包含該瞬間，可一起使用。備份時間超出上限時，報告會記錄 `after recovery cutoff`，再檢查較早候選；合格時間範圍內的所有備份都無法驗證時，不會發佈還原檔。時間依備份收據的 `captured_at` 判定，復原粒度取決於現有備份。

```sh
python recovery.py restore-latest before.db --candidate first.db first.json --candidate second.db second.json --not-after 2026-04-01T10:00:00+08:00
```

跨專案演練將 BX-19 庫存依序寫為 8、11、0 件，每次提交後都備份。用 WAL Lantern 核對三筆交易各自的提交結束位置，再實際執行還原：一般還原得到 0 件，指定第二份收據的時間上限則還原出 11 件。最後一份備份通過完整性驗證，但它已包含錯誤更新。此演練在單一寫入者停下來時配對日誌與收據；一般 WAL 提交標記本身不含 UTC 時間。[事故復原演練](incident_drill.py) · [WAL Lantern](https://github.com/peca12968/wal-lantern)

- 來源以唯讀方式開啟。程式先讀取頁數以固定交易視圖，再用 SQLite Online Backup API 分頁複製。WAL 模式的測試在複製兩批頁面之間透過另一條連線提交一筆資料，並確認還原結果仍是先前的已提交狀態。[SQLite Online Backup API](https://www.sqlite.org/backup.html)
- 備份和還原都會對獨立副本執行 `integrity_check` 與 `foreign_key_check`，分別檢查 SQLite 結構與外鍵關聯。還原另核對 SHA-256。庫存演練透過服務本身檢查業務行為。[SQLite 完整性檢查](https://www.sqlite.org/pragma.html#pragma_integrity_check)
- 副本在目的地所在磁碟產生。通過檢查後以硬連結發佈完整檔案。測試平行啟動四個獨立 CLI 程序還原至相同路徑，只有一個成功。既有目的檔或殘留的 SQLite 日誌檔會讓操作失敗。指令失敗時傳回非零結束碼。

此工具備份指定的單一 SQLite 主資料庫。WAL 模式適合示範讀寫並行，傳統回滾日誌模式下，備份的讀取交易可能延後寫入提交。演練使用本機暫存磁碟，跨機房保存與實際服務復原時間需在部署環境另外量測。

**履歷用語**　實作 SQLite 線上備份與還原 CLI，以跨專案整合演練驗證庫存與訂單冪等性，並以分頁備份中的並行寫入、損壞副本及競爭還原測試驗證失敗行為。

本作品使用 AI 輔助開發。庫存數字來自隨附的合成演練。
