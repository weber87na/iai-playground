import { icon, iconButton, imageSource, node, renderMessage } from "./render.js";

const IMAGE_TYPES = [".png", ".jpg", ".jpeg", ".webp", "image/png", "image/jpeg", "image/webp"];
const DOCUMENT_TYPES = [".pdf", ".txt", ".md", ".markdown", ".csv", "application/pdf", "text/plain", "text/markdown", "text/csv"];
const ATTACHMENT_TYPES = [...IMAGE_TYPES, ...DOCUMENT_TYPES].join(",");
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const MODES = {
  chat: {
    name: "文字對話", icon: "chat", title: "今天想試什麼？",
    description: "連接你的 iAI API Key，開始對話。",
    placeholder: "輸入訊息，或貼上圖片與文件…", accept: ATTACHMENT_TYPES,
    suggestions: [
      ["file", "整理重點", "請幫我整理以下內容的三個重點：\n"],
      ["bulb", "解釋概念", "用生活中的例子解釋什麼是機器學習。"],
      ["spark", "腦力激盪", "幫我想五個適合大學生的 AI 專題題目。"],
    ],
  },
  image: {
    name: "文字生圖", icon: "image", title: "用文字生成圖片",
    description: "描述想生成的圖片，也可以貼上參考圖或文件。", placeholder: "描述你想生成的圖片…",
    accept: ATTACHMENT_TYPES,
    suggestions: [["image", "夕陽海景", "夕陽中的台灣東海岸，遠山與浪花，寫實底片攝影。"]],
  },
  edit: {
    name: "圖片編輯", icon: "edit", title: "用參考圖開始編輯",
    description: "貼上或上傳一張圖片，描述要修改的地方。", placeholder: "描述你想修改的地方…",
    accept: IMAGE_TYPES.join(","), fileLabel: "選擇或貼上參考圖",
  },
  transcribe: {
    name: "語音轉文字", icon: "mic", title: "將音訊轉成文字",
    description: "上傳一段錄音，產生可複製的逐字稿。", accept: "audio/*,.m4a,.mp3,.wav,.mp4",
    fileLabel: "上傳音訊檔案",
  },
  speak: {
    name: "文字轉語音", icon: "audio", title: "讓文字開口說話",
    description: "貼上想朗讀的文字，再播放或下載音訊。", placeholder: "輸入想朗讀的文字…",
    suggestions: [["audio", "試聽範例", "歡迎來到高科大 iAI Playground。今天想試試哪個模型？"]],
  },
  embed: {
    name: "文字向量化", icon: "grid", title: "將文字轉成向量",
    description: "輸入一段文字，查看向量結果與維度。", placeholder: "輸入想轉換的文字…",
    suggestions: [["grid", "範例輸入", "高雄港是台灣的重要港口。"]],
  },
  rerank: {
    name: "文件重排序", icon: "sort", title: "依相關性排序文件",
    description: "輸入查詢句，並在參數中加入候選文件。", placeholder: "輸入要比對的查詢句…",
    suggestions: [["sort", "範例查詢", "高雄有哪些地方適合看海？"]],
  },
};

// Official catalog categories and the endpoint support documented by nkust-iai.
// The first model granted by the current key is the default for each workspace.
const MODE_MODELS = {
  chat: ["Furen-omni", "Furen-std", "Furen-large", "Furen-max", "Furen-coder", "Nkust"],
  image: ["Pic-small", "Pic-large", "z-image"],
  edit: ["Pic-large", "Pic-small"],
  transcribe: ["Asr"],
  speak: ["Speaker"],
  embed: ["Embedding"],
  rerank: ["Furen-reranker"],
};
const VISION_MODEL = "Furen-omni";

const TEXT = (label, placeholder = "", attrs = {}) => ["text", label, { placeholder, ...attrs }];
const PARAMS = {
  chat: {
    system: ["textarea", "系統提示詞", { rows: 3, placeholder: "選填。設定模型的角色或回覆方式。" }],
    temperature: ["number", "Temperature", { min: 0, max: 2, step: 0.1, placeholder: "模型預設" }],
    max_tokens: ["number", "Max tokens", { min: 1, step: 1, placeholder: "模型預設" }],
    stream: ["checkbox", "使用串流回應", {}],
  },
  image: { size: TEXT("圖片尺寸", "1024x1024", { pattern: "[0-9]{2,5}x[0-9]{2,5}" }) },
  transcribe: { language: ["select", "音訊語言", { options: { "": "讓模型判斷", zh: "中文", en: "英文" } }] },
  speak: {
    voice: TEXT("音色", "預設 taiwan_girl", { maxLength: 128 }),
    response_format: ["select", "輸出格式", { options: { "": "模型預設", mp3: "MP3", wav: "WAV" } }],
  },
  rerank: {
    documents: ["textarea", "候選文件（每行一筆）", { rows: 5, placeholder: "輸入或貼上候選文件" }],
    top_n: ["number", "最多回傳筆數", { min: 1, step: 1, placeholder: "模型預設" }],
  },
};
PARAMS.edit = PARAMS.image;

