import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from 'react-router-dom/server.mjs';
import { Link } from '@remix-run/react';
import { AppProvider } from '@shopify/polaris';
import { loadImage } from '@napi-rs/canvas';

const root = process.cwd();
const output = resolve(root, 'output/screenshots');
const sources = resolve(output, 'source');
await mkdir(sources, { recursive: true });
const compiled = new Map();
const moduleStyles = [];

// Compile existing view components, keeping their JSX and all display logic.
// Remove only server imports and route handlers: sample fixtures replace loaders.
async function compileView(input) {
  input = resolve(input);
  if (compiled.has(input)) return compiled.get(input);
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 10);
  const destination = resolve(sources, `${basename(input).replace(/\.[^.]+$/, '')}-${hash}.mjs`);
  compiled.set(input, destination);
  const text = await readFile(input, 'utf8');
  if (input.endsWith('.module.css')) {
    const names = [...new Set([...text.matchAll(/\.([A-Za-z][\w-]*)/g)].map(match => match[1]))];
    const mapping = Object.fromEntries(names.map(name => [name, `listing-${hash}-${name}`]));
    let css = text;
    for (const [name, replacement] of Object.entries(mapping)) css = css.replace(new RegExp(`\\.${name}(?![\\w-])`, 'g'), `.${replacement}`);
    moduleStyles.push(css);
    await writeFile(destination, `export default ${JSON.stringify(mapping)};`);
    return destination;
  }
  const ast = ts.createSourceFile(input, text, ts.ScriptTarget.Latest, true, input.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const chunks = [];
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && ['loader', 'action'].includes(statement.name?.text)) continue;
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => ['loader', 'action'].includes(item.name.getText(ast)))) continue;
    let chunk = statement.getText(ast);
    if (ts.isImportDeclaration(statement)) {
      const name = statement.moduleSpecifier.text;
      if (statement.importClause?.isTypeOnly || /(?:\.server|@remix-run\/node|@prisma\/client|^node:)/.test(name)) continue;
      if (name.startsWith('.')) {
        let target = resolve(dirname(input), name);
        if (!extname(target)) {
          // A route filename contains dots but may still have no TS extension.
          target = resolve(dirname(input), `${name}.ts`);
          try { await access(target); } catch { target = resolve(dirname(input), `${name}.tsx`); }
        } else if (!/\.(tsx?|css)$/.test(target)) {
          const tsTarget = `${target}.ts`;
          try { await access(tsTarget); target = tsTarget; } catch { target = `${target}.tsx`; }
        }
        const dependency = await compileView(target);
        chunk = chunk.replace(statement.moduleSpecifier.getText(ast), JSON.stringify(pathToFileURL(dependency).href));
      }
    }
    chunks.push(chunk);
  }
  const js = ts.transpileModule(chunks.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  await writeFile(destination, js);
  return destination;
}

