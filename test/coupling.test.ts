/// <reference types="vite/client" />

/**
 * Isolation guards for PRD NFR1 and NFR3.
 *
 * This repository must import nothing from the Agent package or the Judge
 * repository and must carry no TypeSafe key name. Those rules were prose until
 * now; `checkCoupling` turns them into a scan over every file under `src/`
 * plus the dependency blocks of `package.json`, so a convenience import or a
 * copied secret name fails the test run instead of slipping through review.
 *
 * The scan matches import and require specifier forms rather than any
 * occurrence of a word, so a code comment may mention the agents package in
 * prose without tripping the guard. Documentation is deliberately out of
 * scope: the packet contract names the Judge repository on purpose.
 */

import { describe, expect, it } from "vitest";

import manifestSource from "../package.json?raw";
import configSource from "../src/config.ts?raw";

/**
 * Every TypeScript file under `src/`, keyed by repository-relative path.
 * Vite resolves the glob from disk at load time and never descends into
 * `node_modules` or `.wrangler`, and the negative patterns make that explicit.
 */
const SOURCE_TREE: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob(["../src/**/*.ts", "!**/node_modules/**", "!**/.wrangler/**"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  ).map(([key, source]) => [key.replace(/^\.\.\//, ""), source]),
);

/** Configuration names this repository owns; the guard must keep seeing them declared. */
const ALLOWED_CONFIG_NAMES = ["JUDGE_FIREHOSE_URL", "JUDGE_INGEST_TOKEN", "DEMO_ORIGIN_ALLOWLIST"] as const;

/** Name of this repository; a specifier naming it is not a Judge import. */
const SELF_PACKAGE = "otel-judge-firehose";

/** The one exact key name PRD NFR1 forbids, plus any identifier that carries the vendor name. */
const FORBIDDEN_KEY_PATTERN = /\bTYPESAFE_API_KEY\b|[A-Za-z0-9_]*typesafe[A-Za-z0-9_]*/gi;

interface Violation {
  readonly file: string;
  readonly kind: "agents-import" | "judge-import" | "escaping-import" | "forbidden-key" | "forbidden-dependency";
  readonly detail: string;
}

interface CouplingReport {
  readonly filesScanned: number;
  readonly violations: readonly Violation[];
}

/** Pulls every module specifier out of import, export-from, dynamic import, and require forms. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.push(match[1] as string);
    }
  }
  return found;
}

/** Resolves a relative specifier against its importing file using POSIX rules, without Node's path module. */
function resolveRelative(file: string, specifier: string): string {
  const segments = file.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (segments.length === 0) {
        return "..";
      }
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join("/");
}

function isAgentsPackage(specifier: string): boolean {
  return specifier === "agents" || specifier.startsWith("agents/");
}

function isJudgeRepository(specifier: string): boolean {
  return specifier.includes("otel-judge") && !specifier.includes(SELF_PACKAGE);
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function importViolations(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  for (const specifier of importSpecifiers(source)) {
    if (isAgentsPackage(specifier)) {
      violations.push({ file, kind: "agents-import", detail: specifier });
    } else if (isJudgeRepository(specifier)) {
      violations.push({ file, kind: "judge-import", detail: specifier });
    } else if (isRelative(specifier)) {
      const resolved = resolveRelative(file, specifier);
      if (resolved === ".." || resolved.startsWith("../") || !resolved.startsWith("src/")) {
        violations.push({ file, kind: "escaping-import", detail: specifier });
      }
    }
  }
  return violations;
}

function keyViolations(file: string, text: string): Violation[] {
  const matches = new Set([...text.matchAll(FORBIDDEN_KEY_PATTERN)].map((match) => match[0]));
  return [...matches].map((detail) => ({ file, kind: "forbidden-key", detail }));
}

function dependencyViolations(manifest: string): Violation[] {
  const parsed = JSON.parse(manifest) as Record<string, unknown>;
  const violations: Violation[] = [];
  for (const block of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const entries = parsed[block];
    if (typeof entries !== "object" || entries === null) {
      continue;
    }
    for (const name of Object.keys(entries)) {
      if (isAgentsPackage(name) || isJudgeRepository(name)) {
        violations.push({ file: "package.json", kind: "forbidden-dependency", detail: `${block}.${name}` });
      }
    }
  }
  return violations;
}

/**
 * Runs every guard over a source tree and a manifest. An empty tree is a pass,
 * not an error: there is nothing to couple.
 */
function checkCoupling(tree: Record<string, string>, manifest: string): CouplingReport {
  const violations: Violation[] = [];
  const files = Object.keys(tree).sort();
  for (const file of files) {
    const source = tree[file] as string;
    violations.push(...importViolations(file, source), ...keyViolations(file, source));
  }
  violations.push(...dependencyViolations(manifest), ...keyViolations("package.json", manifest));
  return { filesScanned: files.length, violations };
}

function withFile(tree: Record<string, string>, file: string, source: string): Record<string, string> {
  return { ...tree, [file]: source };
}

describe("coupling guard", () => {
  it("no forbidden imports: the current source tree and manifest pass", () => {
    const report = checkCoupling(SOURCE_TREE, manifestSource);
    console.info(`coupling guard scanned ${report.filesScanned} source files under src/`);
    expect(report.filesScanned).toBeGreaterThan(0);
    expect(report.violations).toEqual([]);
  });

  it("no forbidden imports: an empty source tree passes rather than errors", () => {
    const report = checkCoupling({}, manifestSource);
    expect(report.filesScanned).toBe(0);
    expect(report.violations).toEqual([]);
  });

  it("no forbidden imports: a comment mentioning the agents package in prose does not trip the guard", () => {
    const source = "// This Worker never imports from the agents package or otel-judge.\nexport const x = 1;\n";
    const report = checkCoupling(withFile({}, "src/prose.ts", source), manifestSource);
    expect(report.violations).toEqual([]);
  });

  it("detects agent import: a static import from the agents package fails", () => {
    const source = 'import { Agent } from "agents";\nexport class Bad extends Agent {}\n';
    const report = checkCoupling(withFile(SOURCE_TREE, "src/bad/agent.ts", source), manifestSource);
    expect(report.violations).toEqual([{ file: "src/bad/agent.ts", kind: "agents-import", detail: "agents" }]);
  });

  it("detects agent import: subpath, dynamic, and require forms fail too", () => {
    const source = [
      'import type { Env } from "agents/env";',
      'const mod = await import("agents/mcp");',
      'const legacy = require("agents");',
    ].join("\n");
    const report = checkCoupling(withFile({}, "src/bad/forms.ts", source), manifestSource);
    expect(report.violations.map((violation) => violation.detail)).toEqual(["agents/env", "agents/mcp", "agents"]);
    expect(report.violations.every((violation) => violation.kind === "agents-import")).toBe(true);
  });

  it("detects agent import: a Judge repository specifier and an escaping relative import fail", () => {
    const source = [
      'import { PacketSchema } from "otel-judge/src/schema";',
      'import { shared } from "../../shared/util";',
      'import { ok } from "../config";',
    ].join("\n");
    const report = checkCoupling(withFile({}, "src/bad/judge.ts", source), manifestSource);
    expect(report.violations.map((violation) => violation.kind)).toEqual(["judge-import", "escaping-import"]);
  });

  it("detects agent import: an agents or otel-judge dependency in the manifest fails", () => {
    const manifest = JSON.stringify({
      dependencies: { zod: "^4.0.0", agents: "^0.1.0" },
      devDependencies: { "otel-judge": "file:../otel-judge" },
    });
    const report = checkCoupling({}, manifest);
    expect(report.violations.map((violation) => violation.detail)).toEqual([
      "dependencies.agents",
      "devDependencies.otel-judge",
    ]);
  });

  it("detects forbidden key: a TypeSafe key identifier in a source file fails", () => {
    const source = 'export const key = env.TYPESAFE_API_KEY;\nconst other = typeSafeSecret;\n';
    const report = checkCoupling(withFile({}, "src/bad/key.ts", source), manifestSource);
    expect(report.violations.map((violation) => violation.detail)).toEqual(["TYPESAFE_API_KEY", "typeSafeSecret"]);
    expect(report.violations.every((violation) => violation.kind === "forbidden-key")).toBe(true);
  });

  it("detects forbidden key: a TypeSafe identifier in the manifest fails", () => {
    const manifest = JSON.stringify({ name: SELF_PACKAGE, config: { TYPESAFE_API_KEY: "" } });
    const report = checkCoupling({}, manifest);
    expect(report.violations).toEqual([{ file: "package.json", kind: "forbidden-key", detail: "TYPESAFE_API_KEY" }]);
  });

  it("allowed config names: this repository's own variables are still declared in src/config.ts", () => {
    expect(SOURCE_TREE["src/config.ts"]).toBe(configSource);
    for (const name of ALLOWED_CONFIG_NAMES) {
      expect(configSource).toMatch(new RegExp(`^\\s+${name}\\?: string;`, "m"));
    }
    expect(checkCoupling({ "src/config.ts": configSource }, manifestSource).violations).toEqual([]);
  });
});
