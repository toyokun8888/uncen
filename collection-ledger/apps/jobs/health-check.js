"use strict";

function main() {
  const result = {
    ok: true,
    app: "collection-ledger",
    layer: "apps/jobs",
    message: "job entry is runnable",
  };

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();

