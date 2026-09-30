import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsVault } from "../src/vault/FsVault.js";

const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-search-"));
const target = "akkio/supplemental-info/horizon-staging-lidl-demo-claim-race-2026-09-22.md";

try {
  await writeNote(target, `---
title: Horizon staging Lidl Demo claim race
created: "2026-09-23"
tags:
  - type/learning
  - tech/temporal
  - tech/datadog
  - client/horizon
aliases:
  - lidl demo supplemental info race
  - nvf5j activity claim race
---

Staging failed on Lidl Demo because Temporal kept a Started lease on a process that died before the activity function ran. This is not the KEDA scale-down failure mode.

## What happened

- Temporal marked the activity Started on pod nvf5j. That pod had been up for about 2 seconds.
- Kubernetes sent SIGTERM. The worker logged that it would wait 1:00:00, then exited in 14ms. No "activity started" log.

## Why the hour did not apply

graceful_shutdown_timeout is a deadline for activities already in the running set. A task that Temporal has marked Started, but that Python has not entered, is in neither the poll-queue drain nor the running set.
`);
  await writeNote("akkio/supplemental-info/supplemental-info-refresh-failure-modes.md", `---
title: Supplemental info refresh failure modes
created: "2026-09-10"
tags:
  - tech/temporal
  - tech/keda
---

# Failure mode 8 — KEDA scales down after an Activity leaves queued backlog

KEDA reads Temporal queue backlog. When the backlog drains, the worker deployment scales down and the pod shuts down while activities are running. Graceful shutdown waits for running activities.
`);
  await writeNote("akkio/temporal-worker-runbook.md", `---
title: Temporal worker runbook
created: "2026-08-01"
tags:
  - tech/temporal
---

Restart a Temporal worker with kubectl. Check worker logs for activity errors and poll the task queue response times.
`);
  for (let day = 1; day <= 22; day += 1) {
    const date = `2026-09-${String(day).padStart(2, "0")}`;
    await writeNote(`00 Capture/${date}.md`, `---
title: "${date}"
created: "${date}"
type: daily
tags:
  - type/daily
---

## Focus

- Review audience-distribution alerts and close stale connector tickets.

## Work

### Agent session — Temporal supplemental refresh check
- **Outcome:** Temporal worker restarted; supplemental activity queue drained. Temporal dashboards looked normal. Temporal shutdown was clean.
- **Learned:** Temporal activity logs are noisy. Worker started, activity started, worker exited.

### Meeting — weekly sync
- **Outcome:** Connector report-type PR approved. Slow chat and SQL tickets stay with data modeling. Audience alerts need an owner.
- **Commitments:** Write up agentic chat tool forcing; start a thread on alert noise; review dashboard costs.

## Personal

- Groceries, gym, and a call with family.
`);
  }
  await writeNote("00 Capture/2026-09-23.md", `# 2026-09-23

## Work

### Agent session — Staging Lidl Demo supplemental-info lost before the activity ran
- **Outcome:** The 60-minute drain did not cause it.
- **Promoted:** [[akkio/supplemental-info/horizon-staging-lidl-demo-claim-race-2026-09-22]]
`);

  const vault = new FsVault(root, "00 Capture");
  await vault.init();

  for (const query of [
    "worker claimed activity but exited before running it",
    "Temporal shutdown race",
    "activity marked Started but no activity-start log",
    "poll response claim race"
  ]) {
    const search = await vault.searchSimple(query, 100, 5);
    assert.equal(search.result[0]?.filename, target, `${query}: ${search.result.map((item) => item.filename).join(", ")}`);
  }

  const aliasSearch = await vault.searchSimple("nvf5j claim race", 80, 3);
  const aliasHit = aliasSearch.result[0];
  assert.equal(aliasHit?.filename, target);
  assert.equal(aliasHit.title, "Horizon staging Lidl Demo claim race");
  assert.equal(aliasHit.date, "2026-09-23");
  assert(aliasHit.reasons.some((reason) => reason.startsWith("title matches: claim, race")));
  assert(aliasHit.reasons.some((reason) => reason.startsWith(`alias "nvf5j activity claim race"`)));
  assert(aliasHit.matches.some((match) => match.heading === "What happened" && match.context.includes("nvf5j")));

  const firstPage = await vault.searchSimple("Temporal", 50, 15);
  assert.equal(firstPage.result.length, 15);
  assert.equal(firstPage.total, 25);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.nextOffset, 15);
  assert(firstPage.result.slice(0, 3).every((item) => !item.filename.startsWith("00 Capture/")), firstPage.result.map((item) => item.filename).join(", "));
  const secondPage = await vault.searchSimple("Temporal", 50, 15, { offset: 15 });
  assert.equal(secondPage.result.length, 10);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.nextOffset, undefined);
  const pages = [...firstPage.result, ...secondPage.result].map((item) => item.filename);
  assert.equal(new Set(pages).size, 25);
  assert(pages.includes(target));

  const tagged = await vault.searchSimple("Temporal", 50, 50, { tag: "#tech/temporal" });
  assert.deepEqual(tagged.result.map((item) => item.filename).sort(), [
    "akkio/supplemental-info/horizon-staging-lidl-demo-claim-race-2026-09-22.md",
    "akkio/supplemental-info/supplemental-info-refresh-failure-modes.md",
    "akkio/temporal-worker-runbook.md"
  ]);
  assert.equal((await vault.searchSimple("Temporal", 50, 50, { tag: "tech" })).total, 3);
  const captures = await vault.searchSimple("Temporal", 50, 50, { pathGlob: "00 Capture/**" });
  assert.equal(captures.total, 22);
  assert(captures.result.every((item) => item.filename.startsWith("00 Capture/")));
  const dated = await vault.searchSimple("Temporal", 50, 50, { after: "2026-09-20", before: "2026-09-23" });
  assert.deepEqual(dated.result.map((item) => item.date).sort(), ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"]);

  const legacy = await vault.searchSimple("claim-race", 20, 100);
  const legacyHit = legacy.result.find((item) => item.filename === target);
  assert(legacyHit);
  assert(legacyHit.reasons.includes("contains the exact query text"));
  const filenameMatch = legacyHit.matches.find((match) => match.match.source === "filename");
  assert.deepEqual(filenameMatch?.match, { start: 26, end: 36, source: "filename" });
  const phrase = await vault.searchSimple("Started lease", 20, 100);
  const phraseHit = phrase.result.find((item) => item.filename === target);
  const contentMatch = phraseHit?.matches.find((match) => match.match.source === "content");
  assert(contentMatch);
  assert.equal(contentMatch.match.end - contentMatch.match.start, "Started lease".length);
  assert.match(contentMatch.context, /Started lease/);

  const stopwordsOnly = await vault.searchSimple("is in", 20, 100);
  assert(stopwordsOnly.total > 0);
  assert(stopwordsOnly.result.every((item) => item.reasons.includes("contains the exact query text")));

  console.log("search ranking ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function writeNote(relative: string, content: string): Promise<void> {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}
