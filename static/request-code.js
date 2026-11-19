const psQuote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => JSON.stringify(value, null, 2);
const extensionFor = (body) => body.response_format === "wav" ? "wav" : "mp3";
const isImageRequest = (mode) => mode === "image" || mode === "edit";

function formParts(body) {
  const entries = Array.from(body);
  const multipleFiles = entries.filter(([, value]) => typeof value !== "string").length > 1;
  let fileNumber = 0;
  return entries.map(([field, value]) => {
    if (typeof value === "string") return { field, value };
    fileNumber++;
    const original = value.name.replace(/[\r\n\0]/g, "_");
    const filename = original.replace(/[<>:"/\\|?*]/g, "_");
    const local = "./" + (multipleFiles ? fileNumber + "-" : "") + filename;
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(value.type) ? value.type : "application/octet-stream";
    return { field, file: { original, local, mime } };
  });
}

const curlQuotedPart = (value) => '"' + value.replace(/[\\"]/g, "\\$&") + '"';

function curlRequest(packet, base, { output, bodyExpression = "$requestBody", capture } = {}) {
  const url = psQuote(base + "/api/" + packet.path);
  const command = ["curl.exe --silent --show-error --fail-with-body --no-buffer --max-time 330",
    '--header "Authorization: Bearer $env:IAI_API_KEY"'];
  let prefix = "";
  let formSetup = "";
  if (packet.body instanceof FormData) {
    const args = [];
    for (const { field, value, file } of formParts(packet.body)) {
      if (file) {
        args.push("--form", field + "=@" + curlQuotedPart(file.local)
          + ";filename=" + curlQuotedPart(file.original) + ";type=" + file.mime);
      } else {
        args.push("--form-string", field + "=" + value);
      }
    }
    formSetup = "$formArgs = @'\n" + json(args) + "\n'@ | ConvertFrom-Json\n";
    command.push("@formArgs");
  } else {
    command.push("--header 'Content-Type: application/json'", "--data-binary '@-'");
    prefix = bodyExpression + " | ";
  }
  if (output) command.push("--output " + psQuote(output));
  command.push(url);
  const run = command.join(" " + String.fromCharCode(96) + "\n  ");
  return formSetup + (capture ? capture + " = " : "") + prefix + run;
}

function psBody(body) {
  return "$requestBody = @'\n" + json(body) + "\n'@";
}

function curlCode(request, base) {
  const lines = [
    "if (-not $env:IAI_API_KEY) { throw 'Set IAI_API_KEY before running this example.' }",
    "",
  ];
  if (request.brief) {
    if (!(request.brief.body instanceof FormData)) lines.push(psBody(request.brief.body));
    lines.push(curlRequest(request.brief, base, { capture: "$briefResult" }));
    lines.push("if ($LASTEXITCODE -ne 0) { throw 'Prompt preparation failed.' }");
    lines.push("$brief = ($briefResult | ConvertFrom-Json).text.Trim()");
    lines.push("if (-not $brief) { throw 'The prompt was empty.' }");
    lines.push("$brief = $brief.Substring(0, [Math]::Min($brief.Length, 2400))", "");
  }
  const image = isImageRequest(request.mode);
  const output = image ? "iai-image-response.json" :
    request.mode === "speak" ? "iai-speech." + extensionFor(request.body) : undefined;
  if (!(request.body instanceof FormData)) lines.push(psBody(request.body));
  if (request.brief) {
    lines.push("$imageBody = $requestBody | ConvertFrom-Json", "$imageBody.text = $brief", "");
  }
  lines.push(curlRequest(request, base, {
    output, bodyExpression: request.brief ? "$imageBody | ConvertTo-Json -Depth 20 -Compress" : undefined,
  }));
  lines.push("if ($LASTEXITCODE -ne 0) { throw 'Playground request failed.' }");
  if (image) {
    lines.push("", "$image = (Get-Content -Raw -Encoding utf8 'iai-image-response.json' | ConvertFrom-Json).data[0]",
      "if ($image.b64_json) {",
      "    $extension = switch -Regex ($image.b64_json) {",
      "        '^iVBOR' { 'png' }",
      "        '^/9j/' { 'jpeg' }",
      "        '^UklGR' { 'webp' }",
      "        '^R0lGOD' { 'gif' }",
      "        default { 'bin' }",
      "    }",
      "    [IO.File]::WriteAllBytes((Join-Path (Get-Location) ('iai-image.' + $extension)), [Convert]::FromBase64String($image.b64_json))",
      "} else {",
      "    $image.url",
      "}");
  }
  return lines.join("\n");
}

function pythonLiteral(value, depth = 0) {
  const indent = "    ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return "[\n" + value.map((item) => indent + pythonLiteral(item, depth + 1) + ",").join("\n")
      + "\n" + "    ".repeat(depth) + "]";
  }
  if (value && typeof value === "object") {
    const items = Object.entries(value);
    if (!items.length) return "{}";
    return "{\n" + items.map(([key, item]) => indent + JSON.stringify(key) + ": " + pythonLiteral(item, depth + 1) + ",").join("\n")
      + "\n" + "    ".repeat(depth) + "}";
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null) return "None";
  return JSON.stringify(value);
}

function pythonRequest(packet, response, bodyVariable) {
  const address = "base_url + " + JSON.stringify("/api/" + packet.path);
  const lines = [];
  if (packet.body instanceof FormData) {
    const parts = formParts(packet.body);
    const fields = Object.fromEntries(parts.filter((part) => !part.file).map(({ field, value }) => [field, value]));
    lines.push("data = " + pythonLiteral(fields), "files = [");
    for (const { field, file } of parts) {
      if (!file) continue;
      lines.push("    (" + json(field) + ", (" + json(file.original) + ", Path(" + json(file.local)
        + ").read_bytes(), " + json(file.mime) + ")),");
    }
    lines.push("]", response + " = client.post(" + address + ", data=data, files=files)");
  } else {
    if (!bodyVariable) {
      bodyVariable = "payload";
      lines.push(bodyVariable + " = " + pythonLiteral(packet.body));
    }
    lines.push(response + " = client.post(" + address + ", json=" + bodyVariable + ")");
  }
  lines.push(response + ".raise_for_status()");
  return lines.join("\n");
}

function pythonCode(request, base) {
  const image = isImageRequest(request.mode);
  const audio = request.mode === "speak";
  const needsFiles = request.body instanceof FormData || request.brief?.body instanceof FormData;
  const lines = ["# pip install httpx"];
  if (image) lines.push("import base64");
  if (!image && !audio) lines.push("import json");
  lines.push("import os");
  if (image || audio || needsFiles) lines.push("from pathlib import Path");
  lines.push("", "import httpx", "", "base_url = " + json(base),
    'headers = {"Authorization": "Bearer " + os.environ["IAI_API_KEY"]}',
    "with httpx.Client(headers=headers, timeout=330) as client:");
  const run = [];
  if (request.brief) {
    run.push(pythonRequest(request.brief, "brief_response"));
    run.push('brief = brief_response.json()["text"].strip()[:2400]',
      'if not brief:', '    raise ValueError("The prompt was empty.")',
      "payload = " + pythonLiteral(request.body), 'payload["text"] = brief');
  }
  run.push(pythonRequest(request, "response", request.brief ? "payload" : undefined));
  lines.push(...run.join("\n").split("\n").map((line) => "    " + line));
  lines.push("");
  if (image) {
    lines.push('image = response.json()["data"][0]', 'if image.get("b64_json"):',
      '    encoded = image["b64_json"]',
      '    formats = {"iVBOR": "png", "/9j/": "jpeg", "UklGR": "webp", "R0lGOD": "gif"}',
      '    extension = next((ext for prefix, ext in formats.items() if encoded.startswith(prefix)), "bin")',
      '    Path("iai-image." + extension).write_bytes(base64.b64decode(encoded))',
      "else:", '    print(image["url"])');
  } else if (audio) {
    lines.push('content_type = response.headers.get("content-type", "").partition(";")[0]',
      'formats = {"audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/mp4": "m4a"}',
      'Path("iai-speech." + formats.get(content_type, "audio")).write_bytes(response.content)');
  } else if (request.mode === "chat") {
    lines.push('if "application/x-ndjson" in response.headers.get("content-type", ""):',
      '    for line in response.iter_lines():', '        if not line.strip():', '            continue',
      '        chunk = json.loads(line)', '        if chunk.get("error"):', '            raise RuntimeError(chunk["error"])',
      '        print(chunk.get("text", ""), end="")', '    print()',
      'else:', '    print(response.json()["text"])');
  } else {
    lines.push("print(json.dumps(response.json(), ensure_ascii=False, indent=2))");
  }
  return lines.join("\n");
}

export function renderRequestCode(request, language, base) {
  return language === "python" ? pythonCode(request, base) : curlCode(request, base);
}
