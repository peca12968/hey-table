# Count Relay｜離線盤點與複點

東、西站在沒有網路的倉庫盤點。各自負責的兩板貨分別有 12 與 8 件，但同一個共用貨箱，兩站各記了 4 件和 6 件。主管需要知道哪些數字可以採用、哪一箱仍要複點，以及舊快照重送會不會改回舊數字。

## 重現兩台裝置的盤點

使用 Python 3.12 標準函式庫。示範會建立兩份獨立的 SQLite 資料庫，在暫存目錄完成雙向交換、複點與重送。

```sh
python demo.py
python -m unittest -v
```

| 時點 | 已確認總數 | 共用箱的狀態 |
| --- | ---: | --- |
| 兩站交換快照 | 20 | 顯示 4 與 6 兩筆不同讀數，此箱暫時排除 |
| 現場複點為 5 件，再同步 | 25 | 兩站都取得複點結果 |
| 再次收到西站舊快照 | 25 | 匯入新增紀錄 0 筆 |

庫存數量是每個批次當下的絕對讀數。請為同一實體批次使用相同識別碼。兩站獨立讀到相同數字會計入一次，複點為零也是有效結果。[完整示範](demo.py)

## 帶著檔案交換資料

以下範例建立同一場盤點的兩個站點，將東站的資料帶到西站。快照可透過隨身碟或其他檔案傳輸方式交接。兩站都曾更新時，請各自匯出並傳給對方。

```sh
python count_relay.py init east.db spring-count
python count_relay.py init west.db spring-count
python count_relay.py record east.db pallet-A 12 --device east
python count_relay.py export east.db > east-copy.json
python count_relay.py merge west.db east-copy.json
python count_relay.py status west.db
```

`status` 逐批列出現行讀數、裝置名稱及 `revision`。發現數量不一致時，先檢視各方讀數並完成實物複點，再以該批次剛才顯示的完整 revision 登記結果，例如 `python count_relay.py record west.db shared-crate 5 --device supervisor --expect REVISION`。若審閱期間又收到新讀數，指令會要求重新檢視。另一台仍離線的裝置可能稍後帶回先前未見的分歧，工具會重新列出待複點項目。

## 兩台裝置已交換過資料，只帶回新增的讀數

西站先列出已有紀錄的 ID 與內容雜湊，把清單帶給東站。東站核對共有紀錄內容，回傳西站缺少的紀錄。西站可在等待回覆時繼續盤點。以下三個命令依序在西站、東站、西站執行，裝置之間只需傳送兩份 JSON。

```sh
python count_relay.py manifest west.db > west-known.json
python count_relay.py delta east.db west-known.json > east-reply.json
python count_relay.py merge west.db east-reply.json
```

執行 `python demo_delta.py` 可重現已有 100 筆共同紀錄的情境。東站新增 3 筆，西站在清單送出後也對同一箱記下新數值。回覆只帶 3 筆，重送匯入 0 筆。東、西站各自登記的 102 與 103 件均保留待複點。接著反方向同步，兩站狀態相同。[可執行示範](demo_delta.py)

| 傳送方式 | 範例 JSON 大小 |
| --- | ---: |
| 東站完整快照，含 103 筆 | 19,842 位元組 |
| 西站已知清單 | 10,886 位元組 |
| 東站增量回覆，含 3 筆 | 686 位元組 |
| 清單加上回覆 | 11,572 位元組 |

以上是含換行的 UTF-8、LF 格式，沒有壓縮。清單大小會隨已知紀錄數增加，首次交換可直接使用完整快照。西站產生清單時，同一筆交易會在資料庫留下清單摘要。若回覆送到未產生該清單的資料庫，或接收端還原到產生清單前的備份，匯入會失敗。此時可重建清單或交換完整快照。接收端會以本機與封包的合併歷史檢查缺少前序、跨批次引用與循環。摘要用於核對內容，交換對象應為可信裝置。

## 核對實物盤點與 Stockroom 庫存

全數同步後，匯出盤點紀錄和同一盤點時點的 Stockroom 庫存。先登記截止時間前的收貨與出貨，盤點和匯出期間暫停這些商品的進出貨。建立 `scope.json`，以批次識別碼對應 Stockroom 的 SKU。同一 SKU 可以有多個批次，清單應涵蓋該 SKU 的所有實體庫存。

```json
{"session":"spring-count","batches":{"pallet-A":"KIT-01","pallet-B":"KIT-01"}}
```

```sh
python count_relay.py record west.db pallet-B 8 --device west
python count_relay.py export west.db > counts.json
curl -fsS http://127.0.0.1:8000/inventory-snapshot -o inventory.json
python stockroom_check.py counts.json inventory.json scope.json
```

報表附盤點場次和庫存快照時間，逐項列出實盤數、帳面實體庫存 `capacity` 及差異 `counted - capacity`。例如 20 件庫存中已有 6 件被保留，可用量是 14，實盤 20 件時差異為 0。缺少讀數或出現盤點分歧的 SKU 會保留空白差異，並列出應處理的批次。若有讀數找不到對應 SKU，須先補上批次對應，報表才會計算差異。核對程式以唯讀方式處理三份檔案。結束碼 0 代表所列 SKU 均完成且吻合，1 代表有差異或仍需補件，2 代表檔案或資料格式有問題。[核對程式](stockroom_check.py) · [Stockroom 端對端測試](../stockroom-reservations/tests/test_count_relay_check.py)

端對端測試也會將實際命令輸出與 [作品站的三種示範結果](examples/stockroom-audit.json) 比對，涵蓋待複點、短少一件與盤點吻合。

要入帳時，將已確認的實點數與盤點場次帶到 Stockroom 的調整單，並使用盤點截止時取得的該 SKU 版次。有待複點或缺讀數時先完成盤點。若現場進出貨已改變版次，系統會退回原調整申請。[保存盤點差異](../stockroom-reservations/README.md#核對實點後調整庫存)

同一盤點場次的多個 SKU 可先取得共用快照，再用整批調整入帳。任一品項版次已變更或實點不足時，其他品項也會保留原庫存。[批次盤點調整](../stockroom-reservations/README.md#一起保存多品項盤點)

## 為何不同傳送順序仍能得到相同結果

每筆盤點紀錄有 UUID，並記下它取代的所有已知同批次讀數。兩個快照合併時取紀錄聯集，同一 UUID 的內容必須一致。仍未被後續紀錄取代的讀數共同決定該批次的狀態。裝置時鐘快慢不影響判定。檢查審閱版本與寫入複點結果共用一筆 SQLite 寫入交易。[合併與複點實作](count_relay.py)

快照包含整場歷史，匯入會檢查場次、紀錄格式、前序紀錄與循環，再以單一交易寫入。此版本適用於可信裝置之間交換中小型盤點檔案，檔案大小與檢查成本會隨累計筆數成長。裝置名稱供現場辨識，並無數位簽章。

測試實際匯入四份快照的全部 24 種排列，每份都重送一次。第四份快照雖已解決兩站分歧，但未見第三站的離線讀數，所有排列都正確保留 5 與 7 兩個待核對結果。另驗證兩位主管同時複點只能接受一份相同審閱版本，以及寫入中途失敗會整批回滾。[測試](test_relay.py)

本作品使用 AI 輔助開發，盤點案例為合成資料。
