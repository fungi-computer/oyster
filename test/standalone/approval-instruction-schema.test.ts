import { resolve } from "node:path";
import * as ts from "typescript";
import { expect, it } from "vitest";
import { appApprovalInstructions } from "../../src/mcp.js";

function declaration(instructions: string): string {
  const start = instructions.indexOf("type AppApprovalResult");
  if (start < 0) throw new Error("Approval result guidance is missing");
  // TypeScript, not a second type grammar, determines the declaration's end.
  const source = ts.createSourceFile(
    "approval-guidance.ts",
    instructions.slice(start),
    ts.ScriptTarget.Latest,
    true,
  );
  const alias = source.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "AppApprovalResult",
  );
  if (alias === undefined) throw new Error("Approval result type is missing");
  return alias.getText(source);
}

function contract(instructions: string): string {
  return `
import type {
  PendingApprovalSchema,
  ApprovalRefusalSchema,
} from "@fungi.computer/approvals";
${declaration(instructions)}
type Pending = typeof PendingApprovalSchema.Type;
type Refusal = typeof ApprovalRefusalSchema.Type;
// Guidance describes mutable JSON, not the owner's readonly representation.
type Mutable<T> = { -readonly [K in keyof T]:
  T[K] extends object ? Mutable<T[K]> : T[K] };
// The approved display intentionally says reason: string. Runtime keeps the
// owning closed refusal vocabulary; no other field or optionality is widened.
type Expected = Mutable<Pending | (Omit<Refusal, "reason"> & { reason: string })>;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Require<T extends true> = T;
type Contract = Require<Equal<AppApprovalResult, Expected>>;
`;
}

it("keeps approval guidance fields and optionality aligned with the owning schemas", () => {
  const cases = [
    { name: "current", text: appApprovalInstructions, valid: true },
    {
      name: "missing-record-id",
      text: appApprovalInstructions.replace("recordId: string; ", ""),
      valid: false,
    },
    {
      name: "required-denial-note",
      text: appApprovalInstructions.replace("denialNote?:", "denialNote:"),
      valid: false,
    },
    {
      name: "optional-description-title",
      text: appApprovalInstructions.replace("title: string", "title?: string"),
      valid: false,
    },
  ];
  const sources = new Map(
    cases.map(({ name, text }) => [
      resolve(import.meta.dirname, `approval-contract-${name}.ts`),
      contract(text),
    ]),
  );
  const options: ts.CompilerOptions = {
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, fresh) => {
    const text = sources.get(resolve(name));
    return text === undefined
      ? readSource(name, version, onError, fresh)
      : ts.createSourceFile(name, text, version, true);
  };
  // One maintained compiler/checker graph for the real text and stale-text
  // controls. No files are emitted and no schema or instruction is modified.
  const program = ts.createProgram([...sources.keys()], options, host);
  for (const { name, valid } of cases) {
    const source = program.getSourceFile(
      resolve(import.meta.dirname, `approval-contract-${name}.ts`),
    );
    expect(source, name).toBeDefined();
    const diagnostics = ts.getPreEmitDiagnostics(program, source);
    const messages = diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
    if (valid) expect(messages, name).toEqual([]);
    else {
      expect(diagnostics, name).toHaveLength(1);
      expect(diagnostics[0]?.code, name).toBe(2344);
    }
  }
});
