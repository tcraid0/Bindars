const {
  RECONCILIATION_COALESCE_MS,
} = require("../../.tmp/workspace-tests/src/hooks/useDocumentReconciliation.js");

async function waitForReconciliationWindow() {
  await new Promise((resolve) => setTimeout(
    resolve,
    RECONCILIATION_COALESCE_MS + 10,
  ));
}

module.exports = { waitForReconciliationWindow };
