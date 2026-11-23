# Commit Gap｜出貨回應遺失後，可以重送嗎？

倉庫登記一箱三件商品。連線突然中斷，沒有收到 HTTP 回應，保留期限也快到了。這個演練啟動真正的 Stockroom FastAPI 服務，在兩個不同位置終止程序，再用同一個箱號並行重送。程式會比對資料庫內的出貨收據、商品總量、可用量及訂單剩餘保留量。

## 四種結果

商品原有 20 件。其中 2 件是第一版 Stockroom 建立的舊保留單，沒有期限。新版啟動後於第 100 秒再保留 7 件，有效至第 110 秒。接著登記出貨 3 件，兩種中斷都會讓客戶端看到斷線。

| 服務停止位置 | 重啟時刻 | 八個請求同時重送相同箱號 | 登記出貨 | 最終可用量 |
| --- | ---: | --- | ---: | ---: |
| 資料已寫入交易，即將提交 | 109 秒 | 一筆 201 新建，七筆 200 取回同張收據 | 3 件 | 11 件 |
| 資料已寫入交易，即將提交 | 110 秒 | 八筆 409，原保留已到期 | 0 件 | 18 件 |
| 已提交，即將送出 HTTP 回應標頭 | 109 秒 | 八筆 200 取回原收據 | 3 件 | 11 件 |
| 已提交，即將送出 HTTP 回應標頭 | 110 秒 | 八筆 200 取回原收據，剩餘 4 件回到庫存 | 3 件 | 15 件 |

最後一列的出貨收據仍記載出貨當下剩餘保留 4 件。重啟後再查訂單，當下保留量已是零。舊版的 2 件保留在四種情況中均存在。只要已有該箱收據，同箱號改送 2 件會收到 409。

## 重跑

需要 Git 與 Python 3.12。以下從本專案根目錄執行，建議使用虛擬環境。Stockroom checkout 需含初版的 Git 歷史。

```sh
git clone https://github.com/peca12968/stockroom-reservations ../stockroom-reservations
git -C ../stockroom-reservations checkout 34165f1adceb2baceaa53997b7a79a86656e959b
python -m pip install -r ../stockroom-reservations/requirements.txt
python drill.py ../stockroom-reservations
```

每次執行建立四個獨立的暫存資料庫。輸出 JSON 中，`beforeRestart` 是故障後、重啟前的唯讀資料庫觀測值；`replayStatuses` 是用戶端實際收到的 HTTP 狀態碼筆數；`final` 是核對完 API 後的資料庫結果。可加上 `--workers 1` 重現單一用戶端重送，或指定 1 到 32 個並行用戶端。

## 如何定位中斷位置

- 先取出 Stockroom 初版的儲存程式建立舊保留，再讓固定版本的服務執行自己的遷移。測試時鐘固定於三個時刻，跨越到期邊界可重跑。[初版儲存程式](https://github.com/peca12968/stockroom-reservations/blob/ce5bf2d652d6c77f5018a50aca80a5ae5fcf7644/stockroom/store.py)
- 提交前案例在出貨收據的 INSERT 後，於同一條 SQLite 連線即將執行 COMMIT 時立即退出程序。回應前案例則在出貨端點即將送出 201 標頭時立即退出。兩者都檢查子程序結束碼，以及用戶端是否確實未收到回應。[演練子程序](server.py)
- 每次重啟都用新的本機 HTTP 服務程序連回原資料庫。用戶端同步開始重送，核對每張回覆，接著讀取整單、箱號與庫存。故障後和重送後也執行 SQLite 完整性與外鍵檢查。演練模擬服務程序中止，觀察範圍止於系統的出貨登記；硬體斷電和物流端實際交寄需各自驗證。[HTTP 重播與資料核對](drill.py)

本專案為 AI 輔助開發的履歷作品，使用合成庫存與本機暫存資料。
