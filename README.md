# iAI Playground

使用 uv、Python 與 FastAPI 的高科大 iAI 模型工作區。以自己的 iAI API Key（BYOK）連線，工作區會從帳號可用的模型中選擇相容預設。

## 啟動

需要已安裝的 [uv](https://docs.astral.sh/uv/getting-started/installation/) 與 Python 3.11 以上。從專案資料夾執行以下指令。

~~~sh
uv sync --locked
uv run --locked uvicorn app:app --host 127.0.0.1 --port 8000 --no-access-log
~~~

開啟 [本機 Playground](http://127.0.0.1:8000)。點側欄的 **API Key**，貼上金鑰，再選擇要使用的功能。可從 [高科大 iAI 官網](https://www.iai.nkust.edu.tw/) 申請金鑰。

### Azure App Service（Linux）

建議使用 Python 3.12。專案根目錄的 `requirements.txt` 由 `uv.lock` 匯出，可用 `pip install -r requirements.txt` 安裝。若使用 ZIP 部署原始碼，可設定 `SCM_DO_BUILD_DURING_DEPLOYMENT=true` 讓 App Service 執行安裝。[Azure Python 設定文件](https://learn.microsoft.com/en-us/azure/app-service/configure-language-python)

Startup Command 使用下列指令。[Azure 自訂啟動文件](https://learn.microsoft.com/en-us/azure/developer/python/configure-python-web-app-on-app-service)

~~~sh
python -m uvicorn app:app --host 0.0.0.0 --port 8000 --no-access-log
~~~

更新依賴後，透過下列命令同步部署用檔案。

~~~sh
uv export --locked --no-dev --no-emit-project --no-hashes --format requirements-txt --output-file requirements.txt
~~~

## 工作區

| 功能 | 用法 |
| --- | --- |
| 文字對話 | 多輪訊息、附件問答、串流回應、停止回應、複製文字。參數可設定系統提示詞、Temperature 與 Max tokens。 |
| 文字生圖 | 輸入描述，或貼上文件作為生圖素材。可調圖片尺寸，支援顯示 base64 圖片與 HTTPS 圖片網址。 |
| 圖片編輯 | 貼上或上傳一張參考圖，輸入編輯指令，可調圖片尺寸。 |
| 語音轉文字 | 上傳音訊，設定語言或讓模型判斷，取得可複製的文字。 |
| 文字轉語音 | 輸入要朗讀的文字，Speaker 預設使用 `taiwan_girl`。可選音色與 MP3、WAV，並在頁面播放或下載結果。 |
| 文字向量化 | 檢視 JSON 與向量維度。 |
| 文件重排序 | 在參數中每行輸入一筆候選文件，可限制回傳筆數。 |

每個工作區會依功能對照表與金鑰權限設定預設模型。文字對話優先使用有「視覺」標籤的 `Furen-omni`。若有多個相容模型，可用頂部的「切換」選擇。新模型需先核對功能，再加入 `static/app.js` 的 `MODE_MODELS`。各模型的功能與參數可查 [官方模型目錄](https://www.iai.nkust.edu.tw/models)。如果某個對話模型不接受串流，可在參數關閉串流後手動重試。工作區的上傳上限為 20 MB，iAI 端可能有個別限制。

## 貼上附件

- 在輸入框按 `Ctrl+V` 或 `⌘V`，也可以拖曳到輸入區或按迴紋針。部分瀏覽器不會將檔案管理器複製的 PDF 交給網頁，此時可用拖放或選檔。
- 對話支援 PNG、JPEG、WebP、PDF，以及 UTF-8 的 TXT、Markdown 與 CSV。檔案合計最多 4 個、20 MB。PDF 合計最多 30 頁，每次最多 6 張圖片或需視覺辨識的 PDF 頁面。文字及掃描頁會分別以文字與頁面影像交給 `Furen-omni`，需要該模型權限。[Omni 圖片輸入格式](https://docs.nvidia.com/nim/vision-language-models/1.7.0/examples/nemotron-3-nano-omni-30b-a3b-reasoning/api.html)
- 貼上後按「依附件生圖」。單張圖片會帶到「圖片編輯」作為參考圖，並帶入近期前文。文件或多個附件會帶到「文字生圖」，送出時先由 Omni 讀取附件、整理對話與提示詞，再呼叫生圖模型，會使用兩次模型請求。已完成的文字對話也可以按「依對話生圖」。

## 用量與額度

Playground 連線後會用原本的 iAI API Key 向 AIHub 的 `GET /aihub/key/info` 查詢這把金鑰。當回應包含 `max_budget` 和 `spend` 時，側欄顯示兩者相減的剩餘額度（USD），可按「更新」再次查詢。如果這把金鑰沒有查詢權限，請點「官方帳戶用量」。

[官方金鑰管理頁](https://www.iai.nkust.edu.tw/portal/app/apikey)由 Portal 的登入工作階段呼叫 `GET /portal/backend/keys`，用回傳的帳戶用量、上限與重置時間顯示金鑰及額度。[官方個人用量頁](https://www.iai.nkust.edu.tw/portal/app/usage)另外呼叫 `GET /portal/backend/usage/info`，顯示 `remaining_budget`。這兩個 Portal API 使用官網登入授權。金鑰額度與整個帳戶的額度範圍可能不同。

## 金鑰與資料

- 金鑰只保留在目前頁面的 JavaScript 記憶體，透過 Playground 的 Python 後端送到高科大官方 API。重新整理或中斷連線後需重新貼上。
- 文字對話與附件名稱保存在目前瀏覽器，可從側欄刪除。原始附件只保留於目前頁面，同一對話會沿用最近一次送出的附件，重新整理後需重新加入。
- 本機預設僅監聽環回位址。模型請求使用你的 iAI 帳號額度。

API 參考 [nkust-iai](https://github.com/weber87na/nkust-iai)。