const defaults = (mode) => ({
  ...(mode === "chat" ? { stream: true } : {}),
  ...(["image", "edit"].includes(mode) ? { size: "1024x1024" } : {}),
});
const $ = (id) => document.getElementById(id);
const storageKey = "iai-playground.history.v1";
const mobile = matchMedia("(max-width: 760px)");
const state = {
  mode: "chat", key: "", models: [], selected: {}, settings: {},
  chats: loadHistory(), conversation: null, taskMessages: [], imageContext: [], files: [], request: null,
};
let chatUploads = new WeakMap();
let panelOpen = !mobile.matches;
let settingsMode;
let usageRequest;

function loadHistory() {
  try {
    const chats = JSON.parse(localStorage.getItem(storageKey));
    return Array.isArray(chats) ? chats.filter((chat) =>
      chat && typeof chat.id === "string" && typeof chat.title === "string"
      && Array.isArray(chat.messages) && chat.messages.every((item) =>
        item && ["user", "assistant"].includes(item.role) && typeof item.text === "string")
    ) : [];
  } catch {
    return [];
  }
}

function storeHistory() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state.chats));
    return true;
  } catch {
    return false;
  }
}

function status(message = "", error = false) {
  const element = $("composer-status");
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle("error", error);
}

function setPanel(open) {
  panelOpen = open;
  $("sidebar").setAttribute("aria-hidden", String(!open));
  $("toggle-panel").setAttribute("aria-expanded", String(open));
  $("scrim").hidden = !open || !mobile.matches;
}

function setMode(mode, { keepConversation = false, draft } = {}) {
  if (state.request) return;
  if (state.mode !== mode || !keepConversation) {
    for (const message of state.taskMessages) if (message.audio) URL.revokeObjectURL(message.audio);
    state.taskMessages = [];
    state.imageContext = draft?.context ?? [];
    state.files = draft?.files ?? [];
    $("file-input").value = "";
    $("prompt").value = draft?.text ?? "";
  }
  if (!keepConversation) {
    state.conversation = null;
    if (mode === "chat") delete state.selected.chat;
  }
  state.mode = mode;
  status();
  refreshUi();
  if (mobile.matches) setPanel(false);
}

const currentChat = () => state.chats.find((chat) => chat.id === state.conversation);
const currentMessages = () => state.mode === "chat" ? (currentChat()?.messages ?? []) : state.taskMessages;
const authorizedModels = (mode) => MODE_MODELS[mode].filter((id) => state.models.includes(id));
const lastAttachmentTurn = () => currentChat()?.messages.findLast((message) => message.attachments?.length);
const activeChatFiles = () => state.files.length ? state.files : chatUploads.get(lastAttachmentTurn()) ?? [];
const chatHistory = () => (currentChat()?.messages ?? []).map(({ role, text }) => ({ role, content: text }));
function availableModels() {
  const models = authorizedModels(state.mode);
  return state.mode === "chat" && activeChatFiles().length ? models.filter((id) => id === VISION_MODEL) : models;
}
function modelId() {
  const models = availableModels();
  const selected = state.selected[state.mode];
  return models.includes(selected) ? selected : models[0] ?? "";
}
const noModelMessage = () => "這組金鑰目前沒有可用於「" + MODES[state.mode].name + "」的模型。";
const modeSettings = (mode) => state.settings[mode] ?? defaults(mode);

