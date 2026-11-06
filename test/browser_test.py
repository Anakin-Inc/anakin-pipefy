#!/usr/bin/env python3
"""Drives the real pages in Chromium with a stubbed Pipefy SDK.

This does not prove Pipefy behaviour: only a run inside a Pipefy org does that.
It does prove the UI logic, the failure paths and, when ANAKIN_TEST_KEY is set,
real cross-origin calls to api.anakin.io from a browser.

    ANAKIN_TEST_KEY=... python3 test/browser_test.py [--screenshots DIR]
"""
import functools
import glob
import http.server
import json
import os
import pathlib
import sys
import threading

from playwright.sync_api import sync_playwright

DOCS = pathlib.Path(__file__).resolve().parent.parent / "docs"
LIVE_KEY = os.environ.get("ANAKIN_TEST_KEY", "")
FAKE_KEY = "ask_" + "0" * 64
SHOTS = sys.argv[sys.argv.index("--screenshots") + 1] if "--screenshots" in sys.argv else None

STUB_SDK = r"""
(function () {
  var cfg = window.__cfg;
  var log = (window.__log = { set: [], mutation: [], render: 0, resize: [], notes: [], fetch: [] });
  var store = cfg.store || {};
  var client = {
    card: function () { return Promise.resolve(cfg.card === undefined ? { id: '42', title: 'Competitor', field_values: { website: 'https://example.com/' } } : cfg.card); },
    fields: function () { return Promise.resolve(cfg.fields === undefined ? [{ id: 'notes', label: 'Scraped notes', type: 'long_text' }, { id: 'name', label: 'Name', type: 'short_text' }] : cfg.fields); },
    get: function (scope, visibility, key) {
      if (cfg.getRejects) return Promise.reject(new Error('get failed'));
      return Promise.resolve(store[scope + '/' + visibility + '/' + key]);
    },
    set: function (scope, visibility, key, value) {
      log.set.push({ scope: scope, visibility: visibility, key: key, length: String(value).length });
      if (cfg.setRejects) return Promise.reject(new Error('set failed'));
      if (cfg.setDropsWrite) return Promise.resolve();
      store[scope + '/' + visibility + '/' + key] = value;
      return Promise.resolve();
    },
    mutation: function (query, variables) {
      log.mutation.push({ query: query, variables: variables });
      return Promise.resolve(cfg.mutationResult || { data: { updateCardField: { success: true } } });
    },
    showNotification: function (text, type) { log.notes.push([text, type]); },
  };
  window.PipefyApp = {
    init: function () { if (cfg.noAppId) throw new Error('PipefyApp: no "appID" query parameter'); return client; },
    render: function (cb) { log.render++; cb(); },
    resizeTo: function (selector) {
      if (!document.querySelector(selector)) throw new TypeError('no element');
      log.resize.push(selector);
    },
  };
})();
"""


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class Suite:
    def __init__(self, browser, base):
        self.browser, self.base = browser, base
        self.passed, self.failed = 0, []

    def page(self, cfg=None, surface="card-tab", api=None, sdk=True):
        ctx = self.browser.new_context(viewport={"width": 860, "height": 640})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.errors = errors
        page.add_init_script("window.__cfg = %s;" % json.dumps(cfg or {}))
        if sdk:
            page.route("https://platform.staticpipefy.com/**", lambda r: r.fulfill(content_type="text/javascript", body=STUB_SDK))
        else:
            page.route("https://platform.staticpipefy.com/**", lambda r: r.abort())
        if api is not None:
            page.route("https://api.anakin.io/**", api)
        page.goto("%s/%s.html" % (self.base, "card-tab" if surface == "card-tab" else "modal"))
        return page

    def run(self, name, fn):
        try:
            fn()
            self.passed += 1
            print("  ok  ", name)
        except Exception as e:  # noqa: BLE001
            self.failed.append(name)
            print("  FAIL", name, "\n      ", repr(e).split("\n")[0][:300])


def log(page):
    return page.evaluate("window.__log")


