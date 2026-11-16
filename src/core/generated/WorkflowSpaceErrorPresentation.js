globalThis.WorkflowSpaceFormatError = function (
  node,
  raw,
  translate,
  errorCodes = {},
  details = null,
  flowFailure = false,
) {
  const root = { I18n: { t: translate } };
  const window = {
    ...root,
    ProviderConfigManager: { getApiConfigValueSync: () => errorCodes },
  };
  window.MuseApiFacade = {
    errorMessage(error, translate2) {
      const t = translate2 || ((key) => window.I18n?.t?.(key));
      const code = String(error?.code || error?.message || error || "").trim();
      const keys = /^MUSE_[A-Z0-9_]+$/.test(code)
        ? [`museErrors.${code}`, `museErrors.${code.replace(/\d+$/, "")}`]
        : [];
      for (const key of [
        ...keys,
        "museErrors.unknown",
        "museApi.unavailable",
      ]) {
        const value = t?.(key);
        if (typeof value === "string" && value && value !== key) return value;
      }
      return "";
    },
  };
  window.flow_uuid_gateway = {
    _notFoundKey: "download.flowMediaNotFound",
    formatErrorSync(error) {
      const code = String(error?.code || error?.message || error || "");
      if (code !== "FLOW_MEDIA_UUID_NOT_FOUND") return code;
      const translated = root.I18n?.t?.(this._notFoundKey);
      return translated && translated !== this._notFoundKey ? translated : code;
    },
  };
  window.FlowApiAdapter = {
    classifyError(error, suppliedType = null) {
      const allowed = new Set([
        "quota_exceeded",
        "per_model_daily",
        "content_blocked",
        "tier_restricted",
        "bot_detected",
        "media_expired",
        "captcha_failed",
        "auth_expired",
        "project_mismatch",
        "schema_changed",
        "server_unavailable",
        "unknown",
      ]);
      const raw2 = String(error || "").toUpperCase();
      if (
        /\bFLOW_RECOVERY_OBSERVER_(?:UPDATE_REQUIRED|UNAVAILABLE)\b/.test(raw2)
      )
        return "unknown";
      if (/NO_FLOW_KEY|TOKEN_EXPIRED/.test(raw2)) return "auth_expired";
      const configured =
        window.ProviderConfigManager?.getApiConfigValueSync?.(
          "flow",
          "api_error_codes",
        ) || {};
      for (const [code, type] of Object.entries(configured)) {
        if (raw2.includes(String(code).toUpperCase()) && allowed.has(type))
          return type;
      }
      if (allowed.has(suppliedType)) return suppliedType;
      if (/PROJECT.*MISMATCH|WRONG_PROJECT/.test(raw2))
        return "project_mismatch";
      if (/SCHEMA|ENDPOINT_MISSING|MODEL_KEY_MISSING|CONFIG_MISSING/.test(raw2))
        return "schema_changed";
      if (
        /NETWORK|TIMEOUT|TRANSPORT|BRIDGE.*(?:MISSING|NOT_INSTALLED|CHANNEL|CLOSED)|(?:^|[^A-Z0-9])SERVER(?:[^A-Z0-9]|$)|FETCH/.test(
          raw2,
        )
      )
        return "server_unavailable";
      return "unknown";
    },
    formatError(error, errorType) {
      const raw2 = String(error || "API_FAILED");
      if (raw2 === "V2_BRIDGE_FETCH_REQUEST_UNSUPPORTED") {
        const key2 = "settings.bridgeOutdated";
        const translated2 = window.I18n?.t?.(key2);
        return translated2 && translated2 !== key2 ? translated2 : raw2;
      }
      if (
        /^(?:Google Flow:\s*)?(?:SUBMIT_NOT_TRIGGERED:\s*)?FLOW_CREDIT_LIMIT$/.test(
          raw2,
        )
      ) {
        const key2 = "flow.creditLimitHit";
        const translated2 = window.I18n?.t?.(key2);
        return translated2 && translated2 !== key2 ? translated2 : raw2;
      }
      const modelContract =
        /^(?:Google Flow:\s*)?MODEL_OPTION_(?:NOT_FOUND|NOT_APPLIED):\s*(.{1,160})$/.exec(
          raw2,
        );
      if (modelContract) {
        const key2 = "gen.flowModelUnavailable";
        const translated2 = window.I18n?.t?.(key2, {
          model: modelContract[1].trim(),
        });
        return translated2 && translated2 !== key2 ? translated2 : raw2;
      }
      const providerPrefixed =
        /^([^:\n]{1,80}):\s*((?:(?:[A-Za-z][A-Za-z0-9_]{2,119}|HTTP \d{3}|gRPC \d{1,2}|Google status \d{1,2}))(?:\s*[,·]\s*(?:[A-Za-z][A-Za-z0-9_]{2,119}|HTTP \d{3}|gRPC \d{1,2}|Google status \d{1,2})){0,15})$/.exec(
          raw2,
        );
      if (providerPrefixed) {
        const translatedCode = this.formatError(providerPrefixed[2], errorType);
        if (translatedCode !== providerPrefixed[2])
          return `${providerPrefixed[1]}: ${translatedCode}`;
      }
      const commaCodes = raw2.split(/\s*,\s*/);
      if (
        commaCodes.length > 1 &&
        commaCodes.length <= 16 &&
        commaCodes.every((part) => /^[A-Za-z][A-Za-z0-9_]{2,119}$/.test(part))
      ) {
        return [
          ...new Set(
            commaCodes.map((part) => this.formatError(part, errorType)),
          ),
        ].join(" \xB7 ");
      }
      const parts = raw2.split(/\s*·\s*/);
      if (parts.length > 1 && parts.length <= 16) {
        const translatedParts = parts.map((part) =>
          /^(?:[A-Za-z][A-Za-z0-9_]{2,119}|HTTP \d{3}|gRPC \d{1,2}|Google status \d{1,2})$/.test(
            part,
          )
            ? this.formatError(part)
            : part,
        );
        if (translatedParts.some((part, index) => part !== parts[index])) {
          return [...new Set(translatedParts)].join(" \xB7 ");
        }
      }
      const dictionaryCode = /^[A-Za-z][A-Za-z0-9_]{2,119}$/.test(raw2);
      const grpc = /^gRPC (\d{1,2})$/.exec(raw2);
      const http = /^HTTP (\d{3})$/.exec(raw2);
      const status = /^Google status (\d{1,2})$/.exec(raw2);
      const dictionaryKey = grpc
        ? "flowErrors.grpc." + grpc[1]
        : http
          ? "flowErrors.http." + http[1]
          : status
            ? "flowErrors.status." + status[1]
            : dictionaryCode
              ? "flowErrors.codes." + raw2
              : null;
      const dictionaryText = dictionaryKey
        ? window.I18n?.t?.(dictionaryKey)
        : null;
      if (dictionaryText && dictionaryText !== dictionaryKey)
        return dictionaryText;
      if (raw2 === "FLOW_RECOVERY_REFERENCE_IDENTITY_UNRESOLVED") {
        const referenceKey =
          "flowErrors.codes.FLOW_REFERENCE_IDENTITY_UNVERIFIED";
        const referenceText = window.I18n?.t?.(referenceKey);
        return referenceText && referenceText !== referenceKey
          ? `${referenceText} (${raw2})`
          : raw2;
      }
      if (
        raw2 === "REF_UPLOAD_FAILED" ||
        raw2 === "GEN_API_REFERENCE_UNVERIFIED" ||
        /^FLOW_RECOVERY_OBSERVER_(?:UPDATE_REQUIRED|UNAVAILABLE)$/.test(raw2)
      )
        return raw2;
      if (grpc || http || status) return raw2;
      const type = this.classifyError(raw2, errorType);
      const key =
        dictionaryCode && type === "unknown"
          ? "gen.flowErr_unmapped"
          : "gen.flowErr_" + type;
      const translated = dictionaryCode ? window.I18n?.t?.(key) : null;
      if (
        type === "server_unavailable" &&
        dictionaryCode &&
        translated &&
        translated !== key
      ) {
        return `${translated} (${raw2})`;
      }
      return translated && translated !== key ? translated : raw2;
    },
  };
  window.WorkflowVideoMerge = {
    formatError(error) {
      const raw2 = String(
        typeof error === "string" ? error : error?.message || error?.code || "",
      );
      const code =
        typeof error === "object" ? String(error?.code || raw2) : raw2;
      const detail =
        typeof error === "object" ? error?.diagnostic?.lineageCheck || "" : "";
      let key;
      if (code === "FLOW_MEDIA_UUID_NOT_FOUND")
        return window.flow_uuid_gateway?.formatErrorSync?.(error) || raw2;
      if (code === "MOTION_MERGE_TIMEOUT")
        key = "workflowVideoMerge.mergeTimeout";
      else if (
        /(?:PROJECT.*MISMATCH|WRONG_PROJECT)/.test(code) ||
        (code === "LINEAGE_MISMATCH" && /projectId/.test(detail))
      )
        key = "workflowVideoMerge.sourceProjectMismatch";
      else if (code === "LINEAGE_MISMATCH" && /poster URL format$/.test(detail))
        key = "workflowVideoMerge.sourceMetadataUnavailable";
      else if (
        /(?:IDENTITY.*MISMATCH|MISMATCH.*IDENTITY)/.test(code) ||
        (code === "LINEAGE_MISMATCH" && detail)
      )
        key = "workflowVideoMerge.sourceIdentityMismatch";
      else if (code === "LINEAGE_MISMATCH")
        key = "flowErrors.codes.LINEAGE_MISMATCH";
      else if (/^FLOW_WEB_RESULT_NOT_SYNCED/.test(code))
        key = "workflowVideoMerge.sourceMetadataUnavailable";
      if (!key) return raw2;
      const translated = window.I18n?.t?.(key);
      return translated && translated !== key ? translated : raw2;
    },
  };
  const reader = {
    workflow: { nodes: [node] },
    _formatNodeErrorForDisplay(
      nodeOrType,
      errorMessage,
      flowApiFailure = false,
      errorDetails = null,
    ) {
      const raw2 = String(errorMessage || "");
      const museCode = /^(MUSE_[A-Z0-9_]+)(?=[:\s]|$)/.exec(
        String(errorDetails?.code || raw2),
      )?.[1];
      if (museCode) return window.MuseApiFacade?.errorMessage?.(museCode) || "";
      if (!raw2) return "";
      if (/\bFLOW_MEDIA_UUID_NOT_FOUND\b/.test(raw2)) {
        const message2 = window.flow_uuid_gateway?.formatErrorSync?.(
          "FLOW_MEDIA_UUID_NOT_FOUND",
        );
        if (message2 && message2 !== "FLOW_MEDIA_UUID_NOT_FOUND")
          return raw2.replace(/\bFLOW_MEDIA_UUID_NOT_FOUND\b/g, () => message2);
      }
      if (raw2 === "PROVIDER_WORKER_NEEDS_REVIEW")
        return window.I18n?.t?.("workflow.statusFailed") || "Failed";
      if (raw2 === "WORKFLOW_INTERRUPTED") {
        const translated2 = window.I18n?.t?.("flowRecovery.interrupted");
        return translated2 && translated2 !== "flowRecovery.interrupted"
          ? translated2
          : window.I18n?.t?.("workflow.statusFailed") || "Failed";
      }
      if (/^TEMPLATE_MEDIA_UPLOAD_FAILED(?::\d+)?$/.test(raw2)) {
        const key2 = "workflow.templateMediaUploadFailed";
        const message2 = window.I18n?.t?.(key2);
        return message2 && message2 !== key2
          ? message2
          : window.I18n?.t?.("workflow.statusFailed") || "";
      }
      const descriptor =
        typeof nodeOrType === "string"
          ? { node_type: nodeOrType }
          : nodeOrType || {};
      const nodeId = descriptor.node_id;
      const savedNode = nodeId
        ? this.workflow?.nodes?.find((node2) => node2.node_id === nodeId)
        : null;
      const nodeType = descriptor.node_type || savedNode?.node_type || "";
      if (nodeType === "video_merge") {
        const message2 = window.WorkflowVideoMerge?.formatError?.(
          errorDetails || raw2,
        );
        if (message2 && message2 !== raw2) return message2;
      }
      const provider =
        descriptor.provider ||
        descriptor.provider_id ||
        savedNode?.provider ||
        "";
      const isFlowError =
        flowApiFailure ||
        nodeType === "generate" ||
        nodeType === "video_merge" ||
        provider === "flow";
      if (!isFlowError) return raw2;
      const translated = window.FlowApiAdapter?.formatError?.(raw2);
      const message = translated && translated !== raw2 ? translated : raw2;
      const key = "flowStatus.botCookieHint";
      const hint = window.I18n?.t?.(key);
      return window.FlowApiAdapter?.classifyError?.(raw2) === "bot_detected" &&
        hint &&
        hint !== key &&
        !message.includes(hint)
        ? `${message} ${hint}`
        : message;
    },
  };
  return reader._formatNodeErrorForDisplay(node, raw, flowFailure, details);
};
globalThis.WorkflowSpaceReviewState = function (data) {
  const noResultReview =
    data.error?.code === "PROVIDER_WORKER_NEEDS_REVIEW" ||
    data.error?.workerOutcome === "needs_review";
  const terminalFailure =
    noResultReview || data.error?.workerOutcome === "failed";
  const marker = data.error?.workerCheckpointed
    ? "[PROVIDER_REVIEW_REQUIRED] PROVIDER_WORKFLOW_SETTLEMENT_UNCONFIRMED"
    : noResultReview
      ? "[PROVIDER_REVIEW_REQUIRED] PROVIDER_WORKER_NEEDS_REVIEW"
      : `[PROVIDER_REVIEW_REQUIRED] ${data.error?.code || data.error?.message || ""}`;
  const status = data.error?.workerCheckpointed
    ? "completed"
    : terminalFailure
      ? "failed"
      : "pending";
  return {
    status,
    error_message: marker,
    generation_queued: false,
    phase: null,
    run_started_at: null,
  };
};