function renderHistory() {
  const list = $("history-list");
  list.replaceChildren();
  if (!state.chats.length) list.append(node("p", "history-empty", "這個瀏覽器還沒有對話。"));
  for (const chat of state.chats) {
    const row = node("div", "history-row");
    const active = state.mode === "chat" && chat.id === state.conversation;
    row.classList.toggle("active", active);
    const button = node("button", "history-open", chat.title);
    button.title = chat.title;
    if (active) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => {
      if (state.request) return;
      const model = chat.messages.findLast((message) => message.role === "assistant")?.model;
      if (authorizedModels("chat").includes(model)) state.selected.chat = model;
      else delete state.selected.chat;
      if (state.conversation !== chat.id) {
        $("prompt").value = "";
        state.files = [];
        $("file-input").value = "";
      }
      state.conversation = chat.id;
      setMode("chat", { keepConversation: true });
    });
    const remove = iconButton("trash", "刪除「" + chat.title + "」", () => {
      if (state.request || !window.confirm("刪除這筆對話紀錄？")) return;
      state.chats = state.chats.filter((item) => item.id !== chat.id);
      const stored = storeHistory();
      if (state.conversation === chat.id) setMode("chat");
      else renderHistory();
      if (!stored) status("無法更新瀏覽器中的對話紀錄。", true);
    }, "history-delete");
    row.append(button, remove);
    list.append(row);
  }
}

function renderFeed() {
  const messages = currentMessages();
  const empty = !messages.length;
  $("surface").classList.toggle("is-empty", empty);
  $("welcome").hidden = !empty;
  $("messages").hidden = empty;
  $("messages").replaceChildren();
  let last;
  for (const message of messages) {
    const view = renderMessage(message);
    $("messages").append(view.article);
    last = view;
  }
  $("suggestions").hidden = !empty;
  if (!empty) scrollDown();
  return last;
}

function scrollDown() {
  const feed = $("feed");
  feed.scrollTop = feed.scrollHeight;
}

function isNearEnd() {
  const feed = $("feed");
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
}

function refreshComposer() {
  const mode = MODES[state.mode];
  const busy = Boolean(state.request);
  const needsFile = Boolean(mode.fileLabel);
  $("prompt").hidden = state.mode === "transcribe";
  $("prompt").disabled = busy;
  $("pick-file").hidden = !mode.accept || (needsFile && !state.files.length);
  $("pick-file").disabled = busy;
  $("file-required").hidden = !needsFile || Boolean(state.files.length);
  $("attachment").hidden = !state.files.length;
  $("attachment").replaceChildren();
  $("file-required").replaceChildren();
  if (needsFile && !state.files.length) {
    const picker = node("button");
    picker.type = "button";
    picker.disabled = busy;
    picker.append(icon("upload"), mode.fileLabel);
    picker.addEventListener("click", () => $("file-input").click());
    $("file-required").append(picker);
  }
  for (const [index, file] of state.files.entries()) {
    const chip = node("div", "attachment-chip");
    const remove = iconButton("close", "移除 " + file.name, () => {
      state.files.splice(index, 1);
      $("file-input").value = "";
      status();
      refreshComposer();
    });
    remove.disabled = busy;
    chip.append(icon(isImage(file) ? "image" : "file"), node("span", "", file.name), remove);
    $("attachment").append(chip);
  }
  $("attachment-action").hidden = state.mode !== "chat" || (!activeChatFiles().length && !currentChat()?.messages.length);
  $("attachment-action").textContent = activeChatFiles().length ? "依附件生圖" : "依對話生圖";
  $("attachment-action").disabled = busy;
  const hint = composerAttachmentHint();
  $("attachment-hint").textContent = hint;
  $("attachment-hint").hidden = !hint;
  const hasInput = (state.mode === "transcribe" || $("prompt").value.trim()
    || (["chat", "image"].includes(state.mode) && state.files.length)
    || (state.mode === "image" && state.imageContext.length)) && (!needsFile || state.files.length);
  $("submit").disabled = !busy && !hasInput;
  $("submit").textContent = busy ? "停止回應" : "送出";
  $("open-settings").disabled = !PARAMS[state.mode] || busy;
  $("open-model").disabled = busy || (Boolean(state.key) && availableModels().length === 1);
  $("open-key").disabled = busy;
  $("mobile-key").disabled = busy;
  $("new-chat").disabled = busy;
  for (const button of $("mode-list").querySelectorAll("button")) button.disabled = busy;
  renderModelStatus();
}

