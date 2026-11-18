import base64
from collections.abc import Iterator
from contextlib import closing
from io import BytesIO
from pathlib import PurePosixPath
from threading import Lock

import pypdfium2 as pdfium
from PIL import Image, ImageOps, UnidentifiedImageError
from pypdfium2 import raw as pdfium_raw


MAX_ATTACHMENTS = 4
MAX_DOCUMENT_PAGES = 30
MAX_TEXT_LENGTH = 60_000
MAX_VISUALS = 6
IMAGE_FORMATS = ("PNG", "JPEG", "WEBP")
TEXT_EXTENSIONS = {".txt", ".md", ".markdown", ".csv"}
PDF_LOCK = Lock()


class AttachmentError(ValueError):
    pass


def text_part(text):
    return {"type": "text", "text": text}


def attachment_kind(filename, content_type):
    suffix = PurePosixPath(filename).suffix.lower()
    if suffix == ".pdf" or content_type == "application/pdf":
        return "pdf"
    if suffix in TEXT_EXTENSIONS or content_type in {"text/plain", "text/markdown", "text/csv"}:
        return "text"
    if suffix in {".png", ".jpg", ".jpeg", ".webp"} or content_type in {
        "image/png", "image/jpeg", "image/webp",
    }:
        return "image"
    raise AttachmentError("附件請使用 PNG、JPEG、WebP、PDF、TXT、Markdown 或 CSV。")


def visual_part(image):
    with image.convert("RGBA") as rgba:
        with Image.new("RGB", rgba.size, "white") as rgb:
            rgb.paste(rgba, mask=rgba.getchannel("A"))
            with BytesIO() as output:
                rgb.save(output, format="JPEG", quality=90)
                encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded}"}}


def read_image(data):
    try:
        with Image.open(BytesIO(data), formats=IMAGE_FORMATS) as source:
            if source.width * source.height > 32_000_000:
                raise AttachmentError("圖片解析度過大。請先縮小圖片。")
            with ImageOps.exif_transpose(source) as image:
                image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
                return visual_part(image)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as exc:
        raise AttachmentError("無法讀取圖片。請確認檔案格式及內容。") from exc


def has_visuals(page):
    types = (pdfium_raw.FPDF_PAGEOBJ_IMAGE, pdfium_raw.FPDF_PAGEOBJ_PATH)
    paths = 0
    for obj in page.get_objects(filter=types):
        if obj.type == pdfium_raw.FPDF_PAGEOBJ_IMAGE:
            return True
        paths += 1
        if paths >= 8:
            return True
    return False


def pdf_parts(data, remaining_pages, remaining_visuals) -> Iterator[tuple[str, dict]]:
    # PDFium calls must be serialized, including native handle cleanup.
    with PDF_LOCK:
        try:
            with pdfium.PdfDocument(data) as pdf:
                if not len(pdf):
                    raise AttachmentError("PDF 裡沒有頁面。")
                if len(pdf) > remaining_pages:
                    raise AttachmentError(f"PDF 合計最多 {MAX_DOCUMENT_PAGES} 頁。請分批上傳所需頁面。")
                for index in range(len(pdf)):
                    page = pdf[index]
                    try:
                        text_page = page.get_textpage()
                        try:
                            text = text_page.get_text_bounded().strip()
                        finally:
                            text_page.close()
                        yield "page", text_part(f"第 {index + 1} 頁\n{text}")
                        if len("".join(text.split())) < 32 or has_visuals(page):
                            if remaining_visuals <= 0:
                                raise AttachmentError(f"每次最多可讀取 {MAX_VISUALS} 張圖片或含圖 PDF 頁面，請分批送出。")
                            remaining_visuals -= 1
                            longest_side = max(page.get_size())
                            bitmap = page.render(scale=1600 / longest_side)
                            try:
                                with bitmap.to_pil() as image:
                                    yield "visual", visual_part(image)
                            finally:
                                bitmap.close()
                    finally:
                        page.close()
        except (pdfium.PdfiumError, ValueError, OSError) as exc:
            if isinstance(exc, AttachmentError):
                raise
            raise AttachmentError("無法讀取 PDF。請確認檔案完整且已解除密碼保護。") from exc


def attachment_parts(files):
    parts = []
    remaining_pages = MAX_DOCUMENT_PAGES
    remaining_visuals = MAX_VISUALS
    remaining_text = MAX_TEXT_LENGTH
    for filename, content_type, data in files:
        safe_name = PurePosixPath(filename.replace("\\", "/")).name[:180]
        kind = attachment_kind(safe_name, content_type)
        parts.append(text_part(f"附件：{safe_name}"))
        if kind == "image":
            if remaining_visuals <= 0:
                raise AttachmentError(f"每次最多可讀取 {MAX_VISUALS} 張圖片或含圖 PDF 頁面，請分批送出。")
            remaining_visuals -= 1
            parts.append(read_image(data))
        elif kind == "pdf":
            # Close the generator even when a later size check stops iteration.
            with closing(pdf_parts(data, remaining_pages, remaining_visuals)) as pages:
                for part_kind, part in pages:
                    if part_kind == "page":
                        remaining_pages -= 1
                        remaining_text -= len(part["text"])
                    else:
                        remaining_visuals -= 1
                    if remaining_text < 0:
                        raise AttachmentError("附件文字過長。請分批上傳需要的內容。")
                    parts.append(part)
        else:
            try:
                text = data.decode("utf-8-sig").strip()
            except UnicodeDecodeError as exc:
                raise AttachmentError("文字附件請使用 UTF-8 編碼。") from exc
            if not text or "\0" in text:
                raise AttachmentError("文字附件沒有可讀取的內容。")
            remaining_text -= len(text)
            if remaining_text < 0:
                raise AttachmentError("附件文字過長。請分批上傳需要的內容。")
            parts.append(text_part(text))
    return parts
