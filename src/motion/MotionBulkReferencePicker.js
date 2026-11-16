class MotionBulkReferencePicker {
  constructor({
    userId,
    flowProjectId,
    profile,
    onChange,
    onBusy,
    onError,
    onStatus,
  }) {
    this.userId = Number(userId);
    this.flowProjectId = flowProjectId;
    this.profile = profile;
    this.onChange = onChange;
    this.onBusy = onBusy;
    this.onError = onError;
    this.onStatus = onStatus;
    this.epoch = 0;
    this.closed = false;
    this.busy = false;
  }
  _assert(target, expected = null) {
    if (
      this.closed ||
      Number(window.authManager?.getUser?.()?.id) !== this.userId ||
      window._currentProjectId !== this.flowProjectId ||
      target?.projectId !== this.flowProjectId ||
      !Number.isInteger(target?.tabId) ||
      !target.driverKey ||
      (expected &&
        (target.tabId !== expected.tabId ||
          target.driverKey !== expected.driverKey ||
          target.origin !== expected.origin))
    ) {
      throw new Error("MOTION_FLOW_PROJECT_MISMATCH");
    }
  }
  async open(kind, references) {
    if (
      this.busy ||
      !["character", "background"].includes(kind) ||
      !window.imagePickerModal ||
      !window.ImagePickerModal ||
      !window.MessageBridge ||
      !this.profile?.settings?.flow_model
    )
      throw new Error("MOTION_REF_PICKER_UNAVAILABLE");
    if (
      kind === "background" &&
      (this.profile.settings.show_background_refs === false ||
        references.mode !== "character_background")
    )
      throw new Error("MOTION_BACKGROUND_DISABLED");
    const epoch = ++this.epoch;
    const target = await window.MessageBridge.getProjectTargetContext(
      this.flowProjectId,
    );
    this._assert(target);
    const caps = window.ImagePickerModal.resolveCapsMulti({
      provider: "flow",
      mode: "video",
      isFrames: false,
      modelValue: this.profile.settings.flow_model,
      duration: this.profile.settings.flow_duration,
    });
    const other =
      kind === "background"
        ? references.character.length
        : references.mode === "character_background"
          ? references.background.length
          : 0;
    const total = Number.isInteger(caps.total)
      ? Math.max(0, caps.total - 1)
      : caps.image;
    const available = Math.min(caps.image ?? NaN, total ?? NaN) - other;
    if (!Number.isFinite(available) || available < 0)
      throw new Error("MOTION_REF_CAP_CONFIG_UNAVAILABLE");
    const selected = references[kind];
    const selectionSnapshot = JSON.stringify(references);
    window.imagePickerModal.open({
      expectedFlowTarget: target,
      cleanFlowRefs: false,
      mediaFilter: "image",
      refAuditContext: { surface: "motion" },
      singleSelect: available > 0,
      maxSelections: Math.min(1, available),
      maxImageSelections: Math.min(1, available),
      maxVideoSelections: 0,
      maxTotalSelections: Math.min(1, available),
      existingFileIds: selected.map((ref) => ref.fileId),
      existingMedia: Object.fromEntries(
        selected.map((ref) => [ref.fileId, ref]),
      ),
      onConfirm: (items) => {
        this.pickerOverlay = null;
        if (JSON.stringify(references) !== selectionSnapshot) {
          this.onError?.("MOTION_REF_SELECTION_STALE", kind);
          return;
        }
        void this._accept(kind, items, target, epoch);
      },
    });
    this.pickerOverlay = window.imagePickerModal.overlay;
  }
  async uploadLocal(kind, file, references) {
    if (
      this.busy ||
      !["character", "background"].includes(kind) ||
      !file?.type?.startsWith("image/")
    ) {
      throw new Error("MOTION_REF_IMAGE_REQUIRED");
    }
    if (
      kind === "background" &&
      (this.profile.settings.show_background_refs === false ||
        references.mode !== "character_background")
    )
      throw new Error("MOTION_BACKGROUND_DISABLED");
    const caps = window.ImagePickerModal.resolveCapsMulti({
      provider: "flow",
      mode: "video",
      isFrames: false,
      modelValue: this.profile.settings.flow_model,
      duration: this.profile.settings.flow_duration,
    });
    const other =
      kind === "background"
        ? references.character.length
        : references.mode === "character_background"
          ? references.background.length
          : 0;
    const total = Number.isInteger(caps.total)
      ? Math.max(0, caps.total - 1)
      : caps.image;
    if (
      !Number.isFinite(Math.min(caps.image ?? NaN, total ?? NaN)) ||
      Math.min(caps.image, total) - other < 1
    )
      throw (
        window.ImagePickerModal.motionReferenceCapError?.({
          caps,
          imageCount: other + 1,
          stage: "prepare",
          modelValue: this.profile.settings.flow_model,
        }) || new Error("MOTION_REF_CAP_EXCEEDED")
      );
    const epoch = ++this.epoch;
    const target = await window.MessageBridge.getProjectTargetContext(
      this.flowProjectId,
    );
    this._assert(target);
    await this._accept(kind, [{ source: "upload", file }], target, epoch);
  }
  async rescan(kind, references) {
    if (this.closed || this.busy || !["character", "background"].includes(kind))
      return;
    const ref = references[kind]?.[0];
    if (!ref) return;
    const epoch = ++this.epoch,
      original = JSON.stringify(ref);
    this.busy = true;
    this.onBusy?.(kind, true, "rescan");
    const safeThumbnail = (value) =>
      typeof value === "string" &&
      value.length <= 8192 &&
      /^https:\/\//i.test(value)
        ? value
        : null;
    try {
      const target = await window.MessageBridge.getProjectTargetContext(
        this.flowProjectId,
      );
      this._assert(target);
      if (ref.project_id !== target.projectId)
        throw new Error("MOTION_REF_PROJECT_MISMATCH");
      const uuid = [ref.media_uuid, ref.fileId].find((value) =>
        window.flow_uuid_gateway.isUuid(value),
      );
      let corrected = { ...ref },
        thumbnail = null;
      if (uuid) {
        const catalog = await window.MessageBridge.lookupFlowMediaCatalog([
          uuid,
        ]).catch(() => null);
        this._assert(
          await window.MessageBridge.getTargetContext(target),
          target,
        );
        const info = catalog?.known?.[uuid];
        if (
          catalog?.supported === true &&
          catalog.projectId === target.projectId &&
          String(info?.media_uuid || "").toLowerCase() === uuid.toLowerCase() &&
          info?.type === "image" &&
          window.flow_uuid_gateway.isAsb(info?.persistent_media_id)
        ) {
          corrected = {
            ...ref,
            media_uuid: uuid,
            persistent_media_id: info.persistent_media_id,
            file_name: info.persistent_media_id,
            identity_durability: "durable",
            identity_aliases: [
              ...new Set([
                ...(ref.identity_aliases || []),
                uuid,
                info.persistent_media_id,
              ]),
            ].slice(0, 20),
          };
          thumbnail = safeThumbnail(info.thumbnail || info.source_thumbnail);
        }
      }
      if (!thumbnail) {
        const result = await window.MessageBridge.getThumbnailsByIds(
          [ref.fileId],
          {
            deep: true,
            fileNamesById: {
              [ref.fileId]:
                corrected.file_name || ref.persistent_media_id || "",
            },
          },
        );
        this._assert(
          await window.MessageBridge.getTargetContext(target),
          target,
        );
        const info = result?.results?.[ref.fileId];
        if (!info?.type || info.type === "image")
          thumbnail = safeThumbnail(info?.thumbnail);
      }
      if (
        this.closed ||
        epoch !== this.epoch ||
        JSON.stringify(references[kind]?.[0]) !== original
      )
        return;
      if (thumbnail) corrected.thumbnail = thumbnail;
      this.onChange?.(kind, [corrected]);
      this.onStatus?.(kind, !!thumbnail);
    } catch (error) {
      if (!this.closed && epoch === this.epoch)
        this.onError?.(error?.message || "MOTION_REF_FAILED", kind);
    } finally {
      this.busy = false;
      if (!this.closed && epoch === this.epoch)
        this.onBusy?.(kind, false, "rescan");
    }
  }
  async _accept(kind, items, target, epoch) {
    if (this.closed || epoch !== this.epoch) return;
    if (!Array.isArray(items) || items.length > 1) {
      this.onError?.("MOTION_REFERENCE_LIMIT_ONE", kind);
      return;
    }
    if (!items.length) return;
    this.busy = true;
    this.onBusy?.(kind, true);
    try {
      this._assert(await window.MessageBridge.getTargetContext(target), target);
      const next = [];
      for (let item of items) {
        let file = item.source === "upload" ? item.file : null;
        let pendingKey = null;
        try {
          if (item.source === "album") {
            const prepared =
              await window.ImagePickerModal.prepareAlbumImageForRef(item);
            pendingKey = prepared?.key || null;
            file = window.pendingUploadFiles?.get?.(pendingKey)?.file || null;
          }
          if (file) {
            if (!file.type?.startsWith("image/"))
              throw new Error("MOTION_REF_IMAGE_REQUIRED");
            const base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve(String(reader.result || "").split(",")[1] || "");
              reader.onerror = () =>
                reject(reader.error || new Error("MOTION_REF_READ_FAILED"));
              reader.readAsDataURL(file);
            });
            this._assert(
              await window.MessageBridge.getTargetContext(target),
              target,
            );
            if (epoch !== this.epoch)
              throw new Error("MOTION_REF_SELECTION_STALE");
            const payload = [
              { name: file.name || "motion-ref.png", type: file.type, base64 },
            ];
            let uploaded;
            try {
              uploaded = await window.MessageBridge.uploadFilesToFlow(payload, {
                surface: "workflow",
                expectedFlowTarget: target,
              });
            } finally {
              payload[0].base64 = "";
            }
            const detail = uploaded?.tileDetails?.[0];
            if (uploaded?.error || !detail?.id)
              throw new Error(
                uploaded?.error || "MOTION_REF_UPLOAD_UNCONFIRMED",
              );
            if (detail.project_id && detail.project_id !== target.projectId)
              throw new Error("MOTION_REF_PROJECT_MISMATCH");
            item = {
              ...item,
              source: "flow",
              fileId: detail.persistent_media_id || detail.id,
              media_uuid: detail.media_uuid || detail.id,
              persistent_media_id: detail.persistent_media_id || null,
              file_name: detail.file_name || null,
              thumbnail: detail.thumbnailUrl || detail.thumbnail || "",
              identity_aliases: detail.identity_aliases || [detail.id],
              identity_durability: detail.identity_durability || "session",
            };
          } else if (item.source !== "flow" && item.source !== "existing")
            throw new Error("MOTION_REF_SOURCE_UNVERIFIED");
          const fileId = String(item.fileId || "").trim();
          if (
            !fileId ||
            fileId.startsWith("upload_") ||
            (item.project_id && item.project_id !== target.projectId)
          ) {
            throw new Error("MOTION_REF_ID_UNVERIFIED");
          }
          const thumbnail =
            [item.source_thumbnail, item.thumbnail].find(
              (value) =>
                typeof value === "string" &&
                value.length <= 8192 &&
                /^https:\/\//i.test(value),
            ) || null;
          next.push({
            fileId,
            media_uuid: item.media_uuid || null,
            persistent_media_id: item.persistent_media_id || null,
            file_name: item.file_name || null,
            identity_aliases: Array.isArray(item.identity_aliases)
              ? item.identity_aliases.filter(Boolean).slice(0, 20)
              : [],
            identity_durability: ["durable", "session"].includes(
              item.identity_durability,
            )
              ? item.identity_durability
              : "session",
            type: "image",
            project_id: target.projectId,
            thumbnail,
            display_name:
              String(item.display_name || item.name || "").slice(0, 255) ||
              null,
          });
        } finally {
          if (pendingKey) window.pendingUploadFiles?.delete?.(pendingKey);
        }
      }
      this._assert(await window.MessageBridge.getTargetContext(target), target);
      if (epoch !== this.epoch) throw new Error("MOTION_REF_SELECTION_STALE");
      this.onChange?.(kind, next);
    } catch (error) {
      if (!this.closed && epoch === this.epoch)
        this.onError?.(error?.message || "MOTION_REF_FAILED", kind);
    } finally {
      this.busy = false;
      if (!this.closed && epoch === this.epoch) this.onBusy?.(kind, false);
    }
  }
  close() {
    this.closed = true;
    this.epoch++;
    if (
      this.pickerOverlay &&
      window.imagePickerModal?.overlay === this.pickerOverlay
    )
      window.imagePickerModal.close?.();
    this.pickerOverlay = null;
  }
}
globalThis.MotionBulkReferencePicker = MotionBulkReferencePicker;