const sampleInvoices = [
  { id: 'demo-invoice-1042', invoiceNumber: 'SB-1042', total: 576, currency: 'USD', vendor: { name: 'Sample Textiles' }, purchaseOrder: { poNumber: 'PO-2041' }, reviewStatus: 'APPROVED', accountingStatus: 'EXPORTED', cogsSyncStatus: 'SYNCED' },
  { id: 'demo-invoice-1043', invoiceNumber: 'SB-1043', total: 372, currency: 'USD', vendor: { name: 'Sample Ceramics' }, purchaseOrder: { poNumber: 'PO-2042' }, reviewStatus: 'NEEDS_ATTENTION', accountingStatus: 'NOT_EXPORTED', cogsSyncStatus: 'NOT_SYNCED' },
  { id: 'demo-invoice-1044', invoiceNumber: 'SB-1044', total: 210, currency: 'USD', vendor: { name: 'Sample Packaging' }, purchaseOrder: { poNumber: 'PO-2043' }, reviewStatus: 'PENDING_REVIEW', accountingStatus: 'NOT_EXPORTED', cogsSyncStatus: 'NOT_SYNCED' },
  { id: 'demo-invoice-1045', invoiceNumber: 'SB-1045', total: 480, currency: 'USD', vendor: { name: 'Sample Ceramics' }, purchaseOrder: { poNumber: 'PO-2044' }, reviewStatus: 'APPROVED', accountingStatus: 'EXPORTED', cogsSyncStatus: 'SYNCED' },
  { id: 'demo-invoice-1046', invoiceNumber: 'SB-1046', total: 288, currency: 'USD', vendor: { name: 'Sample Textiles' }, purchaseOrder: { poNumber: 'PO-2045' }, reviewStatus: 'APPROVED', accountingStatus: 'NOT_EXPORTED', cogsSyncStatus: 'NOT_SYNCED' },
];
const invoiceFixture = { invoices: sampleInvoices, count: sampleInvoices.length, page: 1, search: '', status: '', role: 'ADMIN', deleted: false };
const receiptFixture = {
  requestKey: '00000000-0000-4000-8000-000000000001',
  po: {
    id: 'demo-po-2041', poNumber: 'PO-2041', vendor: { name: 'Sample Textiles' },
    items: [
      { id: 'demo-tote', sku: 'TOTE-01', name: 'Linen tote', expectedQty: 40, receivedQty: 30, billedQty: 40 },
      { id: 'demo-cup', sku: 'CUP-01', name: 'Ceramic cup', expectedQty: 60, receivedQty: 48, billedQty: 60 },
    ],
    receipts: [{ id: 'demo-receipt-01', receivedAt: '2026-09-28T09:30:00.000Z', reference: 'DEMO-DEL-01', actor: 'Sample staff', items: [{ quantity: 30 }, { quantity: 48 }] }],
  },
};
const supplierGroups = new Map();
for (const invoice of sampleInvoices) {
  const group = supplierGroups.get(invoice.vendor.name) || [];
  group.push(invoice);
  supplierGroups.set(invoice.vendor.name, group);
}
const analyticsFixture = {
  vendorAnalytics: [...supplierGroups].map(([name, invoices], index) => ({
    id: `sample-vendor-${index}`, currency: 'USD', name, totalSpend: invoices.reduce((sum, invoice) => sum + invoice.total, 0),
    invoiceCount: invoices.length, averageInvoice: invoices.reduce((sum, invoice) => sum + invoice.total, 0) / invoices.length,
    purchaseOrderCount: invoices.length, mismatchCount: name === 'Sample Ceramics' ? 1 : 0,
  })).sort((a, b) => b.totalSpend - a.totalSpend),
  metrics: { totalSpend: [{ currency: 'USD', total: sampleInvoices.reduce((sum, invoice) => sum + invoice.total, 0) }], invoiceCount: 5, needsAttention: 1, syncedCogs: 2, exported: 2, mismatchedPOs: 1, purchaseOrderCount: 5 },
};

