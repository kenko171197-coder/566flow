(function () {
  "use strict";
  const SESSION_CODES = new Set([
    "TOKEN_EXPIRED",
    "NO_FLOW_KEY",
    "BRIDGE_NOT_INSTALLED",
    "BRIDGE_REQUEST_TIMEOUT",
    "BRIDGE_CHANNEL_CLOSED",
    "V2_PAGE_RELAY_UNAVAILABLE",
    "V2_PAGE_COMMAND_TIMEOUT",
    "V2_PAGE_RELOADING",
    "V2_CONTENT_SCRIPT_RECOVERING",
    "page_reloading",
    "content_script_recovering",
    "flow_project_tab_required",
    "project_mismatch",
    "login_required",
    "csrf_missing",
    "fresh_page_session_required",
    "session_refresh_timeout",
    "captcha_not_ready",
    "CAPTCHA_FAILED",
  ]);
  class FlowApiDriverError extends Error {
    constructor(message, details = {}) {
      const rawCode = String(details.code || message || "FLOW_API_FAILED");
      const baseCode = /^(RPC_REJECTED|RPC_REJECT)$/.test(rawCode)
        ? "GOOGLE_REJECTED"
        : rawCode;
      const code = baseCode;
      super(String(message || code));
      this.name = "FlowApiDriverError";
      this.driver = details.driver === "v2" ? "v2" : "v1";
      this.code = code;
      this.errorType =
        details.errorType ||
        (SESSION_CODES.has(code) ? "auth_expired" : "unknown");
      this.stage = details.stage || "pre_dispatch";
      this.dispatchStarted = details.dispatchStarted === true;
      this.ambiguous = details.ambiguous === true;
      this.operationId = details.operationId || null;
      this.retryable = details.retryable === true;
      if (this.stage === "terminal") this.retryable = false;
      this.failureDetails = FlowApiDriverError.sanitizeFailureDetails(
        details.failureDetails,
      );
      this.reason = details.reason || code;
      this.grpcCode = Number.isInteger(details.grpcCode)
        ? details.grpcCode
        : null;
      this.grpcReason =
        typeof details.grpcReason === "string" ? details.grpcReason : null;
      this.providerErrorCodes = [
        ...new Set(
          (Array.isArray(details.providerErrorCodes)
            ? details.providerErrorCodes
            : []
          ).filter(
            (value) =>
              typeof value === "string" &&
              /^PUBLIC_ERROR_[A-Z0-9_]{1,107}$/.test(value),
          ),
        ),
      ].slice(0, 8);
      this.diagnostic =
        details.diagnostic && typeof details.diagnostic === "object"
          ? { ...details.diagnostic }
          : null;
      if (details.cause) this.cause = details.cause;
    }
    static normalize(error, context = {}) {
      if (error instanceof FlowApiDriverError) return error;
      const code = String(
        error?.code || error?.message || context.code || "FLOW_API_FAILED",
      );
      const dispatchStarted =
        error?.dispatchStarted === true || context.dispatchStarted === true;
      const operationId = error?.operationId || context.operationId || null;
      const confirmedRejection =
        /^(GOOGLE_REJECTED|RPC_REJECTED|RPC_REJECT)$/.test(code) &&
        ((Number.isInteger(error?.grpcCode) && error.grpcCode > 0) ||
          (Array.isArray(error?.providerErrorCodes) &&
            error.providerErrorCodes.some(
              (value) =>
                typeof value === "string" &&
                /^PUBLIC_ERROR_[A-Z0-9_]{1,107}$/.test(value),
            )));
      const explicitStage =
        error?.stage ||
        context.stage ||
        (confirmedRejection ? "receipt" : null);
      const ambiguous =
        error?.ambiguous === true ||
        (!explicitStage &&
          dispatchStarted &&
          !operationId &&
          !/^(ABORTED|V2_OPERATION_TIMEOUT|V2_POLL_|V2_RESOLVE_|FLOW_API_V2_RECOVERY_)/.test(
            code,
          ));
      const stage =
        explicitStage ||
        (operationId
          ? "accepted_poll"
          : ambiguous
            ? "ambiguous"
            : "pre_dispatch");
      const retryable = error?.retryable === true || SESSION_CODES.has(code);
      const providerCode = (
        Array.isArray(error?.providerErrorCodes) ? error.providerErrorCodes : []
      ).find(
        (value) =>
          typeof value === "string" &&
          /^PUBLIC_ERROR_[A-Z0-9_]{1,107}$/.test(value) &&
          window.FlowApiAdapter?.classifyError?.(value) !== "unknown",
      );
      const v2Mapped =
        (error?.driver || context.driver) === "v2"
          ? window.FlowApiAdapter?.classifyError?.("", error?.errorType)
          : null;
      const classified =
        v2Mapped && v2Mapped !== "unknown"
          ? v2Mapped
          : window.FlowApiAdapter?.classifyError?.(
              providerCode || code,
              error?.errorType,
            ) ||
            error?.errorType ||
            "unknown";
      const errorType =
        classified === "unknown" && SESSION_CODES.has(code)
          ? "auth_expired"
          : classified;
      const policy = window.FlowApiAdapter?.getErrorPolicy?.(errorType);
      const internalRead = this.isInternalReadFailure({
        driver: error?.driver || context.driver,
        stage,
        operationId,
        ambiguous,
        errorType,
        grpcCode: error?.grpcCode,
      });
      return new FlowApiDriverError(code, {
        driver: error?.driver || context.driver,
        code,
        errorType,
        stage,
        dispatchStarted,
        ambiguous,
        operationId,
        retryable:
          stage === "terminal" || error?.retryable === false
            ? false
            : internalRead || (policy ? policy.retryable === true : retryable),
        reason: error?.reason || code,
        grpcCode: error?.grpcCode,
        grpcReason: error?.grpcReason,
        providerErrorCodes: error?.providerErrorCodes,
        diagnostic: error?.diagnostic,
        failureDetails:
          error?.failureDetails ||
          error?.diagnostic?.outputs?.map((output) => ({
            ...output.failureDetail,
            operationId: output.operationId,
          })),
        cause: error,
      });
    }
    static isInternalReadFailure(error) {
      return (
        error?.driver === "v2" &&
        error?.stage === "accepted_poll" &&
        !!error?.operationId &&
        error?.ambiguous !== true &&
        error?.grpcCode === 13 &&
        ["unknown", "server_unavailable"].includes(error?.errorType)
      );
    }
    static sanitizeFailureDetails(values = []) {
      return (Array.isArray(values) ? values : [])
        .slice(0, 32)
        .map((value) => ({
          operationId:
            typeof value?.operationId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              value.operationId,
            )
              ? value.operationId
              : null,
          statusCode: Number.isInteger(value?.statusCode)
            ? value.statusCode
            : null,
          message:
            typeof value?.message === "string"
              ? value.message
                  .replace(/https?:\/\/[^\s"<>]+/gi, "[url]")
                  .replace(/Bearer\s+\S+/gi, "[authorization]")
                  .replace(/[A-Za-z0-9_=-]{64,}/g, "[token]")
                  .replace(/[\u0000-\u001f\u007f]/g, " ")
                  .slice(0, 1e3)
              : null,
        }))
        .filter((value) => value.message || value.statusCode !== null);
    }
    static safeLineageCheck(error) {
      const value = error?.diagnostic?.lineageCheck;
      return typeof value === "string" &&
        /^[A-Za-z0-9 _-]{1,96}$/.test(value.trim())
        ? value.trim()
        : null;
    }
    static safeLineageReference(error) {
      const diagnostic = error?.diagnostic;
      return this.safeLineageCheck(error) &&
        Number.isInteger(diagnostic?.lineageRefIndex) &&
        diagnostic.lineageRefIndex >= 0 &&
        diagnostic.lineageRefIndex < 32 &&
        ["reference_crops", "reference_context"].includes(
          diagnostic?.lineageRefPath,
        )
        ? {
            lineageRefIndex: diagnostic.lineageRefIndex,
            lineageRefPath: diagnostic.lineageRefPath,
          }
        : {};
    }
    static safeBridgeCheck(error) {
      const source =
        error?.diagnostic?.bridgeCheck ||
        error?.bridgeCheck ||
        (error?.generationTransport ? error : null);
      if (
        !source ||
        source.generationTransport !== "fetch_request" ||
        !["ping_failed", "ping_result_missing_capability"].includes(
          source.bridgeCheckOutcome,
        )
      )
        return {};
      const version =
        typeof source.bridgeVersionAtCheck === "string" &&
        /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(source.bridgeVersionAtCheck)
          ? source.bridgeVersionAtCheck
          : null;
      const pingError =
        source.bridgeCheckOutcome === "ping_failed" &&
        typeof source.bridgePingError === "string" &&
        /^[A-Z][A-Z0-9_]{1,79}$/.test(source.bridgePingError)
          ? source.bridgePingError
          : null;
      return {
        generationTransport: "fetch_request",
        bridgeVersionAtCheck: version,
        bridgeCheckOutcome: source.bridgeCheckOutcome,
        bridgePingError: pingError,
      };
    }
    static safeTransportEvidence(error) {
      if (error?.driver !== "v2") return {};
      const diagnostic = error?.diagnostic || {};
      const timing = diagnostic.transportTiming || error;
      if (!timing || typeof timing !== "object") return {};
      const result = {};
      const transport =
        diagnostic.transport === "native_xhr_same_origin"
          ? "xhr"
          : diagnostic.transport === "native_fetch_request_same_origin"
            ? "fetch_request"
            : ["xhr", "fetch_request"].includes(error?.generationTransport)
              ? error.generationTransport
              : null;
      if (transport) result.generationTransport = transport;
      const phase = timing.phase ?? timing.transportPhase;
      if (
        [
          "before_dispatch",
          "waiting_headers",
          "reading_body",
          "decoding",
        ].includes(phase)
      ) {
        result.transportPhase = phase;
      }
      const causeKind = timing.causeKind ?? timing.transportCauseKind;
      if (
        [
          "page_lifecycle_interrupted",
          "network_offline",
          "xhr_rejected",
          "fetch_rejected",
          "response_stream_interrupted",
          "decoder_runtime_error",
          "transport_runtime_error",
          "xhr_exception",
          "fetch_exception",
          "response_stream_exception",
        ].includes(causeKind)
      ) {
        result.transportCauseKind = causeKind;
      }
      const abortSource = timing.abortSource ?? timing.transportAbortSource;
      if (
        [
          "request_deadline",
          "control_observed_mutation_preserved",
          "control_cancel",
          "external_abort",
        ].includes(abortSource)
      )
        result.transportAbortSource = abortSource;
      const online = timing.online ?? timing.transportOnline;
      if (typeof online === "boolean") result.transportOnline = online;
      const elapsedMs = timing.elapsedMs ?? timing.transportElapsedMs;
      if (
        Number.isInteger(elapsedMs) &&
        elapsedMs >= 0 &&
        elapsedMs <= 4294967295
      ) {
        result.transportElapsedMs = elapsedMs;
      }
      const httpStatus = timing.httpStatus ?? timing.transportHttpStatus;
      if (
        Number.isInteger(httpStatus) &&
        httpStatus >= 100 &&
        httpStatus <= 599
      ) {
        result.transportHttpStatus = httpStatus;
      }
      return result;
    }
    static safeHttp401(error) {
      if (String(error?.code || error?.message || "") !== "HTTP_401") return {};
      const diagnostic = error?.diagnostic || {};
      const session = diagnostic.sessionReady || {};
      const transport =
        diagnostic.transport === "native_fetch_request_same_origin"
          ? "fetch_request"
          : diagnostic.transport === "native_xhr_same_origin"
            ? "xhr"
            : ["fetch_request", "xhr"].includes(error?.generationTransport)
              ? error.generationTransport
              : null;
      const result = { httpStatus: 401 };
      if (transport) result.generationTransport = transport;
      for (const [field, source] of [
        [
          "httpSessionAtPresent",
          session.antiCsrf ?? error?.httpSessionAtPresent,
        ],
        [
          "httpSessionBuildPresent",
          session.build ?? error?.httpSessionBuildPresent,
        ],
        [
          "httpSessionFsidPresent",
          session.fSid ?? error?.httpSessionFsidPresent,
        ],
      ]) {
        if (typeof source === "boolean") result[field] = source;
      }
      const tokenLength = diagnostic.captchaTokenLength;
      if (
        Number.isInteger(tokenLength) &&
        tokenLength >= 0 &&
        tokenLength <= 8192
      ) {
        result.httpCaptchaTokenPresent = tokenLength > 0;
      } else if (typeof error?.httpCaptchaTokenPresent === "boolean") {
        result.httpCaptchaTokenPresent = error.httpCaptchaTokenPresent;
      }
      const age =
        diagnostic.captchaContext?.tokenToDispatchMs ?? error?.httpCaptchaAgeMs;
      if (Number.isInteger(age) && age >= 0 && age <= 6e5)
        result.httpCaptchaAgeMs = age;
      return result;
    }
    static withLineageCheck(message, error) {
      const lineageCheck = this.safeLineageCheck(error);
      return lineageCheck
        ? `${message} \xB7 ${lineageCheck}`.slice(0, 1200)
        : message;
    }
    static fromFailedOutputs(outputs) {
      const error = Object.assign(
        new Error(outputs[0]?.error || "V2_OPERATION_FAILED"),
        {
          driver: "v2",
          stage: "terminal",
          dispatchStarted: true,
          retryable: false,
          grpcCode:
            outputs.find((output) => Number.isInteger(output.grpcCode))
              ?.grpcCode ?? null,
          grpcReason:
            outputs.find((output) => output.grpcReason)?.grpcReason || null,
          providerErrorCodes: outputs.flatMap(
            (output) => output.providerErrorCodes || [],
          ),
          operationId: outputs[0]?.operationId || null,
          failureDetails: this.sanitizeFailureDetails(
            outputs.map((output) => ({
              ...output.failureDetail,
              operationId: output.operationId,
            })),
          ),
          diagnostic: {
            outputs: outputs.map((output) => ({
              operationId: output.operationId,
              state: output.state,
              rawState: output.rawState ?? null,
              model: output.model || null,
              error: output.error || null,
              failureDetail:
                this.sanitizeFailureDetails([output.failureDetail])[0] || null,
            })),
          },
        },
      );
      return this.normalize(error);
    }
    static displayMessage(error) {
      const rawCode = String(
        error?.code || error?.message || "FLOW_API_FAILED",
      );
      const code = /^(RPC_REJECTED|RPC_REJECT)$/.test(rawCode)
        ? "GOOGLE_REJECTED"
        : rawCode;
      if (
        code === "PROMPT_TOO_LONG" &&
        Number.isInteger(error.diagnostic?.promptChars) &&
        Number.isInteger(error.diagnostic?.promptMaxLength)
      ) {
        const key = "flowPromptCountError";
        const translated = window.I18n?.t?.(key, {
          count: error.diagnostic.promptChars,
          limit: error.diagnostic.promptMaxLength,
        });
        return translated && translated !== key
          ? translated
          : `${code} \xB7 ${error.diagnostic.promptChars}/${error.diagnostic.promptMaxLength}`;
      }
      if (
        code === "GOOGLE_INPUT_REJECTED" ||
        code === "GOOGLE_PROMPT_REJECTED"
      ) {
        const key = "flowInputRejected";
        const translated = window.I18n?.t?.(key, {
          count: error.diagnostic?.promptChars,
        });
        return translated && translated !== key
          ? translated
          : `GOOGLE_INPUT_REJECTED \xB7 gRPC 3 \xB7 PROMPT_CHARS=${error.diagnostic?.promptChars}`;
      }
      const reason =
        typeof error?.grpcReason === "string" &&
        /^[A-Z][A-Z0-9_]{2,119}$/.test(error.grpcReason)
          ? error.grpcReason
          : null;
      const providerCodes = Array.isArray(error?.providerErrorCodes)
        ? error.providerErrorCodes
        : [];
      const codes = [
        ...new Set(
          [
            ...providerCodes.filter(
              (value) =>
                typeof value === "string" &&
                /^PUBLIC_ERROR_[A-Z0-9_]{1,107}$/.test(value),
            ),
            reason,
          ].filter(Boolean),
        ),
      ].slice(0, 8);
      const parts = codes.length ? codes : [code];
      const messages = parts.map((value) => {
        if (
          [
            "bot_detected",
            "captcha_failed",
            "quota_exceeded",
            "per_model_daily",
            "tier_restricted",
          ].includes(error?.errorType)
        ) {
          const exactKey = "flowErrors.codes." + value;
          const exact = window.I18n?.t?.(exactKey);
          if (exact && exact !== exactKey) return exact;
          const typeKey = "gen.flowErr_" + error.errorType;
          const typed = window.I18n?.t?.(typeKey);
          if (typed && typed !== typeKey) return typed;
        }
        return (
          window.FlowApiAdapter?.formatError?.(value, error?.errorType) || value
        );
      });
      if (
        [
          "bot_detected",
          "captcha_failed",
          "quota_exceeded",
          "per_model_daily",
          "tier_restricted",
        ].includes(error?.errorType)
      ) {
        return [...new Set(messages)].join(" \xB7 ");
      }
      let translatedGrpc = false;
      if (!codes.length && Number.isInteger(error?.grpcCode)) {
        const rawGrpc = `gRPC ${error.grpcCode}`;
        const grpcMessage =
          window.FlowApiAdapter?.formatError?.(rawGrpc) || rawGrpc;
        translatedGrpc = grpcMessage !== rawGrpc;
        if (translatedGrpc) messages.splice(0, messages.length, grpcMessage);
        else messages.push(rawGrpc);
      }
      const failures = this.sanitizeFailureDetails(error?.failureDetails);
      const failureMessages = failures.map((value) =>
        [
          value.message && /^[A-Za-z][A-Za-z0-9_]{2,119}$/.test(value.message)
            ? window.FlowApiAdapter?.formatError?.(value.message) ||
              value.message
            : value.message,
          value.statusCode !== null
            ? window.FlowApiAdapter?.formatError?.(
                `Google status ${value.statusCode}`,
              ) || `Google status ${value.statusCode}`
            : null,
        ]
          .filter(Boolean)
          .join(" \xB7 "),
      );
      return this.withLineageCheck(
        [...new Set(failureMessages.length ? failureMessages : messages)]
          .join(" \xB7 ")
          .slice(0, 1200),
        error,
      );
    }
  }
  window.FlowApiDriverError = FlowApiDriverError;
  if (typeof globalThis !== "undefined")
    globalThis.FlowApiDriverError = FlowApiDriverError;
})();