function composerAttachmentHint() {
  if (state.mode === "image" && (state.files.length || state.imageContext.length)) {
    return state.imageContext.length
      ? "會帶入前文，先整理生圖提示詞，再呼叫生圖模型。"
      : "先用 Furen-omni 整理附件，再呼叫生圖模型。";
  }
  if (state.mode === "edit" && state.imageContext.length) return "會帶入對話前文作為圖片編輯背景。";
  if (state.mode !== "chat" || state.files.length) return "";
  const turn = lastAttachmentTurn();
  if (!turn) return "";
  return chatUploads.has(turn) ? "後續問題會沿用最近送出的附件。" : "如需重新讀取原檔，請再附上檔案。";
}

function renderModelStatus() {
  const connected = Boolean(state.key);
  const modelCount = availableModels().length;
  const active = modelId();
  $("model-button-label").textContent = active || (connected ? "沒有可用模型" : "連接 API Key");
  $("model-vision").hidden = active !== VISION_MODEL;
  $("model-action").hidden = modelCount < 2;
  $("key-status").textContent = connected ? "已連線 · " + state.models.length + " 個模型" : "尚未連線";
}

function refreshUi() {
  const mode = MODES[state.mode];
  $("welcome-title").textContent = mode.title;
  const description = state.mode === "chat" && state.key ? "輸入訊息，或從下方的提示詞開始。" : mode.description;
  $("welcome-description").textContent = state.key && !modelId() ? noModelMessage() : description;
  $("hero-icon").setAttribute("href", "#i-" + (state.mode === "chat" ? "orbit" : mode.icon));
  $("prompt").placeholder = mode.placeholder ?? "";
  $("file-input").accept = mode.accept ?? "";
  $("file-input").multiple = state.mode === "chat" || state.mode === "image";
  $("mode-pill").replaceChildren(icon(mode.icon), mode.name);
  for (const button of $("mode-list").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
  }
  $("suggestions").replaceChildren();
  for (const [glyph, label, prompt] of mode.suggestions ?? []) {
    const button = node("button", "suggestion");
    button.append(icon(glyph), node("span", "", label));
    button.addEventListener("click", () => {
      $("prompt").value = prompt;
      $("prompt").focus();
      refreshComposer();
    });
    $("suggestions").append(button);
  }
  renderHistory();
  refreshComposer();
  return renderFeed();
}

async function api(path, { key = state.key, body, signal } = {}) {
  const headers = { Authorization: "Bearer " + key };
  const multipart = body instanceof FormData;
  if (body && !multipart) headers["Content-Type"] = "application/json";
  const response = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    body: multipart ? body : body && JSON.stringify(body),
    headers, signal, credentials: "omit", cache: "no-store",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === "string" ? data.detail : "請求失敗，請稍後再試。");
  }
  return response;
}

const usd = new Intl.NumberFormat("en", {
  style: "currency", currency: "USD", maximumFractionDigits: 5,
});

function usageSummary(data) {
  if (data.status !== "available") return "此金鑰無法查詢額度。";
  if (data.remaining !== null) return "剩餘 " + usd.format(data.remaining) + " USD";
  if (data.spend !== null) return "已使用 " + usd.format(data.spend) + " USD，未提供額度上限";
  return "額度上限 " + usd.format(data.limit) + " USD，未提供已用金額";
}

async function refreshUsage() {
  usageRequest?.abort();
  if (!state.key) {
    usageRequest = undefined;
    $("usage-panel").hidden = true;
    $("usage-status").textContent = "";
    return;
  }
  const controller = new AbortController();
  usageRequest = controller;
  $("usage-panel").hidden = false;
  $("usage-status").textContent = "查詢中…";
  $("refresh-usage").disabled = true;
  try {
    const response = await api("usage", { signal: controller.signal });
    const data = await response.json();
    if (usageRequest === controller) $("usage-status").textContent = usageSummary(data);
  } catch {
    if (usageRequest === controller) $("usage-status").textContent = "暫時無法查詢，請稍後更新。";
  } finally {
    if (usageRequest === controller) {
      usageRequest = undefined;
      $("refresh-usage").disabled = false;
    }
  }
}

function showKey() {
  $("key-error").hidden = true;
  $("key-input").value = "";
  $("disconnect").hidden = !state.key;
  $("key-dialog").showModal();
}

function updateModels(models) {
  state.models = models;
  for (const [mode, model] of Object.entries(state.selected)) {
    if (!authorizedModels(mode).includes(model)) delete state.selected[mode];
  }
}

