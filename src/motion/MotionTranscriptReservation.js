class MotionTranscriptReservation {
  static async reconcilePendingIntent({
    owner,
    frameId,
    journal,
    api,
    assertScope,
  }) {
    if (
      !owner ||
      !frameId ||
      !journal ||
      typeof api !== "function" ||
      typeof assertScope !== "function"
    )
      throw new Error("MOTION_RESERVATION_CONFIG_INVALID");
    await assertScope();
    const pending = await journal.pendingFailedTranscriptIntent({
      ...owner,
      frameId,
    });
    if (!pending) return { reconciled: false };
    const response = await api("POST", "execution/provider-web/intent", {
      run_id: pending.reservationId,
      token: pending.token,
      item_id: `${pending.reservationId}:0`,
      attempt_id: pending.attemptId,
      prompt_index: 0,
      reconcile_only: true,
      request_nonce: crypto.randomUUID(),
      ...(pending.previousAttemptId && {
        retry_previous_attempt_id: pending.previousAttemptId,
        retry_reason: "motion_no_result",
      }),
    });
    const receipt = response?.data || response;
    if (
      response?.success === false ||
      receipt?.status !== "dispatch_intent" ||
      receipt.dispatch_allowed !== false
    )
      throw new Error("MOTION_INTENT_RECONCILE_REQUIRED");
    await assertScope();
    await journal.confirmTranscriptIntent({
      ...owner,
      frameId,
      frameRunId: pending.frameRunId,
      inputRevision: pending.inputRevision,
      operationId: pending.attemptId,
    });
    return { reconciled: true };
  }
  static async reserve({ attempt, reservationId, journal, api, assertScope }) {
    if (
      !attempt ||
      typeof api !== "function" ||
      typeof assertScope !== "function" ||
      !journal
    )
      throw new Error("MOTION_RESERVATION_CONFIG_INVALID");
    await assertScope();
    const run = await journal.get(attempt);
    if (
      !run ||
      run.runId !== attempt.runId ||
      !["chatgpt", "gemini"].includes(run.transcriptionProvider)
    )
      throw new Error("MOTION_RESERVATION_SCOPE_INVALID");
    let reservation = await journal.prepareTranscriptReservation({
      ...attempt,
      reservationId,
    });
    if (reservation.token) {
      if (
        reservation.retryLimit !== run.transcriptMaxRetries ||
        reservation.retryEnabled !== run.retryEnabled
      )
        throw new Error("MOTION_RESERVATION_SNAPSHOT_MISMATCH");
      if (reservation.expiresAt <= Date.now()) {
        await assertScope();
        try {
          await api("POST", "execution/cancel-undispatched-motion", {
            token: reservation.token,
            run_id: reservation.reservationId,
            request_nonce: crypto.randomUUID(),
          });
        } catch (_) {}
        await assertScope();
        const response2 = await api("POST", "execution/settlement", {
          token: reservation.token,
          request_nonce: crypto.randomUUID(),
        });
        const receipt = response2?.data || response2;
        console.info(
          "[MotionReservationRecovery]",
          JSON.stringify({
            runId: attempt.runId,
            frameId: attempt.frameId,
            stage: "expired_receipt",
            tokenStatus: receipt?.token_status || null,
            dispatchIntents:
              receipt?.provider_web?.dispatch_intent_count ?? null,
            sameReservation:
              receipt?.provider_web?.run_id === reservation.reservationId,
          }),
        );
        if (
          response2?.success === false ||
          receipt?.provider_web?.run_id !== reservation.reservationId ||
          receipt.provider_web.source !== "motion" ||
          receipt.provider_web.dispatch_intent_count !== 0 ||
          !["expired", "revoked"].includes(receipt.token_status)
        )
          throw new Error("MOTION_RESERVATION_EXPIRED");
        await assertScope();
        reservation = await journal.replaceUndispatchedTranscriptReservation({
          ...attempt,
          receipt,
          previousReservationId: reservation.reservationId,
          previousToken: reservation.token,
          reservationId: crypto.randomUUID(),
        });
        reservationId = reservation.reservationId;
      }
      if (reservation.token) return reservation;
    }
    await assertScope();
    const response = await api("POST", "execution/provider-web/reserve", {
      run_id: reservationId,
      source: "motion",
      provider: run.transcriptionProvider,
      media_type: "text",
      prompt_count: 1,
      ref_count: 0,
      motion_tool_project_id: attempt.toolProjectId,
      motion_project_run_id: attempt.runId,
      motion_frame_id: attempt.frameId,
      motion_frame_run_id: attempt.frameRunId,
      motion_source_revision: run.sourceRevision,
      motion_input_revision: attempt.inputRevision,
      ...(attempt.fullAudioFrames && {
        motion_full_audio_frames: attempt.fullAudioFrames,
        motion_full_audio_timeline: attempt.fullAudioTimeline,
        motion_profile_key: run.profileKey || "default",
        motion_profile_revision: run.profileRevision,
      }),
      request_nonce: crypto.randomUUID(),
    });
    const value = response?.data || response;
    if (
      response?.success === false ||
      typeof value?.execution_token !== "string" ||
      !value.execution_token ||
      value.token_status !== "active" ||
      !Number.isFinite(Number(value.expires_in)) ||
      Number(value.expires_in) <= 0
    )
      throw new Error(
        response?.error?.code || "MOTION_RESERVATION_UNAVAILABLE",
      );
    await assertScope();
    const expiresAt = Date.now() + Math.floor(Number(value.expires_in) * 1e3);
    await journal.commitTranscriptReservation({
      ...attempt,
      reservationId,
      token: value.execution_token,
      expiresAt,
      retryLimit: value.motion_retry_limit,
      retryEnabled: value.motion_retry_enabled,
      startupMs: value.motion_provider_startup_ms,
      textTimeoutMs: value.motion_text_timeout_ms,
    });
    if (
      value.motion_retry_limit !== run.transcriptMaxRetries ||
      value.motion_retry_enabled !== run.retryEnabled
    )
      throw new Error("MOTION_RESERVATION_SNAPSHOT_MISMATCH");
    return {
      reservationId,
      token: value.execution_token,
      expiresAt,
      startupMs: value.motion_provider_startup_ms,
      textTimeoutMs: value.motion_text_timeout_ms,
    };
  }
  static async recoverExpired({
    owner,
    frameId,
    reservation,
    journal,
    api,
    assertScope,
  }) {
    await assertScope();
    let response;
    try {
      response = await api("POST", "execution/cancel-undispatched-motion", {
        token: reservation.token,
        run_id: reservation.reservationId,
        request_nonce: crypto.randomUUID(),
      });
    } catch (_) {
      return false;
    }
    const closed = response?.data || response;
    if (
      response?.success === false ||
      closed?.undispatched !== true ||
      closed.transcript_reset !== true
    )
      return false;
    await assertScope();
    const settled = await api("POST", "execution/settlement", {
      token: reservation.token,
      request_nonce: crypto.randomUUID(),
    });
    if (settled?.success === false) return false;
    await assertScope();
    await journal.recoverExpiredTranscriptReservation({
      ...owner,
      frameId,
      frameRunId: reservation.frameRunId,
      inputRevision: reservation.inputRevision,
      previousReservationId: reservation.reservationId,
      previousToken: reservation.token,
      reservationId: crypto.randomUUID(),
      receipt: settled?.data || settled,
      serverTranscriptReset: true,
    });
    return true;
  }
  static async intent({ attempt, journal, api, assertScope }) {
    await assertScope();
    const pending = await journal.beginTranscriptIntent(attempt);
    await assertScope();
    const response = await api("POST", "execution/provider-web/intent", {
      run_id: pending.reservationId,
      token: pending.token,
      item_id: `${pending.reservationId}:0`,
      attempt_id: pending.attemptId,
      prompt_index: 0,
      request_nonce: crypto.randomUUID(),
      ...(pending.previousAttemptId && {
        retry_previous_attempt_id: pending.previousAttemptId,
        retry_reason: pending.retryReason,
      }),
    });
    const receipt = response?.data || response;
    if (response?.success === false || receipt?.status !== "dispatch_intent")
      throw new Error(response?.error?.code || "MOTION_INTENT_DENIED");
    await assertScope();
    await journal.confirmTranscriptIntent(attempt);
    return {
      allowed: receipt.dispatch_allowed === true,
      replayed: receipt.replayed === true,
    };
  }
  static async settle({
    attempt,
    status,
    journal,
    api,
    assertScope,
    flush,
    onDiagnostic = () => {},
  }) {
    if (typeof flush !== "function")
      throw new Error("MOTION_SETTLEMENT_CONFIG_INVALID");
    await assertScope();
    await flush();
    const pending = await journal.beginTranscriptSettlement({
      ...attempt,
      status,
    });
    if (pending.settled) return { status: pending.status, replayed: true };
    let confirmed = false;
    const diagnose = (operation, eventState, error = null) => {
      const raw = String(error?.code || error?.message || "");
      try {
        onDiagnostic({
          phase: "transcript_settlement",
          operation,
          eventState,
          code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw) ? raw : null,
          httpStatus: Number(error?.httpStatus) || null,
        });
      } catch (_) {}
    };
    try {
      await assertScope();
      diagnose("complete", "start");
      const response = await api("POST", "execution/complete", {
        token: pending.token,
        status,
        request_nonce: crypto.randomUUID(),
      });
      const receipt = response?.data || response;
      confirmed = response?.success !== false && receipt?.status === status;
      diagnose("complete", confirmed ? "verified" : "unconfirmed");
    } catch (error) {
      diagnose("complete", "failed", error);
    }
    if (!confirmed) {
      await assertScope();
      diagnose("settlement", "start");
      let response;
      try {
        response = await api("POST", "execution/settlement", {
          token: pending.token,
          request_nonce: crypto.randomUUID(),
        });
      } catch (error) {
        diagnose("settlement", "failed", error);
        throw error;
      }
      const receipt = response?.data || response;
      confirmed =
        response?.success !== false &&
        receipt?.provider_web?.run_id === pending.reservationId &&
        receipt?.provider_web?.source === "motion" &&
        receipt?.settlement?.method === "complete" &&
        receipt?.settlement?.status === status;
      diagnose("settlement", confirmed ? "verified" : "unconfirmed");
    }
    if (!confirmed) throw new Error("MOTION_SETTLEMENT_UNCONFIRMED");
    await assertScope();
    await journal.confirmTranscriptSettlement({ ...attempt, status });
    return { status, replayed: false };
  }
}
globalThis.MotionTranscriptReservation = MotionTranscriptReservation;
