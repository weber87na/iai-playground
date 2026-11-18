import json
import unittest

import httpx

from app import BASE_URL, app


class SpeechTests(unittest.IsolatedAsyncioTestCase):
    async def synthesize(self, params):
        async def mock(request):
            self.assertEqual(request.url.path, "/aihub/v1/audio/speech")
            data = json.loads(request.content)
            self.assertEqual(data["model"], "Speaker")
            self.assertEqual(data["input"], "你好。")
            if not data.get("voice"):
                return httpx.Response(500, json={"error": "Internal server error"})
            return httpx.Response(
                200, headers={"Content-Type": "audio/mpeg"},
                content=data["voice"].encode(),
            )

        async with httpx.AsyncClient(base_url=BASE_URL, transport=httpx.MockTransport(mock)) as upstream:
            app.state.upstream = upstream
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
                return await client.post(
                    "/api/task/speak", headers={"Authorization": "Bearer test-key"},
                    json={"model": "Speaker", "text": "你好。", **params},
                )

    async def test_default_voice_prevents_speaker_500(self):
        for params in ({}, {"voice": "  "}):
            with self.subTest(params=params):
                response = await self.synthesize(params)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, b"taiwan_girl")

    async def test_explicit_voice_is_forwarded(self):
        response = await self.synthesize({"voice": "custom_voice"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"custom_voice")
