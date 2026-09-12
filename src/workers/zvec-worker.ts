/**
 * Owned zvec worker process. Runs one bounded request read from argv, prints
 * one JSON line to stdout and exits. The parent enforces timeout by killing
 * this process; a changed index identity invalidates the semantic result.
 *
 * Only the lexical (`rg`) route is used: vector retrieval is blocked pending a
 * verified offline model contract upstream (design stage-0 gate). No index
 * creation, update or drop happens here; `autoUpdate: false` always.
 */

type WorkerRequest = {
  root: string;
  query: string;
  limit: number;
  mode: "search" | "info";
};

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) throw new Error("missing request argument");
  const req = JSON.parse(raw) as WorkerRequest;

  const mod = await import("@zvec/zvec-grep");
  const zg = await mod.createZvecGrep({ root: req.root });
  try {
    if (req.mode === "info") {
      const info = await zg.info({ root: req.root });
      process.stdout.write(
        JSON.stringify({
          ok: true,
          info: {
            root: info.root,
            indexed: info.indexed,
            indexPolicy: info.indexPolicy,
            indexPath: info.indexPath,
            source: info.source,
          },
        }) + "\n",
      );
      return;
    }
    const result = await zg.context({
      query: req.query,
      root: req.root,
      rg: true, // lexical route: no embedding model is initialized
      autoUpdate: false, // never refresh an index from the retrieval path
      limit: req.limit,
    });
    const items = (result.items ?? [])
      .slice(0, req.limit)
      .map((it: { file?: { absolutePath?: string; relativePath?: string } }) => ({
        absolutePath: it.file?.absolutePath ?? null,
        relativePath: it.file?.relativePath ?? null,
      }));
    process.stdout.write(JSON.stringify({ ok: true, items, root: req.root }) + "\n");
  } finally {
    if (typeof (zg as { close?: () => Promise<void> }).close === "function") {
      await (zg as unknown as { close: () => Promise<void> }).close();
    }
  }
}

main().catch((e: unknown) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String((e as Error).message) }) + "\n");
  process.exit(1);
});
