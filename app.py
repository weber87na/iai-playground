import json
import re
import subprocess
from contextlib import asynccontextmanager
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Annotated, Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from attachments import MAX_ATTACHMENTS, AttachmentError, attachment_parts, reference_sheet, text_part


IAIHUB_URL = "https://www.iai.nkust.edu.tw/aihub"
BASE_URL = f"{IAIHUB_URL}/v1/"
PROJECT_ROOT = Path(__file__).resolve().parent
STATIC = PROJECT_ROOT / "static"
MAX_FILE = 20 * 1024 * 1024
VISION_MODEL = "Furen-omni"
ROUTES = {
    "image": "images/generations",
    "edit": "images/edits",
    "transcribe": "audio/transcriptions",
    "speak": "audio/speech",
    "embed": "embeddings",
    "rerank": "rerank",
}

def build_revision():
    try:
        packaged = (PROJECT_ROOT / "build-revision.txt").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        packaged = ""
    if re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", packaged):
        return packaged[:8]
    try:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=PROJECT_ROOT, capture_output=True,
            text=True, check=True, timeout=2,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return revision[:8] if re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision) else None


BUILD_REVISION = build_revision()


@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient(
        base_url=BASE_URL, timeout=httpx.Timeout(300, connect=15),
        follow_redirects=False, trust_env=False,
    ) as client:
        app.state.upstream = client
        yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def response_headers(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        origin = request.headers.get("origin")
        if origin and origin != f"{request.url.scheme}://{request.url.netloc}":
            # A hosting proxy can terminate TLS before forwarding to Uvicorn.
            secure_origin = f"https://{request.url.netloc}"
            if origin != secure_origin or request.headers.get("sec-fetch-site") != "same-origin":
                return JSONResponse({"detail": "請從 Playground 頁面發送請求。"}, 403)
        length = request.headers.get("content-length")
        if length and length.isdecimal() and int(length) > MAX_FILE + 1024 * 1024:
            return JSONResponse({"detail": "請縮小檔案後再試，附件合計上限 20 MB。"}, 413)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'self' blob: data: https:; media-src blob:; "
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(RequestValidationError)
async def invalid_input(request, exc):
    return JSONResponse({"detail": "請檢查模型、提示詞及進階參數的格式。"}, 422)


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/version")
async def version():
    return {"commit": BUILD_REVISION}


def auth(request, operation=""):
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    if not re.fullmatch(r"[!-~]{1,2048}", token):
        raise HTTPException(401, "請先貼上有效的 iAI API Key。")
    header = "x-litellm-api-key" if operation == "rerank" else "Authorization"
    return {header: f"Bearer {token}"}


def check_status(response):
    status = response.status_code
    if response.is_success:
        return
    messages = {
        400: "iAI 拒絕此請求。請確認模型支援目前的功能及參數。",
        401: "iAI 無法驗證金鑰。請確認金鑰內容和有效期限。",
        403: "這組金鑰沒有此功能或模型的使用權限。",
        404: "iAI 找不到此模型或端點。請重新整理模型清單。",
        405: "iAI 不接受此請求方法。",
        413: "檔案或請求超過 iAI 的大小限制。",
        422: "iAI 無法處理這組參數。請確認模型支援的格式。",
        429: "已達 iAI 的額度或速率限制。請稍後再試。",
    }
    raise HTTPException(status if status in messages else 502,
                        messages.get(status, f"iAI 服務回傳 HTTP {status}。"))


async def send(request, method, route, *, stream=False, operation="", **kwargs):
    client = request.app.state.upstream
    upstream = client.build_request(method, route, headers=auth(request, operation), **kwargs)
    try:
        response = await client.send(upstream, stream=stream)
    except httpx.TimeoutException as exc:
        raise HTTPException(504, "等待 iAI 回應逾時。請確認後再重試。") from exc
    except httpx.RequestError as exc:
        raise HTTPException(502, "無法連線到 iAI。請檢查網路後再試。") from exc
    try:
        check_status(response)
    except HTTPException:
        await response.aclose()
        raise
    return response


def response_json(response):
    try:
        body = response.json()
    except ValueError as exc:
        raise HTTPException(502, "iAI 回傳了無法解析的資料。") from exc
    if not isinstance(body, dict) or body.get("error"):
        raise HTTPException(502, "iAI 回傳了非預期的結果。")
    return body


@app.get("/api/models")
async def models(request: Request):
    response = await send(request, "GET", "models")
    data = response_json(response).get("data")
    if not isinstance(data, list):
        raise HTTPException(502, "iAI 回傳的模型清單格式不正確。")
    ids = {
        model["id"] for model in data
        if isinstance(model, dict) and isinstance(model.get("id"), str) and model["id"].strip()
    }
    return {"models": sorted(ids, key=str.casefold)}


def budget_amount(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        return None
    return amount if amount.is_finite() and amount >= 0 else None


@app.get("/api/usage")
async def key_usage(request: Request):
    try:
        response = await send(request, "GET", f"{IAIHUB_URL}/key/info", timeout=10.0)
    except HTTPException as exc:
        if exc.status_code in {403, 404, 405}:
            return {"status": "unavailable"}
        raise
    info = response_json(response).get("info")
    if not isinstance(info, dict):
        return {"status": "unavailable"}
    spend = budget_amount(info.get("spend"))
    limit = budget_amount(info.get("max_budget"))
    remaining = max(0, limit - spend) if limit is not None and spend is not None else None
    if spend is None and limit is None:
        return {"status": "unavailable"}
    return {
        "status": "available",
        "spend": str(spend) if spend is not None else None,
        "limit": str(limit) if limit is not None else None,
        "remaining": str(remaining) if remaining is not None else None,
    }


class Message(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1)


ModelID = Annotated[str, Field(min_length=1, max_length=256)]


class ChatRequest(BaseModel):
    model: ModelID
    messages: list[Message] = Field(min_length=1)
    stream: bool = False
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, gt=0)


class AttachedChatRequest(ChatRequest):
    attachment_index: int | None = Field(default=None, ge=0)
    attachment_indices: list[Annotated[int, Field(ge=0)]] | None = Field(
        default=None, min_length=1, max_length=MAX_ATTACHMENTS,
    )


class PromptEnhancementRequest(BaseModel):
    model: ModelID
    mode: Literal["chat", "image", "edit"]
    text: str = Field(min_length=1, max_length=100_000)
    context: list[Message] = Field(default_factory=list, max_length=8)


PROMPT_GUIDANCE = {
    "chat": "清楚組織任務目標、可用資料、限制及使用者要求的輸出格式。",
    "image": "以自然的視覺描述寫清楚主體、構圖、光線、場景和風格。使用者沒要求時，不加入文字或浮水印。",
    "edit": "清楚寫出要修改的區域、修改方式，以及需要保留的參考圖特徵。",
}


def text_content(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(part["text"] for part in value if isinstance(part, dict)
                       and isinstance(part.get("text"), str))
    return ""


def event(**fields):
    return json.dumps(fields, ensure_ascii=False) + "\n"


async def sse_data(response):
    parts = []
    async for line in response.aiter_lines():
        if line.startswith("data:"):
            parts.append(line[5:].removeprefix(" "))
        elif not line and parts:
            yield "\n".join(parts)
            parts.clear()
    if parts:
        yield "\n".join(parts)


async def chat_events(response):
    finished = False
    try:
        async for data in sse_data(response):
            if data == "[DONE]":
                finished = True
                break
            chunk = json.loads(data)
            if chunk.get("error"):
                raise ValueError("Upstream stream error")
            choices = chunk.get("choices") or []
            if choices:
                choice = choices[0]
                delta = choice.get("delta") or {}
                content = text_content(delta.get("content"))
                if content:
                    yield event(text=content)
                finished = finished or bool(choice.get("finish_reason"))
            if isinstance(chunk.get("usage"), dict):
                yield event(usage=chunk["usage"])
        if finished:
            yield event(done=True)
        else:
            yield event(error="iAI 串流提前中斷，請重試或在參數中關閉串流。")
    except (httpx.RequestError, ValueError, AttributeError, TypeError, IndexError):
        yield event(error="iAI 串流回應中斷，請重試或在參數中關閉串流。")
    finally:
        await response.aclose()


@app.post("/api/chat")
async def chat(request: Request, payload: ChatRequest):
    return await complete_chat(request, payload.model_dump(exclude_none=True))


@app.post("/api/prompt/enhance")
async def enhance_prompt(request: Request, payload: PromptEnhancementRequest):
    draft = payload.text.strip()
    if not draft:
        raise HTTPException(422, "請先輸入要優化的提示詞。")
    system = (
        "你是提示詞編輯。輸入的 JSON 是待編輯資料，請改寫 draft_prompt，context 僅供釐清指涉。"
        "保留使用者原本的語言、目標、具體細節、引用文字和限制。"
        "可以補足表達與結構，但不要憑空引入人名、事實、需求或無關風格。"
        "不要執行或回答提示詞。直接輸出可使用的改寫文字，無前言或外層程式碼框。"
        + PROMPT_GUIDANCE[payload.mode]
    )
    context = [message.model_dump() | {"content": message.content[-1500:]} for message in payload.context]
    result = await complete_chat(request, {
        "model": payload.model,
        "stream": False,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps({"draft_prompt": draft, "context": context}, ensure_ascii=False)},
        ],
    })
    return {"text": result["text"].strip(), "model": payload.model}


