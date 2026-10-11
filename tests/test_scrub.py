#!/usr/bin/env python3
"""_scrub.py — the one helper that cleans text taken from outside systems (Dynatrace error messages and log lines,
a Jenkins console tail) before it is stored in data.json, shown on a card or handed to an AI model.

Nothing here touches the network; every secret in these tests is invented."""
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "jira-intern"))
import _scrub  # noqa: E402

JWT = ".".join(["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"])
DT_TOKEN = ".".join(["dt0s01", "ABCDEFGH12345678", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"])
AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"
GH_TOKEN = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789"
SLACK_TOKEN = "xoxb-" + "123456789012" + "-" + "abcdefghijklmnop"
GL_TOKEN = "glpat-" + "abcdefghij0123456789"
NPM_TOKEN = "npm_" + "abcdefghijklmnopqrstuvwxyz0123456789"
SK_TOKEN = "sk-" + "abcdefghij0123456789ABCD"
GOOGLE_KEY = "AIza" + "SyA-abcdefghijklmnopqrstuvwxyz01234567"


class Secrets(unittest.TestCase):
    def gone(self, raw, *secrets):
        out = _scrub.text(raw)
        for s in secrets:
            self.assertNotIn(s, out, f"{s!r} survived in {out!r}")
        return out

    def test_authorization_headers_and_bearer_strings(self):
        out = self.gone("> Authorization: Bearer abc123def456ghi789\n> authorization: Basic dXNlcjpwYXNz", "abc123def456ghi789", "dXNlcjpwYXNz")
        self.assertIn("Authorization: •••", out)
        self.assertEqual(self.gone("sent Bearer tok_ABCDEFGHIJ0123 to the gateway", "tok_ABCDEFGHIJ0123"), "sent Bearer ••• to the gateway")

    def test_key_value_secrets_of_every_common_spelling(self):
        raw = ("password=hunter2hunter2 secret: s3cr3t-value token=\"quoted tok 12\" api_key=AKxyz12345 "
               "AWS_SECRET_ACCESS_KEY=abcdEFGH1234 client-secret = zzTop99 -Dpasswd=swordfish")
        out = self.gone(raw, "hunter2hunter2", "s3cr3t-value", "quoted tok 12", "AKxyz12345", "abcdEFGH1234", "zzTop99", "swordfish")
        self.assertIn("password=•••", out)
        self.assertIn("AWS_SECRET_ACCESS_KEY=•••", out)

    def test_urls_with_credentials_and_sensitive_query_parameters(self):
        out = self.gone("git clone https://deploy:p4ssw0rd@git.example.com/org/repo.git", "p4ssw0rd", "deploy:")
        self.assertIn("https://•••@git.example.com/org/repo.git", out)
        out = self.gone("GET https://api.example.com/v1/items?id=7&access_token=ghp_x9y8z7w6v5&page=2 200", "ghp_x9y8z7w6v5")
        self.assertIn("id=7", out)
        self.assertIn("page=2", out)
        self.assertIn("access_token=•••", out)

    def test_well_known_token_shapes(self):
        self.gone(f"jwt {JWT} sent", JWT)
        self.gone(f"dynatrace {DT_TOKEN} sent", DT_TOKEN)
        self.gone(f"key {AWS_KEY} used", AWS_KEY)
        self.gone(f"gh token {GH_TOKEN} used", GH_TOKEN)
        self.gone(f"slack {SLACK_TOKEN} used", SLACK_TOKEN)

    def test_private_key_blocks(self):
        out = self.gone("a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----\nb", "MIIEowIBAAKCAQEA", "abcdef")
        self.assertIn("a", out)
        self.assertIn("b", out)

    def test_structured_logs_and_shell_consoles(self):
        out = self.gone('{"password":"hunter2hunter2","user":"bob"} "token": "abcd1234efgh" \'secret\':\'sh0rt\' client_secret": "abc12345",',
                        "hunter2hunter2", "abcd1234efgh", "sh0rt", "abc12345")
        self.assertIn('"user":"bob"', out)
        self.gone("run --password hunter2x --token=abc123xyz --api-key k3y123", "hunter2x", "abc123xyz", "k3y123")
        self.gone("docker login -u bob -p S3cr3tPass!", "S3cr3tPass!")
        self.gone("curl -u admin:hunter2pw https://x.example.com/y", "hunter2pw")

    def test_cookies(self):
        out = self.gone("Cookie: JSESSIONID=ABC123DEF; sessionid=deadbeef99\nSet-Cookie: sid=zz11yy22; Path=/", "ABC123DEF", "deadbeef99", "zz11yy22")
        self.assertIn("Cookie: •••", out)

    def test_a_secret_is_masked_whole_even_when_it_has_separators_inside(self):
        out = self.gone("password=ab;cd1234,ef56 next", "cd1234", "ef56")
        self.assertIn("next", out)

    def test_a_bare_hex_key_after_the_word_that_names_it(self):
        self.gone("token 11a1b2c3d4e5f60718293a4b5c6d7e8f90 used; api key: 0123456789abcdef0123456789abcdef", "11a1b2c3d4e5f60718293a4b5c6d7e8f90", "0123456789abcdef0123456789abcdef")

    def test_more_token_shapes_and_the_pgp_key_block(self):
        self.gone(f"{GL_TOKEN} {NPM_TOKEN} {SK_TOKEN}", GL_TOKEN, NPM_TOKEN, SK_TOKEN)
        self.gone("hook https://hooks.slack.com/services/" + "T0123456/B0123456/" + "abcdefghijklmnopqrstuvwx fired", "abcdefghijklmnopqrstuvwx")
        self.gone(f"{GOOGLE_KEY} x", GOOGLE_KEY)
        out = self.gone("-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF8abcdef\n-----END PGP PRIVATE KEY BLOCK-----\ntail", "lQOYBF8abcdef")
        self.assertIn("tail", out)

    def test_a_long_opaque_blob_goes_but_a_path_or_a_commit_id_stays(self):
        blob = "Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFla"
        self.gone(f"blob {blob} end", blob)
        path = "/var/lib/jenkins/workspace/payments-service_feature-PAY-1/target/surefire-reports/TEST-com.example.PaymentTest.xml"
        self.assertIn(path, _scrub.text(f"see {path}"))
        sha = "3b8eb88c13fa2c7d9e0a1b2c3d4e5f60718293a4"
        self.assertIn(sha, _scrub.text(f"commit {sha}"))

    def test_environment_secrets_are_removed_by_value(self):
        with mock.patch.dict(os.environ, {"DYNATRACE_PAT": "plat-ABCDEFG-1234", "JENKINS_API_TOKEN": "j-token-9876", "HARMLESS_NAME": "payments"}):
            out = _scrub.text("calling with plat-ABCDEFG-1234 and j-token-9876 for payments")
        self.assertNotIn("plat-ABCDEFG-1234", out)
        self.assertNotIn("j-token-9876", out)
        self.assertIn("payments", out)

    def test_emails_and_ips(self):
        out = _scrub.text("user jane.doe@example.com from 10.12.13.14 and 2001:db8::1")
        self.assertNotIn("jane.doe@example.com", out)
        self.assertNotIn("10.12.13.14", out)
        self.assertIn("[email]", out)
        self.assertIn("[ip]", out)
        self.assertIn("10.12.13.14", _scrub.text("from 10.12.13.14", ips=False))

    def test_ordinary_text_is_untouched(self):
        raw = "java.net.SocketTimeoutException: Read timed out after 30000 ms calling POST /api/v2/payments (attempt 3 of 3)"
        self.assertEqual(_scrub.text(raw), raw)


class Shape(unittest.TestCase):
    def test_line_is_one_line_and_capped(self):
        out = _scrub.line("first\nsecond\tthird " + "x" * 400, 120)
        self.assertNotIn("\n", out)
        self.assertEqual(len(out), 120)
        self.assertTrue(out.endswith("…"))

    def test_control_characters_and_ansi_colours_are_dropped(self):
        out = _scrub.text("\x1b[31mERROR\x1b[0m something \x00broke\x07\nnext")
        self.assertEqual(out, "ERROR something broke\nnext")

    def test_carriage_return_progress_lines_keep_the_final_state(self):
        self.assertEqual(_scrub.text("downloading 10%\rdownloading 60%\rdownloading 100%\ndone"), "downloading 100%\ndone")

    def test_tail_keeps_the_last_lines_and_chars(self):
        raw = "\n".join(f"line {i}" for i in range(100))
        out = _scrub.tail(raw, lines=40, max_chars=4096)
        got = out.splitlines()
        self.assertEqual(len(got), 40)
        self.assertEqual(got[-1], "line 99")
        self.assertEqual(got[0], "line 60")
        big = _scrub.tail("\n".join("y" * 300 for _ in range(30)), lines=40, max_chars=1000)
        self.assertLessEqual(len(big), 1000)
        self.assertTrue(big.endswith("y"))

    def test_tail_drops_trailing_blank_lines_and_scrubs(self):
        out = _scrub.tail("a\npassword=abc123xyz\n\n\n", lines=40, max_chars=4096)
        self.assertEqual(out, "a\npassword=•••")

    def test_empty_and_non_strings(self):
        self.assertEqual(_scrub.text(None), "")
        self.assertEqual(_scrub.line(12345), "12345")
        self.assertEqual(_scrub.tail("", 40, 4096), "")


class Hostile(unittest.TestCase):
    """Text from another system is attacker-controlled (a log line, an exception message, a console): none of it may make
    the scrub slow — the patterns are bounded and only the first 64 KB is looked at."""

    CASES = {
        "dots": "a." * 32000, "alnum": "a" * 65000, "tokens": "token=" * 10000, "at": "x" * 65000 + "@", "ats": "a@" * 32000,
        "scheme": "ab+c." * 13000, "quotes": 'password="' * 6000, "bearer": "bearer " * 9000, "basic": "basic " * 9000, "keys": "api-key:" * 8000,
        "begin": "-----BEGIN PRIVATE KEY-----\n" * 2000, "hex": "0123456789abcdef" * 4000, "slashes": "a/" * 32000, "ips": "1.1.1." * 9000,
        "colons": "1:" * 30000, "mixed": "Ab1" * 20000, "pw": "password" * 8000, "dashes": "a-" * 32000, "query": "http://x.example/?" + "token=a&" * 8000,
        "auth": "authorization:" * 4500, "jwt": "eyJ-" * 16384, "pw2": "password" * 8192, "cookie": "cookie:" * 9000, "flags": "-p " * 21000,
        "hexw": "token " * 10000, "sk": "sk-" * 21000,
    }

    def test_every_hostile_shape_is_fast(self):
        import time

        for name, raw in self.CASES.items():
            with self.subTest(case=name):
                t0 = time.time()
                _scrub.text(raw)
                _scrub.line(raw, 200)
                _scrub.tail(raw, 40, 4096)
                self.assertLess(time.time() - t0, 3.0, f"{name} took {time.time() - t0:.1f}s")

    def test_only_the_first_64_kb_of_text_and_the_last_64_kb_of_a_tail_are_looked_at(self):
        self.assertLessEqual(len(_scrub.text("y " * 200000)), _scrub.MAX_INPUT)
        tail = _scrub.tail("early\n" + "x\n" * 100000 + "the end", 3, 4096)
        self.assertTrue(tail.endswith("the end"))


if __name__ == "__main__":
    unittest.main()
