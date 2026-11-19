import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from langchain.agents import create_agent

from app import BASE_URL, app
from playground_agent import FOLLOW_UP_SEARCHES, MAX_SEARCHES


def tool_call(index, name, arguments):
    return {
        "id": f"call_{index}", "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
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

    async def test_current_role_question_searches_and_reads_multiple_sources(self):
        call = tool_call(0, "web_search", {"query": "各分校現任校長", "related_queries": ["各分校 人事公告"]}) | {"index": 0}
        follow_up = tool_call(1, "read_sources", {"source_ids": [2], "focus": "現任校長生效日期"}) | {"index": 0}

        def model(request):
            self.assertEqual(request.headers["authorization"], "Bearer test-key")
            contents = json.loads(request.content)
            if not contents.get("stream"):
                self.assertEqual([entry["function"]["name"] for entry in contents["tools"]], ["ResearchAnswer"])
                review = json.loads(contents["messages"][-1]["content"])
                self.assertEqual({source["id"] for source in review["sources"]}, {1, 2})
                self.assertIn("現任校長原文", review["sources"][0]["text"])
                return completion(calls=[tool_call(2, "ResearchAnswer", {
                    "findings": [{"text": "依據資料。", "source_ids": [1, 2]}],
                })])
            results = [message for message in contents["messages"] if message["role"] == "tool"]
            if not results:
                self.assertEqual(contents["tool_choice"], "required")
                self.assertEqual([spec["function"]["name"] for spec in contents["tools"]], ["web_search"])
                return sse({"role": "assistant", "content": "暫存"}, {"tool_calls": [call]})
            if len(results) == 1:
                self.assertEqual(contents["tool_choice"], "required")
                self.assertEqual([spec["function"]["name"] for spec in contents["tools"]], ["read_sources"])
                self.assertEqual(results[0]["tool_call_id"], "call_0")
                evidence = json.loads(results[0]["content"])
                self.assertEqual(len(evidence["searches"]), 2)
                self.assertEqual([page["id"] for page in evidence["opened"]], [1, 3])
                return sse({"role": "assistant", "tool_calls": [follow_up]})
            self.assertNotIn("tool_choice", contents)
            self.assertEqual(results[-1]["tool_call_id"], "call_1")
            self.assertIn("現任校長原文", "".join(row["text"] for row in json.loads(results[-1]["content"])))
            return sse({"role": "assistant", "content": "依據資料 "}, {"content": "[1] [2]。"})

        result = {"url": "https://example.org/news", "title": "<b>報導</b>", "body": "摘要"}
        official = {"url": "https://example.gov.tw/document", "title": "公告", "body": "原始資料"}
        fallback = {"url": "https://example.net/profile", "title": "校務名單"}
        with patch("playground_agent.search_web", new=AsyncMock(side_effect=[[result, fallback], [official]])) as search, patch(
            "playground_agent.read_source", new=AsyncMock(side_effect=lambda url, _focus:
                                                            None if url == official["url"] else (url, "現任校長原文")),
        ) as reader:
            response = await self.post("各分校現任校長是誰？", model, stream=True)
            self.assertEqual([call.args for call in search.await_args_list],
                             [("各分校現任校長", "web"), ("各分校 人事公告", "web")])
            self.assertEqual({call.args[0] for call in reader.await_args_list},
                             {item["url"] for item in (result, official, fallback)})
        rows = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual([row["status"] for row in rows if "status" in row],
                         ["正在規劃查證", "正在搜尋網路", "正在核對搜尋結果", "正在開啟原始來源", "正在核對搜尋結果", "正在核對答覆與原文"])
        answer = ""
        for row in rows:
            if row.get("reset"):
                answer = ""
            answer += row.get("text", "")
        self.assertEqual(answer, "依據資料。 [1] [2]")
        self.assertTrue(rows[-1]["done"])
        self.assertEqual([source["url"] for source in rows[-1]["sources"]], [result["url"], fallback["url"]])

    async def test_unavailable_search_shows_notice_and_ends_at_call_limit(self):
        rounds = 0

        def model(request):
            nonlocal rounds
            rounds += 1
            body = json.loads(request.content)
            if "tools" in body:
                return completion(calls=[tool_call(rounds, "web_search", {"query": f"台灣半導體 {rounds}"})])
            self.assertEqual(rounds, MAX_SEARCHES - FOLLOW_UP_SEARCHES + 1)
            return completion("模型自行提出的未查證結果")

        with patch("playground_agent.search_web", new=AsyncMock(side_effect=TimeoutError)) as search:
            response = await self.post("上網查今天的新聞", model)
            self.assertEqual(search.await_count, MAX_SEARCHES - FOLLOW_UP_SEARCHES)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["sources"], [])
        self.assertIn("未能讀取足以查證", response.json()["text"])

    async def test_drops_unopened_citation(self):
        def model(request):
            body = json.loads(request.content)
            names = [entry["function"]["name"] for entry in body.get("tools", [])]
            if names == ["ResearchAnswer"]:
                return completion(calls=[tool_call(2, "ResearchAnswer", {
                    "findings": [{"text": "推測的版本", "source_ids": [99]}],
                })])
            if names and not any(message["role"] == "tool" for message in body["messages"]):
                return completion(calls=[tool_call(0, "web_search", {"query": "目前版本", "related_queries": ["發布公告"]})])
            return completion("推測的版本 [99]。")

        evidence = [[{"url": "https://example.org/releases"}], [{"url": "https://example.net/releases"}]]
        with patch("playground_agent.search_web", new=AsyncMock(side_effect=evidence)), patch(
            "playground_agent.read_source", new=AsyncMock(side_effect=lambda url, _focus: (url, "發行說明")),
        ):
            response = await self.post("目前的版本是多少", model)
        self.assertIn("未能產生引用原文的查證結果", response.json()["text"])
        self.assertNotIn("[99]", response.json()["text"])

    async def test_review_follows_up_on_missing_information(self):
        def model(request):
            body = json.loads(request.content)
            names = [entry["function"]["name"] for entry in body.get("tools", [])]
            if names == ["ResearchAnswer"]:
                evidence = json.loads(body["messages"][-1]["content"])["sources"]
                verdict = {"findings": [{"text": "現行版本為 2.0。", "source_ids": [1]}]}
                if len(evidence) == 2:
                    verdict.update(unresolved=["生效日期"], follow_up_queries=["版本 2.0 生效公告"])
                else:
                    verdict["findings"].append({"text": "生效日期為 2 月 1 日。", "source_ids": [3]})
                return completion(calls=[tool_call(3, "ResearchAnswer", verdict)])
            if not any(message["role"] == "tool" for message in body["messages"]):
                return completion(calls=[tool_call(0, "web_search", {"query": "現行版本", "related_queries": ["版本公告"]})])
            return completion("現行版本為 2.0。")

        sources = [[{"url": f"https://{domain}/release"}] for domain in ("example.org", "example.net", "example.com")]
        with patch("playground_agent.search_web", new=AsyncMock(side_effect=sources)) as search, patch(
            "playground_agent.read_source", new=AsyncMock(side_effect=lambda url, _focus: (url, "發行原文")),
        ):
            response = await self.post("現行版本和生效日期是什麼，請查證", model)
        search.assert_awaited_with("版本 2.0 生效公告", "web")
        self.assertIn("生效日期為 2 月 1 日。 [3]", response.json()["text"])

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