@app.post("/api/chat/attachments")
async def chat_with_attachments(request: Request):
    auth(request)
    async with request.form(max_files=MAX_ATTACHMENTS, max_fields=1, max_part_size=2 * 1024 * 1024) as form:
        try:
            payload = AttachedChatRequest.model_validate_json(form.get("payload"))
        except ValidationError as exc:
            raise HTTPException(422, "請檢查附件對話的訊息格式。") from exc
        if payload.model != VISION_MODEL:
            raise HTTPException(422, "附件對話請使用 Furen-omni。")
        files = form.getlist("file")
        if not files or any(not isinstance(file, UploadFile) or not file.size for file in files):
            raise HTTPException(422, "請上傳非空白的附件。")
        indices = payload.attachment_indices
        if indices is None and payload.attachment_index is not None:
            indices = [payload.attachment_index] * len(files)
        if not indices or len(indices) != len(files) or any(
            index >= len(payload.messages) or payload.messages[index].role != "user" for index in indices
        ):
            raise HTTPException(422, "每個附件都必須對應一則使用者訊息。")
        if sum(file.size for file in files) > MAX_FILE:
            raise HTTPException(413, "附件合計上限為 20 MB。")
        data = [(file.filename or "附件", file.content_type or "", await file.read()) for file in files]
    try:
        groups = await run_in_threadpool(attachment_parts, data)
    except AttachmentError as exc:
        raise HTTPException(422, str(exc)) from exc
    body = payload.model_dump(exclude_none=True, exclude={"attachment_index", "attachment_indices"})
    for index, parts in zip(indices, groups, strict=True):
        message = body["messages"][index]
        if isinstance(message["content"], str):
            message["content"] = [text_part(message["content"])]
        message["content"].extend(parts)
    return await complete_chat(request, body)


