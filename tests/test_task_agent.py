import json
import unittest
from unittest.mock import patch

import httpx
from langchain.agents import create_agent

from app import BASE_URL, app


class TaskAgentTests(unittest.IsolatedAsyncioTestCase):
    async def post(self, route, transport, **kwargs):
        async with httpx.AsyncClient(base_url=BASE_URL, transport=httpx.MockTransport(transport)) as upstream:
            app.state.upstream = upstream
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
                return await client.post(route, headers={"Authorization": "Bearer test-key"}, **kwargs)

    async def test_workspace_dispatches_once_to_matching_iai_tool(self):
        cases = [
            ("image", "images/generations", {"model": "Pic-large", "text": "city", "size": "1024x1024"},
             {"model": "Pic-large", "prompt": "city", "n": 1, "size": "1024x1024"}),
            ("embed", "embeddings", {"model": "Embedding", "text": "city"},
             {"model": "Embedding", "input": "city", "encoding_format": "float"}),
            ("rerank", "rerank", {"model": "Furen-reranker", "text": "city", "documents": ["A"], "top_n": 1},
             {"model": "Furen-reranker", "query": "city", "documents": ["A"], "top_n": 1}),
        ]
        for operation, route, payload, expected in cases:
            with self.subTest(operation=operation):
                calls = []

                def upstream(request):
                    calls.append(request.url.path)
                    self.assertEqual(json.loads(request.content), expected)
                    header = "x-litellm-api-key" if operation == "rerank" else "authorization"
                    self.assertEqual(request.headers[header], "Bearer test-key")
                    return httpx.Response(200, json={"data": [{"result": operation}]})

                with patch("playground_agent.create_agent", wraps=create_agent) as factory:
                    response = await self.post(f"/api/task/{operation}", upstream, json=payload)
                    self.assertEqual([tool.name for tool in factory.call_args.kwargs["tools"]], [f"iai_{operation}"])
                self.assertEqual(calls, [f"/aihub/v1/{route}"])
                self.assertEqual(response.json(), {"data": [{"result": operation}]})

    async def test_transcription_returns_tool_result_and_propagates_rate_limit(self):
        async def upstream(request):
            self.assertEqual(request.url.path, "/aihub/v1/audio/transcriptions")
            self.assertIn(b'name="file"; filename="recording.wav"', await request.aread())
            return httpx.Response(status, json=result)

        for status, result in [(200, {"text": "你好"}), (429, {"error": "limit"})]:
            with self.subTest(status=status):
                response = await self.post("/api/upload/transcribe", upstream,
                                           data={"model": "Asr", "language": "zh"},
                                           files={"file": ("recording.wav", b"test", "audio/wav")})
                self.assertEqual(response.status_code, status)
                if status == 200:
                    self.assertEqual(response.json(), result)
                else:
                    self.assertIn("速率限制", response.json()["detail"])

    async def test_enhancement_runs_agent_with_editing_prompt_and_no_search_tools(self):
        def upstream(request):
            self.assertEqual(request.url.path, "/aihub/v1/chat/completions")
            body = json.loads(request.content)
            self.assertNotIn("tools", body)
            system, user = body["messages"]
            self.assertEqual(system["role"], "system")
            self.assertIn("你是提示詞編輯", system["content"])
            self.assertEqual(json.loads(user["content"])["draft_prompt"], "查今天的新聞")
            return httpx.Response(200, json={"choices": [
                {"message": {"role": "assistant", "content": " 請整理今天的三則重點新聞。 "}},
            ]})

        with patch("playground_agent.create_agent", wraps=create_agent) as factory:
            response = await self.post("/api/prompt/enhance", upstream,
                                       json={"model": "Furen-max", "mode": "chat", "text": "查今天的新聞"})
            self.assertEqual(factory.call_args.kwargs["tools"], [])
        self.assertEqual(response.json(), {"model": "Furen-max", "text": "請整理今天的三則重點新聞。"})
