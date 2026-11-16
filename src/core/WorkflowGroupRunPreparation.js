(function () {
  "use strict";
  const referenceFields = ["ref_file_ids", "ref_thumbnails", "ref_file_names"];
  const refSnapshot = (node) =>
    JSON.stringify(referenceFields.map((key) => node[key] ?? null));
  const idsEqual = (a, b) =>
    a.length === b.length &&
    [...a].sort().every((id, index) => id === [...b].sort()[index]);
  async function prepare(
    workflow,
    pending,
    { flowApiMode = false, assertCurrent = async () => {} } = {},
  ) {
    const proof = pending.groupReset;
    const startedAt = Date.now();
    const log = (stage) =>
      console.info("[WorkflowGroupRun]", {
        workflowId: workflow.wf_id,
        operationId: proof?.operationId || null,
        stage,
        elapsedMs: Date.now() - startedAt,
      });
    const selected = new Set((pending.onlyNodeIds || []).map(String));
    const nodes = (workflow.nodes || []).filter(
      (node) =>
        selected.has(String(node.node_id)) &&
        node.enabled !== false &&
        !["start", "note"].includes(node.node_type),
    );
    const ids = nodes.map((node) => String(node.node_id));
    if (
      !proof ||
      !ids.length ||
      !Array.isArray(proof.nodeIds) ||
      !idsEqual(ids, proof.nodeIds) ||
      typeof proof.grant !== "string" ||
      !proof.grant ||
      typeof proof.operationId !== "string" ||
      !["https://local.566flow.invalid", "https://566flow.invalid"].includes(
        proof.origin,
      )
    )
      throw Error("INVALID_RESET_SCOPE");
    if (
      !window.WorkflowGroupReferencePreflight ||
      !window.WorkflowSpaceHealthLifecycle?.commitPreparedGroupReset
    )
      throw Error("NATIVE_RESET_CONTEXT_REQUIRED");
    await assertCurrent();
    log("references_requested");
    const before = new Map(
      nodes.map((node) => [node.node_id, refSnapshot(node)]),
    );
    const missing = await window.WorkflowGroupReferencePreflight.check(
      workflow,
      nodes,
      { flowApiMode },
    );
    await assertCurrent();
    if (missing) {
      log("references_rejected");
      await window.WorkflowGroupReferencePreflight.showFailure(missing);
      return false;
    }
    log("references_confirmed");
    for (const node of nodes)
      if (before.get(node.node_id) !== refSnapshot(node)) {
        await assertCurrent();
        const saved = await window.storageManager.updateNodeStatus(
          workflow.wf_id,
          node.node_id,
          Object.fromEntries(
            referenceFields.map((key) => [
              key,
              node[key] ?? (key === "ref_file_ids" ? "" : {}),
            ]),
          ),
        );
        if (
          !saved ||
          String(saved.ref_file_ids || "") !== String(node.ref_file_ids || "")
        )
          throw Error("SAVE_FAILED");
      }
    await assertCurrent();
    if (window.WorkflowGroupReferencePreflight.needsFlowActivation(nodes)) {
      try {
        await chrome.runtime.sendMessage({ action: "ensureFlowTabActive" });
      } catch (_) {}
    }
    await assertCurrent();
    if (window.__flowReloadSyncInProgress === true)
      throw Error("FLOW_RELOAD_IN_PROGRESS");
    log("reset_requested");
    const receipt =
      await window.WorkflowSpaceHealthLifecycle.commitPreparedGroupReset({
        workflowId: workflow.wf_id,
        userId: String(pending.actorUserId),
        operationId: proof.operationId,
        nodeIds: ids,
        grant: proof.grant,
        origin: proof.origin,
      });
    await assertCurrent();
    if (
      receipt?.state !== "committed" ||
      !ids.every((id) =>
        receipt.results?.some(
          (row) =>
            row.nodeId === id && row.ok === true && !row.settlementPending,
        ),
      )
    ) {
      throw Error(receipt?.error || "RESET_NOT_COMPLETED");
    }
    log("reset_committed");
    window.RequestCoalescer?.invalidate?.(`workflows/${workflow.wf_id}`);
    if (window.__flowReloadSyncInProgress === true)
      throw Error("FLOW_RELOAD_IN_PROGRESS");
    log("ready");
    return true;
  }
  window.WorkflowGroupRunPreparation = { prepare };
})();
