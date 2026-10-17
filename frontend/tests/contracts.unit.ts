import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExtraction } from "../src/invoices/types";
import { documentSuggestions, mergeDocumentSuggestions } from "../src/invoices/documentAutofill";
import { api, ApiError, setSessionToken, setWorkspaceId, scopedUrl } from "../src/lib/api";

test("extraction boundary rejects invalid money, unsupported VAT and missing document IDs", () => {
  for (const raw of [
    {fields: {}}, {id: "doc", fields: {withholding: "10.00"}},
    {id: "doc", fields: {lines: [{base: 10.5, vat_rate: 21}]}},
    {id: "doc", fields: {lines: [{base: 1000, vat_rate: 99}]}},
    {id: "doc", classification: {document_type: "invoice", issuer_country: "invalid"}},
  ]) assert.throws(() => parseExtraction(raw), /Tus cambios se conservan/);
});

test("untrusted status cannot confirm an invoice; valid zero amounts remain suggestions", () => {
  const result = parseExtraction({id: "doc", fields: {number: "SYN-1", withholding: 0, status: "confirmed"}});
  assert.deepEqual(documentSuggestions(result, "expense"), {number: "SYN-1", withholding: "0.00"});
  const form = {kind: "expense" as const, status: "draft" as const, number: "manual"};
  assert.equal(mergeDocumentSuggestions(form, result, new Set(["number"])).status, "draft");
  assert.equal(mergeDocumentSuggestions(form, result, new Set(["number"])).number, "manual");
});

test("transport applies CSRF/workspace headers and leaves multipart boundaries to the browser", async () => {
  const original = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, options) => { calls.push(options!); return new Response('{"ok":true}'); };
  try {
    setSessionToken("csrf-test"); setWorkspaceId("client / 1");
    await api("/invoices", {method: "POST", body: "{}", headers: new Headers({"X-Test": "yes"})});
    await api("/documents", {method: "POST", body: new FormData()});
    const headers = new Headers(calls[0].headers);
    assert.equal(headers.get("X-CSRF-Token"), "csrf-test");
    assert.equal(headers.get("X-Workspace-Id"), "client / 1");
    assert.equal(headers.get("X-Test"), "yes");
    assert.equal(new Headers(calls[1].headers).has("Content-Type"), false);
    assert.equal(scopedUrl("/api/export?year=2026"), "/api/export?year=2026&workspace=client%20%2F%201");
    setSessionToken("");
    assert.equal(scopedUrl("/api/export"), "/api/export?workspace=");
  } finally { globalThis.fetch = original; setSessionToken(""); }
});

test("transport normalizes non-JSON errors without exposing server HTML", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>internal error</html>", {status: 503});
  try {
    await assert.rejects(api("/invoices"), (error: unknown) => error instanceof ApiError && error.status === 503 && !error.message.includes("html"));
  } finally { globalThis.fetch = original; }
});