function renderModels() {
  const query = $("model-search").value.trim().toLowerCase();
  const compatible = availableModels();
  const models = compatible.filter((id) => id.toLowerCase().includes(query));
  $("model-count").textContent = MODES[state.mode].name + " · " + compatible.length + " 個可用模型";
  $("models").replaceChildren();
  if (!models.length) {
    $("models").append(node("p", "", compatible.length ? "找不到符合的模型。" : noModelMessage()));
    return;
  }
  for (const model of models) {
    const button = node("button", "model-option", model);
    if (model === VISION_MODEL) button.append(node("span", "vision-badge", "視覺"));
    button.setAttribute("aria-pressed", String(modelId() === model));
    button.addEventListener("click", () => {
      state.selected[state.mode] = model;
      renderModelStatus();
      $("model-dialog").close();
      status();
      if (mobile.matches) setPanel(false);
      if (!$("prompt").hidden) $("prompt").focus();
    });
    $("models").append(button);
  }
}

function showModel() {
  if (!state.key) {
    showKey();
    return;
  }
  $("model-error").hidden = true;
  $("model-search").value = "";
  renderModels();
  $("model-dialog").showModal();
  $("model-search").focus();
}

$("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("key-input").value.trim();
  if (!/^[!-~]{1,2048}$/.test(key)) {
    $("key-error").textContent = "請貼上金鑰本身，並移除多餘的空格。";
    $("key-error").hidden = false;
    return;
  }
  const controller = new AbortController();
  const dialog = $("key-dialog");
  const cancel = () => controller.abort();
  dialog.addEventListener("close", cancel, { once: true });
  $("connect").disabled = true;
  $("disconnect").disabled = true;
  $("key-error").hidden = true;
  try {
    const response = await api("models", { key, signal: controller.signal });
    const data = await response.json();
    if (controller.signal.aborted || !dialog.open) return;
    if (state.key && state.key !== key) chatUploads = new WeakMap();
    state.key = key;
    updateModels(data.models);
    $("key-input").value = "";
    dialog.removeEventListener("close", cancel);
    dialog.close();
    status();
    refreshUi();
    refreshUsage();
    if (mobile.matches) setPanel(false);
  } catch (error) {
    if (controller.signal.aborted) return;
    $("key-error").textContent = error.message;
    $("key-error").hidden = false;
  } finally {
    dialog.removeEventListener("close", cancel);
    $("connect").disabled = false;
    $("disconnect").disabled = false;
  }
});

$("disconnect").addEventListener("click", () => {
  chatUploads = new WeakMap();
  state.key = "";
  state.models = [];
  state.selected = {};
  $("key-input").value = "";
  $("key-dialog").close();
  status();
  refreshUi();
  refreshUsage();
});
$("key-dialog").addEventListener("close", () => { $("key-input").value = ""; });

$("refresh-models").addEventListener("click", async () => {
  const key = state.key;
  $("refresh-models").disabled = true;
  $("model-error").hidden = true;
  try {
    const response = await api("models", { key });
    const data = await response.json();
    if (state.key === key) {
      updateModels(data.models);
      status();
      refreshUi();
      renderModels();
    }
  } catch (error) {
    $("model-error").textContent = error.message;
    $("model-error").hidden = false;
  } finally {
    $("refresh-models").disabled = false;
  }
});

function renderSettings(values) {
  const container = $("settings-fields");
  container.replaceChildren();
  for (const [name, [type, label, options]] of Object.entries(PARAMS[settingsMode])) {
    const wrapper = node("label", "control", label);
    const input = node(["textarea", "select"].includes(type) ? type : "input");
    input.name = name;
    if (input.localName === "input") input.type = type;
    if (type === "select") {
      for (const [value, text] of Object.entries(options.options)) input.add(new Option(text, value));
    } else Object.assign(input, options);
    if (type === "checkbox") input.checked = Boolean(values[name]);
    else input.value = values[name] ?? "";
    if (type === "checkbox") wrapper.prepend(input);
    else wrapper.append(input);
    container.append(wrapper);
  }
}
$("open-settings").addEventListener("click", () => {
  settingsMode = state.mode;
  $("settings-description").textContent = MODES[state.mode].name + " · 模型支援的參數依服務而異";
  renderSettings(modeSettings(settingsMode));
  $("settings-dialog").showModal();
});
$("reset-settings").addEventListener("click", () => renderSettings(defaults(settingsMode)));
$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const values = {};
  for (const input of $("settings-fields").querySelectorAll("input, select, textarea")) {
    if (input.type === "checkbox") values[input.name] = input.checked;
    else if (input.value.trim()) {
      values[input.name] = input.type === "number" ? input.valueAsNumber : input.value.trim();
    }
  }
  state.settings[settingsMode] = values;
  $("settings-dialog").close();
  status();
});

