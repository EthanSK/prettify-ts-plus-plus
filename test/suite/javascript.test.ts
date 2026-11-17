import * as assert from "node:assert";
import * as vscode from "vscode";
import { applySettings, assertHover, ensureTypeScriptServerReady, getHover, openDocument } from "./utils";

suite("JavaScript, JSX and TSX hover support (#90)", () => {
  suiteSetup(async () => ensureTypeScriptServerReady("canary.ts", "ServerReadinessProbe"));
  setup(async () => applySettings({ maxDepth: 3 }));
  teardown(async () => applySettings());

  test("checked JavaScript expands JSDoc aliases", async () => {
    await openDocument("javascript.js");
    assertHover(await getHover("jsModel ="), "const jsModel: { details: { value: string; }; };");
  });

  test("unchecked JSX expands JSDoc aliases", async () => {
    await openDocument("javascriptreact.jsx");
    assertHover(await getHover("jsxModel ="), "const jsxModel: { details: { value: string; }; };");
  });

  test("TSX expands aliases through its real hover provider", async () => {
    await openDocument("typescriptreact.tsx");
    assert.strictEqual(vscode.window.activeTextEditor?.document.languageId, "typescriptreact");
    assertHover(await getHover("tsxModel:"), "const tsxModel: { details: { value: string; }; };");
  });
});
