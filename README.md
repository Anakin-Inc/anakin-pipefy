# Anakin Web Scraper for Pipefy

A [Pipefy App](https://developers.pipefy.com/docs/build-your-first-pipefy-app) that scrapes a public web page into a card as clean Markdown, using your own [Anakin](https://anakin.io) API key.

## What it adds to Pipefy

- A **card tab** and a **card button** (the button opens the same screen in a modal).
- Paste a URL, or use one already on the card, preview the Markdown, and save it to a Long text field you pick. Saving replaces that field's current value.

## Install in your organization

You must be an admin of the Pipefy organization.

1. Get an API key from the [Anakin dashboard](https://anakin.io/dashboard). Anakin has a free tier.
2. Go to <https://app.pipefy.com/developers/apps> and click **Add new app**.
3. Enter the name `Anakin Web Scraper` and the manifest URL `https://anakin-inc.github.io/anakin-pipefy/manifest.json`.
4. Open a card, select the **Anakin** tab, and paste your key.

## Data handling

| Data | Where it goes |
|---|---|
| Your Anakin API key | Stored by Pipefy with `organization` scope and `private` visibility, so only your user can read it. Sent only to `api.anakin.io`. |
| The URL you scrape | Sent to `api.anakin.io`. |
| Card field values | Read in your browser to suggest a URL. Not sent anywhere. |
| Pipe field list | Read in your browser to offer save targets. Not sent anywhere. |
| Scraped Markdown | Written to the Long text field you pick, only when you click **Save to field**. |

The app is a static site in `docs/` with no backend. The browser calls `api.anakin.io` directly.

## Develop

No build step.

```sh
npm test                                           # unit tests, including manifest asset checks
ANAKIN_TEST_KEY=... python3 test/browser_test.py   # real pages in Chromium with a stubbed Pipefy SDK
```

The browser test needs Python Playwright. It proves the UI logic, failure paths and real cross-origin calls to Anakin, but not Pipefy behaviour: that takes a run inside a Pipefy organization.

## License

MIT