const definitions = [
  { filename: 'smartbill-desktop-01-invoice-review.png', route: 'app/routes/app.invoices.tsx', pathname: '/app/invoices', title: 'Invoice review', alt: 'Supplier invoices with review and accounting statuses', fixture: invoiceFixture, width: 1600, height: 900, scale: 1, zoom: 1.15 },
  { filename: 'smartbill-desktop-02-purchase-order-receipts.png', route: 'app/routes/app.receipts.$id.tsx', pathname: '/app/receipts/demo-po-2041', title: 'Purchase order receipts', alt: 'Compare ordered, received, and billed product quantities', fixture: receiptFixture, width: 1600, height: 900, scale: 1, zoom: 1.2 },
  { filename: 'smartbill-desktop-03-vendor-analytics.png', route: 'app/routes/app.analytics.tsx', pathname: '/app/analytics', title: 'Vendor analytics', alt: 'Supplier spending, invoice counts, and purchase order issues', fixture: analyticsFixture, width: 1600, height: 900, scale: 1, zoom: 1.25 },
  { filename: 'smartbill-mobile-01-record-delivery.png', route: 'app/routes/app.receipts.$id.tsx', pathname: '/app/receipts/demo-po-2041', title: 'Record a delivery on mobile', alt: 'Record a delivery on mobile with previous receipts visible', fixture: receiptFixture, width: 450, height: 800, scale: 2, zoom: 1, inProgress: true },
];
for (const definition of definitions) assert.ok(definition.alt.length <= 64, 'Alt text must not exceed 64 characters.');
const brandModule = await compileView(resolve(root, 'app/components/SmartBillBrand.tsx'));
const { SmartBillBrand } = await import(pathToFileURL(brandModule).href);
const noticeModule = await compileView(resolve(root, 'app/components/IntuitTrademarkNotice.tsx'));
const { IntuitTrademarkNotice } = await import(pathToFileURL(noticeModule).href);
const english = JSON.parse(await readFile(resolve(root, 'node_modules/@shopify/polaris/locales/en.json'), 'utf8'));
const css = await readFile(resolve(root, 'node_modules/@shopify/polaris/build/esm/styles.css'), 'utf8') + '\n' + await readFile(resolve(root, 'app/styles/forms.css'), 'utf8');
function Frame({ children }) {
  return React.createElement(React.Fragment, null,
    React.createElement('header', { className: 'smartbill-app-brand' }, React.createElement(Link, { to: '/app', 'aria-label': 'SmartBill home' }, React.createElement(SmartBillBrand, { size: 32 }))),
    React.createElement('main', { className: 'smartbill-workspace' }, children),
    React.createElement(IntuitTrademarkNotice, { className: 'smartbill-trademark-notice' }));
}
for (const definition of definitions) {
  const componentFile = await compileView(resolve(root, definition.route));
  const { default: View } = await import(pathToFileURL(componentFile).href);
  const routes = [{ id: 'sample-view', path: definition.pathname, loader: () => definition.fixture, element: React.createElement(Frame, null, React.createElement(View)) }];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`https://screenshot.invalid${definition.pathname}`));
  assert.ok(!(context instanceof Response), 'Fixture route must render locally.');
  const router = createStaticRouter(handler.dataRoutes, context);
  let markup = renderToStaticMarkup(React.createElement(AppProvider, { i18n: english }, React.createElement(StaticRouterProvider, { router, context, hydrate: false })));
  assert.ok(!markup.includes('Unexpected Application Error'), 'Route failed to render.');
  for (const size of [64, 128, 256]) {
    const bytes = await readFile(resolve(root, `public/brand/smartbill-icon-${size}.png`));
    markup = markup.replaceAll(`/brand/smartbill-icon-${size}.png`, `data:image/png;base64,${bytes.toString('base64')}`);
  }
  const progressScript = definition.inProgress ? `<script>document.querySelector('input[name="reference"]').value='DEMO-DEL-02';document.querySelector('input[name="qty:demo-tote"]').value='10';document.querySelector('input[name="qty:demo-cup"]').value='12';</script>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SmartBill - ${definition.title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${moduleStyles.join('\n')}\nhtml{zoom:${definition.zoom}}body{margin:0;background:#f1f1f1;}</style></head><body>${markup}${progressScript}</body></html>`;
  definition.html = resolve(sources, definition.filename.replace('.png', '.html'));
  await writeFile(definition.html, html);
}

