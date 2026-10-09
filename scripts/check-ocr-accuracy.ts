import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseInvoiceText } from "../app/utils/parser.server";
import { compareInvoice, parsedValues, validateExpected, type AccuracyCase } from "./ocr-accuracy/evaluate";

const args = process.argv.slice(2);
function option(name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return args[index + 1];
}

try {
  const fixturePath = resolve(option("--fixture") || "scripts/ocr-accuracy/cases.json");
  const fixtures: AccuracyCase[] = JSON.parse(await readFile(fixturePath, "utf8"));
  if (!Array.isArray(fixtures) || !fixtures.length) throw new Error("At least one accuracy case is required.");
  const selected = option("--case");
  const cases = selected ? fixtures.filter((entry) => entry.id === selected) : fixtures;
  if (!cases.length) throw new Error("Requested accuracy case was not found.");
  const evidencePath = option("--evidence");
  if (evidencePath && cases.length !== 1) throw new Error("Select one --case for live evidence.");
  const evidence = evidencePath ? JSON.parse(await readFile(resolve(evidencePath), "utf8")) : null;
  if (evidence && (evidence.kind !== "live-invoice-snapshot" || typeof evidence.rawText !== "string" || !Number.isInteger(evidence.revision))) {
    throw new Error("Live evidence must be a captured invoice snapshot.");
  }
  const ids = new Set<string>();
  const results = cases.map((entry) => {
    if (!entry.id || ids.has(entry.id) || !entry.source || !["DMY", "MDY"].includes(entry.dateOrder) || typeof entry.rawText !== "string" || !entry.rawText.trim()) {
      throw new Error("Accuracy cases need a unique id, source, dateOrder and rawText.");
    }
    ids.add(entry.id);
    validateExpected(entry.expected);
    const parsed = parseInvoiceText(evidence?.rawText ?? entry.rawText, evidence?.dateOrder ?? entry.dateOrder);
    const comparison = compareInvoice(entry.expected, parsedValues(parsed));
    const missingWarnings = (entry.requiredWarnings || []).filter((pattern) =>
      !parsed.warnings?.some((warning) => new RegExp(pattern, "i").test(warning)),
    );
    const persisted = evidence ? compareInvoice(entry.expected, evidence.persisted, true) : null;
    return {
      id: entry.id, source: entry.source,
      mode: evidence ? "CURRENT_PARSER_REPLAY_OF_STORED_OCR" : "PARSER_REGRESSION",
      ...comparison,
      result: comparison.result === "PASS" && !missingWarnings.length && (!persisted || persisted.result === "PASS") ? "PASS" : "FAIL",
      warnings: parsed.warnings || [], missingWarnings,
      persistedState: persisted ? { ...persisted, revision: evidence.revision, phase: evidence.revision === 0 ? "UNEDITED" : "REVIEWED" } : null,
      // These commands do not observe the browser or independently read the
      // original document. A live MCP review must supply that separate evidence.
      initialLiveUiAccuracy: "UNVERIFIED_BY_THIS_COMMAND",
    };
  });
  let commit = "unknown";
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* Non-git checkout. */ }
  const report = {
    runId: randomUUID(), observedAt: new Date().toISOString(), commit,
    parserSourceSha256: createHash("sha256").update(await readFile("app/utils/parser.server.ts")).digest("hex"),
    scope: "Exact expected-field comparison; not an OCR confidence score or a claim of accuracy on untested documents.",
    caseCount: results.length,
    passedCases: results.filter((entry) => entry.result === "PASS").length,
    failedCases: results.filter((entry) => entry.result === "FAIL").length,
    evidence: evidence ? { capturedAt: evidence.capturedAt, invoiceId: evidence.invoiceId, shop: evidence.shop, revision: evidence.revision } : null,
    results,
  };
  const output = resolve(".cache/ocr-accuracy/runs", `${report.observedAt.replace(/[:.]/g, "-")}-${report.runId}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ caseCount: report.caseCount, passedCases: report.passedCases, failedCases: report.failedCases, report: output }, null, 2));
  for (const result of results) console.log(`${result.id}: ${result.result} (${result.matchedFields}/${result.checkedFields} fields), ${result.warnings.length} review warning(s)`);
  if (report.failedCases) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "OCR accuracy check failed.");
  process.exitCode = 1;
}
