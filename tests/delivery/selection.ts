// Shared by the delivery tests (tests/delivery/batch.test.ts, deploy.test.ts):
// which test files a workflow step executes, resolved the way npm and node do.
import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";

export const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
type Obj = Record<string, any>;

/** Split a shell command line into words, honouring single and double quotes (no expansion). */
export function words(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/**
 * The test files a workflow `run:` command executes: `npm test` and `npm run <script>` resolve through
 * package.json's scripts, and `node --test <patterns>` expands its patterns the way node does (fs.globSync
 * from the repository root). Any other command executes no test file.
 */
export function testSelection(command: string, scripts: Record<string, string>, seen: string[] = []): string[] {
  const files = new Set<string>();
  for (const part of command.split(/\n|&&|\|\||;/)) {
    const w = words(part.trim());
    let script: string | undefined;
    if (w[0] === "npm" && (w[1] === "test" || w[1] === "t")) script = "test";
    else if (w[0] === "npm" && (w[1] === "run" || w[1] === "run-script") && w[2]) script = w[2];
    if (script !== undefined) {
      if (seen.includes(script)) throw new Error(`npm script ${script} runs itself`);
      const body = scripts[script];
      if (body === undefined) throw new Error(`no npm script ${script}`);
      for (const f of testSelection(body, scripts, [...seen, script])) files.add(f);
      continue;
    }
    if (w[0] === "node" && w.includes("--test")) {
      for (const arg of w.slice(1).filter((a) => !a.startsWith("-"))) {
        for (const f of globSync(arg, { cwd: repoRoot })) files.add(f.split("\\").join("/"));
      }
    }
  }
  return [...files].sort();
}

/** Every `run:` command of a workflow's jobs, keyed by job. */
export function runCommands(wf: Obj): Array<{ job: string; run: string }> {
  const out: Array<{ job: string; run: string }> = [];
  for (const [job, spec] of Object.entries((wf["jobs"] ?? {}) as Obj)) {
    for (const step of ((spec as Obj)["steps"] ?? []) as Obj[]) if (typeof step["run"] === "string") out.push({ job, run: step["run"] });
  }
  return out;
}