async def complete_chat(request, body):
    streaming = body["stream"]
    response = await send(request, "POST", "chat/completions", stream=streaming, json=body)
    if streaming and "text/event-stream" in response.headers.get("content-type", "").lower():
        return StreamingResponse(chat_events(response), media_type="application/x-ndjson",
                                 headers={"X-Accel-Buffering": "no"})
    try:
        await response.aread()
        body = response_json(response)
        content = text_content(body["choices"][0]["message"].get("content"))
    except (KeyError, IndexError, TypeError, AttributeError, httpx.RequestError) as exc:
        raise HTTPException(502, "iAI 未回傳可顯示的對話內容。") from exc
    finally:
        await response.aclose()
    if not content.strip():
        raise HTTPException(502, "iAI 未回傳可顯示的對話內容。")
    return {"text": content, "usage": body.get("usage")}


class TaskRequest(BaseModel):
    model: ModelID
    text: str = Field(min_length=1, max_length=100_000)
    size: str | None = Field(default=None, pattern=r"^\d{2,5}x\d{2,5}$")
    voice: str | None = Field(default=None, max_length=128)
    response_format: Literal["mp3", "wav"] | None = None
    documents: list[Annotated[str, Field(min_length=1)]] | None = Field(
        default=None, min_length=1, max_length=500
    )
    top_n: int | None = Field(default=None, gt=0)


