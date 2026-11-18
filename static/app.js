import { icon, iconButton, imageSource, node, renderMessage } from "./render.js";

const MODES = {
  chat: {
    name: "文字對話", icon: "chat", title: "今天想試什麼？",
    description: "連接你的 iAI API Key，開始對話。",
    placeholder: "輸入訊息，探索模型的能力…",
    suggestions: [
      ["file", "整理重點", "請幫我整理以下內容的三個重點：\n"],
      ["bulb", "解釋概念", "用生活中的例子解釋什麼是機器學習。"],
      ["spark", "腦力激盪", "幫我想五個適合大學生的 AI 專題題目。"],
    ],
  },
  image: {
    name: "文字生圖", icon: "image", title: "用文字生成圖片",
    description: "描述你想生成的主題、構圖或風格。", placeholder: "描述你想生成的圖片…",
    suggestions: [["image", "夕陽海景", "夕陽中的台灣東海岸，遠山與浪花，寫實底片攝影。"]],
  },
  edit: {
    name: "圖片編輯", icon: "edit", title: "用參考圖開始編輯",
    description: "上傳一張圖片，描述要修改的地方。", placeholder: "描述你想修改的地方…",
    accept: "image/*", fileLabel: "上傳參考圖片",
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
    voice: TEXT("音色", "例如 taiwan_girl", { maxLength: 128 }),
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
  chats: loadHistory(), conversation: null, taskMessages: [], file: null, request: null,
};
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

function setMode(mode, { keepConversation = false } = {}) {
  if (state.request) return;
  if (state.mode !== mode || !keepConversation) {
    for (const message of state.taskMessages) if (message.audio) URL.revokeObjectURL(message.audio);
    state.taskMessages = [];
    state.file = null;
    $("file-input").value = "";
    $("prompt").value = "";
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
const availableModels = (mode = state.mode) => MODE_MODELS[mode].filter((id) => state.models.includes(id));
const modelId = () => state.selected[state.mode] ?? availableModels()[0] ?? "";
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
      if (availableModels("chat").includes(model)) state.selected.chat = model;
      else delete state.selected.chat;
      if (state.conversation !== chat.id) $("prompt").value = "";
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
  const needsFile = Boolean(mode.accept);
  $("prompt").hidden = state.mode === "transcribe";
  $("prompt").disabled = busy;
  $("pick-file").hidden = !needsFile || !state.file;
  $("pick-file").disabled = busy;
  $("file-required").hidden = !needsFile || Boolean(state.file);
  $("attachment").hidden = !needsFile || !state.file;
  $("attachment").replaceChildren();
  $("file-required").replaceChildren();
  if (needsFile) {
    const picker = node("button");
    picker.type = "button";
    picker.disabled = busy;
    picker.append(icon("upload"), mode.fileLabel);
    picker.addEventListener("click", () => $("file-input").click());
    $("file-required").append(picker);
  }
  if (state.file) {
    const remove = iconButton("close", "移除檔案", () => {
      state.file = null;
      $("file-input").value = "";
      refreshComposer();
    });
    remove.disabled = busy;
    $("attachment").append(icon("file"), node("span", "", state.file.name), remove);
  }
  const hasInput = (state.mode === "transcribe" || $("prompt").value.trim())
    && (!needsFile || state.file);
  $("submit").disabled = !busy && !hasInput;
  $("submit").textContent = busy ? "停止回應" : "送出";
  $("open-settings").disabled = !PARAMS[state.mode] || busy;
  $("open-model").disabled = busy || (Boolean(state.key) && availableModels().length === 1);
  $("open-key").disabled = busy;
  $("mobile-key").disabled = busy;
  $("new-chat").disabled = busy;
  for (const button of $("mode-list").querySelectorAll("button")) button.disabled = busy;
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
  $("mode-pill").replaceChildren(icon(mode.icon), mode.name);
  renderModelStatus();
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
    if (!availableModels(mode).includes(model)) delete state.selected[mode];
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
    body.set("file", state.file);
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
  const text = mode === "transcribe" ? "" : $("prompt").value.trim();
  const file = state.file;
  if ((!text && mode !== "transcribe") || (MODES[mode].accept && !file)) return;
  if (!state.key) {
    showKey();
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
      [path, body] = taskInput(mode, model, text, settings);
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
  const user = { role: "user", text: file ? [text, file.name].filter(Boolean).join("\n") : text };
  const assistant = { role: "assistant", model, text: "", pending: true };
  messages.push(user);
  if (mode === "chat") {
    const { system, ...options } = settings;
    body = { ...options, model, messages: messages.map(({ role, text: content }) => ({ role, content })) };
    if (system) body.messages.unshift({ role: "system", content: system });
  }
  messages.push(assistant);
  $("prompt").value = "";
  const view = refreshUi();
  let removed = false;
  try {
    const response = await api(path, { body, signal: controller.signal });
    if (mode === "chat") {
      await readChat(response, assistant, view.update);
      if (!assistant.text.trim()) throw new Error("iAI 未回傳可顯示的對話內容。");
    } else await readTask(mode, response, assistant);
    state.file = null;
    $("file-input").value = "";
  } catch (error) {
    const stopped = controller.signal.aborted;
    if (!assistant.text.trim()) {
      messages.splice(-2);
      if (newChat) {
        state.chats.shift();
        state.conversation = null;
      }
      $("prompt").value = text;
      removed = true;
    } else assistant.note = stopped ? "已停止 · 部分回應" : "傳輸中斷 · 部分回應";
    status(stopped ? "已停止回應。" : error.message, !stopped);
  } finally {
    delete assistant.pending;
    state.request = null;
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
$("file-input").addEventListener("change", () => {
  const file = $("file-input").files[0];
  if (!file) return;
  if (!file.size || file.size > 20 * 1024 * 1024) {
    status("請選擇 20 MB 以下且非空白的檔案。", true);
    $("file-input").value = "";
    return;
  }
  state.file = file;
  status();
  refreshComposer();
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
