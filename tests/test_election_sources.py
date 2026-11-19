import unittest
from datetime import date
from unittest.mock import patch

from election_sources import CITIES, roster_year, verify_roster


class ElectionSourceTests(unittest.TestCase):
    def test_selects_only_requested_election_year(self):
        today = date(2026, 11, 19)
        self.assertEqual(roster_year("六都的市長候選人是誰", today), 2026)
        self.assertEqual(roster_year("民國115年六都市長候選人名單", date(2027, 1, 1)), 2026)
        self.assertIsNone(roster_year("2022 年六都市長候選人名單", today))
        self.assertIsNone(roster_year("上屆六都市長候選人是誰", today))
        self.assertIsNone(roster_year("六都市長候選人的政見", today))

    def test_candidate_must_match_city_bulletin(self):
        names = ("王小甲", "王小乙", "王小丙", "王小丁", "王小戊", "王小己")
        table = "\n".join(f"{city} 115/09/02 {name} 無" for city, name in zip(CITIES, names, strict=True))
        documents = [table, "王小乙", *names[1:]]
        urls = [f"https://bulletin.cec.gov.tw/{index}.pdf" for index in range(len(CITIES))]
        with patch("election_sources.pdf_text", side_effect=lambda content, limit: content):
            result = verify_roster(2026, "https://www.cec.gov.tw/roster.pdf", urls, documents)
        self.assertNotIn(names[0], result["text"])
        self.assertIn("臺北市**：未能用市選舉公報核實名單", result["text"])
        self.assertIn("新北市**：王小乙（無政黨推薦）", result["text"])
        self.assertEqual(len(result["sources"]), 6)
        self.assertIn("notice", result)