function applyChunk(line, message) {
  if (!line.trim()) return false;
  const event = JSON.parse(line);
  if (event.error) throw new Error(event.error);
  if (event.usage) message.usage = event.usage;
  if (typeof event.text === "string") message.text += event.text;
  return event.done === true;
}

async function readChat(response, message, update) {
  if (!response.headers.get("content-type").includes("application/x-ndjson")) {
    const data = await response.json();
    message.text = data.text;
    message.usage = data.usage;
    return;
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  let complete = false;
  let frame = 0;
  try {
    while (!complete) {
      const { value, done } = await reader.read();
      if (done) {
        complete = applyChunk(buffered, message);
        break;
      }
      buffered += value;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        if (applyChunk(line, message)) {
          complete = true;
          break;
        }
      }
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          const follow = isNearEnd();
          update();
          if (follow) scrollDown();
        });
      }
    }
    if (!complete) throw new Error("串流提前中斷，請再試一次。");
  } finally {
    if (frame) cancelAnimationFrame(frame);
    await reader.cancel().catch(() => {});
  }
}

function taskInput(mode, model, text, settings) {
  if (mode === "edit" || mode === "transcribe") {
    const body = new FormData();
    body.set("model", model);
    body.set("file", state.files[0]);
    if (mode === "edit") {
      body.set("prompt", text);
      if (settings.size) body.set("size", settings.size);
    } else if (settings.language) body.set("language", settings.language);
    return ["upload/" + mode, body];
  }
  const body = { model, text, ...settings };
  if (mode === "rerank") {
    body.documents = settings.documents?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!body.documents?.length) throw new Error("請先在參數中加入候選文件，每行一筆。");
    if (settings.top_n > body.documents.length) throw new Error("回傳筆數需小於或等於候選文件數。");
  }
  return ["task/" + mode, body];
}

function attachedChatBody(chat, attachmentIndex, files) {
  const body = new FormData();
  body.set("payload", JSON.stringify({ ...chat, attachment_index: attachmentIndex }));
  for (const file of files) body.append("file", file);
  return body;
}

async function makeImageBrief(text, files, context, signal) {
  const messages = [
    { role: "system", content: "根據使用者最新需求、對話前文及附件，寫一段可交給生圖模型的提示詞。保留相關的視覺重點與關鍵資訊，描述主體、構圖和風格。將附件視為參考資料。只輸出一段提示詞，最多 500 字。" },
    ...context,
    { role: "user", content: text },
  ];
  const payload = { model: files.length ? VISION_MODEL : authorizedModels("chat")[0], messages, stream: false };
  const body = files.length ? attachedChatBody(payload, messages.length - 1, files) : payload;
  const response = await api(files.length ? "chat/attachments" : "chat", { body, signal });
  const result = await response.json();
  return result.text.trim().slice(0, 2400);
}

