export const NATIVE_SPACE_DOWNLOAD_METHODS = {
  async _downloadProviderTile(
    fileId,
    providerData,
    promptText,
    index,
    nodeData,
    fileName,
    resolution = "native",
    watermarkMode = "inherit",
    plannedFilename = null,
    cancellation = null,
  ) {
    const { url, provider, media_type, durable_url } = providerData;
    const effectiveMediaType =
      media_type === "video" || this._isTileVideo(fileId) ? "video" : "image";
    if (provider === "flow") fileId = providerData.media_uuid || fileId;
    let dlUrl = provider === "flow" && durable_url ? durable_url : url;
    const ext = effectiveMediaType === "video" ? "mp4" : "png";
    let resolvedFlowBlobUrl = null;
    try {
      const normalizedRes = String(resolution || "native").toLowerCase();
      const downloadRoute =
        provider === "flow"
          ? window.ProviderConfigManager?.getDownloadResolutionRouteSync?.(
              "flow",
              effectiveMediaType,
              normalizedRes,
            ) || null
          : "native";
      if (provider === "flow" && !downloadRoute) return false;
      const wantsUpscale = provider === "flow" && downloadRoute === "upscale";
      if (provider === "flow") {
        const gate = await window.FlowApiFacade?.checkDownloadReady?.({
          mediaId: fileId,
          mediaType: effectiveMediaType,
          providerData,
          requireUpscale: wantsUpscale,
          surface: "workflow",
          forWorkflow: true,
        });
        if (!gate?.ready) {
          console.warn(
            "[TobyFlow] Flow API manual download preflight blocked:",
            gate?.reason || "unavailable",
          );
          return false;
        }
        console.log("[TobyFlow] Flow API manual download route:", {
          fileId,
          mediaType: effectiveMediaType,
          resolution: normalizedRes,
          route: wantsUpscale ? "upscale" : "native",
          mediaTypeSource: media_type ? "provider" : "tile-cache",
        });
      }
      if (wantsUpscale) {
        if (cancellation?.abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
        const upOk = await this._downloadFlowUpscaledTile(
          fileId,
          { ...providerData, media_type: effectiveMediaType },
          normalizedRes,
          promptText,
          index,
          nodeData,
          watermarkMode,
          plannedFilename,
          cancellation,
        );
        if (upOk) return true;
        console.warn(
          `[TobyFlow] Flow API manual upscale ${normalizedRes} failed; native download suppressed`,
        );
        return false;
      }
      const hasFlowProviderUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          String(fileId || ""),
        );
      if (
        provider === "flow" &&
        (hasFlowProviderUuid ||
          !dlUrl ||
          dlUrl.includes("media.getMediaUrlRedirect"))
      ) {
        const resolved = await window.FlowApiFacade?.resolveDownload?.({
          mediaId: fileId,
          mediaType: effectiveMediaType,
          providerData,
        });
        if (resolved?.base64) {
          const binary = atob(resolved.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++)
            bytes[i] = binary.charCodeAt(i);
          const resolvedBlob = new Blob([bytes], {
            type:
              resolved.mime ||
              (effectiveMediaType === "video" ? "video/mp4" : "image/jpeg"),
          });
          resolvedFlowBlobUrl = URL.createObjectURL(resolvedBlob);
          dlUrl = resolvedFlowBlobUrl;
        } else {
          dlUrl = resolved?.url || null;
        }
        console.log("[TobyFlow] Flow API native media resolved", {
          mediaType: effectiveMediaType,
          hasUrl: !!dlUrl,
          fromUuid: true,
        });
      }
      if (!dlUrl) {
        console.warn("[TobyFlow] _downloadProviderTile: native URL missing", {
          fileId,
          provider,
        });
        return false;
      }
      const _dlSet = await window.DownloadHelper.getSettings();
      let filename =
        plannedFilename ||
        window.DownloadHelper.buildFilename({
          template: _dlSet.template,
          project: _dlSet.project,
          prompt: promptText,
          index,
          taskName: this.workflow?.wf_name || null,
          folder: _dlSet.folder,
          ext,
        });
      if (
        provider === "flow" &&
        effectiveMediaType !== "video" &&
        !wantsUpscale
      ) {
        filename = filename.replace(/\.png$/i, "");
      }
      if (provider === "gemini") {
        const queried = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { action: "queryProviderTabs", provider: "gemini" },
            (value) => resolve(value),
          );
        });
        const geminiTabId = queried?.tabs?.[0]?.id ?? null;
        if (!geminiTabId) {
          window.showNotification?.(
            window.I18n?.t("workflow.openGeminiTabToDownload") ||
              "Open a Gemini tab and download again.",
            "warning",
            4e3,
          );
          return false;
        }
        const nativeFn =
          effectiveMediaType === "video"
            ? window.MessageBridge?.geminiDownloadVideoNative
            : window.MessageBridge?.geminiDownloadImageNative;
        if (providerData.fingerprint && nativeFn) {
          const native = await nativeFn.call(window.MessageBridge, {
            tabId: geminiTabId,
            fingerprint: providerData.fingerprint,
            filename,
            removeWatermark:
              watermarkMode === "clean" ||
              (watermarkMode === "inherit" &&
                window.WatermarkClient?.enabled?.(effectiveMediaType) === true),
          });
          if (native?.success) return true;
          console.warn(
            "[TobyFlow] Gemini native download failed; materializing provider URL:",
            native?.error,
          );
        }
        const monitor = window.ProviderConfigManager?.getApiConfigValueSync?.(
          "gemini",
          "generation_monitor",
        )?.[effectiveMediaType];
        const maxBytes = Number(monitor?.max_materialized_bytes);
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) return false;
        const fetched = await window.MessageBridge?.geminiFetchMedia?.(
          dlUrl,
          geminiTabId,
          maxBytes,
        );
        if (!fetched?.success || !fetched.base64) return false;
        return (
          (
            await window.DownloadHelper.downloadExternalMedia({
              url: fetched.base64,
              filename,
              mediaType: effectiveMediaType,
              waitForComplete: true,
            })
          )?.success === true
        );
      }
      let _blobUrl = resolvedFlowBlobUrl;
      let _dlUrlFinal = dlUrl;
      if (provider === "chatgpt") {
        const _q = await new Promise((r) => {
          chrome.runtime.sendMessage(
            { action: "queryProviderTabs", provider: "chatgpt" },
            (x) => r(x),
          );
        });
        const _tabId = _q?.tabs?.[0]?.id ?? null;
        if (!_tabId) {
          const _msg =
            window.I18n?.t("workflow.chatgptNeedTab") ||
            "Open a ChatGPT tab and download again \u2014 the original image is only reachable from the page session.";
          console.warn(
            "[TobyFlow] ChatGPT: kh\xF4ng c\xF3 tab chatgpt.com \u0111ang m\u1EDF \u2192 kh\xF4ng t\u1EA3i \u0111\u01B0\u1EE3c \u1EA3nh g\u1ED1c",
          );
          if (typeof window.showToast === "function")
            window.showToast(_msg, "warning");
          else {
            try {
              window.customDialog?.alert?.(_msg, { type: "warning" });
            } catch (_) {}
          }
          return false;
        }
        const _f = await window.MessageBridge?.chatGPTFetchImage?.(
          dlUrl,
          _tabId,
        );
        if (!_f?.success || !_f.base64) {
          console.warn(
            "[TobyFlow] ChatGPT fetchImage fail:",
            _f?.error || "unknown",
          );
          return false;
        }
        _blobUrl = URL.createObjectURL(await (await fetch(_f.base64)).blob());
        _dlUrlFinal = _blobUrl;
      } else if (
        provider === "flow" &&
        watermarkMode !== "original" &&
        window.DownloadHelper?.cleanMediaBlob
      ) {
        const kind = effectiveMediaType;
        const force = watermarkMode === "clean";
        if (force || window.WatermarkClient.enabled(kind)) {
          try {
            let response;
            try {
              response = await fetch(dlUrl, { cache: "no-store" });
            } catch (_) {
              response = await fetch(dlUrl, {
                credentials: "include",
                cache: "no-store",
              });
            }
            if (!response.ok) throw new Error(`HTTP_${response.status}`);
            const clean = await window.DownloadHelper.cleanMediaBlob(
              await response.blob(),
              kind,
              { force },
            );
            if (!clean.cleaned && !clean.noWatermark)
              throw new Error(clean.reason || "WM_NOT_CLEANED");
            if (clean.cleaned) {
              _blobUrl = URL.createObjectURL(clean.blob);
              _dlUrlFinal = _blobUrl;
            } else {
              console.info(
                "[TobyFlow] Flow API manual: kh\xF4ng ph\xE1t hi\u1EC7n watermark \u2192 t\u1EA3i b\u1EA3n g\u1ED1c",
              );
            }
          } catch (e) {
            console.warn(
              "[TobyFlow] Flow API manual watermark clean failed \u2192 original:",
              e?.message,
            );
          }
        }
      }
      if (
        _blobUrl &&
        provider === "flow" &&
        effectiveMediaType !== "video" &&
        !/\.[a-z0-9]+$/i.test(filename)
      ) {
        filename += ".png";
      }
      const dlResp = await new Promise((resolve) => {
        if (cancellation?.abortFn?.()) {
          resolve({ success: false, error: "DOWNLOAD_STOPPED" });
          return;
        }
        const requestId = `manual_dl_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
        const onAbort = () =>
          chrome.runtime
            .sendMessage({ action: "cancelPreparedDownload", requestId })
            .catch(() => {});
        cancellation?.signal?.addEventListener("abort", onAbort, {
          once: true,
        });
        chrome.runtime.sendMessage(
          {
            action: "chromeDownload",
            url: _dlUrlFinal,
            filename,
            requestId,
            waitForComplete: true,
            waitTimeoutMs: effectiveMediaType === "video" ? 6e5 : 12e4,
          },
          (r) => {
            cancellation?.signal?.removeEventListener("abort", onAbort);
            resolve(r);
          },
        );
      });
      if (_blobUrl) setTimeout(() => URL.revokeObjectURL(_blobUrl), 3e4);
      if (!dlResp?.success) {
        console.warn(
          `[TobyFlow] ${provider} direct download fail:`,
          dlResp?.error,
        );
        return false;
      }
      console.log(`[TobyFlow] ${provider} direct download OK:`, filename);
      return true;
    } catch (err) {
      console.error("[TobyFlow] _downloadProviderTile exception:", err);
      return false;
    }
  },
  async _downloadWorkflowFlowResult({
    nodeId,
    fileId,
    fileName,
    providerData,
    media,
    mediaType,
    resolution,
    watermarkMode,
    plannedFilename,
    promptText,
    taskName,
    index,
    nodeData,
    generationMode = null,
    abortFn = null,
    signal = null,
  }) {
    const assertActive = () => {
      if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
    };
    assertActive();
    this._setNodeManualDownloadState(nodeId, fileId, "downloading");
    try {
      if (
        providerData?.provider === "flow" &&
        window.FlowApiAdapter?.isApiModeIntended?.({
          forWorkflow: true,
          forDownload: true,
        }) === true
      ) {
        const config = window.ProviderConfigManager?.getApiConfigValueSync?.(
          "flow",
          "download_resolutions",
        );
        const list = config?.[mediaType];
        const selected = Array.isArray(list)
          ? list.find((entry) => entry.value === resolution)
          : null;
        const route =
          window.ProviderConfigManager?.getDownloadResolutionRouteSync?.(
            "flow",
            mediaType,
            resolution,
          ) ||
          (selected?.route === "native" || selected?.route === "upscale"
            ? selected.route
            : null);
        const wantsUpscale = route ? route === "upscale" : null;
        let gate;
        if (wantsUpscale !== null) {
          try {
            gate = await window.FlowApiFacade?.checkDownloadReady?.({
              mediaId: providerData.media_uuid || fileId,
              mediaType,
              providerData,
              requireUpscale: wantsUpscale,
              surface: "workflow",
              forWorkflow: true,
            });
          } catch (_) {
            gate = null;
          }
        }
        if (gate?.ready === true) {
          let ok = false;
          try {
            ok = await this._downloadProviderTile(
              providerData.media_uuid || fileId,
              providerData,
              promptText,
              index,
              nodeData,
              fileName,
              resolution,
              watermarkMode,
              plannedFilename,
              { abortFn, signal },
            );
            assertActive();
          } catch (error) {
            if (wantsUpscale) throw error;
          }
          if (ok === true) {
            this._setNodeManualDownloadState(nodeId, fileId, "done");
            return true;
          }
          if (wantsUpscale) throw new Error("FLOW_API_UPSCALE_FAILED");
        }
      }
      const uuid = (value) =>
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value,
        );
      const keys = [
        ...new Set(
          [
            providerData?.media_uuid,
            media?.media_uuid,
            fileId,
            fileName,
            media?.persistent_media_id,
          ].filter(Boolean),
        ),
      ];
      const projectId =
        providerData?.project_id ||
        media?.project_id ||
        this.workflow?.project_id ||
        this.workflow?.projectId ||
        null;
      if (
        projectId &&
        typeof MessageBridge !== "undefined" &&
        MessageBridge.sendToContentScript
      ) {
        const context =
          await MessageBridge.sendToContentScript("getProjectContext");
        assertActive();
        if (
          String(context?.projectId || "").toLowerCase() !==
          String(projectId).toLowerCase()
        )
          throw new Error("PROJECT_MISMATCH");
      }
      let mountedUuid = null;
      if (
        mediaType === "video" &&
        typeof MessageBridge !== "undefined" &&
        MessageBridge.checkTilesExist
      ) {
        const uuidIds = keys.filter(uuid);
        const mounted = await MessageBridge.checkTilesExist(uuidIds);
        mountedUuid =
          uuidIds.find((id) => mounted?.existing?.includes(id)) || null;
      }
      let catalog = null;
      const savedAsb =
        mediaType === "video"
          ? keys.find((key) => this._isFlowV2AsbIdentity(key))
          : null;
      if (keys.length) {
        if (
          typeof MessageBridge !== "undefined" &&
          MessageBridge.lookupFlowMediaCatalog
        ) {
          catalog = await MessageBridge.lookupFlowMediaCatalog(keys);
          if (
            projectId &&
            String(catalog?.projectId || "").toLowerCase() !==
              String(projectId).toLowerCase()
          ) {
            throw new Error("PROJECT_MISMATCH");
          }
        }
      }
      const identity = keys
        .map((key) => catalog?.known?.[key])
        .find((value) => value?.type === mediaType);
      const canonicalUuid =
        keys.find(uuid) ||
        (uuid(identity?.media_uuid) ? identity.media_uuid : null);
      if (
        canonicalUuid &&
        identity?.media_uuid &&
        identity.media_uuid.toLowerCase() !== canonicalUuid.toLowerCase()
      ) {
        throw new Error("FLOW_WEB_MEDIA_IDENTITY_MISMATCH");
      }
      const currentAsb = this._isFlowV2AsbIdentity(
        identity?.persistent_media_id,
      )
        ? identity.persistent_media_id
        : null;
      const webFileName =
        mediaType === "video"
          ? currentAsb || mountedUuid || savedAsb
          : identity?.media_uuid || canonicalUuid;
      const webId = canonicalUuid || webFileName;
      if (
        !webId ||
        (mediaType === "video" &&
          !mountedUuid &&
          !this._isFlowV2AsbIdentity(webFileName))
      ) {
        throw new Error(
          mediaType === "video"
            ? "FLOW_WEB_MEDIA_CATALOG_PENDING"
            : "FLOW_WEB_MEDIA_ID_MISSING",
        );
      }
      if (
        typeof MessageBridge === "undefined" ||
        !MessageBridge.downloadTileMedia
      )
        throw new Error("FLOW_WEB_DOWNLOAD_UNAVAILABLE");
      assertActive();
      await window.DownloadHelper?._activateFlowTabForDomDownload?.();
      assertActive();
      const requestId = `manual_dl_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
      const onAbort = () =>
        MessageBridge.sendToContentScript("cancelTileMediaDownload", {
          requestId,
        }).catch(() => {});
      signal?.addEventListener("abort", onAbort, { once: true });
      let response;
      try {
        response = await MessageBridge.downloadTileMedia(
          webId,
          promptText,
          taskName,
          webFileName,
          mediaType === "image" ? resolution : null,
          null,
          index,
          mediaType === "video" ? resolution : null,
          watermarkMode,
          plannedFilename,
          requestId,
        );
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      assertActive();
      const completed =
        window.flow_uuid_gateway?.downloadSucceeded?.(response) ??
        (response === true || response?.success === true);
      if (!completed)
        throw new Error(response?.error || "TILE_DOWNLOAD_FAILED");
      this._setNodeManualDownloadState(nodeId, fileId, "done");
      return true;
    } catch (error) {
      this._setNodeManualDownloadState(
        nodeId,
        fileId,
        "failed",
        window.DownloadHelper?.formatDownloadError?.(error, resolution) ||
          error.message ||
          "DOWNLOAD_FAILED",
      );
      throw error;
    }
  },
  async _downloadFlowUpscaledTile(
    fileId,
    providerData,
    resLabel,
    promptText,
    index,
    nodeData,
    watermarkMode = "inherit",
    plannedFilename = null,
    cancellation = null,
  ) {
    if (window.flow_uuid_gateway)
      await window.flow_uuid_gateway.requireDownload(
        [providerData?.media_uuid || fileId],
        {
          projectId: providerData?.project_id || this.workflow?.project_id,
          mediaType: providerData?.media_type === "video" ? "video" : "image",
          surface: "workflow",
          signal: cancellation?.signal,
          abortFn: cancellation?.abortFn,
        },
      );
    try {
      fileId = providerData?.media_uuid || fileId;
      const projectId =
        providerData?.project_id || this.workflow?.project_id || null;
      const isVideo = providerData?.media_type === "video";
      const upscaleBudgetMs = isVideo
        ? (await window.FlowApiFacade.videoUpscaleTimeoutMs({
            mediaId: fileId,
            projectId,
            mediaType: "video",
            providerData,
          })) + 3e4
        : 12e4;
      const deadline = Date.now() + upscaleBudgetMs;
      const abortFn = () =>
        Date.now() > deadline || cancellation?.abortFn?.() === true;
      let downloadUrl;
      let blobUrl = null;
      let ext;
      if (isVideo) {
        const ratio = nodeData?.ratio || providerData?.ratio || null;
        if (!ratio && providerData?.api_driver !== "v2") {
          console.warn("[TobyFlow] upscaleVideo blocked: VIDEO_RATIO_MISSING");
          return false;
        }
        const up = await window.FlowApiFacade.upscaleVideo({
          mediaId: fileId,
          ratio,
          resolution: resLabel,
          abortFn,
          projectId,
          mediaType: "video",
          providerData,
        });
        if (cancellation?.abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
        if (!up?.ok || !up.videoUrl) {
          console.warn("[TobyFlow] upscaleVideo fail:", up?.error);
          return false;
        }
        downloadUrl = up.videoUrl;
        ext = "mp4";
      } else {
        const up = await window.FlowApiFacade.upscaleImage({
          mediaId: fileId,
          resolution: resLabel,
          abortFn,
          projectId,
          mediaType: "image",
          providerData,
        });
        if (cancellation?.abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
        if (!up?.ok || !up.base64) {
          console.warn("[TobyFlow] upscaleImage fail:", up?.error);
          return false;
        }
        ext =
          up.mime === "image/webp"
            ? "webp"
            : up.mime === "image/png"
              ? "png"
              : "jpg";
        let imageBase64 = up.base64;
        const forceClean = watermarkMode === "clean";
        if (
          watermarkMode !== "original" &&
          window.WatermarkClient &&
          (forceClean || window.WatermarkClient.enabled("image"))
        ) {
          try {
            const clean = await window.WatermarkClient.cleanBase64(
              imageBase64,
              up.mime || "image/png",
              "image",
              { ignoreUserSetting: forceClean },
            );
            if (clean?.cleaned && clean.base64) imageBase64 = clean.base64;
          } catch (e) {
            console.warn(
              "[TobyFlow] upscale image watermark clean failed \u2192 original:",
              e?.message,
            );
          }
        }
        const bin = atob(imageBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blobUrl = URL.createObjectURL(new Blob([bytes], { type: up.mime }));
        downloadUrl = blobUrl;
      }
      if (
        isVideo &&
        watermarkMode !== "original" &&
        window.DownloadHelper?.cleanMediaBlob
      ) {
        const forceClean = watermarkMode === "clean";
        if (forceClean || window.WatermarkClient.enabled("video")) {
          try {
            const response = await fetch(downloadUrl, { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP_${response.status}`);
            const clean = await window.DownloadHelper.cleanMediaBlob(
              await response.blob(),
              "video",
              { force: forceClean },
            );
            if (!clean.cleaned && !clean.noWatermark)
              throw new Error(clean.reason || "VIDEO_WM_NOT_CLEANED");
            if (clean.cleaned) {
              blobUrl = URL.createObjectURL(clean.blob);
              downloadUrl = blobUrl;
            } else {
              console.info(
                "[TobyFlow] upscale video: kh\xF4ng ph\xE1t hi\u1EC7n watermark \u2192 t\u1EA3i b\u1EA3n g\u1ED1c",
              );
            }
          } catch (e) {
            console.warn(
              "[TobyFlow] upscale video watermark clean failed \u2192 original:",
              e?.message,
            );
          }
        }
      }
      const _dlSet = await window.DownloadHelper.getSettings();
      let filename = plannedFilename
        ? plannedFilename.replace(/\.[^.\/]+$/, `.${ext}`)
        : window.DownloadHelper.buildFilename({
            template: _dlSet.template,
            project: _dlSet.project,
            prompt: promptText,
            index,
            taskName: this.workflow?.wf_name || null,
            folder: _dlSet.folder,
            ext,
          });
      if (!plannedFilename)
        filename = filename.replace(
          new RegExp(`\\.${ext}$`, "i"),
          `_${resLabel}.${ext}`,
        );
      const dlResp = await new Promise((resolve) => {
        if (cancellation?.abortFn?.()) {
          resolve({ success: false, error: "DOWNLOAD_STOPPED" });
          return;
        }
        const requestId = `manual_dl_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
        const onAbort = () =>
          chrome.runtime
            .sendMessage({ action: "cancelPreparedDownload", requestId })
            .catch(() => {});
        cancellation?.signal?.addEventListener("abort", onAbort, {
          once: true,
        });
        chrome.runtime.sendMessage(
          {
            action: "chromeDownload",
            url: downloadUrl,
            filename,
            requestId,
            waitForComplete: true,
            waitTimeoutMs: isVideo ? 6e5 : 12e4,
          },
          (r) => {
            cancellation?.signal?.removeEventListener("abort", onAbort);
            resolve(r);
          },
        );
      });
      if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 6e4);
      if (!dlResp?.success) {
        console.warn("[TobyFlow] upscale download fail:", dlResp?.error);
        return false;
      }
      console.log(`[TobyFlow] flow upscale ${resLabel} download OK:`, filename);
      return true;
    } catch (err) {
      console.error("[TobyFlow] _downloadFlowUpscaledTile exception:", err);
      return false;
    }
  },
  async _nodeUuidDownloadRoutes(data, fileIds, fileNames, providerUrls) {
    const routes = new Map();
    if (
      window.FlowApiAdapter?.isApiModeIntended?.({
        forWorkflow: true,
        forDownload: true,
      }) !== true
    )
      return routes;
    const uuid = (value) =>
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      );
    let legacyReady;
    const selections = new Map();
    for (const id of fileIds) {
      const existing = providerUrls[id] || providerUrls[fileNames[id]];
      const media =
        data.result_thumbnails?.[id] || this._tileCache?.get?.(id) || {};
      const mediaId = [existing?.media_uuid, media?.media_uuid, id].find(uuid);
      if (!mediaId) continue;
      const mediaType =
        data.media_type === "Video" ||
        data.gen_type === "Video" ||
        media.type === "video"
          ? "video"
          : "image";
      const pinnedDriver = existing?.api_driver || media?.api_driver;
      let lookupConfig = null;
      let driver = pinnedDriver;
      if (!driver) {
        if (!selections.has(mediaType)) {
          try {
            selections.set(
              mediaType,
              await window.FlowApiSessionCoordinator?.check?.({
                surface: "workflow",
                mediaType,
                passive: true,
              }),
            );
          } catch (_) {
            selections.set(mediaType, null);
          }
        }
        const selection = selections.get(mediaType);
        if (selection?.ready !== true) continue;
        driver = selection.driver;
        if (driver === "v2") {
          lookupConfig =
            await window.ProviderConfigManager?.fetchFlowApiV2Configs?.();
          if (!lookupConfig) continue;
        }
      }
      const standaloneV2Upload =
        driver === "v2" &&
        (media.identity_kind === "flow-api-uuid" ||
          existing?.identity_kind === "flow-api-uuid") &&
        !existing?.operation_uuid &&
        !media.operation_uuid;
      if (standaloneV2Upload && !lookupConfig) {
        lookupConfig =
          await window.ProviderConfigManager?.fetchFlowApiV2Configs?.();
        if (!lookupConfig) continue;
      }
      if (driver !== "v1" && driver !== "v2") continue;
      if (driver === "v1") {
        if (legacyReady === void 0) {
          try {
            legacyReady =
              (
                await window.FlowApiAdapter?.checkSessionReady?.({
                  allowAutoHeal: false,
                })
              )?.ready === true;
          } catch (_) {
            legacyReady = false;
          }
        }
        if (!legacyReady) continue;
      }
      const provider = {
        ...(existing?.provider === "flow" ? existing : {}),
        provider: "flow",
        api_driver: driver,
        media_uuid: mediaId,
        media_type: mediaType,
        project_id:
          existing?.project_id ||
          media.project_id ||
          this.workflow?.project_id ||
          this.workflow?.projectId ||
          selections.get(mediaType)?.projectId,
        operation_uuid: existing?.operation_uuid || media.operation_uuid,
        protocol_revision:
          existing?.protocol_revision ||
          media.protocol_revision ||
          lookupConfig?.protocol?.schema_version,
        protocol_fingerprint:
          existing?.protocol_fingerprint ||
          media.protocol_fingerprint ||
          (lookupConfig
            ? window.FlowApiV2CheckpointStore?.fingerprint?.(lookupConfig)
            : null),
        ...(lookupConfig && (!pinnedDriver || standaloneV2Upload)
          ? { uuidLookup: true }
          : {}),
      };
      try {
        const health = await window.FlowApiFacade?.checkDownloadReady?.({
          mediaId,
          mediaType: provider.media_type,
          providerData: provider,
          requireUpscale: false,
          surface: "workflow",
          forWorkflow: true,
        });
        if (health?.ready === true) routes.set(id, provider);
        else
          console.info(
            "[WorkflowDownloadIdentity] API UUID lookup unavailable",
            JSON.stringify({
              mediaType,
              driver,
              reason: health?.reason || "download_not_ready",
              hasProjectId: !!provider.project_id,
              uuidLookup: provider.uuidLookup === true,
            }),
          );
      } catch (_) {}
    }
    return routes;
  },
  _isTileVideo(fileId) {
    return (
      this._tileCache.has(fileId) &&
      this._tileCache.get(fileId).type === "video"
    );
  },
  _isFlowV2AsbIdentity(value) {
    return window.flow_uuid_gateway.isAsb(String(value || "").trim());
  },
};
