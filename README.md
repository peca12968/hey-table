# Coldroom Inbox｜冷庫溫度寫入後斷線，同一筆會記幾次？

感測器以 MQTT QoS 1 傳送北庫溫度 −18 °C。收集器已將讀值提交到 SQLite，broker 卻還沒收到 PUBACK。示範此時強制終止收集程序，並在離線期間再送一筆 −17.5 °C。用相同 client ID 重連後，broker 回報原有 session，第一筆再次送達，第二筆從離線佇列送達。北庫最後保留兩筆不同觀測。

## 重現斷線

CI 使用 Node.js 26。在儲存庫目錄執行以下指令。示範使用真實 TCP 連線、本機 Aedes broker、獨立的收集程序與暫存 SQLite 檔。

```sh
npm ci
npm test
npm run demo
```

| 可觀察的時間點 | 結果 |
| --- | --- |
| 第一次程序終止前 | 從另一條 SQLite 連線讀得到 1 筆，broker 收到 0 個收集端確認 |
| 恢復訂閱後 | 收到先前未確認的讀值與離線時送出的讀值 |
| 再送相同內容、衝突內容、格式錯誤訊息及另一裝置的讀值後 | 重啟後共 6 次送達、6 個確認，資料庫最終有 3 筆觀測與 2 筆拒收紀錄 |

broker 在示範全程持續運作，session 存於記憶體。測試驗證的是收集程序崩潰與離線重送。部署時，離線佇列能保留多久取決於 broker 的儲存與 session 設定。

## 接到自己的 broker

### 依觀測時間匯出歷史資料

執行 `node history.mjs readings.db north 3000 12000`，以 NDJSON 匯出指定裝置的讀值。區間含起點、排除終點，時間戳相同時依事件 ID 排序。查詢開啟後讀取同一個 SQLite 快照；在這期間補送的讀值可在下一次查詢讀到。收集器升級時替既有資料建立裝置與時間索引，測試檢查查詢計畫確實使用涵蓋索引，能依索引順序直接輸出。

### 補送的讀值會怎樣改變超溫報表？

用歷史版收集器寫入第一筆溫度，升級後經真實 MQTT 連線補齊其餘紀錄。15 秒的合成紀錄中，有效期設定為 4 秒時，原先估算高於 −16 °C 的時間為 8 至 13 秒。晚到的第 7 秒讀值補上兩秒缺測，區間縮至 10 至 13 秒。第 9 秒仍有兩筆不同事件 ID 的讀值跨越門檻，保留三秒的不確定性。相同事件的重送與衝突也在演練中核對。

```sh
npm ci
git worktree add --detach ../coldroom-legacy 320c6586eaeb233e127ba999e5903f95d37fa38c
git clone https://github.com/peca12968/thaw-window.git ../thaw-window
git -C ../thaw-window checkout 8183b10d648d90f3cdc445298abb58e1a2ca560e
node coverage-demo.mjs ../coldroom-legacy/inbox.mjs ../thaw-window/thaw.py
```

此演練需 Python 3.12 執行時間區間計算工具。[跨版本與跨專案演練](coverage-demo.mjs)

### 啟動收集器

```sh
node consumer.mjs mqtt://127.0.0.1:1883 freezer-sink readings.db
```

以 QoS 1 發布至 `coldroom/north/reading`，UTF-8 JSON 本文例如 `{"id":"n-1","timeMs":5000,"milliC":-18000}`。一次觀測以裝置與事件 ID 共同識別，時間用非負整數毫秒，溫度用千分之一攝氏度。相同觀測重送會輸出 `duplicate`。若同鍵對應不同時間或溫度，保留先前讀值並將新本文摘要記為 `conflict`。格式錯誤的本文記為 `invalid`。拒收紀錄按主題與原始本文的 SHA-256 去重。

處理成功或拒收紀錄提交後，收集器才讓 MQTT.js 發送確認。SQLite 寫入失敗則回滾並中斷連線，讓 broker 保留重送機會。可用 `SELECT device,id,time_ms,milli_c FROM readings ORDER BY device,time_ms,id` 查觀測，或用 `SELECT topic,reason,digest FROM rejected` 查拒收原因。測試資料為合成資料，專案以 AI 輔助開發。[真實傳輸演練](demo.mjs) · [交易與錯誤測試](inbox.test.mjs) · [MQTT.js 訊息處理介面](https://github.com/mqttjs/MQTT.js#mqttclienthandlemessagepacket-callback)
