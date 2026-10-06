import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const root = process.cwd();
const out = resolve(root, 'output/imagegen');
const scratch = resolve(out, 'feature-media-source');
await mkdir(scratch, { recursive: true });
const routeFile = resolve(root, 'app/routes/app.invoices.$id.tsx');
const source = await readFile(routeFile, 'utf8');
const ast = ts.createSourceFile(routeFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const candidates = [];
function visit(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'div') {
    const text = node.getText(ast);
    if (text.includes('Freight, duty and landed cost')) candidates.push(text);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const actualPanel = candidates.sort((a, b) => a.length - b.length)[0];
if (!actualPanel) throw new Error('Actual landed-cost UI not found.');
const entry = `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppProvider, Page, Card, BlockStack, Text, Banner, Badge } from '@shopify/polaris';
import { allocateCharges, allocationSummary, landedUnitCost, LANDED_COST_METHODS, LANDED_COST_METHOD_LABELS } from './app/utils/landedCost';
export function render() {
  const invoice = { currency: 'USD', invoiceNumber: 'SB-1042' };
  const productLines = [
    { id: 'tote', name: 'Linen tote', quantity: 40, price: 6, amount: 240, category: 'PRODUCT' },
    { id: 'cup', name: 'Ceramic cup', quantity: 60, price: 4, amount: 240, category: 'PRODUCT' },
  ];
  const chargeLines = [{ category: 'FREIGHT', amount: 72 }, { category: 'DUTY', amount: 24 }];
  const chargeTotal = 96;
  const landedCostMethod = 'VALUE';
  const result = allocateCharges(productLines, chargeTotal, landedCostMethod);
  const landedCost = {
    summary: allocationSummary(result), warnings: result.warnings,
    lines: productLines.map(line => {
      const allocated = result.allocations.find(a => a.lineId === line.id).amount;
      return { ...line, allocated, landedUnitCost: landedUnitCost(line, allocated) };
    }),
  };
  const landedCostError = '', landedCostMethodWarning = '', locked = false;
  const setDirty = () => {}, setLandedCostMethod = () => {};
  return renderToStaticMarkup(
    <AppProvider i18n={{}}>
      <Page title={'Invoice ' + invoice.invoiceNumber}>
        <BlockStack gap="400">
          <Badge>APPROVED</Badge>
          <Card>${actualPanel}</Card>
        </BlockStack>
      </Page>
    </AppProvider>
  );
}
`;
const bundleFile = resolve(scratch, 'reference-component.mjs');
await build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'feature-reference.tsx', loader: 'tsx' }, outfile: bundleFile, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' });
const { render } = await import(pathToFileURL(bundleFile).href);
const polarisCss = await readFile(resolve(root, 'node_modules/@shopify/polaris/build/esm/styles.css'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${polarisCss}
html,body{margin:0;background:#f1f1f1;}body{padding:18px 12px;} .Polaris-Page{max-width:none;}
</style></head><body>${render()}</body></html>`;
await writeFile(resolve(scratch, 'smartbill-landed-cost-reference.html'), html);
await writeFile(resolve(scratch, 'source-info.json'), JSON.stringify({ source: 'app/routes/app.invoices.$id.tsx', method: 'Actual landed-cost JSX rendered with the installed Polaris components; fictional sample data; no database or network calls.', products: productLinesForNotes() }, null, 2));
function productLinesForNotes() { return [{ product: 'Linen tote', quantity: 40, baseCost: 6, allocatedCharges: 48, landedCost: 7.2 }, { product: 'Ceramic cup', quantity: 60, baseCost: 4, allocatedCharges: 48, landedCost: 4.8 }]; }
console.log(JSON.stringify({ html: resolve(scratch, 'smartbill-landed-cost-reference.html'), actualUiCharacters: actualPanel.length }));
