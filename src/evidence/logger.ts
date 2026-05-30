// JSONL evidence log. Every MCP tool call writes exactly one line here
// before returning to the caller. If the write fails we throw — tools must
// fail closed so that we never report success without a durable trace.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Compiled file lives at dist/evidence/logger.js → project root is two up.
const PROJECT_ROOT = join(here, "..", "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "output");
const SCREENSHOTS_DIR = join(OUTPUT_DIR, "screenshots");
const EVIDENCE_PATH = join(OUTPUT_DIR, "evidence.jsonl");

export type EvidenceEntry = {
  ts: string;
  tool: string;
  input: unknown;
  ok: boolean;
  summary: string;
  screenshot: string | null;
  error: string | null;
};

let dirsEnsured = false;

async function ensureDirs(): Promise<void> {
  if (dirsEnsured) return;
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  dirsEnsured = true;
}

export async function logEvidence(entry: EvidenceEntry): Promise<void> {
  await ensureDirs();
  await appendFile(EVIDENCE_PATH, JSON.stringify(entry) + "\n", "utf8");
}

export function getScreenshotsDir(): string {
  return SCREENSHOTS_DIR;
}
