import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from langchain.agents import create_agent

from app import BASE_URL, app


def tool_call(index=0):
    return {
        "id": f"call_{index}", "type": "function",
        "function": {"name": "web_search", "arguments": '{"query":"台灣半導體","kind":"news"}'},
    }


def completion(content=None, calls=None):
    message = {"role": "assistant", "content": content}
    if calls:
        message["tool_calls"] = calls
    return httpx.Response(200, json={"choices": [{"message": message}]})


def sse(*deltas):
    chunks = ["data: " + json.dumps({"choices": [{"index": 0, "delta": delta}]}) for delta in deltas]
    return httpx.Response(200, text="\n\n".join([*chunks, "data: [DONE]", ""]),
                          headers={"Content-Type": "text/event-stream"})


class WebAgentTests(unittest.IsolatedAsyncioTestCase):
    async def post(self, prompt, upstream_mock, *, stream=False, web_search=True):
        async with httpx.AsyncClient(base_url=BASE_URL, transport=httpx.MockTransport(upstream_mock)) as upstream:
            app.state.upstream = upstream
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
                return await client.post("/api/chat", headers={"Authorization": "Bearer test-key"}, json={
                    "model": "Furen-omni", "stream": stream, "web_search": web_search,
                    "messages": [{"role": "user", "content": prompt}],
                })

    async def test_simple_request_does_not_search(self):
        def model(request):
            contents = json.loads(request.content)
            self.assertNotIn("tool_choice", contents)
            return completion("你好")

        with patch("playground_agent.search_web", new_callable=AsyncMock) as search:
            response = await self.post("翻譯 hello", model)
            search.assert_not_awaited()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"text": "你好", "usage": None, "sources": []})

    async def test_news_streams_search_progress_then_cited_answer(self):
        call = tool_call() | {"index": 0}

        def model(request):
            self.assertEqual(request.headers["authorization"], "Bearer test-key")
            contents = json.loads(request.content)
            self.assertTrue(contents["stream"])
            if contents["messages"][-1]["role"] == "user":
                self.assertEqual(contents["tool_choice"], "required")
                return sse({"role": "assistant", "content": "暫存"}, {"tool_calls": [call]})
            self.assertNotIn("tool_choice", contents)
            tool_result = contents["messages"][-1]
            self.assertEqual(tool_result["role"], "tool")
            self.assertEqual(tool_result["tool_call_id"], "call_0")
            self.assertEqual([row["id"] for row in json.loads(tool_result["content"])], [1])
            return sse({"role": "assistant", "content": "依據報導 "}, {"content": "[1]。"})

        result = {"url": "https://example.org/news", "title": "<b>報導</b>", "body": "摘要"}
        with patch("playground_agent.search_web", new=AsyncMock(return_value=[result])) as search:
            response = await self.post("今天的新聞", model, stream=True)
            search.assert_awaited_once_with("台灣半導體", "news")
        rows = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual([row["status"] for row in rows if "status" in row], ["正在搜尋網路", "正在整理搜尋結果"])
        answer = ""
        for row in rows:
            if row.get("reset"):
                answer = ""
            answer += row.get("text", "")
        self.assertEqual(answer, "依據報導 [1]。")
        self.assertTrue(rows[-1]["done"])
        self.assertEqual(rows[-1]["sources"], [{"id": 1, "url": result["url"], "title": "報導",
                                               "site": "example.org", "date": ""}])

    async def test_unavailable_search_shows_notice_and_ends_at_call_limit(self):
        rounds = 0

        def model(request):
            nonlocal rounds
            rounds += 1
            body = json.loads(request.content)
            if "tools" in body:
                return completion(calls=[tool_call(rounds)])
            self.assertEqual(rounds, 4)
            return completion("暫時無法查證。")

        with patch("playground_agent.search_web", new=AsyncMock(side_effect=TimeoutError)) as search:
            response = await self.post("上網查今天的新聞", model)
            self.assertEqual(search.await_count, 3)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["sources"], [])
        self.assertEqual(response.json()["notice"], "這次搜尋未取得可引用的來源。")

    async def test_search_off_still_uses_agent_and_streams_without_tools(self):
        def model(request):
            contents = json.loads(request.content)
            self.assertTrue(contents["stream"])
            self.assertNotIn("tools", contents)
            self.assertNotIn("tool_choice", contents)
            return sse({"role": "assistant", "content": "搜尋已關閉。"})

        with patch("playground_agent.create_agent", wraps=create_agent) as factory:
            response = await self.post("今天的新聞", model, stream=True, web_search=False)
            self.assertEqual(factory.call_args.kwargs["tools"], [])
        rows = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual("".join(row.get("text", "") for row in rows), "搜尋已關閉。")
        self.assertEqual(rows[-1], {"done": True, "usage": None})
