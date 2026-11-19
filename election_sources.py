import asyncio
import re
import unicodedata
from contextlib import closing
from datetime import date
from time import monotonic

import httpx
import pypdfium2 as pdfium

from attachments import PDF_LOCK


CITIES = ("臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市")
ROSTERS = {
    2026: (date(2026, 11, 12), "https://www.cec.gov.tw/api/file/bb9a8d7a-9b8a-41ec-8e23-33efd009385a.pdf"),
}
BULLETIN_ROOT = "https://bulletin.cec.gov.tw/01選舉公報/03直轄市長"
MAX_BULLETIN_BYTES = 12 * 1024 * 1024
ROSTER_CACHE_SECONDS = 300
roster_cache = {}
roster_lock = asyncio.Lock()
ROSTER_REQUEST = re.compile(r"(?:六都|六[個大]直轄市|直轄市).{0,28}市長.{0,18}(?:候選人|參選人|名單)")
OTHER_REQUEST = re.compile(r"上屆|上次|前屆|歷屆|下屆|下一屆|補選|政見|選情|選舉結果|誰會|誰贏|可能|提名|初選|翻譯|改寫")
YEARS = re.compile(r"(?<!\d)(20\d{2})(?!\d)|(?<!\d)(\d{3})\s*年")


def roster_year(prompt, today):
    if not ROSTER_REQUEST.search(prompt) or OTHER_REQUEST.search(prompt):
        return None
    years = {int(ce) if ce else int(roc) + 1911 for ce, roc in YEARS.findall(prompt)}
    if len(years) > 1:
        return None
    year = next(iter(years), today.year)
    if year in ROSTERS and today >= ROSTERS[year][0]:
        return year
    return None


async def get_pdf(client, url):
    try:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            if not response.headers.get("content-type", "").startswith("application/pdf"):
                return None
            content = bytearray()
            async for chunk in response.aiter_bytes():
                if len(content) + len(chunk) > MAX_BULLETIN_BYTES:
                    return None
                content.extend(chunk)
            return bytes(content)
    except httpx.HTTPError:
        return None


def pdf_text(content, limit):
    if content is None:
        return ""
    parts = []
    try:
        with PDF_LOCK, pdfium.PdfDocument(content) as document:
            for index in range(min(len(document), limit)):
                with closing(document[index]) as page, closing(page.get_textpage()) as text:
                    parts.append(text.get_text_bounded())
    except (pdfium.PdfiumError, ValueError):
        return ""
    return unicodedata.normalize("NFKC", "\n".join(parts))


def matches_candidate_row(name, bulletin):
    spaced_name = r"[^\S\n]*".join(map(re.escape, name))
    return bool(re.search(rf"(?m)^[^\S\n]*(?:\d{{1,2}}[.、 ]*)?{spaced_name}(?:\s|$)", bulletin))


def verify_roster(year, summary_url, bulletin_urls, documents):
    records = {city: [] for city in CITIES}
    city_names = "|".join(CITIES)
    pattern = rf"(?m)^\s*({city_names})\s+{year - 1911}/\d{{2}}/\d{{2}}\s+([\u3400-\u9fff]{{2,8}})\s+([^\s]+)"
    for city, name, party in re.findall(pattern, pdf_text(documents[0], 4)):
        records[city].append((name, party))
    if any(not rows for rows in records.values()):
        return None

    sources = [{"id": 1, "title": "直轄市長選舉候選人登記彙總表", "url": summary_url, "site": "中央選舉委員會"}]
    lines = []
    incomplete = False
    verified = 0
    for city, url, content in zip(CITIES, bulletin_urls, documents[1:], strict=True):
        bulletin = pdf_text(content, 2)
        matching = [(name, party) for name, party in records[city] if matches_candidate_row(name, bulletin)]
        line = f"- **{city}**："
        if matching:
            number = len(sources) + 1
            sources.append({"id": number, "title": f"{city}市長選舉公報", "url": str(httpx.URL(url)),
                            "site": "中央選舉委員會公報資料庫"})
            line += "、".join(f"{name}（{party if party != '無' else '無政黨推薦'}）" for name, party in matching)
            line += f" [{number}]"
        if len(matching) != len(records[city]):
            line += "。其餘登記資料未能用市選舉公報核實。" if matching else "未能用市選舉公報核實名單。"
            incomplete = True
        verified += len(matching)
        lines.append(line)
    if not verified:
        return None
    result = {"text": f"**{year} 年六都市長候選人**\n\n依中選會登記彙總表 [1] 與各市選舉公報逐城核對，確認 {verified} 人。\n\n"
                      + "\n".join(lines), "sources": sources}
    if incomplete:
        result["notice"] = "有些登記資料未能與選舉公報對上，請參考當地選舉委員會最新公告。"
    return result


async def lookup_roster(year):
    async with roster_lock:
        cached = roster_cache.get(year)
        if cached and cached[0] > monotonic():
            return cached[1]
        summary_url = ROSTERS[year][1]
        bulletin_urls = [f"{BULLETIN_ROOT}/{year - 1911}年/{city}市長.pdf" for city in CITIES]
        try:
            async with asyncio.timeout(22), httpx.AsyncClient(timeout=12, trust_env=False) as client:
                documents = await asyncio.gather(*(get_pdf(client, url) for url in [summary_url, *bulletin_urls]))
        except TimeoutError:
            return None
        result = await asyncio.to_thread(verify_roster, year, summary_url, bulletin_urls, documents)
        if result and "notice" not in result:
            roster_cache[year] = (monotonic() + ROSTER_CACHE_SECONDS, result)
        return result
