import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";
import { chromium } from "playwright";
import { AppProvider, Card, Page, TextField } from "@shopify/polaris";

// Exercise the actual installed Polaris provider and Page in SSR and Chrome,
// including both sides of the 767.95px breakpoint used in Shopify's iframe.
const original = process.argv.includes("--original");
function Fixture() {
  return React.createElement(
    AppProvider,
    { i18n: {} },
    React.createElement(
      Page,
      { title: "Receive MCP-LIVE-20261008-06" },
      React.createElement(
        Card,
        null,
        React.createElement(
          "form",
          {
            onSubmit: (e) => {
              e.preventDefault();
              document.body.dataset.submitted = "true";
            },
          },
          React.createElement(TextField, {
            label: "Delivery note",
            value: "",
            onChange() {},
            autoComplete: "off",
          }),
          React.createElement("button", { type: "submit" }, "Record receipt"),
        ),
      ),
    ),
  );
}
const component = Fixture.toString();
const ssr = renderToString(React.createElement(Fixture));
const bundled = await build({
  stdin: {
    contents: `import React from "react";
      import {hydrateRoot} from "react-dom/client";
      import {AppProvider, Card, Page, TextField} from "@shopify/polaris";
      ${component}
      window.hydrationErrors = [];
      hydrateRoot(document.getElementById("root"), React.createElement(Fixture), {
        onRecoverableError: error => window.hydrationErrors.push(error.message)
      });`,
    resolveDir: process.cwd(),
    sourcefile: "polaris-hydration-fixture.js",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: original
    ? [
        {
          name: "unpatched-polaris-baseline",
          setup(builder) {
            builder.onLoad(
              { filter: /MediaQueryProvider[\\/]MediaQueryProvider\.js$/ },
              async ({ path }) => ({
                contents: (await readFile(path, "utf8")).replace(
                  "setIsNavigationCollapsed] = useState(false)",
                  "setIsNavigationCollapsed] = useState(navigationBarCollapsed().matches)",
                ),
                loader: "js",
              }),
            );
          },
        },
      ]
    : [],
});
const script = bundled.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const artifact = resolve(
  `.cache/polaris-hydration-${original ? "original" : "fixed"}.html`,
);
await mkdir(resolve(".cache"), { recursive: true });
await writeFile(
  artifact,
  `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root">${ssr}</div><script>${script}</script></body></html>`,
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const width of [360, 630, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const exceptions = [];
    page.on("pageerror", (error) => exceptions.push(error.message));
    await page.goto(new URL(`file:///${artifact.replace(/\\/g, "/")}`).href);
    await page.waitForFunction(() =>
      document.documentElement.classList.contains("p-theme-light"),
    );
    const errors = await page.evaluate(() => window.hydrationErrors);
    assert.equal(exceptions.length, 0);
    assert.equal(
      errors.length > 0,
      original && width < 768,
      `Hydration at ${width}px`,
    );
    await page.getByRole("button", { name: "Record receipt" }).click();
    assert.equal(
      await page.locator("body").getAttribute("data-submitted"),
      "true",
    );
    const mobile = await page
      .locator(".Polaris-Page-Header--mobileView")
      .count();
    assert.equal(mobile > 0, width < 768, `Responsive header at ${width}px`);
    results.push({
      width,
      hydrationErrors: errors.length,
      formUsable: true,
      responsive: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(
  JSON.stringify(
    { mode: original ? "original defect reproduced" : "fixed", results },
    null,
    2,
  ),
);