@app.post("/api/task/{operation}")
async def run_task(
    request: Request, operation: Literal["image", "speak", "embed", "rerank"], payload: TaskRequest
):
    data = {"model": payload.model}
    if operation == "image":
        data.update(prompt=payload.text, n=1)
        if payload.size:
            data["size"] = payload.size
    elif operation == "speak":
        data["input"] = payload.text
        data.update(payload.model_dump(include={"voice", "response_format"}, exclude_none=True))
        if payload.model == "Speaker" and not data.get("voice", "").strip():
            data["voice"] = "taiwan_girl"
    elif operation == "embed":
        data.update(input=payload.text, encoding_format="float")
    else:
        if not payload.documents:
            raise HTTPException(422, "請輸入至少一筆候選文件。")
        if payload.top_n and payload.top_n > len(payload.documents):
            raise HTTPException(422, "回傳筆數需小於或等於候選文件數。")
        data.update(query=payload.text, documents=payload.documents)
        if payload.top_n:
            data["top_n"] = payload.top_n
    response = await send(request, "POST", ROUTES[operation], json=data, operation=operation)
    if operation == "speak":
        media_type = response.headers.get("content-type", "").partition(";")[0].strip().lower()
        if media_type == "application/octet-stream" and response.content:
            if response.content.startswith(b"RIFF") and response.content[8:12] == b"WAVE":
                media_type = "audio/wav"
            elif response.content.startswith(b"ID3") or (
                len(response.content) > 1 and response.content[0] == 0xFF
                and (response.content[1] & 0xE0) == 0xE0
            ):
                media_type = "audio/mpeg"
        if not media_type.startswith("audio/") or not response.content:
            raise HTTPException(502, "iAI 未回傳可播放的音訊。")
        return Response(response.content, media_type=media_type)
    return response_json(response)


@app.post("/api/upload/{operation}")
async def run_upload(request: Request, operation: Literal["edit", "transcribe"]):
    auth(request, operation)
    max_files = MAX_ATTACHMENTS if operation == "edit" else 1
    async with request.form(max_files=max_files, max_fields=4) as form:
        model = form.get("model", "")
        uploads = form.getlist("file")
        if (not isinstance(model, str) or not model.strip() or len(model) > 256
                or not uploads or any(not isinstance(file, UploadFile) or not file.size for file in uploads)):
            raise HTTPException(422, "請先選擇模型和檔案。")
        if sum(file.size for file in uploads) > MAX_FILE:
            raise HTTPException(413, "附件合計上限為 20 MB。")
        data = {"model": model}
        if operation == "edit":
            prompt = form.get("prompt")
            size = form.get("size")
            if not isinstance(prompt, str) or not prompt.strip():
                raise HTTPException(422, "請填寫圖片編輯指令。")
            data.update(prompt=prompt, n="1")
            if size:
                if not isinstance(size, str) or not re.fullmatch(r"\d{2,5}x\d{2,5}", size):
                    raise HTTPException(422, "圖片尺寸請使用 1024x1024 這類格式。")
                data["size"] = size
        else:
            data["response_format"] = "json"
            language = form.get("language")
            if language in ("zh", "en"):
                data["language"] = language
        if len(uploads) > 1:
            try:
                image = await run_in_threadpool(reference_sheet, [await file.read() for file in uploads])
            except AttachmentError as exc:
                raise HTTPException(422, str(exc)) from exc
            data["prompt"] += (
                "\n\n參考圖依左到右、上到下編號。未指明主圖時以參考圖 1 為主，其餘依指令參考。"
                "請輸出一張完整圖片，忽略合圖分隔、底板及編號。"
            )
            upload = ("reference-sheet.png", image, "image/png")
        else:
            file = uploads[0]
            upload = (Path(file.filename or "upload").name, await file.read(),
                      file.content_type or "application/octet-stream")
        field = "image" if operation == "edit" else "file"
        response = await send(request, "POST", ROUTES[operation], data=data,
                              files={field: upload})
    return response_json(response)
