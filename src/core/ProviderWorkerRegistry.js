var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) =>
  key in obj
    ? __defProp(obj, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value,
      })
    : (obj[key] = value);
var __publicField = (obj, key, value) =>
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class ProviderWorkerRegistry {
  static _serialize(task) {
    const next = this._mutation.catch(() => {}).then(task);
    this._mutation = next.catch(() => {});
    return next;
  }
  static async _read() {
    const data = await chrome.storage.session.get(this.KEY);
    return data?.[this.KEY] && typeof data[this.KEY] === "object"
      ? data[this.KEY]
      : {};
  }
  static async _write(records) {
    await chrome.storage.session.set({ [this.KEY]: records });
  }
  static async prepareWorkflowLayout({
    windowId,
    runId,
    screenLeft,
    screenTop,
    screenWidth,
    screenHeight,
  }) {
    return this._prepareSourceLayout({
      windowId,
      runId,
      screenLeft,
      screenTop,
      screenWidth,
      screenHeight,
      key: this.WORKFLOW_LAYOUT_KEY,
    });
  }
  static async prepareMainLayout({
    windowId,
    runId,
    screenLeft,
    screenTop,
    screenWidth,
    screenHeight,
  }) {
    return this._prepareSourceLayout({
      windowId,
      runId,
      screenLeft,
      screenTop,
      screenWidth,
      screenHeight,
      key: `${this.MAIN_LAYOUT_KEY}${windowId}`,
    });
  }
  static async _prepareSourceLayout({
    windowId,
    runId,
    screenLeft,
    screenTop,
    screenWidth,
    screenHeight,
    key,
  }) {
    return this._serialize(async () => {
      if (
        !Number.isInteger(windowId) ||
        typeof runId !== "string" ||
        !runId ||
        ![screenLeft, screenTop, screenWidth, screenHeight].every(
          Number.isSafeInteger,
        ) ||
        screenWidth < 850 ||
        screenHeight < 400
      )
        return { success: false, error: "WORKFLOW_LAYOUT_ARGUMENT_INVALID" };
      const existing = (await chrome.storage.session.get(key))?.[key];
      const source = await chrome.windows.get(windowId).catch(() => null);
      if (!source) return { success: false, error: "WORKFLOW_WINDOW_CLOSED" };
      const matchesExisting =
        existing?.windowId === windowId &&
        source.state === "normal" &&
        ["left", "top", "width", "height"].every(
          (field) =>
            Number.isFinite(source[field]) &&
            Math.abs(source[field] - existing.bounds?.[field]) <= 12,
        );
      if (matchesExisting) {
        if (!existing.runIds?.includes(runId)) {
          existing.runIds = [...(existing.runIds || []), runId];
          await chrome.storage.session.set({ [key]: existing });
        }
        return { success: true, adjusted: true, joined: true };
      }
      const visibleWidth =
        Number.isFinite(source.left) && Number.isFinite(source.width)
          ? Math.max(
              0,
              Math.min(source.left + source.width, screenLeft + screenWidth) -
                Math.max(source.left, screenLeft),
            )
          : 0;
      const fullWidth =
        source.state === "normal" && visibleWidth >= screenWidth * 0.98;
      if (!["fullscreen", "maximized"].includes(source.state) && !fullWidth)
        return { success: true, adjusted: false };
      const original = {
        state: source.state,
        left: source.left,
        top: source.top,
        width: source.width,
        height: source.height,
      };
      const height = fullWidth ? source.height : Math.floor(screenHeight * 0.9);
      const bounds = {
        left: screenLeft + 8,
        top: fullWidth
          ? source.top
          : screenTop + Math.floor((screenHeight - height) / 2),
        width: Math.floor(screenWidth * 0.9),
        height,
      };
      const restoreOriginal = async () => {
        if (original.state === "normal") {
          await chrome.windows
            .update(windowId, {
              left: original.left,
              top: original.top,
              width: original.width,
              height: original.height,
            })
            .catch(() => {});
        } else {
          await chrome.windows
            .update(windowId, { state: original.state })
            .catch(() => {});
        }
      };
      if (source.state !== "normal")
        await chrome.windows.update(windowId, { state: "normal" });
      let applied = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          await chrome.windows.update(windowId, bounds);
          await new Promise((resolve) => setTimeout(resolve, 180));
          applied = await chrome.windows.get(windowId);
          if (
            applied.state === "normal" &&
            applied.height >= bounds.height - 32 &&
            Math.abs(applied.width - bounds.width) <= 32
          )
            break;
        }
      } catch (error) {
        await restoreOriginal();
        throw error;
      }
      if (
        applied?.state !== "normal" ||
        applied.height < bounds.height - 32 ||
        Math.abs(applied.width - bounds.width) > 32
      ) {
        await restoreOriginal();
        return {
          success: false,
          error: "WORKFLOW_LAYOUT_BOUNDS_NOT_APPLIED",
          requested: bounds,
          actual: applied && {
            left: applied.left,
            top: applied.top,
            width: applied.width,
            height: applied.height,
            state: applied.state,
          },
        };
      }
      await chrome.storage.session.set({
        [key]: {
          windowId,
          runIds: [runId],
          original,
          bounds: {
            left: applied.left,
            top: applied.top,
            width: applied.width,
            height: applied.height,
          },
        },
      });
      console.info(
        "[ProviderWorkerRegistry] workflow_layout_prepared",
        JSON.stringify({
          windowId,
          runId,
          originalState: original.state,
          bounds: applied && {
            left: applied.left,
            top: applied.top,
            width: applied.width,
            height: applied.height,
          },
        }),
      );
      return { success: true, adjusted: true };
    });
  }
  static async restoreWorkflowLayout({ windowId, runId }) {
    return this._restoreSourceLayout({
      windowId,
      runId,
      key: this.WORKFLOW_LAYOUT_KEY,
    });
  }
  static async restoreMainLayout({ windowId, runId }) {
    return this._restoreSourceLayout({
      windowId,
      runId,
      key: `${this.MAIN_LAYOUT_KEY}${windowId}`,
    });
  }
  static async _restoreSourceLayout({ windowId, runId, key }) {
    return this._serialize(async () => {
      const lease = (await chrome.storage.session.get(key))?.[key];
      if (
        !lease ||
        lease.windowId !== windowId ||
        !lease.runIds?.includes(runId)
      )
        return { success: true, restored: false };
      lease.runIds = lease.runIds.filter((id) => id !== runId);
      if (lease.runIds.length) {
        await chrome.storage.session.set({ [key]: lease });
        return { success: true, restored: false, reason: "OTHER_RUNS_ACTIVE" };
      }
      await chrome.storage.session.remove(key);
      const current = await chrome.windows.get(windowId).catch(() => null);
      const sameBounds =
        current?.state === "normal" &&
        ["left", "top", "width", "height"].every(
          (field) => Math.abs(current[field] - lease.bounds[field]) <= 12,
        );
      if (!sameBounds)
        return { success: true, restored: false, reason: "WINDOW_CHANGED" };
      console.info(
        "[ProviderWorkerRegistry] worker_layout_retained",
        JSON.stringify({ windowId, runId }),
      );
      return { success: true, restored: false, retained: true };
    });
  }
  static _guardSourceWorkers(records, sourceWindowId) {
    const until = Date.now() + 2e3;
    for (const record of Object.values(records)) {
      if (
        !record.reusedTab &&
        record.sourceWindowId === sourceWindowId &&
        !(record.focusLeaseUntil > Date.now())
      ) {
        record.focusGuardUntil = Math.max(record.focusGuardUntil || 0, until);
      }
    }
  }
  static async _lowerSourceWorkers(records, sourceWindowId) {
    const ids = [
      ...new Set(
        Object.values(records)
          .filter(
            (record) =>
              !record.reusedTab && record.sourceWindowId === sourceWindowId,
          )
          .map((record) => record.windowId)
          .filter(Number.isInteger),
      ),
    ];
    const lowered = [];
    for (const id of ids) {
      const worker = await chrome.windows.get(id).catch(() => null);
      if (worker?.state === "normal") {
        if (
          await chrome.windows.update(id, { focused: false }).catch(() => null)
        )
          lowered.push(id);
      }
    }
    if (ids.length)
      console.info(
        "[ProviderWorkerRegistry] worker_z_order_lower",
        JSON.stringify({
          sourceWindowId,
          workerWindowIds: ids,
          loweredWindowIds: lowered,
        }),
      );
    return lowered;
  }
  static async logFocusChange(windowId) {
    return this._serialize(async () => {
      const owned = Object.values(await this._read()).filter(
        (record) => !record.reusedTab,
      );
      if (!owned.length) return;
      const lateWorker = owned.find(
        (record) =>
          record.windowId === windowId &&
          Number.isInteger(record.sourceWindowId) &&
          record.focusGuardUntil > Date.now() &&
          !(record.focusLeaseUntil > Date.now()),
      );
      let recovered = false;
      if (lateWorker) {
        const worker = await chrome.windows.get(windowId).catch(() => null);
        const target = await chrome.windows
          .get(lateWorker.sourceWindowId)
          .catch(() => null);
        if (worker?.focused === true && target) {
          await this._lowerSourceWorkers(
            Object.fromEntries(
              owned.map((record) => [record.workerId, record]),
            ),
            target.id,
          );
          recovered = !!(await chrome.windows
            .update(target.id, { focused: true })
            .catch(() => null));
        }
      }
      const ids = [
        ...new Set(
          owned
            .flatMap((record) => [record.sourceWindowId, record.windowId])
            .filter(Number.isInteger),
        ),
      ];
      const states = await Promise.all(
        ids.map(async (id) => {
          const window = await chrome.windows.get(id).catch(() => null);
          return {
            windowId: id,
            focused: window?.focused === true,
            state: window?.state || null,
          };
        }),
      );
      console.info(
        "[ProviderWorkerRegistry] window_focus_changed",
        JSON.stringify({
          eventWindowId: windowId,
          recoveredLateWorkerFocus: recovered,
          guardedWorkerId: lateWorker?.workerId || null,
          states,
        }),
      );
    });
  }
  static _origin(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" ? parsed.origin : null;
    } catch (_) {
      return null;
    }
  }
  static _transientBlank(tab) {
    return !!tab && (!tab.url || tab.url === "about:blank");
  }
  static _tabState(tab, origin) {
    return {
      status: tab?.status || "unknown",
      location: this._transientBlank(tab)
        ? "blank"
        : this._origin(tab?.url) === origin
          ? "provider"
          : "other",
    };
  }
  static _matchesAccount(tab, record) {
    if (record.provider !== "gemini") return true;
    try {
      const path = new URL(tab.url).pathname;
      return (
        path === `${record.accountPrefix || ""}/app` ||
        path === `${record.accountPrefix || ""}/app/` ||
        path.startsWith(`${record.accountPrefix || ""}/app/`)
      );
    } catch (_) {
      return false;
    }
  }
  static _windowBounds(
    source,
    slot,
    count,
    screenTop = null,
    screenHeight = null,
    screenLeft = null,
    screenWidth = null,
  ) {
    if (
      !Number.isInteger(source?.width) ||
      source.width <= 100 ||
      !Number.isInteger(source?.height) ||
      source.height <= 100
    )
      return {};
    const top = Number.isSafeInteger(screenTop) ? screenTop : source.top;
    const heightAvailable =
      Number.isSafeInteger(screenHeight) && screenHeight > 100
        ? screenHeight
        : source.height;
    const offset = Math.min(240, Math.round(source.width * 0.2));
    let left = Number.isInteger(source.left) ? source.left + offset : null;
    let width = source.width - 48;
    if (
      left !== null &&
      Number.isSafeInteger(screenLeft) &&
      Number.isSafeInteger(screenWidth) &&
      screenWidth > 100
    ) {
      const screenRight = screenLeft + screenWidth;
      const leftRoom = Math.max(0, source.left - screenLeft);
      const rightRoom = Math.max(0, screenRight - (source.left + source.width));
      if (rightRoom >= width + 8) left = source.left + source.width + 8;
      else if (leftRoom >= width + 8) left = source.left - width - 8;
      else if (leftRoom > rightRoom)
        left = Math.max(screenLeft, source.left - offset);
      else left = Math.max(screenLeft, Math.min(left, screenRight - 100));
      width = Math.min(width, screenRight - left);
    }
    if (
      count > 1 &&
      Number.isInteger(source.left) &&
      Number.isInteger(source.top)
    ) {
      const height = Math.floor(heightAvailable / count);
      return { width, height, left, top: top + height * slot };
    }
    return {
      width,
      height: source.height - 48,
      ...(Number.isInteger(source.left) && Number.isInteger(source.top)
        ? { left, top }
        : {}),
    };
  }
  static async create(
    {
      workerId,
      epoch,
      userId,
      provider,
      reuseTabId = null,
      sourceWindowId = null,
      sourceSurface = null,
      accountTabId = null,
      layoutCount = 1,
      promptIndex = null,
      runId = null,
      toolProjectId = null,
      attemptId = null,
      flowTabId = null,
      hostEpoch = null,
      hostTabId = null,
      screenTop = null,
      screenHeight = null,
      screenLeft = null,
      screenWidth = null,
    },
    resolveAdmission = null,
  ) {
    return this._serialize(async () => {
      let admittedMax = null;
      if (sourceSurface === "motion" && !resolveAdmission)
        return { success: false, error: "MOTION_WORKER_ADMISSION_REQUIRED" };
      if (resolveAdmission) {
        const policy = await resolveAdmission(provider);
        if (policy?.enabled === false)
          return { success: false, error: "PROVIDER_WEB_PAUSED_BY_CONFIG" };
        if (
          policy?.enabled !== true ||
          !Number.isSafeInteger(policy.max) ||
          policy.max < 1 ||
          policy.max > 4
        )
          return { success: false, error: "PROVIDER_WORKER_CONFIG_INVALID" };
        admittedMax = policy.max;
        const records = await this._read();
        const creations =
          (await chrome.storage.session.get(this.MOTION_CREATION_KEY))?.[
            this.MOTION_CREATION_KEY
          ] || {};
        if (
          Object.keys(records).length +
            Object.keys(creations).filter((id) => !records[id]).length >=
          policy.max
        )
          return { success: false, error: "WORKER_CAPACITY_FULL" };
      }
      return this._create({
        workerId,
        epoch,
        userId,
        provider,
        reuseTabId,
        sourceWindowId,
        sourceSurface,
        accountTabId,
        layoutCount: sourceSurface === "motion" ? admittedMax : layoutCount,
        promptIndex,
        runId,
        toolProjectId,
        attemptId,
        flowTabId,
        hostEpoch,
        hostTabId,
        screenTop,
        screenHeight,
        screenLeft,
        screenWidth,
      });
    });
  }
  static async _create({
    workerId,
    epoch,
    userId,
    provider,
    reuseTabId,
    sourceWindowId,
    sourceSurface,
    accountTabId,
    layoutCount,
    promptIndex,
    runId,
    toolProjectId,
    attemptId,
    flowTabId,
    hostEpoch,
    hostTabId,
    screenTop,
    screenHeight,
    screenLeft,
    screenWidth,
  }) {
    if (
      !["muse", "chatgpt", "gemini"].includes(provider) ||
      !workerId ||
      !Number.isSafeInteger(epoch) ||
      !userId
    )
      return { success: false, error: "WORKER_ARGUMENT_INVALID" };
    if (
      runId !== null &&
      (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(runId))
    )
      return { success: false, error: "WORKER_RUN_INVALID" };
    if (
      sourceSurface !== null &&
      !["sidebar", "workflow", "motion"].includes(sourceSurface)
    )
      return { success: false, error: "WORKER_SOURCE_SURFACE_INVALID" };
    if (sourceSurface === "motion") {
      const uuid = (value) =>
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          String(value || ""),
        );
      if (
        !["chatgpt", "gemini"].includes(provider) ||
        reuseTabId !== null ||
        !uuid(runId) ||
        !uuid(toolProjectId) ||
        !uuid(attemptId) ||
        !Number.isInteger(flowTabId) ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(String(workerId))
      ) {
        return { success: false, error: "MOTION_WORKER_SCOPE_INVALID" };
      }
    }
    if (sourceSurface && !Number.isInteger(sourceWindowId))
      return { success: false, error: "WORKER_SOURCE_WINDOW_REQUIRED" };
    const baseUrl = getProviderWorkerUrl(
      provider,
      provider === "muse" ? "baseUrl" : "base",
    );
    const origin = this._origin(baseUrl);
    if (!origin) return { success: false, error: "WORKER_URL_CONFIG_MISSING" };
    let startUrl = getProviderWorkerUrl(
      provider,
      provider === "muse" ? "newChatUrl" : "createUrl",
    );
    if (!startUrl || this._origin(startUrl) !== origin)
      return { success: false, error: "WORKER_START_URL_CONFIG_MISSING" };
    let accountPrefix = "";
    if (provider === "gemini") {
      if (!Number.isInteger(accountTabId))
        return { success: false, error: "GEMINI_ACCOUNT_TAB_REQUIRED" };
      const accountTab = await chrome.tabs.get(accountTabId).catch(() => null);
      let accountUrl;
      try {
        accountUrl = new URL(accountTab?.url);
      } catch (_) {}
      const validRoute =
        accountUrl?.origin === origin &&
        (accountUrl.pathname === "/app" ||
          /^\/app\//.test(accountUrl?.pathname || "") ||
          /^\/u\/\d+\/?$/.test(accountUrl?.pathname || "") ||
          /^\/u\/\d+\/app(?:\/|$)/.test(accountUrl?.pathname || ""));
      if (!validRoute)
        return { success: false, error: "GEMINI_ACCOUNT_ROUTE_UNVERIFIED" };
      const accountRoute = /^\/u\/(\d+)(?:\/|$)/.exec(accountUrl.pathname);
      accountPrefix = accountRoute ? `/u/${accountRoute[1]}` : "";
      const configured = new URL(startUrl);
      if (!/^\/(?:u\/\d+\/)?app\/?$/.test(configured.pathname))
        return { success: false, error: "WORKER_START_URL_CONFIG_MISSING" };
      configured.pathname = `${accountPrefix}/app`;
      configured.search = "";
      configured.hash = "";
      startUrl = configured.href;
    }
    const records = await this._read();
    if (records[workerId]) return { success: false, error: "WORKER_ID_EXISTS" };
    if (!Number.isSafeInteger(layoutCount) || layoutCount < 1)
      return { success: false, error: "WORKER_LAYOUT_COUNT_INVALID" };
    if (reuseTabId !== null) {
      if (!Number.isInteger(reuseTabId))
        return { success: false, error: "WORKER_TAB_INVALID" };
      if (
        Object.values(records).some((record3) => record3.tabId === reuseTabId)
      )
        return { success: false, error: "WORKER_TAB_ALREADY_OWNED" };
      const tab2 = await chrome.tabs.get(reuseTabId).catch(() => null);
      if (
        !tab2 ||
        !Number.isInteger(tab2.windowId) ||
        !tab2.active ||
        this._origin(tab2.url) !== origin ||
        (provider === "gemini" &&
          !this._matchesAccount(tab2, { provider, accountPrefix }))
      )
        return { success: false, error: "WORKER_TAB_LOST" };
      const record2 = {
        workerId,
        epoch,
        userId: String(userId),
        provider,
        windowId: tab2.windowId,
        tabId: tab2.id,
        origin,
        reusedTab: true,
        ...(runId && { runId }),
        ...(sourceSurface && { sourceSurface }),
        ...(Number.isInteger(sourceWindowId) && { sourceWindowId }),
        ...(accountPrefix && { accountPrefix }),
      };
      records[workerId] = record2;
      await this._write(records);
      return { success: true, worker: record2 };
    }
    const sourceWindow = Number.isInteger(sourceWindowId)
      ? await chrome.windows.get(sourceWindowId).catch(() => null)
      : null;
    const foregroundBeforeCreate = await chrome.windows
      .getLastFocused()
      .catch(() => null);
    const siblings = Object.values(records).filter(
      (record2) =>
        !record2.reusedTab && record2.sourceWindowId === sourceWindowId,
    );
    const occupiedSlots = new Set(
      siblings.map((record2, index) =>
        Number.isSafeInteger(record2.positionSlot)
          ? record2.positionSlot
          : index,
      ),
    );
    let positionSlot = 0;
    while (occupiedSlots.has(positionSlot)) positionSlot++;
    const count = Math.max(
      layoutCount,
      siblings.length + 1,
      ...siblings.map((record2) => record2.layoutCount || 1),
    );
    const size = this._windowBounds(
      sourceWindow,
      positionSlot,
      count,
      screenTop,
      screenHeight,
      screenLeft,
      screenWidth,
    );
    const deferredNavigation =
      sourceSurface === "workflow" && sourceWindow?.state === "fullscreen";
    let bootstrapUrl = null;
    if (sourceSurface === "motion") {
      bootstrapUrl = `${chrome.runtime.getURL("motion-worker.html")}?creation=${crypto.randomUUID()}`;
      const creations =
        (await chrome.storage.session.get(this.MOTION_CREATION_KEY))?.[
          this.MOTION_CREATION_KEY
        ] || {};
      creations[workerId] = {
        workerId,
        epoch,
        userId: String(userId),
        provider,
        sourceSurface,
        toolProjectId,
        attemptId,
        runId,
        flowTabId,
        hostEpoch,
        hostTabId,
        origin,
        bootstrapUrl,
      };
      await chrome.storage.session.set({
        [this.MOTION_CREATION_KEY]: creations,
      });
    }
    const initialUrl =
      bootstrapUrl || (deferredNavigation ? "about:blank" : startUrl);
    let window;
    let usedChromePlacement = false;
    if (deferredNavigation) {
      window = await chrome.windows.create({
        url: initialUrl,
        focused: false,
        type: "normal",
        state: "minimized",
      });
    } else {
      try {
        window = await chrome.windows.create({
          url: initialUrl,
          focused: false,
          type: "normal",
          state: "normal",
          ...size,
        });
      } catch (error) {
        if (
          !Object.keys(size).length ||
          !/Invalid value for bounds|Bounds must be at least 50%/i.test(
            error?.message || "",
          )
        )
          throw error;
        console.warn(
          "[ProviderWorkerRegistry] source bounds rejected; retrying with Chrome placement",
          { provider, error: error.message },
        );
        window = await chrome.windows.create({
          url: initialUrl,
          focused: false,
          type: "normal",
          state: "normal",
        });
        usedChromePlacement = true;
      }
    }
    const tab = window?.tabs?.[0];
    if (
      !Number.isInteger(window?.id) ||
      !Number.isInteger(tab?.id) ||
      tab.windowId !== window.id ||
      tab.active !== true
    ) {
      if (Number.isInteger(window?.id))
        await chrome.windows.remove(window.id).catch(() => {});
      return { success: false, error: "WORKER_WINDOW_INVALID" };
    }
    const record = {
      workerId,
      epoch,
      userId: String(userId),
      provider,
      windowId: window.id,
      tabId: tab.id,
      origin,
      ...(accountPrefix && { accountPrefix }),
      ...(runId && { runId }),
      ...(sourceSurface === "motion" && {
        toolProjectId,
        attemptId,
        flowTabId,
        ...(Number.isSafeInteger(hostEpoch) && hostEpoch > 0 && { hostEpoch }),
        ...(Number.isInteger(hostTabId) && { hostTabId }),
      }),
      ...(Number.isInteger(sourceWindowId) && { sourceWindowId }),
      ...(sourceSurface && { sourceSurface }),
      positionSlot,
      layoutCount,
      ...(Number.isSafeInteger(promptIndex) && { promptIndex }),
      ...(Number.isSafeInteger(screenTop) && { screenTop }),
      ...(Number.isSafeInteger(screenHeight) &&
        screenHeight > 100 && { screenHeight }),
      ...(Number.isSafeInteger(screenLeft) && { screenLeft }),
      ...(Number.isSafeInteger(screenWidth) &&
        screenWidth > 100 && { screenWidth }),
      focusGuardUntil: Date.now() + 5e3,
      openedAtNewChat: provider === "muse",
    };
    records[workerId] = record;
    try {
      if (deferredNavigation) {
        try {
          await chrome.windows.update(window.id, { state: "normal", ...size });
        } catch (error) {
          await chrome.windows.update(window.id, { state: "normal" });
          if (Object.keys(size).length)
            await chrome.windows.update(window.id, size).catch(() => null);
        }
      }
      if (usedChromePlacement && Object.keys(size).length)
        await chrome.windows.update(window.id, size).catch(() => null);
      let placedWindow = await chrome.windows.get(window.id).catch(() => null);
      if (placedWindow?.state === "fullscreen" && Object.keys(size).length) {
        try {
          await chrome.windows.update(window.id, { state: "normal" });
          await chrome.windows.update(window.id, size);
        } catch (error) {
          console.warn("[ProviderWorkerRegistry] worker placement rejected", {
            provider,
            workerWindowId: window.id,
            error: error?.message || String(error),
          });
        }
        placedWindow = await chrome.windows.get(window.id).catch(() => null);
      }
      await this._write(records);
      const createdWindow =
        placedWindow || (await chrome.windows.get(window.id).catch(() => null));
      console.info(
        "[ProviderWorkerRegistry] worker_window_geometry",
        JSON.stringify({
          provider,
          workerWindowId: window.id,
          sourceWindowId,
          sourceSurface,
          requested: size,
          actual: createdWindow
            ? {
                left: createdWindow.left ?? null,
                top: createdWindow.top ?? null,
                width: createdWindow.width ?? null,
                height: createdWindow.height ?? null,
                state: createdWindow.state || null,
              }
            : null,
          layoutCount: count,
          positionSlot,
        }),
      );
      if (
        sourceWindow?.focused === true ||
        siblings.some(
          (sibling) => sibling.windowId === foregroundBeforeCreate?.id,
        )
      ) {
        const currentSource = await chrome.windows
          .get(sourceWindowId)
          .catch(() => null);
        const currentWorker = await chrome.windows
          .get(window.id)
          .catch(() => null);
        const lastFocused = await chrome.windows
          .getLastFocused()
          .catch(() => null);
        const workerRaised = currentWorker?.focused === true;
        const sourceStillFocused = currentSource?.focused === true;
        this._guardSourceWorkers(records, sourceWindowId);
        await this._write(records);
        const loweredWorkers = await this._lowerSourceWorkers(
          records,
          sourceWindowId,
        );
        const restored = !!(await chrome.windows
          .update(sourceWindowId, { focused: true })
          .catch(() => null));
        const sourceAfterRestore = await chrome.windows
          .get(sourceWindowId)
          .catch(() => null);
        console.info(
          "[ProviderWorkerRegistry] worker_open_focus",
          JSON.stringify({
            provider,
            workerWindowId: window.id,
            sourceWindowId,
            sourceFocusedBefore: sourceWindow?.focused === true,
            siblingFocusedBefore: siblings.some(
              (sibling) => sibling.windowId === foregroundBeforeCreate?.id,
            ),
            workerRaised,
            sourceStillFocused,
            lastFocusedWindowId: lastFocused?.id ?? null,
            loweredWorkers,
            restored,
            sourceFocusedAfter: sourceAfterRestore?.focused === true,
          }),
        );
      }
      if (deferredNavigation || bootstrapUrl) {
        await chrome.tabs.update(tab.id, { url: startUrl });
        if (sourceSurface === "motion")
          console.info(
            "[MotionWorker]",
            JSON.stringify({
              stage: "provider_navigation_started",
              provider,
              workerId,
              windowId: window.id,
              tabId: tab.id,
            }),
          );
        if (sourceWindow?.focused === true) {
          const foreground = await chrome.windows
            .getLastFocused()
            .catch(() => null);
          if (
            foreground?.id === sourceWindowId ||
            foreground?.id === window.id
          ) {
            await this._lowerSourceWorkers(records, sourceWindowId);
            await chrome.windows
              .update(sourceWindowId, { focused: true })
              .catch(() => null);
          }
        }
      }
      if (bootstrapUrl) {
        const creations =
          (await chrome.storage.session.get(this.MOTION_CREATION_KEY))?.[
            this.MOTION_CREATION_KEY
          ] || {};
        delete creations[workerId];
        await chrome.storage.session.set({
          [this.MOTION_CREATION_KEY]: creations,
        });
      }
    } catch (error) {
      await chrome.windows.remove(window.id).catch(() => {});
      throw error;
    }
    return { success: true, worker: record };
  }
  static async verify({ workerId, epoch, userId, tabId }) {
    const record = (await this._read())[workerId];
    if (
      !record ||
      record.epoch !== epoch ||
      record.userId !== String(userId) ||
      (tabId && tabId !== record.tabId)
    )
      return { success: false, error: "WORKER_OWNER_MISMATCH" };
    const tab = await chrome.tabs.get(record.tabId).catch(() => null);
    if (!tab || tab.windowId !== record.windowId || !tab.active)
      return {
        success: false,
        error: "WORKER_TAB_LOST",
        worker: record,
        tabState: this._tabState(tab, record.origin),
      };
    if (this._transientBlank(tab) || tab.status === "loading")
      return {
        success: false,
        error: "WORKER_TAB_LOADING",
        worker: record,
        tabState: this._tabState(tab, record.origin),
      };
    if (
      this._origin(tab.url) !== record.origin ||
      !this._matchesAccount(tab, record)
    )
      return {
        success: false,
        error: "WORKER_TAB_LOST",
        worker: record,
        tabState: this._tabState(tab, record.origin),
      };
    return { success: true, worker: record };
  }
  static async activateForSubmit(owner) {
    const record = (await this._read())[owner?.workerId];
    if (
      !record ||
      record.epoch !== owner.epoch ||
      record.userId !== String(owner.userId) ||
      record.tabId !== owner.tabId
    )
      return { success: false, error: "WORKER_OWNER_MISMATCH" };
    const tab = await chrome.tabs.get(record.tabId).catch(() => null);
    if (
      !tab ||
      tab.windowId !== record.windowId ||
      !(
        this._transientBlank(tab) ||
        (this._origin(tab.url) === record.origin &&
          this._matchesAccount(tab, record))
      )
    )
      return { success: false, error: "WORKER_TAB_LOST" };
    await chrome.tabs.update(record.tabId, { active: true });
    return this.focusForSend(owner);
  }
  static async focusForSend(owner) {
    await this._resultRevealTurn;
    return this._serialize(async () => {
      const records = await this._read();
      const record = records[owner?.workerId];
      if (
        !record ||
        record.epoch !== owner.epoch ||
        record.userId !== String(owner.userId) ||
        record.tabId !== owner.tabId
      )
        return { success: false, error: "WORKER_OWNER_MISMATCH" };
      const tab = await chrome.tabs.get(record.tabId).catch(() => null);
      if (
        !tab ||
        tab.windowId !== record.windowId ||
        !(
          this._transientBlank(tab) ||
          (this._origin(tab.url) === record.origin &&
            this._matchesAccount(tab, record))
        )
      )
        return { success: false, error: "WORKER_TAB_LOST" };
      const focused = await chrome.windows.getLastFocused().catch(() => null);
      const source = Number.isInteger(record.sourceWindowId)
        ? await chrome.windows.get(record.sourceWindowId).catch(() => null)
        : null;
      if (!source)
        return { success: false, error: "WORKER_SOURCE_WINDOW_LOST" };
      const workerWindow = await chrome.windows
        .get(record.windowId)
        .catch(() => null);
      const workerAlreadyFocused =
        workerWindow?.focused === true ||
        (workerWindow?.focused !== false && focused?.id === record.windowId);
      const bounds = [
        source?.left,
        source?.top,
        source?.width,
        source?.height,
        workerWindow?.left,
        workerWindow?.top,
        workerWindow?.width,
        workerWindow?.height,
      ];
      const coveredBySource =
        bounds.every(Number.isFinite) &&
        source?.focused === true &&
        source.left <= workerWindow.left &&
        source.top <= workerWindow.top &&
        source.left + source.width >= workerWindow.left + workerWindow.width &&
        source.top + source.height >= workerWindow.top + workerWindow.height;
      const visibility = await this._tabVisibility(record.tabId);
      if (
        visibility === "visible" &&
        !coveredBySource &&
        !workerAlreadyFocused
      ) {
        console.info(
          "[ProviderWorkerRegistry] send_focus_skipped",
          JSON.stringify({
            workerId: record.workerId,
            sourceWindowId: record.sourceWindowId ?? null,
            sourceFocused: source?.focused === true,
            coveredBySource,
            sourceState: source?.state || null,
            visibility,
            reason: "TARGET_UNCOVERED",
          }),
        );
        return { success: true, focused: false, reason: "TARGET_UNCOVERED" };
      }
      const returnFocusWindowId = source.id;
      records[record.workerId] = {
        ...record,
        returnFocusWindowId,
        focusLeaseUntil: Date.now() + 5e3,
      };
      await this._write(records);
      console.info(
        "[ProviderWorkerRegistry] send_focus",
        JSON.stringify({
          sourceWindowId: record.sourceWindowId ?? null,
          sourceFocused: source?.focused === true,
          preferSourceWindow: owner.preferSourceWindow === true,
          lastFocusedWindowId: focused?.id ?? null,
          returnFocusWindowId,
          visibility,
          coveredBySource,
          workerAlreadyFocused,
        }),
      );
      if (!workerAlreadyFocused)
        await chrome.windows.update(record.windowId, { focused: true });
      return { success: true, focused: true };
    });
  }
  static async _tabVisibility(tabId) {
    if (!chrome.scripting?.executeScript) return null;
    let timer;
    try {
      return await Promise.race([
        chrome.scripting
          .executeScript({
            target: { tabId },
            func: () => document.visibilityState,
          })
          .then((results) => results?.[0]?.result)
          .catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 2e3);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  static async _resultFocusTarget(record, visibility, records) {
    const source = await chrome.windows
      .get(record.sourceWindowId)
      .catch(() => null);
    const worker = await chrome.windows.get(record.windowId).catch(() => null);
    const focused = await chrome.windows.getLastFocused().catch(() => null);
    const diagnostic = {
      stage: "result_wait",
      workerId: record.workerId,
      runId: record.runId || null,
      sourceWindowId: record.sourceWindowId,
      workerWindowId: record.windowId,
      lastFocusedWindowId: focused?.id ?? null,
      sourceFocused: source?.focused === true,
      lastWindowFocused:
        typeof focused?.focused === "boolean" ? focused.focused : null,
      workerFocused: worker?.focused === true,
      visibility,
    };
    const skip = (reason) => ({
      success: true,
      revealed: false,
      reason,
      diagnostic,
    });
    if (!source) return skip("SOURCE_WINDOW_LOST");
    if (!worker) return skip("WORKER_WINDOW_LOST");
    if (worker.focused === true) return skip("TARGET_ALREADY_FOCUSED");
    if (worker.state === "minimized") return skip("TARGET_MINIMIZED");
    if (record.focusLeaseUntil > Date.now())
      return skip("TARGET_INPUT_FOCUS_ACTIVE");
    let covering = source;
    if (source.focused !== true || focused?.id !== source.id) {
      const sibling =
        record.runId &&
        Object.values(records).find(
          (other) =>
            other.workerId !== record.workerId &&
            !other.reusedTab &&
            other.windowId === focused?.id &&
            other.runId === record.runId &&
            other.userId === record.userId &&
            other.sourceWindowId === record.sourceWindowId,
        );
      if (!sibling) return skip("USER_FOCUS_CHANGED");
      if (sibling.focusLeaseUntil > Date.now())
        return skip("SIBLING_INPUT_FOCUS_ACTIVE");
      const verified = await this.verify(sibling);
      if (!verified.success) return skip("SIBLING_WORKER_UNAVAILABLE");
      covering = await chrome.windows.get(sibling.windowId).catch(() => null);
      if (covering?.focused !== true) return skip("USER_FOCUS_CHANGED");
    }
    diagnostic.returnWindowId = covering.id;
    const validBounds =
      [
        covering.left,
        covering.top,
        covering.width,
        covering.height,
        worker.left,
        worker.top,
        worker.width,
        worker.height,
      ].every(Number.isFinite) &&
      covering.width > 0 &&
      covering.height > 0 &&
      worker.width > 0 &&
      worker.height > 0;
    if (
      !(
        visibility === "hidden" &&
        ["fullscreen", "maximized"].includes(covering.state)
      )
    ) {
      if (!validBounds) return skip("WINDOW_BOUNDS_UNAVAILABLE");
      const overlaps =
        covering.left < worker.left + worker.width &&
        covering.left + covering.width > worker.left &&
        covering.top < worker.top + worker.height &&
        covering.top + covering.height > worker.top;
      diagnostic.overlaps = overlaps;
      if (!overlaps)
        return skip(
          visibility === "hidden"
            ? "SOURCE_NOT_OVERLAPPING"
            : "TARGET_NOT_HIDDEN",
        );
    }
    return { success: true, returnWindowId: covering.id, diagnostic };
  }
  static async revealForResult(owner) {
    const previousTurn = this._resultRevealTurn.catch(() => {});
    let releaseTurn;
    this._resultRevealTurn = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    await previousTurn;
    try {
      const checked = await this.verify(owner);
      if (!checked.success) return { success: false, error: checked.error };
      const record = checked.worker;
      if (!Number.isInteger(record.sourceWindowId) || record.reusedTab)
        return {
          success: true,
          revealed: false,
          reason: "NO_OWNED_SOURCE_WINDOW",
        };
      const visibility = await this._tabVisibility(record.tabId);
      const focus = await this._serialize(async () => {
        const checkedNow = await this.verify(owner);
        if (!checkedNow.success) return checkedNow;
        const records = await this._read();
        const current = records[owner.workerId];
        if (
          !current ||
          current.epoch !== owner.epoch ||
          current.tabId !== owner.tabId ||
          current.userId !== String(owner.userId)
        )
          return { success: false, error: "WORKER_OWNER_MISMATCH" };
        const decision = await this._resultFocusTarget(
          current,
          visibility,
          records,
        );
        console.info(
          "[ProviderWorkerRegistry] result_focus_decision",
          JSON.stringify({
            ...decision.diagnostic,
            reason: decision.reason || "REVEAL_COVERED_RESULT",
          }),
        );
        if (!Number.isInteger(decision.returnWindowId)) return decision;
        records[owner.workerId] = {
          ...current,
          returnFocusWindowId: decision.returnWindowId,
          focusLeaseUntil: Date.now() + 5e3,
        };
        await this._write(records);
        const checkedBeforeFocus = await this.verify(owner);
        const foreground = await chrome.windows
          .get(decision.returnWindowId)
          .catch(() => null);
        const lastFocused = await chrome.windows
          .getLastFocused()
          .catch(() => null);
        if (
          !checkedBeforeFocus.success ||
          foreground?.focused !== true ||
          lastFocused?.id !== decision.returnWindowId
        ) {
          records[owner.workerId] = current;
          await this._write(records);
          if (!checkedBeforeFocus.success) return checkedBeforeFocus;
          return {
            success: true,
            revealed: false,
            reason: "USER_FOCUS_CHANGED_BEFORE_REVEAL",
          };
        }
        try {
          await chrome.windows.update(current.windowId, { focused: true });
        } catch (error) {
          records[owner.workerId] = current;
          await this._write(records);
          throw error;
        }
        return { success: true, returnWindowId: decision.returnWindowId };
      });
      if (!focus.success || focus.revealed === false) return focus;
      let restored;
      try {
        await new Promise((resolve) => setTimeout(resolve, 1e3));
      } finally {
        restored = await this.restoreFocus(owner);
      }
      const focusedAfter = await chrome.windows
        .getLastFocused()
        .catch(() => null);
      return {
        success: true,
        revealed: true,
        restored: restored?.restored === true,
        focusAfter:
          focusedAfter?.id === record.sourceWindowId
            ? "source"
            : focusedAfter?.id === record.windowId
              ? "worker"
              : focusedAfter?.id === focus.returnWindowId
                ? "sibling"
                : "other",
      };
    } finally {
      releaseTurn();
    }
  }
  static async revealLegacyForResult({
    sourceWindowId,
    tabId,
    provider,
    visibility = null,
    purpose = "result",
  }) {
    const previousTurn = this._resultRevealTurn.catch(() => {});
    let releaseTurn;
    this._resultRevealTurn = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    await previousTurn;
    try {
      if (
        !Number.isInteger(sourceWindowId) ||
        !Number.isInteger(tabId) ||
        !["muse", "gemini", "chatgpt", "flow"].includes(provider)
      )
        return { success: false, error: "LEGACY_REVEAL_OWNER_INVALID" };
      const providerUrl =
        provider === "flow"
          ? getProviderUrl("flow", "base")
          : getProviderWorkerUrl(
              provider,
              provider === "muse" ? "baseUrl" : "base",
            );
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (
        !providerUrl ||
        !tab?.active ||
        this._origin(tab.url) !== this._origin(providerUrl)
      )
        return { success: false, error: "LEGACY_REVEAL_TAB_MISMATCH" };
      const source = await chrome.windows.get(sourceWindowId).catch(() => null);
      const target = await chrome.windows.get(tab.windowId).catch(() => null);
      if (!source || !target || sourceWindowId === tab.windowId)
        return {
          success: true,
          revealed: false,
          reason: "LEGACY_REVEAL_WINDOW_UNAVAILABLE",
        };
      const focused = await chrome.windows.getLastFocused().catch(() => null);
      if (!source.focused || focused?.id !== sourceWindowId)
        return { success: true, revealed: false, reason: "USER_FOCUS_CHANGED" };
      if (purpose === "input") {
        const targetVisibility = await this._tabVisibility(tabId);
        const bounds = [
          source.left,
          source.top,
          source.width,
          source.height,
          target.left,
          target.top,
          target.width,
          target.height,
        ];
        const fullyCovered =
          bounds.every(Number.isFinite) &&
          source.left <= target.left &&
          source.top <= target.top &&
          source.left + source.width >= target.left + target.width &&
          source.top + source.height >= target.top + target.height;
        if (targetVisibility !== "hidden" && !fullyCovered)
          return { success: true, revealed: false, reason: "TARGET_UNCOVERED" };
      }
      if (
        (provider === "flow" && visibility !== "hidden") ||
        (provider !== "flow" &&
          !["fullscreen", "maximized"].includes(source.state))
      ) {
        const valid = [
          source.left,
          source.top,
          source.width,
          source.height,
          target.left,
          target.top,
          target.width,
          target.height,
        ].every(Number.isFinite);
        if (!valid)
          return {
            success: true,
            revealed: false,
            reason: "WINDOW_BOUNDS_UNAVAILABLE",
          };
        const overlaps =
          source.left < target.left + target.width &&
          source.left + source.width > target.left &&
          source.top < target.top + target.height &&
          source.top + source.height > target.top;
        if (!overlaps)
          return {
            success: true,
            revealed: false,
            reason: "SOURCE_NOT_OVERLAPPING",
          };
      }
      await chrome.windows.update(tab.windowId, { focused: true });
      if (provider === "flow") {
        const targetAfterFocus = await chrome.windows
          .get(tab.windowId)
          .catch(() => null);
        console.info(
          "[FlowUploadFocus] target_focus",
          JSON.stringify({
            tabId,
            flowWindowId: tab.windowId,
            sourceWindowId,
            flowFocused: targetAfterFocus?.focused === true,
          }),
        );
      }
      let restored = false;
      try {
        await new Promise((resolve) => setTimeout(resolve, 1e3));
      } finally {
        const current = await chrome.windows.getLastFocused().catch(() => null);
        if (current?.id === tab.windowId) {
          restored = !!(await chrome.windows
            .update(sourceWindowId, { focused: true })
            .catch(() => null));
        }
      }
      if (provider === "flow") {
        const flowAfter = await chrome.windows
          .get(tab.windowId)
          .catch(() => null);
        const sourceAfter = await chrome.windows
          .get(sourceWindowId)
          .catch(() => null);
        console.info(
          "[FlowUploadFocus] target_release",
          JSON.stringify({
            tabId,
            flowWindowId: tab.windowId,
            sourceWindowId,
            flowFocused: flowAfter?.focused === true,
            sourceFocused: sourceAfter?.focused === true,
            restored,
          }),
        );
      }
      return { success: true, revealed: true, restored };
    } finally {
      releaseTurn();
    }
  }
  static async restoreFocus(owner) {
    return this._serialize(async () => {
      const records = await this._read();
      const record = records[owner?.workerId];
      if (
        !record ||
        record.epoch !== owner.epoch ||
        record.userId !== String(owner.userId) ||
        record.tabId !== owner.tabId
      )
        return { success: false, error: "WORKER_OWNER_MISMATCH" };
      const previousWindowId = record.returnFocusWindowId;
      if (!Number.isInteger(previousWindowId))
        return { success: true, restored: false };
      delete records[record.workerId].returnFocusWindowId;
      records[record.workerId].focusLeaseUntil = 0;
      records[record.workerId].focusGuardUntil = Date.now() + 2e3;
      this._guardSourceWorkers(records, previousWindowId);
      await this._write(records);
      const focused = await chrome.windows.getLastFocused().catch(() => null);
      const workerWindow = await chrome.windows
        .get(record.windowId)
        .catch(() => null);
      const workerFocused =
        typeof workerWindow?.focused === "boolean"
          ? workerWindow.focused
          : focused?.id === record.windowId;
      if (!workerFocused)
        return { success: true, restored: false, reason: "USER_FOCUS_CHANGED" };
      try {
        await this._lowerSourceWorkers(records, previousWindowId);
        await chrome.windows.update(previousWindowId, { focused: true });
        return { success: true, restored: true };
      } catch (_) {
        return { success: true, restored: false };
      }
    });
  }
  static async returnToSourceIfWorkerFocused(owner) {
    return this._serialize(async () => {
      const checked = await this.verify(owner);
      if (!checked.success) return checked;
      const record = checked.worker;
      if (record.reusedTab || !Number.isInteger(record.sourceWindowId))
        return {
          success: true,
          restored: false,
          reason: "NO_OWNED_SOURCE_WINDOW",
        };
      const focused = await chrome.windows.getLastFocused().catch(() => null);
      const workerWindow = await chrome.windows
        .get(record.windowId)
        .catch(() => null);
      const workerFocused =
        typeof workerWindow?.focused === "boolean"
          ? workerWindow.focused
          : focused?.id === record.windowId;
      if (!workerFocused)
        return { success: true, restored: false, reason: "WORKER_NOT_FOCUSED" };
      const source = await chrome.windows
        .get(record.sourceWindowId)
        .catch(() => null);
      if (!source)
        return {
          success: true,
          restored: false,
          reason: "SOURCE_WINDOW_CLOSED",
        };
      await this._lowerSourceWorkers(await this._read(), record.sourceWindowId);
      await chrome.windows.update(record.sourceWindowId, { focused: true });
      const records = await this._read();
      if (records[record.workerId]?.epoch === owner.epoch) {
        records[record.workerId].focusLeaseUntil = 0;
        records[record.workerId].focusGuardUntil = Date.now() + 2e3;
        this._guardSourceWorkers(records, record.sourceWindowId);
        await this._write(records);
      }
      return { success: true, restored: true };
    });
  }
  static async handleMotionTabRemoved(tabId, reconcile) {
    if (!Number.isInteger(tabId) || typeof reconcile !== "function")
      throw new Error("MOTION_WORKER_CLOSE_INVALID");
    return this._serialize(async () => {
      const records = await this._read();
      let reconciled = 0;
      let pending = 0;
      const closedScopes = [];
      for (const [id, record] of Object.entries(records)) {
        if (record.sourceSurface !== "motion" || record.tabId !== tabId)
          continue;
        try {
          await reconcile(record);
          delete records[id];
          reconciled++;
          closedScopes.push({
            userId: record.userId,
            toolProjectId: record.toolProjectId,
            runId: record.runId,
          });
        } catch (_) {
          pending++;
        }
      }
      if (reconciled) await this._write(records);
      return { reconciled, pending, closedScopes };
    });
  }
  static async recoverMotionCreations(userId, reconcile, isAbandoned) {
    if (
      !Number.isSafeInteger(userId) ||
      userId < 1 ||
      typeof reconcile !== "function" ||
      typeof isAbandoned !== "function"
    )
      throw new Error("MOTION_WORKER_CLOSE_INVALID");
    return this._serialize(async () => {
      const creations =
        (await chrome.storage.session.get(this.MOTION_CREATION_KEY))?.[
          this.MOTION_CREATION_KEY
        ] || {};
      const records = await this._read(),
        closedScopes = [];
      let pending = 0,
        changed = false,
        recordsChanged = false;
      for (const [id, intent] of Object.entries(creations)) {
        if (intent.userId !== String(userId)) continue;
        const prefix = `${chrome.runtime.getURL("motion-worker.html")}?creation=`;
        if (
          intent.sourceSurface !== "motion" ||
          intent.workerId !== id ||
          !intent.bootstrapUrl?.startsWith(prefix) ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
            intent.bootstrapUrl.slice(prefix.length),
          )
        ) {
          pending++;
          continue;
        }
        const owned = records[id];
        const tabs = (await chrome.tabs.query({})).filter(
          (tab) =>
            tab.url === intent.bootstrapUrl ||
            tab.pendingUrl === intent.bootstrapUrl,
        );
        if (tabs.length > 1) {
          pending++;
          continue;
        }
        if (owned) {
          if (
            ["epoch", "userId", "runId", "attemptId", "toolProjectId"].some(
              (key) => owned[key] !== intent[key],
            )
          ) {
            pending++;
            continue;
          }
          const tab = await chrome.tabs.get(owned.tabId).catch(() => null);
          if (
            tab?.windowId === owned.windowId &&
            this._origin(tab.url) === owned.origin
          ) {
            delete creations[id];
            changed = true;
            continue;
          }
          if (
            tabs.length &&
            (tabs[0].id !== owned.tabId || tabs[0].windowId !== owned.windowId)
          ) {
            pending++;
            continue;
          }
        }
        try {
          if (!(await isAbandoned(intent))) {
            pending++;
            continue;
          }
          await reconcile(intent);
          if (tabs.length) {
            const tab = tabs[0],
              current = await chrome.tabs.get(tab.id).catch(() => null);
            if (
              current?.windowId !== tab.windowId ||
              (current.url !== intent.bootstrapUrl &&
                current.pendingUrl !== intent.bootstrapUrl)
            ) {
              pending++;
              continue;
            }
            await chrome.tabs.remove(tab.id);
          }
          if (records[id]) {
            delete records[id];
            recordsChanged = true;
          }
          delete creations[id];
          changed = true;
          closedScopes.push({
            userId: intent.userId,
            toolProjectId: intent.toolProjectId,
            runId: intent.runId,
          });
        } catch (_) {
          pending++;
        }
      }
      if (recordsChanged) await this._write(records);
      if (changed)
        await chrome.storage.session.set({
          [this.MOTION_CREATION_KEY]: creations,
        });
      return { success: true, pending, closedScopes };
    });
  }
  static async list({ userId }, isActive = null, reconcileMotion = null) {
    if (!userId) return { success: false, error: "WORKER_USER_REQUIRED" };
    return this._serialize(async () => {
      const records = await this._read();
      let changed = false;
      const closedScopes = [];
      for (const [id, record] of Object.entries(records)) {
        const tab = await chrome.tabs.get(record.tabId).catch(() => null);
        const currentOrigin = tab && this._origin(tab.url);
        if (
          !tab ||
          tab.windowId !== record.windowId ||
          (tab.status !== "loading" &&
            !this._transientBlank(tab) &&
            currentOrigin !== record.origin)
        ) {
          if (record.sourceSurface === "motion") {
            if (typeof reconcileMotion !== "function") continue;
            try {
              await reconcileMotion(record);
            } catch (_) {
              continue;
            }
            closedScopes.push({
              userId: record.userId,
              toolProjectId: record.toolProjectId,
              runId: record.runId,
            });
          }
          delete records[id];
          changed = true;
        }
      }
      if (changed) await this._write(records);
      const allWorkers = Object.values(records);
      const states = isActive
        ? await Promise.all(
            allWorkers.map((record) =>
              Promise.resolve()
                .then(() => isActive(record))
                .catch(() => false),
            ),
          )
        : [];
      return {
        success: true,
        workers: allWorkers.filter(
          (record) => record.userId === String(userId),
        ),
        totalCount: allWorkers.length,
        ...(closedScopes.length && { closedScopes }),
        ...(isActive && { activeCount: states.filter(Boolean).length }),
      };
    });
  }
  static async ownedTabIds() {
    const records = await this._read();
    return new Set(
      Object.values(records)
        .map((record) => record.tabId)
        .filter(Number.isInteger),
    );
  }
  static async motionWorkerForTab(tabId) {
    if (!Number.isInteger(tabId)) return null;
    const matches = Object.values(await this._read()).filter(
      (record) => record.sourceSurface === "motion" && record.tabId === tabId,
    );
    return matches.length === 1 ? matches[0] : null;
  }
  static async trackerForTab(tabId) {
    const records = await this._read();
    const owner = Object.values(records).find(
      (record) => record.tabId === tabId,
    );
    if (!owner) return { owned: false, data: null };
    return { owned: true, data: owner.tracker || null };
  }
  static async assignPrompt({ workerId, epoch, userId, tabId, promptIndex }) {
    return this._serialize(async () => {
      if (!Number.isSafeInteger(promptIndex) || promptIndex < 0)
        return { success: false, error: "WORKER_PROMPT_INDEX_INVALID" };
      const records = await this._read();
      const record = records[workerId];
      if (
        !record ||
        record.epoch !== epoch ||
        record.userId !== String(userId) ||
        record.tabId !== tabId
      )
        return { success: false, error: "WORKER_OWNER_MISMATCH" };
      if (record.promptIndex === promptIndex) return { success: true };
      record.promptIndex = promptIndex;
      await this._write(records);
      return { success: true };
    });
  }
  static async updateTracker({ workerId, epoch, userId, tabId, data }) {
    return this._serialize(async () => {
      const verified = await this.verify({ workerId, epoch, userId, tabId });
      if (!verified.success) return verified;
      const records = await this._read();
      records[workerId] = {
        ...records[workerId],
        tracker: data?.isRunning === false ? null : data,
      };
      await this._write(records);
      await chrome.tabs
        .sendMessage(tabId, { action: "pq:trackerUpdate", data })
        .catch(() => null);
      return { success: true };
    });
  }
  static async close(owner) {
    return this._serialize(() => this._close(owner));
  }
  static async _close(owner) {
    const records = await this._read();
    const record = records[owner?.workerId];
    if (
      !record ||
      record.epoch !== owner.epoch ||
      record.userId !== String(owner.userId) ||
      record.tabId !== owner.tabId
    )
      return { success: false, error: "WORKER_OWNER_MISMATCH" };
    if (record.reusedTab === true) {
      delete records[record.workerId];
      await this._write(records);
      return { success: true, released: true };
    }
    const tab = await chrome.tabs.get(record.tabId).catch(() => null);
    if (!tab || tab.windowId !== record.windowId) {
      delete records[record.workerId];
      await this._write(records);
      return { success: true, alreadyClosed: true };
    }
    if (this._origin(tab.url) !== record.origin && !this._transientBlank(tab)) {
      delete records[record.workerId];
      await this._write(records);
      return { success: true, detached: true, reason: "WORKER_TAB_NAVIGATED" };
    }
    try {
      const tabs = await chrome.tabs.query({ windowId: record.windowId });
      if (tabs.length === 1 && tabs[0]?.id === record.tabId)
        await chrome.windows.remove(record.windowId);
      else await chrome.tabs.remove(record.tabId);
    } catch (error) {
      const remaining = await chrome.tabs.get(record.tabId).catch(() => null);
      if (remaining?.windowId === record.windowId)
        return {
          success: false,
          error: "WORKER_WINDOW_CLOSE_FAILED",
          detail: error?.message || null,
        };
    }
    delete records[record.workerId];
    await this._write(records);
    return { success: true };
  }
}
__publicField(
  ProviderWorkerRegistry,
  "KEY",
  "tobyflow_provider_worker_windows",
);
__publicField(
  ProviderWorkerRegistry,
  "MOTION_CREATION_KEY",
  "tobyflow_motion_worker_creations",
);
__publicField(
  ProviderWorkerRegistry,
  "WORKFLOW_LAYOUT_KEY",
  "tobyflow_workflow_worker_layout",
);
__publicField(
  ProviderWorkerRegistry,
  "MAIN_LAYOUT_KEY",
  "tobyflow_main_worker_layout_",
);
__publicField(ProviderWorkerRegistry, "_mutation", Promise.resolve());
__publicField(ProviderWorkerRegistry, "_resultRevealTurn", Promise.resolve());
self.ProviderWorkerRegistry = ProviderWorkerRegistry;
