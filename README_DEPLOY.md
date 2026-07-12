# FCN 詢價圖表雲端版

這個版本可以部署成固定 HTTPS 網址。部署後手機可直接開啟，不需要帶自己的電腦。

本專案的標準流程是：先在 Codex chat 將報價照片轉成標準文字，再把文字貼進網頁產出 PDF。欄位名稱、簡稱、輸入格式請以 `docs/QUOTE_FIELD_STANDARD.md` 為準。

目前版本請看 `VERSION`。每次可測改版都會同步更新頁面標題旁的版本號與 `CHANGELOG.md`。

## 雲端版會解決什麼

- 不用帶電腦到公司
- 不用依賴 `192.168.x.x` 內網網址
- 手機可以直接輸入報價、抓股價、產 PDF
- 透過 Codex chat 先把報價照片轉成標準文字，再貼進工具產 PDF

## 必要設定

部署時請設定環境變數：

```text
FCN_PIN=你自己的登入 PIN
```

建議一定要設定 PIN，避免公開網址被別人打開。

目前標準工作流不需要在網頁內設定照片辨識。照片轉文字由 Codex chat 處理，網頁負責解析標準文字、抓股價與產 PDF。

## Render 部署流程

Render 官方文件說明 Web Service 會提供公開 URL，服務需要綁定 `0.0.0.0` 的 port；Render 也會提供 `PORT` 環境變數。本專案已配好這些設定。

1. 建立一個 GitHub private repo。
2. 把本資料夾檔案上傳到 repo。
3. 到 Render 新增 `Blueprint` 或 `Web Service`。
4. 如果用 Blueprint，選這個 repo，Render 會讀取 `render.yaml`。
5. 如果手動建 Web Service：
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/health`
6. 在 Render 的 Environment Variables 設定：
   - `FCN_PIN`
7. 部署完成後，用 Render 給你的 `https://...onrender.com` 網址登入。

## 手機使用流程

1. 手機打開雲端網址。
2. 輸入 PIN。
3. 在「多組報價輸入」貼上格式：

```text
A | AVGO UW | ORCL UN | TSLA UW | 70.35 | 90 |
B | QCOM UW | ORCL UN | TSLA UW | 61.06 | 92 | 55
```

4. 工具會自動解析。
5. 按「產生 PDF 版」。
6. 按「產生 PDF 檔」。
7. 按「開啟 PDF 檔」後分享 PDF。

## 報價格式

```text
NO | BBG CODE1 | BBG CODE2 | BBG CODE3 | Strike | KO Barrier | KI Barrier
```

沒有 KI 時最後留空：

```text
A | AVGO UW | ORCL UN | TSLA UW | 70.35 | 90 |
```

有 KI 時：

```text
B | QCOM UW | ORCL UN | TSLA UW | 61.06 | 92 | 55
```

## 注意事項

- 雲端版會把輸入的報價與照片送到雲端服務處理。
- 啟用照片辨識時，照片會送到 OpenAI API 進行辨識。
- 公司資料能否上傳雲端，需要你自行確認合規。
- 產出的 PDF 暫存在雲端服務的 `outputs/reports`，不同平台可能會定期清掉暫存檔。
- 實際下單前仍應以公司正式報價與行情來源為準。

## 參考

- Render Web Services: https://render.com/docs/web-services/
- Render Environment Variables: https://render.com/docs/configure-environment-variables
