import asyncio
import http.client
import ipaddress
import re
import socket
import ssl
from contextlib import closing
from html.parser import HTMLParser
from urllib.parse import quote, urljoin, urlsplit

import pypdfium2 as pdfium

from attachments import PDF_LOCK


MAX_BYTES = 6 * 1024 * 1024
MAX_TEXT = 9_000
SOCKET_TIMEOUT = 5
TLS_CONTEXT = ssl.create_default_context()
SKIP_TAGS = {"script", "style", "nav", "footer", "template", "svg", "noscript"}
BLOCK_TAGS = {"h1", "h2", "h3", "h4", "p", "div", "section", "article", "li", "br", "tr", "td", "th"}
AZURE_PLATFORM_IP = ipaddress.ip_address("168.63.129.16")
TRANSLATION_NETWORKS = tuple(ipaddress.ip_network(value) for value in ("64:ff9b::/96", "64:ff9b:1::/48"))


class PageText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skipped = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self.skipped.append(tag)
        elif not self.skipped and tag in BLOCK_TAGS:
            self.parts.append("\n")
        elif not self.skipped and tag in {"img", "meta"}:
            fields = dict(attrs)
            if tag == "img":
                label = fields.get("alt")
            else:
                kind = fields.get("property") or fields.get("name")
                label = fields.get("content") if kind in {"og:title", "description", "og:description"} else None
            if label:
                self.parts.extend(("\n", label, "\n"))

    def handle_endtag(self, tag):
        if self.skipped and self.skipped[-1] == tag:
            self.skipped.pop()
        elif not self.skipped and tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skipped:
            self.parts.append(data)


def public_address(host, port):
    addresses = {row[4][0] for row in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)}
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global or ip.is_multicast or "%" in address or ip == AZURE_PLATFORM_IP:
            raise ValueError("Source host did not resolve to public addresses")
        if isinstance(ip, ipaddress.IPv6Address) and (
            ip.ipv4_mapped or ip.sixtofour or ip.teredo or any(ip in network for network in TRANSLATION_NETWORKS)
        ):
            raise ValueError("Source used an IPv6 address translation range")
    if not addresses:
        raise ValueError("Source host has no addresses")
    return min(addresses, key=lambda address: (":" in address, address))


def fetch_page(url):
    for _ in range(3):
        if len(url) > 2048 or re.search(r"[\s\\\x00-\x1f\x7f]", url):
            raise ValueError("Invalid source URL")
        parts = urlsplit(url)
        port = 443 if parts.scheme == "https" else 80
        if (parts.scheme not in {"https", "http"} or not parts.hostname or parts.username is not None
                or parts.port not in {None, port}):
            raise ValueError("Source must be a public HTTP or HTTPS page")
        host = parts.hostname.encode("idna").decode("ascii")
        address = public_address(host, port)
        path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
        if parts.query:
            path += "?" + quote(parts.query, safe="%/?:@!$&'()*+,;=-._~")
        with closing(http.client.HTTPConnection(host, port=port, timeout=SOCKET_TIMEOUT)) as connection:
            # Connect to the checked address while retaining the original HTTP host and TLS identity.
            connection.sock = socket.create_connection((address, port), timeout=SOCKET_TIMEOUT)
            if parts.scheme == "https":
                connection.sock = TLS_CONTEXT.wrap_socket(connection.sock, server_hostname=host)
            connection.request("GET", path, headers={"User-Agent": "iAI Playground Source Reader/1.0",
                                                     "Accept": "text/html,application/pdf,text/plain",
                                                     "Accept-Encoding": "identity"})
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308} and (location := response.getheader("Location")):
                url = urljoin(url, location)
                continue
            mime = response.headers.get_content_type()
            if response.status != 200 or mime not in {"text/html", "application/xhtml+xml", "application/pdf", "text/plain"}:
                raise ValueError("Source page is unavailable or has an unsupported format")
            declared = response.getheader("Content-Length", "")
            if declared.isdecimal() and int(declared) > MAX_BYTES:
                raise ValueError("Source response is too large")
            content = response.read(MAX_BYTES + 1)
            if len(content) > MAX_BYTES:
                raise ValueError("Source response is too large")
            return url, content, mime, response.headers.get_content_charset()
    raise ValueError("Source redirected too many times")


def page_text(content, mime, encoding):
    if mime == "application/pdf":
        lines = []
        with PDF_LOCK, pdfium.PdfDocument(content) as document:
            for index in range(min(len(document), 8)):
                with closing(document[index]) as page, closing(page.get_textpage()) as text:
                    lines.append(text.get_text_bounded())
        return "\n".join(lines)
    try:
        text = content.decode(encoding or "utf-8", errors="replace")
    except LookupError:
        text = content.decode("utf-8", errors="replace")
    if mime == "text/plain":
        return text
    parser = PageText()
    parser.feed(text)
    parser.close()
    return "".join(parser.parts)


def extract_passages(text, focus):
    lines = [" ".join(line.split())[:1800] for line in text.splitlines() if line.strip()]
    if not lines:
        return ""
    page = "\n".join(lines)
    if len(page) <= MAX_TEXT:
        return page
    words = set(re.findall(r"[a-z0-9]{3,}|[\u3400-\u9fff]{2,}", focus.casefold()))
    terms = set()
    for word in words:
        if word.isascii():
            terms.add(word)
        else:
            terms.update(word[index:index + 2] for index in range(len(word) - 1))
    scores = [sum(term in line.casefold() for term in terms) for line in lines]
    hits = sorted(range(len(lines)), key=lambda index: (-scores[index], index))[:24]
    relevant = {near for index in hits if scores[index] for near in range(max(0, index - 1), min(index + 2, len(lines)))}
    if not relevant:
        return page[:MAX_TEXT]
    excerpt = "\n".join(lines[index] for index in sorted(relevant))
    return ("\n".join(lines[:8]) + "\n[…]\n" + excerpt)[:MAX_TEXT]


def read_page(url, focus):
    final_url, content, mime, encoding = fetch_page(url)
    return final_url, extract_passages(page_text(content, mime, encoding), focus)


async def read_source(url, focus):
    try:
        return await asyncio.wait_for(asyncio.to_thread(read_page, url, focus), timeout=13)
    except (OSError, http.client.HTTPException, TimeoutError, ValueError, pdfium.PdfiumError):
        return None
