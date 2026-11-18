# iAI Playground

使用 uv、Python 與 FastAPI 的高科大 iAI 模型工作區。以自己的 iAI API Key（BYOK）連線，工作區會從帳號可用的模型中選擇相容預設。

## 啟動

需要已安裝的 [uv](https://docs.astral.sh/uv/getting-started/installation/) 與 Python 3.11 以上。從專案資料夾執行以下指令。

~~~sh
uv sync --locked
uv run --locked uvicorn app:app --host 127.0.0.1 --port 8000 --no-access-log
~~~

開啟 [本機 Playground](http://127.0.0.1:8000)。點側欄的 **API Key**，貼上金鑰，再選擇要使用的功能。可從 [高科大 iAI 官網](https://www.iai.nkust.edu.tw/) 申請金鑰。

## 工作區

| 功能 | 用法 |
| --- | --- |
| 文字對話 | 多輪訊息、串流回應、停止回應、複製文字。參數可設定系統提示詞、Temperature 與 Max tokens。 |
| 文字生圖 | 輸入描述，可調圖片尺寸，支援顯示 base64 圖片與 HTTPS 圖片網址。 |
| 圖片編輯 | 上傳一張參考圖，輸入編輯指令，可調圖片尺寸。 |
| 語音轉文字 | 上傳音訊，設定語言或讓模型判斷，取得可複製的文字。 |
| 文字轉語音 | 輸入要朗讀的文字，可選音色與 MP3、WAV，並在頁面播放或下載結果。 |
| 文字向量化 | 檢視 JSON 與向量維度。 |
| 文件重排序 | 在參數中每行輸入一筆候選文件，可限制回傳筆數。 |

每個工作區會依功能對照表與金鑰權限設定預設模型。文字對話優先使用有「視覺」標籤的 `Furen-omni`。若有多個相容模型，可用頂部的「切換」選擇。新模型需先核對功能，再加入 `static/app.js` 的 `MODE_MODELS`。各模型的功能與參數可查 [官方模型目錄](https://www.iai.nkust.edu.tw/models)。如果某個對話模型不接受串流，可在參數關閉串流後手動重試。工作區的上傳上限為 20 MB，iAI 端可能有個別限制。

## 用量與額度

Playground 連線後會用原本的 iAI API Key 向 AIHub 的 `GET /aihub/key/info` 查詢這把金鑰。當回應包含 `max_budget` 和 `spend` 時，側欄顯示兩者相減的剩餘額度（USD），可按「更新」再次查詢。如果這把金鑰沒有查詢權限，請點「官方帳戶用量」。

[官方金鑰管理頁](https://www.iai.nkust.edu.tw/portal/app/apikey)由 Portal 的登入工作階段呼叫 `GET /portal/backend/keys`，用回傳的帳戶用量、上限與重置時間顯示金鑰及額度。[官方個人用量頁](https://www.iai.nkust.edu.tw/portal/app/usage)另外呼叫 `GET /portal/backend/usage/info`，顯示 `remaining_budget`。這兩個 Portal API 使用官網登入授權。金鑰額度與整個帳戶的額度範圍可能不同。

## 金鑰與資料

- 金鑰只保留在目前頁面的 JavaScript 記憶體，透過本機 Python 後端送到高科大官方 API。重新整理或中斷連線後需重新貼上。
- 文字對話紀錄保存在目前瀏覽器，可從側欄刪除。檔案及其他工作區的結果只保留於頁面記憶體，切換工作區時清除。
- 預設僅監聽本機環回位址。每次按下送出會向 iAI 發出一次請求，使用你的帳號額度。

API 參考 [nkust-iai](https://github.com/weber87na/nkust-iai)。