def stub_api(job, submit_status=202):
    def handler(route):
        headers = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "X-API-Key,Content-Type", "Access-Control-Allow-Methods": "GET,POST"}
        if route.request.method == "OPTIONS":
            return route.fulfill(status=204, headers=headers)
        if route.request.method == "POST":
            return route.fulfill(status=submit_status, headers=headers, json={"jobId": "j1"} if submit_status < 400 else job)
        return route.fulfill(status=200, headers=headers, json=job)
    return handler


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(DOCS)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % server.server_port
    shell = sorted(glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell")))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=shell[-1] if shell else None)
        s = Suite(browser, base)
        stored = {"store": {"organization/private/anakin_api_key": FAKE_KEY}}

        def no_key_shows_connect():
            page = s.page()
            page.wait_for_selector("#api-key")
            assert log(page)["render"] == 1, "card tab must call PipefyApp.render"
            assert page.get_attribute("#api-key", "type") == "password"
            assert not page.errors, page.errors
        s.run("card tab with no key shows the connect form and calls render", no_key_shows_connect)

        def modal_no_render():
            page = s.page(surface="modal")
            page.wait_for_selector("#api-key")
            assert log(page)["render"] == 0, "render throws outside tab and pipe view"
            assert log(page)["resize"] == ["#root"]
        s.run("modal does not call render", modal_no_render)

        def bad_format_never_sent():
            sent = []
            page = s.page(api=lambda r: (sent.append(r.request.url), r.abort()))
            page.wait_for_selector("#api-key")
            page.fill("#api-key", "some clipboard text")
            page.click("button[type=submit]")
            page.wait_for_selector(".status.error")
            assert "does not look like" in page.inner_text(".status.error")
            assert sent == [], sent
        s.run("non-key text is rejected without any network call", bad_format_never_sent)

        def key_save_failure():
            page = s.page(cfg={"setRejects": True}, api=stub_api({"data": []}))
            page.wait_for_selector("#api-key")
            page.fill("#api-key", FAKE_KEY)
            page.click("button[type=submit]")
            page.wait_for_selector(".status.error")
            assert "Could not save" in page.inner_text(".status.error")
        s.run("failure to store the key is reported", key_save_failure)

        def key_write_not_confirmed():
            page = s.page(cfg={"setDropsWrite": True}, api=stub_api({"data": []}))
            page.wait_for_selector("#api-key")
            page.fill("#api-key", FAKE_KEY)
            page.click("button[type=submit]")
            page.wait_for_selector(".status.error")
            assert "Could not save" in page.inner_text(".status.error")
            assert page.locator("#scrape-url").count() == 0
        s.run("a key that does not read back is reported as not saved", key_write_not_confirmed)

        def stored_key_prefills_url():
            page = s.page(cfg=stored)
            page.wait_for_selector("#scrape-url")
            assert page.input_value("#scrape-url") == "https://example.com/"
        s.run("stored key opens scrape view with the URL from the card", stored_key_prefills_url)

        def fatal_paths():
            page = s.page(cfg={"card": None})
            page.wait_for_selector(".status.error")
            assert "Could not load this card" in page.inner_text("#root")
            page = s.page(cfg={"getRejects": True})
            page.wait_for_selector(".status.error")
            assert "Could not load your Anakin settings" in page.inner_text("#root")
            page = s.page(cfg={"noAppId": True})
            page.wait_for_selector(".status.error")
            assert "only works inside Pipefy" in page.inner_text("#root")
            page = s.page(sdk=False)
            page.wait_for_selector(".status.error")
            assert "SDK did not load" in page.inner_text("#root")
        s.run("no blank frames: null card, get failure, opened directly, SDK blocked", fatal_paths)

        def invalid_url():
            page = s.page(cfg=stored)
            page.wait_for_selector("#scrape-url")
            page.fill("#scrape-url", "javascript:alert(1)")
            page.click("button[type=submit]")
            page.wait_for_selector(".status.error")
            assert "full web address" in page.inner_text(".status.error")
        s.run("javascript: URL is refused", invalid_url)

        def untrusted_markdown_inert():
            evil = "<img src=x onerror=\"window.__pwned=1\"><script>window.__pwned=1</script># Title"
            page = s.page(cfg=stored, api=stub_api({"status": "completed", "markdown": evil, "finalUrl": "https://example.com/"}))
            page.wait_for_selector("#scrape-url")
            page.click("button[type=submit]")
            page.wait_for_selector("#preview")
            assert page.inner_text("#preview").startswith("<img src=x")
            assert page.evaluate("window.__pwned") is None
            assert page.locator("#preview img").count() == 0
        s.run("scraped HTML is shown as text and does not execute", untrusted_markdown_inert)

        def save_uses_variables():
            md = 'He said "hi"\n{ brace }'
            page = s.page(cfg=stored, api=stub_api({"status": "completed", "markdown": md, "finalUrl": "https://example.com/"}))
            page.wait_for_selector("#scrape-url")
            page.click("button[type=submit]")
            page.wait_for_selector("#target-field")
            assert page.locator("#target-field option").count() == 1, "only long text fields are offered"
            page.click("text=Save to field")
            page.wait_for_selector(".status.ok >> text=Saved to the card")
            m = log(page)["mutation"][0]
            assert m["variables"]["cardId"] == "42" and m["variables"]["fieldId"] == "notes"
            assert m["variables"]["value"].startswith("Source: https://example.com/\nScraped: ")
            assert m["variables"]["value"].endswith(md)
            assert md not in m["query"], "user data must go in variables"
        s.run("save writes the picked field through GraphQL variables", save_uses_variables)

        def save_error_shown():
            cfg = dict(stored, mutationResult={"errors": [{"message": "Permission denied"}]})
            page = s.page(cfg=cfg, api=stub_api({"status": "completed", "markdown": "x"}))
            page.wait_for_selector("#scrape-url")
            page.click("button[type=submit]")
            page.wait_for_selector("#target-field")
            page.click("text=Save to field")
            page.wait_for_selector(".status.error")
            assert "Permission denied" in page.inner_text(".status.error")
            assert page.is_enabled("text=Save to field"), "button re-enabled for retry"
        s.run("a GraphQL error on a resolved promise is shown", save_error_shown)

        def no_long_text():
            cfg = dict(stored, fields=[{"id": "name", "label": "Name", "type": "short_text"}])
            page = s.page(cfg=cfg, api=stub_api({"status": "completed", "markdown": "x"}))
            page.wait_for_selector("#scrape-url")
            page.click("button[type=submit]")
            page.wait_for_selector("#preview")
            assert "no Long text field" in page.inner_text("#result")
            cfg = dict(stored, fields=None)
            page = s.page(cfg=cfg, api=stub_api({"status": "completed", "markdown": "x"}))
            page.wait_for_selector("#scrape-url")
            page.click("button[type=submit]")
            page.wait_for_selector("#preview")
            assert "Could not load this pipe" in page.inner_text("#result")
        s.run("no Long text field and failed field load both explain themselves", no_long_text)

        def job_failure_and_401():
            page = s.page(cfg=stored, api=stub_api({"status": "failed", "error": "Blocked by the site"}))
            page.wait_for_selector("#scrape-url")
            page.click("button[type=submit]")
            page.wait_for_selector(".status.error")
            assert "Blocked by the site" in page.inner_text(".status.error")
            assert page.is_enabled("button[type=submit]")
            page = s.page(cfg=stored, api=stub_api({"error": "unauthorized", "message": "Invalid"}, submit_status=401))
            page.wait_for_selector("#scrape-url")
            page.click("button[type=submit]")
            page.wait_for_selector("text=Update API key")
            page.click("text=Update API key")
            page.wait_for_selector("#api-key")
            assert page.input_value("#api-key") == "", "the stored key must not be shown back"
        s.run("failed job and rejected key recover cleanly", job_failure_and_401)

        def network_down():
            page = s.page(cfg=stored, api=lambda r: r.abort())
            page.wait_for_selector("#scrape-url")
            page.click("button[type=submit]")
            page.wait_for_selector(".status.error")
            assert "Could not reach Anakin" in page.inner_text(".status.error")
        s.run("network failure is reported", network_down)

        def remove_key():
            page = s.page(cfg=stored)
            page.wait_for_selector("#scrape-url")
            page.click("text=API key")
            page.click("text=Remove key")
            page.wait_for_selector("#api-key")
            sets = log(page)["set"]
            assert sets[-1]["visibility"] == "private" and sets[-1]["length"] == 0
        s.run("key can be removed", remove_key)

        # Real cross-origin calls from a real browser.
        def live_bad_key():
            page = s.page()
            page.wait_for_selector("#api-key")
            page.fill("#api-key", FAKE_KEY)
            page.click("button[type=submit]")
            page.wait_for_selector(".status.error", timeout=30000)
            assert "rejected this API key" in page.inner_text(".status.error")
            assert log(page)["set"] == [], "a rejected key must not be stored"
        s.run("LIVE api.anakin.io: invalid key gets a real 401 and is not stored", live_bad_key)

        if LIVE_KEY:
            def live_flow():
                page = s.page()
                page.wait_for_selector("#api-key")
                page.fill("#api-key", LIVE_KEY)
                page.click("button[type=submit]")
                page.wait_for_selector("#scrape-url", timeout=30000)
                st = log(page)["set"][-1]
                assert st["scope"] == "organization" and st["visibility"] == "private"
                assert LIVE_KEY not in page.content(), "key must not stay in the DOM"
                page.click("button[type=submit]")
                page.wait_for_selector("#preview", timeout=130000)
                assert "documentation examples" in page.inner_text("#preview")
                page.click("text=Save to field")
                page.wait_for_selector(".status.ok >> text=Saved to the card")
                assert "documentation examples" in log(page)["mutation"][0]["variables"]["value"]
                assert not page.errors, page.errors
                if SHOTS:
                    os.makedirs(SHOTS, exist_ok=True)
                    page.screenshot(path=os.path.join(SHOTS, "harness-card-tab.png"))
            s.run("LIVE api.anakin.io: connect, scrape, preview, save", live_flow)
        else:
            print("  skip  live flow (ANAKIN_TEST_KEY not set)")

        browser.close()

    print("\n%d passed, %d failed" % (s.passed, len(s.failed)))
    sys.exit(1 if s.failed else 0)


if __name__ == "__main__":
    main()
