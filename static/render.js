export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function icon(name, extraClass = "") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const use = document.createElementNS(ns, "use");
  svg.setAttribute("class", ["icon", extraClass].filter(Boolean).join(" "));
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

export function iconButton(name, label, callback, className = "") {
  const button = node("button", ("icon-button " + className).trim());
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  button.addEventListener("click", callback);
  return button;
}

function httpsUrl(value, allowHttp = false) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || (allowHttp && url.protocol === "http:")) return url.href;
  } catch {
    return "";
  }
  return "";
}

function inline(parent, text) {
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(text.slice(start, match.index));
    const [, code, bold, italics, label, target] = match;
    if (code) parent.append(node("code", "", code));
    else if (bold) parent.append(node("strong", "", bold));
    else if (italics) parent.append(node("em", "", italics));
    else {
      const url = httpsUrl(target, true);
      if (url) {
        const link = node("a", "", label);
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parent.append(link);
      } else parent.append(match[0]);
    }
    start = match.index + match[0].length;
  }
  parent.append(text.slice(start));
}

export function markdown(text) {
  const fragment = document.createDocumentFragment();
  const paragraphs = [];
  let listing;
  function flush() {
    if (paragraphs.length) {
      const paragraph = node("p");
      inline(paragraph, paragraphs.splice(0).join("\n"));
      fragment.append(paragraph);
    }
    listing = null;
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^\s*(#{1,6})\s+(.+)/.exec(line);
    const item = /^\s*([-+*]|\d+[.)])\s+(.+)/.exec(line);
    if (line.trimStart().startsWith("```")) {
      flush();
      const code = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith("```")) code.push(lines[i]);
      const pre = node("pre");
      pre.append(node("code", "", code.join("\n")));
      fragment.append(pre);
    } else if (heading) {
      flush();
      const element = node("h" + Math.min(heading[1].length + 1, 4));
      inline(element, heading[2]);
      fragment.append(element);
    } else if (item) {
      const tag = /\d/.test(item[1]) ? "ol" : "ul";
      if (listing?.localName !== tag) {
        flush();
        listing = node(tag);
        if (tag === "ol") listing.start = Number.parseInt(item[1], 10);
        fragment.append(listing);
      }
      const li = node("li");
      inline(li, item[2]);
      listing.append(li);
    } else if (!line.trim()) flush();
    else {
      listing = null;
      paragraphs.push(line);
    }
  }
  flush();
  return fragment;
}

export function imageSource(result) {
  for (const image of result?.data ?? []) {
    const b64 = image?.b64_json;
    if (typeof b64 === "string") {
      const formats = [
        ["iVBOR", "png"], ["/9j/", "jpeg"], ["UklGR", "webp"], ["R0lGOD", "gif"],
      ];
      const format = formats.find(([prefix]) => b64.startsWith(prefix));
      if (format) return { src: "data:image/" + format[1] + ";base64," + b64, extension: format[1] };
    }
    const url = httpsUrl(image?.url);
    if (url) return { src: url, extension: "" };
  }
  throw new Error("iAI 未回傳可顯示的圖片。");
}

function download(url, label, filename) {
  const link = node("a", "quiet-button", label);
  link.href = url;
  if (filename) link.download = filename;
  else {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  return link;
}

export function renderMessage(message) {
  const article = node("article", "message " + message.role);
  if (message.role === "user") {
    const filenames = Array.isArray(message.attachments) ? message.attachments.filter((name) => typeof name === "string") : [];
    if (filenames.length) {
      const attachments = node("div", "message-attachments");
      for (const filename of filenames) {
        const label = node("span");
        label.append(icon("file"), filename);
        attachments.append(label);
      }
      article.append(attachments);
    }
    if (message.text) article.append(node("div", "message-content plain", message.text));
    return { article };
  }

  const avatar = node("div", "avatar");
  avatar.append(icon("orbit"));
  const body = node("div");
  const content = node("div", "message-content");
  const actions = node("div", "message-actions");
  const update = () => {
    content.className = "message-content";
    content.replaceChildren();
    actions.replaceChildren();
    if (message.pending && !message.text) {
      content.append(node("div", "pending", message.waiting ?? "等待模型回應"));
      return;
    }
    if (message.image) {
      const image = node("img");
      image.src = message.image.src;
      image.alt = "iAI 模型輸出的圖片";
      const dimensions = node("span");
      image.addEventListener("load", () => {
        dimensions.textContent = image.naturalWidth + " × " + image.naturalHeight;
      });
      image.addEventListener("error", () => {
        image.replaceWith(node("p", "", "圖片無法載入。可嘗試從原始網址開啟。"));
      });
      content.append(image);
      const filename = message.image.extension ? "iai-image." + message.image.extension : "";
      actions.append(download(message.image.src, filename ? "下載圖片" : "開啟圖片", filename), dimensions);
    } else if (message.audio) {
      const audio = node("audio");
      audio.src = message.audio;
      audio.controls = true;
      content.append(audio);
      actions.append(download(message.audio, "下載音訊", "iai-speech." + message.extension));
    } else if (message.json) {
      const pre = node("pre");
      pre.append(node("code", "", message.text));
      content.append(pre);
    } else {
      content.append(markdown(message.text));
    }
    if (!message.pending && message.text) {
      const copy = iconButton("copy", "複製回應", async () => {
        try {
          await navigator.clipboard.writeText(message.text);
          copyStatus.textContent = "已複製";
        } catch {
          copyStatus.textContent = "無法存取剪貼簿";
        }
      });
      const copyStatus = node("span");
      copyStatus.setAttribute("role", "status");
      actions.append(copy, copyStatus);
    }
    if (message.note) actions.append(node("span", "", message.note));
    if (Number.isFinite(message.usage?.total_tokens)) {
      actions.append(node("span", "", message.usage.total_tokens + " tokens"));
    }
  };
  body.append(node("span", "message-meta", message.model), content, actions);
  article.append(avatar, body);
  update();
  return { article, update };
}
