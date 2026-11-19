import json
import unittest
from email import policy
from email.parser import BytesParser
from io import BytesIO

import httpx
from PIL import Image

from app import BASE_URL, app


def png(color):
    with BytesIO() as buffer, Image.new("RGB", (24, 24), color) as image:
        image.save(buffer, "PNG")
        return buffer.getvalue()


class AttachmentTests(unittest.IsolatedAsyncioTestCase):
    async def post(self, path, data, files, mock):
        async with httpx.AsyncClient(base_url=BASE_URL, transport=httpx.MockTransport(mock)) as upstream:
            app.state.upstream = upstream
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
                return await client.post(path, headers={"Authorization": "Bearer test-key"},
                                         data=data, files=files)

    async def test_multiple_turns_keep_separate_attachment_context(self):
        async def mock(request):
            self.assertEqual(request.url.path, "/aihub/v1/chat/completions")
            body = json.loads(request.content)
            self.assertEqual(body["tools"][0]["function"]["name"], "web_search")
            system, *messages = body["messages"]
            self.assertEqual(system["role"], "system")
            first = messages[0]["content"]
            latest = messages[2]["content"]
            self.assertEqual(first[0]["text"], "First")
            self.assertEqual([part["text"] for part in first[1:]], ["附件：older.txt", "older contents"])
            self.assertEqual(messages[1]["content"], "Answer")
            self.assertEqual(latest[0]["text"], "Latest")
            self.assertEqual([part["text"] for part in latest[1:]], ["附件：latest.txt", "current contents"])
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "Both received"}}]})

        payload = {
            "model": "Furen-omni",
            "messages": [{"role": "user", "content": "First"}, {"role": "assistant", "content": "Answer"},
                         {"role": "user", "content": "Latest"}],
            "attachment_indices": [2, 0],
        }
        files = [("file", ("latest.txt", b"current contents", "text/plain")),
                 ("file", ("older.txt", b"older contents", "text/plain"))]
        response = await self.post("/api/chat/attachments", {"payload": json.dumps(payload)}, files, mock)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "Both received")

    async def test_previous_single_index_requests_still_work(self):
        async def mock(request):
            body = json.loads(request.content)
            self.assertNotIn("tools", body)
            self.assertNotIn("web_search", body)
            content = body["messages"][0]["content"]
            self.assertEqual([part["text"] for part in content[::2]], ["Read files", "A", "B"])
            return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})

        payload = {"model": "Furen-omni", "messages": [{"role": "user", "content": "Read files"}],
                   "attachment_index": 0, "web_search": False}
        files = [("file", ("a.txt", b"A", "text/plain")), ("file", ("b.txt", b"B", "text/plain"))]
        response = await self.post("/api/chat/attachments", {"payload": json.dumps(payload)}, files, mock)
        self.assertEqual(response.status_code, 200)

    async def test_multi_image_edit_sends_a_single_numbered_sheet(self):
        async def mock(request):
            self.assertEqual(request.url.path, "/aihub/v1/images/edits")
            prefix = b"Content-Type: " + request.headers["Content-Type"].encode() + b"\r\n\r\n"
            form = BytesParser(policy=policy.default).parsebytes(prefix + await request.aread())
            fields = {part.get_param("name", header="content-disposition"): part for part in form.iter_parts()}
            self.assertEqual(fields["image"].get_filename(), "reference-sheet.png")
            self.assertIn("參考圖 1", fields["prompt"].get_payload(decode=True).decode())
            with Image.open(BytesIO(fields["image"].get_payload(decode=True))) as sheet:
                width, height = sheet.size
                self.assertEqual(sheet.getpixel((width // 4, (height + 38) // 2)), (255, 0, 0))
                self.assertEqual(sheet.getpixel((width * 3 // 4, (height + 38) // 2)), (0, 0, 255))
            return httpx.Response(200, json={"data": [{"url": "https://example.com/image.png"}]})

        files = [("file", ("red.png", png("red"), "image/png")),
                 ("file", ("blue.png", png("blue"), "image/png"))]
        response = await self.post("/api/upload/edit", {"model": "Pic-large", "prompt": "Use both."}, files, mock)
        self.assertEqual(response.status_code, 200)