const manifest = definitions.map(({ filename, alt, route, width, height, scale, inProgress }) => ({ filename, alt, altCharacters: alt.length, sourceRoute: route, width: width * scale, height: height * scale, type: scale === 2 ? 'mobile' : 'desktop', fictionalData: true, ...(inProgress ? { state: 'Delivery quantities entered, not submitted' } : {}) }));
await writeFile(resolve(output, 'screenshot-manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(resolve(output, 'README.md'), `# SmartBill listing screenshots\n\nThree desktop PNGs are 1600 by 900 pixels. One optional mobile PNG is 900 by 1600 pixels.\n\nExisting SmartBill route components are rendered using installed Polaris components and the app's styles. Server handlers are omitted from the local rendering copy and replaced with fictional sample data. No app source, live database, merchant records, integrations, or listing are changed. The desktop capture uses normal browser zoom for readability.\n\nThe mobile image shows a delivery form with sample quantities entered without submitting it. No POS screenshot is included because SmartBill does not implement a POS integration.\n\n| File | Alt text |\n| --- | --- |\n${manifest.map(item => `| ${item.filename} | ${item.alt} |`).join('\n')}\n\nAll alt text is at most 64 characters. Images contain only app content, without browser controls or desktop backgrounds. Sample supplier and staff labels are fictional and contain no personal information. Invoice amounts are sample business records, not app subscription pricing or outcome claims.\n\nRecreate with: \`node output/screenshots/create-smartbill-screenshots.mjs --capture\`. Rendering alone does not launch a browser.\n\nGuidelines: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices#3-screenshots\n`);
console.log(JSON.stringify({ rendered: definitions.length, output, altText: manifest.map(item => ({ file: item.filename, alt: item.alt, characters: item.altCharacters })) }));

if (process.argv.includes('--capture')) {
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  await access(chrome);
  const mobileOnly = process.argv.includes('--mobile-only');
  const selected = mobileOnly ? definitions.filter(item => item.scale === 2) : definitions;
  for (const definition of selected) {
    const imagePath = resolve(output, definition.filename);
    const profilePath = resolve(root, '.cache/smartbill-listing-screenshots', definition.filename.replace('.png', ''));
    await mkdir(profilePath, { recursive: true });
    if (definition.scale === 2) {
      await captureMobile(chrome, definition, profilePath, imagePath);
    } else {
      const args = ['--headless=new', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--force-device-scale-factor=${definition.scale}`, `--window-size=${definition.width},${definition.height}`, `--user-data-dir=${profilePath}`, '--virtual-time-budget=1500', `--screenshot=${imagePath}`, pathToFileURL(definition.html).href];
      await new Promise((complete, reject) => {
        const child = spawn(chrome, args, { windowsHide: true, stdio: 'ignore' });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? complete() : reject(new Error(`Chrome exited with ${code}`)));
      });
    }
    const image = await loadImage(imagePath);
    assert.equal(image.width, definition.width * definition.scale);
    assert.equal(image.height, definition.height * definition.scale);
    const bytes = await readFile(imagePath);
    assert.ok(bytes.length > 10000, 'Screenshot appears empty.');
    console.log(JSON.stringify({ file: imagePath, width: image.width, height: image.height, bytes: bytes.length }));
  }
}

async function captureMobile(chrome, definition, profilePath, imagePath) {
  // Chrome's desktop headless window has a minimum width. Device emulation
  // supplies the actual mobile viewport instead of clipping a wider page.
  const args = ['--headless=new', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profilePath}`, 'about:blank'];
  const child = spawn(chrome, args, { windowsHide: true, stdio: 'ignore' });
  let childError;
  child.on('error', error => { childError = error; });
  let socket;
  let browserSocket;
  try {
    let port;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      try {
        port = Number((await readFile(resolve(profilePath, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) break;
      } catch {}
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(port, 'Headless browser did not expose its local debug port.');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = await connectCdp(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await socket.send('Page.enable');
    await socket.send('Emulation.setDeviceMetricsOverride', { width: definition.width, height: definition.height, deviceScaleFactor: definition.scale, mobile: true });
    await socket.send('Page.navigate', { url: pathToFileURL(definition.html).href });
    await socket.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))', awaitPromise: true, returnByValue: true });
    const layout = await socket.send('Runtime.evaluate', { expression: '({ viewport: innerWidth, document: document.documentElement.scrollWidth, form: !!document.querySelector("input[name=reference]") })', returnByValue: true });
    assert.ok(layout.result.value.form, 'Delivery form did not load.');
    assert.ok(layout.result.value.document <= layout.result.value.viewport, 'Mobile page has horizontal overflow.');
    const screenshot = await socket.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    await writeFile(imagePath, Buffer.from(screenshot.data, 'base64'));
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    browserSocket = await connectCdp(version.webSocketDebuggerUrl);
    await browserSocket.send('Browser.close');
  } finally {
    socket?.close();
    browserSocket?.close();
    if (child.exitCode === null) child.kill();
  }
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const requests = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!requests.has(message.id)) return;
    const request = requests.get(message.id);
    requests.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    },
    close() { socket.close(); },
  };
}