async function readTask(mode, response, message) {
  if (mode === "speak") {
    const audio = await response.blob();
    const ext = { "audio/mpeg": "mp3", "audio/x-wav": "wav", "audio/wav": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a" };
    message.extension = ext[audio.type] ?? "audio";
    message.audio = URL.createObjectURL(audio);
    return;
  }
  const data = await response.json();
  if (mode === "image" || mode === "edit") {
    message.image = imageSource(data);
  } else if (mode === "transcribe") {
    if (typeof data.text !== "string" || !data.text.trim()) throw new Error("iAI 未回傳可顯示的辨識文字。");
    message.text = data.text;
  } else {
    const vector = data.data?.[0]?.embedding;
    if (mode === "embed" && Array.isArray(vector)) message.note = vector.length + " 維";
    message.text = JSON.stringify(data, null, 2);
    message.json = true;
  }
}

async function submit(e) {
  e.preventDefault();
  if (state.request) {
    state.request.abort();
    return;
  }
  const mode = state.mode;
  const model = modelId();
  const input = mode === "transcribe" ? "" : $("prompt").value.trim();
  const files = [...state.files];
  const previousAttachment = mode === "chat" ? lastAttachmentTurn() : null;
  const contextFiles = mode === "chat" && !files.length ? (chatUploads.get(previousAttachment) ?? []) : files;
  const imageContext = state.imageContext;
  const needsBrief = mode === "image" && (files.length > 0 || imageContext.length > 0);
  if (MODES[mode].fileLabel && !files.length) return;
  const text = input || (mode === "chat" && files.length ? "請說明附件的內容。" :
    needsBrief ? "請根據前文與參考資料設計一張圖。" : "");
  if (!text && mode !== "transcribe") return;
  if (!state.key) {
    showKey();
    return;
  }
  if (((mode === "chat" && contextFiles.length) || (needsBrief && files.length)) && !state.models.includes(VISION_MODEL)) {
    status("此金鑰沒有 Furen-omni 的使用權限，無法讀取附件。", true);
    return;
  }
  if (needsBrief && !authorizedModels("chat").length) {
    status("此金鑰沒有可用的文字模型，無法將前文整理成生圖提示詞。", true);
    return;
  }
  if (!model) {
    status(noModelMessage(), true);
    return;
  }
  const settings = modeSettings(mode);
  let [path, body] = ["chat", null];
  if (mode !== "chat") {
    try {
      const context = mode === "edit" ? imageContext.map(({ role, content }) =>
        (role === "user" ? "使用者：" : "助理：") + content).join("\n").slice(-1800) : "";
      const prompt = context ? text + "\n\n可參考的對話背景：\n" + context : text;
      [path, body] = taskInput(mode, model, prompt, settings);
    } catch (error) {
      status(error.message, true);
      return;
    }
  }
  const controller = new AbortController();
  state.request = controller;
  status();
  const newChat = mode === "chat" && !currentChat();
  if (newChat) {
    const chat = { id: crypto.randomUUID(), title: text.replace(/\s+/g, " ").slice(0, 45), messages: [] };
    state.chats.unshift(chat);
    state.conversation = chat.id;
  }
  const messages = currentMessages();
  const user = { role: "user", text };
  if (files.length) user.attachments = files.map((file) => file.name);
  const assistant = { role: "assistant", model, text: "", pending: true };
  if (needsBrief) assistant.waiting = "正在整理生圖提示詞";
  messages.push(user);
  if (mode === "chat") {
    const { system, ...options } = settings;
    body = { ...options, model, messages: messages.map(({ role, text: content }) => ({ role, content })) };
    if (system) body.messages.unshift({ role: "system", content: system });
    if (contextFiles.length) {
      const index = messages.indexOf(files.length ? user : previousAttachment) + (system ? 1 : 0);
      body = attachedChatBody(body, index, contextFiles);
      path = "chat/attachments";
    }
    if (files.length) chatUploads.set(user, files);
  }
  messages.push(assistant);
  $("prompt").value = "";
  const view = refreshUi();
  let removed = false;
  let imageBrief = "";
  try {
    if (needsBrief) {
      imageBrief = await makeImageBrief(text, files, imageContext, controller.signal);
      if (!imageBrief) throw new Error("iAI 未回傳可用的生圖提示詞。");
      body.text = imageBrief;
      assistant.waiting = "正在生成圖片";
      view.update();
    }
    const response = await api(path, { body, signal: controller.signal });
    if (mode === "chat") {
      await readChat(response, assistant, view.update);
      if (!assistant.text.trim()) throw new Error("iAI 未回傳可顯示的對話內容。");
    } else await readTask(mode, response, assistant);
    state.files = [];
    $("file-input").value = "";
  } catch (error) {
    const stopped = controller.signal.aborted;
    if (imageBrief) {
      assistant.text = imageBrief;
      assistant.note = "已整理的生圖提示詞";
      $("prompt").value = input;
    } else if (!assistant.text.trim()) {
      messages.splice(-2);
      if (newChat) {
        state.chats.shift();
        state.conversation = null;
      }
      $("prompt").value = input;
      removed = true;
    } else {
      assistant.note = stopped ? "已停止 · 部分回應" : "傳輸中斷 · 部分回應";
      state.files = [];
      $("file-input").value = "";
    }
    status(stopped ? "已停止回應。" : error.message, !stopped);
  } finally {
    delete assistant.pending;
    state.request = null;
    if (mode === "chat" && !removed && files.length && previousAttachment) chatUploads.delete(previousAttachment);
    if (mode === "chat" && !removed && !storeHistory()) status("瀏覽器無法保存這筆對話。", true);
    if (removed) refreshUi();
    else {
      const follow = isNearEnd();
      view.update();
      refreshComposer();
      if (follow) scrollDown();
    }
  }
}

function matchesFile(file, types) {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return types.some((item) => item.startsWith(".") ? name.endsWith(item) : type === item);
}

const isImage = (file) => matchesFile(file, IMAGE_TYPES);

function useFilesForImage(files, context = []) {
  const mode = files.length === 1 && isImage(files[0]) ? "edit" : "image";
  setMode(mode, { keepConversation: true, draft: { files, context, text: $("prompt").value } });
  $("prompt").focus();
}

function addFiles(incoming) {
  if (!incoming.length || state.request) return;
  const mode = state.mode;
  if (!MODES[mode].accept) {
    status("請切換到文字對話、圖片或語音轉文字工作區以加入附件。", true);
    return;
  }
  let valid;
  let formatError;
  if (mode === "transcribe") {
    valid = incoming.every((file) => file.type.startsWith("audio/") ||
      matchesFile(file, [".m4a", ".mp3", ".wav", ".mp4", ".flac", ".ogg", ".webm"]));
    formatError = "請加入可辨識的音訊檔案。";
  } else if (mode === "edit") {
    valid = incoming.every(isImage);
    formatError = "參考圖請使用 PNG、JPEG 或 WebP。";
  } else {
    valid = incoming.every((file) => isImage(file) || matchesFile(file, DOCUMENT_TYPES));
    formatError = "請加入 PNG、JPEG、WebP、PDF、TXT、Markdown 或 CSV。";
  }
  if (!valid) {
    status(formatError, true);
    return;
  }
  const single = Boolean(MODES[mode].fileLabel);
  const files = single ? incoming : [...state.files, ...incoming];
  if (files.length > (single ? 1 : 4)) {
    status(single ? "這個工作區一次只接受一個檔案。" : "每次最多可附加 4 個檔案。", true);
    return;
  }
  if (files.some((file) => !file.size) || files.reduce((size, file) => size + file.size, 0) > MAX_ATTACHMENT_BYTES) {
    status("附件不可為空白，合計上限為 20 MB。", true);
    return;
  }
  if (mode === "image" && files.length === 1 && isImage(files[0])) {
    useFilesForImage(files);
    return;
  }
  state.files = files;
  status();
  refreshComposer();
}

for (const [id, mode] of Object.entries(MODES)) {
  const button = node("button", "nav-button");
  button.dataset.mode = id;
  button.append(icon(mode.icon), mode.name);
  button.addEventListener("click", () => {
    if (state.mode !== id) setMode(id, { keepConversation: true });
    else if (mobile.matches) setPanel(false);
  });
  $("mode-list").append(button);
}
for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}
$("new-chat").addEventListener("click", () => setMode("chat"));
$("toggle-panel").addEventListener("click", () => setPanel(!panelOpen));
$("scrim").addEventListener("click", () => setPanel(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && mobile.matches && panelOpen && !document.querySelector("dialog[open]")) {
    setPanel(false);
    $("toggle-panel").focus();
  }
});
mobile.addEventListener("change", () => setPanel(!mobile.matches));
$("open-key").addEventListener("click", showKey);
$("refresh-usage").addEventListener("click", refreshUsage);
$("mobile-key").addEventListener("click", showKey);
$("open-model").addEventListener("click", showModel);
$("model-search").addEventListener("input", renderModels);
$("pick-file").addEventListener("click", () => $("file-input").click());
$("attachment-action").addEventListener("click", () => useFilesForImage([...activeChatFiles()], chatHistory()));
$("file-input").addEventListener("change", () => {
  const files = Array.from($("file-input").files);
  $("file-input").value = "";
  addFiles(files);
});
document.addEventListener("paste", (e) => {
  if (!e.clipboardData || state.request || document.querySelector("dialog[open]")) return;
  if (e.target.closest?.("input, textarea, [contenteditable]") && !$("composer").contains(e.target)) return;
  const files = Array.from(e.clipboardData.files);
  if (!files.length) {
    for (const item of e.clipboardData.items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});
$("composer").addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
});
$("composer").addEventListener("drop", (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  addFiles(Array.from(e.dataTransfer.files));
});
$("prompt").addEventListener("input", () => refreshComposer());
$("prompt").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229 || state.request) return;
  e.preventDefault();
  if (!$("submit").disabled) $("composer").requestSubmit();
});
$("composer").addEventListener("submit", submit);
setPanel(panelOpen);
refreshUi();
