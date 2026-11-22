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

## 為何不同傳送順序仍能得到相同結果

每筆盤點紀錄有 UUID，並記下它取代的所有已知同批次讀數。兩個快照合併時取紀錄聯集，同一 UUID 的內容必須一致。仍未被後續紀錄取代的讀數共同決定該批次的狀態。裝置時鐘快慢不影響判定。檢查審閱版本與寫入複點結果共用一筆 SQLite 寫入交易。[合併與複點實作](count_relay.py)

快照包含整場歷史，匯入會檢查場次、紀錄格式、前序紀錄與循環，再以單一交易寫入。此版本適用於可信裝置之間交換中小型盤點檔案，檔案大小與檢查成本會隨累計筆數成長。裝置名稱供現場辨識，並無數位簽章。

測試實際匯入四份快照的全部 24 種排列，每份都重送一次。第四份快照雖已解決兩站分歧，但未見第三站的離線讀數，所有排列都正確保留 5 與 7 兩個待核對結果。另驗證兩位主管同時複點只能接受一份相同審閱版本，以及寫入中途失敗會整批回滾。[測試](test_relay.py)

本作品使用 AI 輔助開發，盤點案例為合成資料。
