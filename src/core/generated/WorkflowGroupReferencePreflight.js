(function () {
  "use strict";
  const console = { ...globalThis.console, log() {} };
  const WorkflowEditor = { _TILE_CACHE_MAX: 100 };
  function reader(workflow) {
    return {
      workflow,
      mode: "edit",
      _tileCache: new Map(),
      async _checkRefFilesExist(nodeDataList, { flowApiMode = false } = {}) {
        if (!nodeDataList?.length || typeof MessageBridge === "undefined")
          return null;
        let nodesWithRefs = [];
        for (const data of nodeDataList) {
          if (!data || data.enabled === false) continue;
          if (["chatgpt", "grok", "gemini", "muse"].includes(data.node_type))
            continue;
          if (
            flowApiMode &&
            ["generate", "image"].includes(data.node_type) &&
            (!data.provider || data.provider === "flow")
          )
            continue;
          const refStr = data.ref_file_ids || "";
          if (!refStr) continue;
          const ids = refStr
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s && !s.startsWith("upload_"));
          if (ids.length > 0) {
            nodesWithRefs.push({ data, ids });
          }
        }
        if (nodesWithRefs.length === 0) return null;
        if (typeof MessageBridge.lookupFlowMediaCatalog === "function") {
          const flowNodes = nodesWithRefs.filter(
            ({ data }) =>
              ["generate", "image"].includes(data.node_type) &&
              (!data.provider || data.provider === "flow"),
          );
          if (flowNodes.length) {
            const confirmMountedRefs = async () => {
              if (typeof MessageBridge.checkTilesExist !== "function")
                return false;
              const ids = [...new Set(flowNodes.flatMap((node) => node.ids))];
              try {
                const mounted = await MessageBridge.checkTilesExist(ids);
                if (
                  mounted?.success === false ||
                  mounted?.error ||
                  !Array.isArray(mounted?.existing) ||
                  !Array.isArray(mounted?.missing) ||
                  mounted.missing.length ||
                  !ids.every((id) => mounted.existing.includes(id))
                )
                  return false;
                nodesWithRefs = nodesWithRefs.filter(
                  (node) => !flowNodes.includes(node),
                );
                console.info(
                  "[WorkflowRefPreflight] catalog unavailable; exact mounted refs confirmed",
                  {
                    requested: ids.length,
                    mounted: ids.length,
                    domScan: false,
                    autoReupload: false,
                  },
                );
                return true;
              } catch (error) {
                console.warn(
                  "[WorkflowRefPreflight] mounted ref check unavailable:",
                  error?.code || error?.message,
                );
                return false;
              }
            };
            try {
              const keys = [
                ...new Set(
                  flowNodes
                    .flatMap(({ data, ids }) =>
                      ids.flatMap((id) => {
                        const saved = data.ref_thumbnails?.[id];
                        return [
                          id,
                          data.ref_file_names?.[id],
                          saved?.media_uuid,
                          saved?.persistent_media_id,
                        ];
                      }),
                    )
                    .filter((value) => typeof value === "string" && value),
                ),
              ];
              const catalog = await MessageBridge.lookupFlowMediaCatalog(keys);
              if (!catalog || typeof catalog.supported !== "boolean") {
                console.warn(
                  "[WorkflowRefPreflight] catalog response invalid; no missing-file verdict",
                  JSON.stringify({
                    responseType: typeof catalog,
                    keys:
                      catalog && typeof catalog === "object"
                        ? Object.keys(catalog)
                        : [],
                    error: catalog?.error || null,
                    code: catalog?.code || null,
                  }),
                );
                if (!(await confirmMountedRefs()))
                  return "FLOW_MEDIA_CATALOG_UNAVAILABLE";
                if (!nodesWithRefs.length) return null;
              }
              if (catalog?.supported === true) {
                let known = 0;
                for (const { data, ids } of flowNodes) {
                  for (const id of ids) {
                    const saved = data.ref_thumbnails?.[id];
                    const info = [
                      id,
                      data.ref_file_names?.[id],
                      saved?.media_uuid,
                      saved?.persistent_media_id,
                    ]
                      .map((key) => catalog.known?.[key])
                      .find(Boolean);
                    if (info) {
                      known++;
                      window.MediaRegistry?.setRefIdentity?.(id, info);
                    }
                  }
                }
                const count = flowNodes.reduce(
                  (total, node) => total + node.ids.length,
                  0,
                );
                console.info(
                  "[WorkflowRefPreflight] catalog policy",
                  JSON.stringify({
                    requested: count,
                    known,
                    unknown: count - known,
                    domScan: false,
                    autoReupload: false,
                    existence: "deferred_to_actual_operation",
                  }),
                );
                nodesWithRefs = nodesWithRefs.filter(
                  (node) => !flowNodes.includes(node),
                );
                if (!nodesWithRefs.length) return null;
              }
            } catch (error) {
              console.warn(
                "[WorkflowRefPreflight] catalog unavailable:",
                error?.message,
              );
              if (!(await confirmMountedRefs()))
                return "FLOW_MEDIA_CATALOG_UNAVAILABLE";
              if (!nodesWithRefs.length) return null;
            }
          }
        }
        const allRefIds = [];
        const nodeNames = {};
        for (const { data, ids } of nodesWithRefs) {
          for (const id of ids) {
            allRefIds.push(id);
            nodeNames[id] = data.node_name || data.node_type || "";
          }
        }
        try {
          const result = await MessageBridge.checkTilesExist([
            ...new Set(allRefIds),
          ]);
          const missing = result?.missing || [];
          if (missing.length === 0) return null;
          if (typeof window.reuploadMissingFiles === "function") {
            console.log(
              `[WorkflowEditor] ${missing.length} ref(s) missing, attempting reupload...`,
            );
            const captureVerifiedIds = new Set();
            for (const { data } of nodesWithRefs) {
              const refStr = data.ref_file_ids || "";
              if (!refStr) continue;
              const thumbMap = data.ref_thumbnails || {};
              console.log(
                "[WorkflowEditor] ref_thumbnails for reupload:",
                JSON.stringify(thumbMap),
              );
              const fileNamesMap = data.ref_file_names || {};
              const oldIds = refStr
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              const updated = await window.reuploadMissingFiles(
                refStr,
                thumbMap,
                null,
                fileNamesMap,
                this._workflowUploadOptions(),
              );
              const updatedIds = (updated || "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              const idsChanged =
                oldIds.length !== updatedIds.length ||
                oldIds.some((id, index) => id !== updatedIds[index]);
              const capturedFileNames =
                window._lastReuploadResolvedFileNames instanceof Set
                  ? window._lastReuploadResolvedFileNames
                  : new Set();
              for (let i = 0; i < oldIds.length; i++) {
                const fn = fileNamesMap[oldIds[i]];
                if (fn && capturedFileNames.has(fn))
                  captureVerifiedIds.add(updatedIds[i] || oldIds[i]);
              }
              console.log(
                "[WorkflowEditor] reuploadMissingFiles result:",
                updated,
                "updatedIds:",
                updatedIds,
                "changed:",
                idsChanged,
                "captureVerified:",
                captureVerifiedIds.size,
              );
              if (idsChanged && updatedIds.length > 0) {
                console.log(
                  `[WorkflowEditor] Reupload success for node "${data.node_name || data.node_type}": ${updated.substring(0, 60)}...`,
                );
                data.ref_file_ids = updated;
                const newIds = updated
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                if (!data.ref_thumbnails) data.ref_thumbnails = {};
                if (!data.ref_file_names) data.ref_file_names = {};
                for (let i = 0; i < oldIds.length && i < newIds.length; i++) {
                  if (oldIds[i] !== newIds[i]) {
                    if (data.ref_thumbnails[oldIds[i]]) {
                      data.ref_thumbnails[newIds[i]] =
                        data.ref_thumbnails[oldIds[i]];
                      delete data.ref_thumbnails[oldIds[i]];
                    }
                    if (data.ref_file_names?.[oldIds[i]]) {
                      data.ref_file_names[newIds[i]] =
                        data.ref_file_names[oldIds[i]];
                      delete data.ref_file_names[oldIds[i]];
                    }
                    const reupDetails = window._lastReuploadTileDetails || {};
                    const reupDetail = reupDetails[newIds[i]];
                    const newThumb =
                      reupDetail?.thumbnailUrl ||
                      MediaRegistry.getThumb(newIds[i]);
                    if (newThumb) {
                      const newFnForCache =
                        reupDetail?.file_name ||
                        MediaRegistry.getFileName(newIds[i]) ||
                        null;
                      data.ref_thumbnails[newIds[i]] =
                        reupDetail?.type === "video"
                          ? {
                              thumbnail: newThumb,
                              type: "video",
                              ...(reupDetail?.video_url && {
                                video_url: reupDetail.video_url,
                              }),
                              ...(newFnForCache && {
                                file_name: newFnForCache,
                              }),
                            }
                          : newThumb;
                      this._tileCacheSet(newIds[i], {
                        thumbnail: newThumb,
                        file_name: newFnForCache,
                        type: reupDetail?.type || "image",
                        ...(reupDetail?.video_url && {
                          video_url: reupDetail.video_url,
                        }),
                        _crossProject: false,
                      });
                    }
                    const newFn =
                      reupDetail?.file_name ||
                      MediaRegistry.getFileName(newIds[i]);
                    if (newFn) data.ref_file_names[newIds[i]] = newFn;
                  }
                }
              }
            }
            const updatedAllIds = [];
            for (const { data } of nodesWithRefs) {
              const ids = (data.ref_file_ids || "")
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s && !s.startsWith("upload_"));
              for (const id of ids) {
                updatedAllIds.push(id);
                if (!nodeNames[id])
                  nodeNames[id] = data.node_name || data.node_type || "";
              }
            }
            if (updatedAllIds.length > 0) {
              const idsToRecheck = [...new Set(updatedAllIds)].filter(
                (id) => !captureVerifiedIds.has(id),
              );
              const recheck =
                idsToRecheck.length > 0
                  ? await MessageBridge.checkTilesExist(idsToRecheck)
                  : { missing: [] };
              const stillMissing = recheck?.missing || [];
              if (stillMissing.length === 0) {
                console.log(
                  "[WorkflowEditor] All missing refs resolved (found on Flow or reuploaded)",
                );
                return null;
              }
              const missingNodes2 = [
                ...new Set(
                  stillMissing.map((id) => nodeNames[id]).filter(Boolean),
                ),
              ];
              const nodeInfo2 =
                missingNodes2.length > 0
                  ? ` (${missingNodes2.join(", ")})`
                  : "";
              return (
                window.I18n?.t("workflow.refNotExist", {
                  count: stillMissing.length,
                  nodeInfo: nodeInfo2,
                }) ||
                `${stillMissing.length} reference image(s) no longer exist on Google Flow${nodeInfo2}. Please check and update the images.`
              );
            }
            return null;
          }
          const missingNodes = [
            ...new Set(missing.map((id) => nodeNames[id]).filter(Boolean)),
          ];
          const nodeInfo =
            missingNodes.length > 0 ? ` (${missingNodes.join(", ")})` : "";
          return (
            window.I18n?.t("workflow.refNotExist", {
              count: missing.length,
              nodeInfo,
            }) ||
            `${missing.length} reference image(s) no longer exist on Google Flow${nodeInfo}. Please check and update the images.`
          );
        } catch (e) {
          console.warn("[TobyFlow] Check tiles exist failed:", e.message);
          return null;
        }
      },
      _workflowUploadOptions(extra = {}) {
        return {
          surface: "workflow",
          expectedProjectId:
            this.workflow?.project_id ||
            this.workflow?.projectId ||
            (this.mode === "create" ? window._currentProjectId : null),
          ...extra,
        };
      },
      _tileCacheSet(key, value, options = {}) {
        value = window.flow_uuid_gateway.cacheMetadata(
          this._tileCache.get(key),
          value,
          options,
        );
        if (this._tileCache.has(key)) {
          this._tileCache.delete(key);
        }
        this._tileCache.set(key, value);
        if (this._tileCache.size > WorkflowEditor._TILE_CACHE_MAX) {
          const oldest = this._tileCache.keys().next().value;
          this._tileCache.delete(oldest);
        }
      },
      async _showRefPreflightFailure(message) {
        const unavailable = message === "FLOW_MEDIA_CATALOG_UNAVAILABLE";
        const title = unavailable
          ? window.I18n?.t("workflow.cannotRun") || "Cannot run workflow"
          : window.I18n?.t("workflow.missingRefTitle") ||
            "Missing reference images";
        const detail = unavailable
          ? `${window.I18n?.t("gen.flowNotReady") || "Google Flow is not ready. Please try again."}
(${message})`
          : message;
        await window.customDialog.alert(detail, { type: "warning", title });
      },
    };
  }
  globalThis.WorkflowGroupReferencePreflight = {
    needsFlowActivation: (nodes) =>
      nodes.some((node) =>
        ["generate", "download", "image", "telegram", "delay"].includes(
          node.node_type || node.type,
        ),
      ),
    check: (workflow, nodes, options) =>
      reader(workflow)._checkRefFilesExist(nodes, options),
    showFailure: (message) => reader(null)._showRefPreflightFailure(message),
  };
})();
