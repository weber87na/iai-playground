import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from langchain.agents import create_agent

from app import BASE_URL, app
from playground_agent import MAX_SEARCHES


def tool_call(index=0, query="台灣半導體"):
    return {
        "id": f"call_{index}", "type": "function",
        "function": {"name": "web_search", "arguments": json.dumps({"query": query, "kind": "news"})},
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
        follow_up = tool_call(1, "台灣半導體 股市公告") | {"index": 0}

        def model(request):
            self.assertEqual(request.headers["authorization"], "Bearer test-key")
            contents = json.loads(request.content)
            self.assertTrue(contents["stream"])
            results = [message for message in contents["messages"] if message["role"] == "tool"]
            if not results:
                self.assertEqual(contents["tool_choice"], "required")
                return sse({"role": "assistant", "content": "暫存"}, {"tool_calls": [call]})
            if len(results) == 1:
                self.assertEqual(contents["tool_choice"], "required")
                self.assertEqual(results[0]["tool_call_id"], "call_0")
                self.assertEqual([row["id"] for row in json.loads(results[0]["content"])], [1])
                return sse({"role": "assistant", "tool_calls": [follow_up]})
            self.assertNotIn("tool_choice", contents)
            self.assertEqual(results[-1]["tool_call_id"], "call_1")
            return sse({"role": "assistant", "content": "依據資料 "}, {"content": "[1] [2]。"})

        result = {"url": "https://example.org/news", "title": "<b>報導</b>", "body": "摘要"}
        official = {"url": "https://example.gov.tw/document", "title": "公告", "body": "原始資料"}
        with patch("playground_agent.search_web", new=AsyncMock(side_effect=[[result], [official]])) as search:
            response = await self.post("今天的新聞", model, stream=True)
            self.assertEqual([call.args for call in search.await_args_list],
                             [("台灣半導體", "news"), ("台灣半導體 股市公告", "web")])
        rows = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual([row["status"] for row in rows if "status" in row], ["正在搜尋網路", "正在核對搜尋結果"] * 2)
        answer = ""
        for row in rows:
            if row.get("reset"):
                answer = ""
            answer += row.get("text", "")
        self.assertEqual(answer, "依據資料 [1] [2]。")
        self.assertTrue(rows[-1]["done"])
        self.assertEqual([source["url"] for source in rows[-1]["sources"]], [result["url"], official["url"]])

    async def test_unavailable_search_shows_notice_and_ends_at_call_limit(self):
        rounds = 0

        def model(request):
            nonlocal rounds
            rounds += 1
            body = json.loads(request.content)
            if "tools" in body:
                return completion(calls=[tool_call(rounds, f"台灣半導體 {rounds}")])
            self.assertEqual(rounds, MAX_SEARCHES + 1)
            return completion("模型自行提出的未查證結果")

        with patch("playground_agent.search_web", new=AsyncMock(side_effect=TimeoutError)) as search:
            response = await self.post("上網查今天的新聞", model)
            self.assertEqual(search.await_count, MAX_SEARCHES)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["sources"], [])
        self.assertEqual(response.json()["notice"], "這次搜尋未取得可引用的來源。")
        self.assertIn("找不到足以查證", response.json()["text"])

    async def test_six_city_roster_uses_verified_result_without_model_guess(self):
        def model(_request):
            self.fail("Verified roster must not be rewritten by an LLM")

        evidence = {"text": "依正式公報核對", "sources": [{"id": 1, "url": "https://bulletin.cec.gov.tw/"}]}
        with patch("playground_agent.roster_year", return_value=2026), patch(
            "playground_agent.lookup_roster", new=AsyncMock(return_value=evidence),
        ) as lookup:
            response = await self.post("六都的市長候選人是誰", model)
            lookup.assert_awaited_once_with(2026)
        self.assertEqual(response.json(), {**evidence, "usage": None})

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
