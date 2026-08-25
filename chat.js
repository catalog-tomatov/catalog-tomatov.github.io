(function () {
  "use strict";

  const CHAT_DB_NAME = "tomato-order-chat-v1";
  const CHAT_DB_VERSION = 2;
  const CHAT_SEASON_KEY = "tomatoChatSeasonId";
  const CHAT_CONFIG_KEY = "tomatoChatSeasonConfig";
  const CHAT_POLL_FAST_INTERVAL = 2500;
  const CHAT_POLL_IDLE_INTERVAL = 8000;
  const CHAT_POLL_FAST_WINDOW = 60000;
  const CHAT_PUSH_SNOOZE_KEY = "tomatoChatPushSnoozedUntil";
  const CHAT_PUSH_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

  const CHAT_SELLER_DELAY = 6000;

const CHAT_PAYMENT = {
  sbpPhone: "+79036094545",

  banks: [
    {
      name: "СБЕРБАНК",
      logo: "./tomato/sber.png"
    },
    {
      name: "Т-БАНК",
      logo: "./tomato/tbank.png"
    }
  ],

  recipient: "Анатолий Дмитриевич С.",

  paymentText:
    "В назначении платежа ничего указывать не нужно. Чек скидывайте пожалуйста сюда в переписку."
};

  const CHAT_TARGET_IMAGE_BYTES = 350 * 1024;
  const CHAT_ATTACHMENT_LIMIT = 1024 * 1024;
  const chatApiUrl = () => `${CATALOG_API_URL}?chat=1`;

  const state = {
    config: null,
    summaries: new Map(),
    // Статус/суммы заказа, подтверждённые Apps Script (Google Sheets).
    // Firestore может сигнализировать об изменении, но не перезаписывает эту истину.
    authoritativeOrders: new Map(),
    statusRefreshTimer: 0,
    statusRefreshPromise: null,
    access: new Map(),
    chatCache: new Map(),
    current: null,
    pendingFile: null,
    shareOrderId: "",
    pollTimer: 0,
    chatActivityAt: 0,
    sellerRevealTimer: 0,
    pushPromptTimer: 0,
    objectUrls: new Set(),
    createPromises: new Map(),
    readStates: new Map(),
    realtimeSubscriptions: new Map(),
    realtimeReady: new Set(),
    realtimeRelinking: new Set(),
    initialized: false,
  };

  const elements = {
    shareModal: document.getElementById("shareChannelModal"),
    closeShare: document.getElementById("closeShareChannel"),
    chooseChat: document.getElementById("chooseInternalChat"),
    chooseMax: document.getElementById("chooseMaxChannel"),
    shareError: document.getElementById("shareChannelError"),
    chatModal: document.getElementById("orderChatModal"),
    closeChat: document.getElementById("closeOrderChat"),
    chatTitle: document.getElementById("orderChatTitle"),
    chatCustomer: document.getElementById("orderChatCustomer"),
    chatStatus: document.getElementById("orderChatStatus"),
    chatError: document.getElementById("orderChatError"),
    chatLoading: document.getElementById("orderChatLoading"),
    maxWarning: document.getElementById("orderChatMaxWarning"),
    maxBack: document.getElementById("orderChatMaxBack"),
    maxContinue: document.getElementById("orderChatMaxContinue"),
    chatMessages: document.getElementById("orderChatMessages"),
    chatComposer: document.getElementById("orderChatComposer"),
    chatInput: document.getElementById("orderChatInput"),
    chatFile: document.getElementById("orderChatFile"),
    chatFilePreview: document.getElementById("orderChatFilePreview"),
    chatFileName: document.getElementById("orderChatFileName"),
    removeChatFile: document.getElementById("removeOrderChatFile"),
    sendChat: document.getElementById("sendOrderChatMessage"),
    quota: document.getElementById("orderChatQuota"),
    restoreModal: document.getElementById("restoreOrderModal"),
    closeRestore: document.getElementById("closeRestoreOrder"),
    restoreId: document.getElementById("restoreOrderId"),
    restorePhone: document.getElementById("restoreOrderPhone"),
    restoreSubmit: document.getElementById("restoreOrderSubmit"),
    restoreError: document.getElementById("restoreOrderError"),
    pushModal: document.getElementById("chatPushPermissionModal"),
    closePush: document.getElementById("closeChatPushPermission"),
    enablePush: document.getElementById("enableChatPushPermission"),
    laterPush: document.getElementById("laterChatPushPermission"),
    pushError: document.getElementById("chatPushPermissionError"),
  };

  function randomRequestId(prefix = "req") {
    const random = window.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}:${random}`;
  }

  function normalizeOrderId(value) {
    const raw = String(value || "").trim().toUpperCase();
    if (/^\d{5,}$/.test(raw)) return `#${raw}`;
    if (/^#\d{5,}$/.test(raw) || /^T-\d{4}-\d{6}$/.test(raw)) return raw;
    return "";
  }

  function orderKey(orderId, seasonId = state.config?.seasonId || "") {
    return `${seasonId}|${normalizeOrderId(orderId)}`;
  }

  function realtimeBridge() {
    return window.tomatoRealtime || null;
  }

  function stopRealtimeSubscriptions() {
    state.realtimeSubscriptions.forEach((unsubscribe) => {
      try { unsubscribe(); } catch (error) { /* best effort */ }
    });
    state.realtimeSubscriptions.clear();
    state.realtimeReady.clear();
  }

  function isRealtimePermissionError(error) {
    const code = String(error?.code || "").toLowerCase();
    const message = String(error?.message || "").toLowerCase();
    return code.includes("permission-denied")
      || code.includes("permission_denied")
      || message.includes("permission")
      || message.includes("insufficient permissions");
  }

  async function ensureRealtimeOrder(order, access, forceLink = false) {
    const bridge = realtimeBridge();
    if (!bridge || !state.config?.seasonId || !access?.chatToken) return false;

    const key = orderKey(order.orderId);
    if (state.realtimeSubscriptions.has(key)) return true;

    // ВАЖНО: не доверяем сохранённому firebaseUid как доказательству membership.
    // Firestore membership мог отсутствовать, поэтому перед новой подпиской
    // делаем короткий idempotent link и используем seasonId, который вернул сервер.
    const linkResult = await bridge.linkOrder({
      apiUrl: chatApiUrl(),
      orderId: order.orderId,
      chatToken: access.chatToken,
    });

    const context = await bridge.ready();
    const firebaseUid = String(linkResult?.uid || context?.user?.uid || "");
    const linkedSeasonId = String(linkResult?.seasonId || state.config.seasonId || "");

    if (firebaseUid) {
      access = await putAccess(order.orderId, { firebaseUid });
      if (
        state.current
        && normalizeOrderId(state.current.order?.orderId) === normalizeOrderId(order.orderId)
      ) {
        state.current.access = access;
      }
    }

    let unsubscribe = () => undefined;
    unsubscribe = await bridge.subscribeOrder({
      seasonId: linkedSeasonId,
      orderId: order.orderId,
      viewer: "client",
      onData: (incoming) => {
        const normalized = normalizeOrderId(order.orderId);
        const currentMemory =
          state.current && normalizeOrderId(state.current.order?.orderId) === normalized
            ? state.current.payload
            : null;
        const memory = currentMemory || state.chatCache.get(key)?.payload;
        let payload = mergeChatPayload(memory, incoming);
        payload.summary = suppressReadSummary(normalized, payload.summary);

        // Firestore может содержать старую копию оплаты. Используем расхождение
        // только как сигнал перечитать Google Sheets через Apps Script.
        requestAuthoritativeStatusRefresh(
          normalized,
          incoming?.order,
          incoming?.summary,
        );

        // Перед любым render возвращаем статус/суммы из source of truth.
        payload = applyLatestKnownOrderStatus(payload, normalized);
        state.realtimeReady.add(key);
        state.summaries.set(normalized, payload.summary);
        void cacheChat(normalized, payload);
        renderSavedOrdersSummary();
        if (document.getElementById("savedOrdersModal")?.style.display === "flex") {
          renderSavedOrdersList();
        }
        updateAppBadge();
        if (
          state.current
          && normalizeOrderId(state.current.order?.orderId) === normalized
          && !elements.chatModal.hidden
        ) {
          state.current.payload = payload;
          stopChatPolling();
          renderChatPayload(payload, false);
          if (Number(payload.summary?.unread || 0) > 0) {
            void markChatReadSnapshot(normalized, access.chatToken, payload);
          }
          setChatError("");
        }
      },
      onError: (error) => {
        console.warn("Realtime-обновление чата отложено", error);
        state.realtimeReady.delete(key);
        const currentUnsubscribe = state.realtimeSubscriptions.get(key);
        if (currentUnsubscribe === unsubscribe) state.realtimeSubscriptions.delete(key);
        try { unsubscribe(); } catch (unsubscribeError) { /* best effort */ }

        // Если локально считали UID уже привязанным, а Firestore говорит
        // permission-denied, один раз перепривязываем заказ через Apps Script.
        if (isRealtimePermissionError(error) && !state.realtimeRelinking.has(key)) {
          state.realtimeRelinking.add(key);
          void putAccess(order.orderId, { firebaseUid: "" })
            .then((nextAccess) => ensureRealtimeOrder(order, nextAccess, true))
            .catch((relinkError) => {
              console.warn("Не удалось восстановить realtime-доступ", relinkError);
              if (
                state.current
                && normalizeOrderId(state.current.order?.orderId) === normalizeOrderId(order.orderId)
              ) {
                startChatPolling();
              }
            })
            .finally(() => state.realtimeRelinking.delete(key));
          return;
        }

        if (state.current && normalizeOrderId(state.current.order?.orderId) === normalizeOrderId(order.orderId)) {
          startChatPolling();
        }
      },
    });
    state.realtimeSubscriptions.set(key, unsubscribe);
    return true;
  }

  function findSavedOrder(orderId) {
    const normalized = normalizeOrderId(orderId);
    return savedOrders.find((order) => normalizeOrderId(order.orderId) === normalized) || null;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("INDEXED_DB_UNAVAILABLE"));
        return;
      }
      const request = indexedDB.open(CHAT_DB_NAME, CHAT_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("access")) db.createObjectStore("access", { keyPath: "key" });
        if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "key" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
        if (!db.objectStoreNames.contains("outbox")) {db.createObjectStore("outbox", {keyPath: "key"});}
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("INDEXED_DB_ERROR"));
    });
  }

  async function dbRequest(storeName, mode, operation) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let request;
        try {
          request = operation(store);
        } catch (error) {
          reject(error);
          return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("INDEXED_DB_ERROR"));
      });
    } finally {
      db.close();
    }
  }

  const dbGet = (store, key) => dbRequest(store, "readonly", (objectStore) => objectStore.get(key));
  const dbPut = (store, value) => dbRequest(store, "readwrite", (objectStore) => objectStore.put(value));
  const dbGetAll = (store) =>
  dbRequest(
    store,
    "readonly",
    (objectStore) => objectStore.getAll()
  );

const dbDelete = (store, key) =>
  dbRequest(
    store,
    "readwrite",
    (objectStore) => objectStore.delete(key)
  );

  async function clearChatDatabase() {
    const db = await openDb();
    try {
      await Promise.all(["access", "chats", "meta", "outbox"].map((storeName) => new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        const request = transaction.objectStore(storeName).clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      })));
    } finally {
      db.close();
    }
  }

  async function apiPost(body, timeout = 20000) {
    const result = await fetchJsonWithTimeout(chatApiUrl(), {
      method: "POST",
      body: JSON.stringify(body),
      cache: "no-store",
    }, timeout);
    if (!result || result.success !== true) {
      const error = new Error(result?.message || "Чат временно недоступен");
      error.code = result?.error || "CHAT_ERROR";
      throw error;
    }
    return result;
  }

  async function fetchChatConfig() {
    const result = await fetchJsonWithTimeout(`${chatApiUrl()}&action=config`, {
      cache: "no-store",
    }, 12000);
    if (!result || result.success !== true || !result.seasonId) {
      throw new Error("Не удалось получить сезон чата");
    }
    localStorage.setItem(CHAT_CONFIG_KEY, JSON.stringify(result));
    return result;
  }

  function readCachedConfig() {
    try {
      const cached = JSON.parse(localStorage.getItem(CHAT_CONFIG_KEY) || "null");
      return cached && cached.seasonId ? cached : null;
    } catch {
      return null;
    }
  }

  async function getAccess(orderId) {
    const key = orderKey(orderId);
    if (state.access.has(key)) return state.access.get(key);
    try {
      const value = await dbGet("access", key);
      if (value) state.access.set(key, value);
      return value || null;
    } catch (error) {
      console.warn("Не удалось прочитать доступ к чату", error);
      return null;
    }
  }

  async function putAccess(orderId, fields) {
    const key = orderKey(orderId);
    const current = state.access.get(key) || await getAccess(orderId) || { key, orderId: normalizeOrderId(orderId) };
    const next = { ...current, ...fields, key, seasonId: state.config?.seasonId || current.seasonId || "" };
    state.access.set(key, next);
    try { await dbPut("access", next); }
    catch (error) { console.warn("Не удалось сохранить доступ к чату", error); }
    return next;
  }

  function chatPushSupported() {
    return Boolean(
      window.isSecureContext
      && "serviceWorker" in navigator
      && "PushManager" in window
      && "Notification" in window
    );
  }

  function base64UrlBytes(value) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const binary = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  async function relayPushRequest(body, timeout = 30000) {
    const result = await fetchJsonWithTimeout(CATALOG_API_URL, {
      method: "POST",
      body: JSON.stringify(body),
      cache: "no-store",
    }, timeout);
    if (!result || result.success !== true) {
      const error = new Error("Сервис уведомлений временно недоступен.");
      error.code = result?.error || "PUSH_RELAY_UNAVAILABLE";
      error.httpStatus = Number(result?.httpStatus) || 0;
      throw error;
    }
    return result;
  }

  async function getChatPushSubscription() {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) return subscription;
    const payload = await relayPushRequest({ action: "pushConfig" }, 20000);
    if (!payload.publicKey) throw new Error("Сервис уведомлений не настроен.");
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlBytes(payload.publicKey),
    });
    return subscription;
  }

  async function saveChatPushSubscription(subscription, access) {
    const orderId = normalizeOrderId(access?.orderId);
    if (!orderId || !access?.chatToken) return false;
    await relayPushRequest({
      action: "pushSubscribe",
      orderId,
      chatToken: access.chatToken,
      subscription: subscription.toJSON(),
    });
    return true;
  }

  async function syncChatPushSubscriptions(preferredAccess = null) {
    if (!chatPushSupported() || Notification.permission !== "granted") return false;
    const subscription = await getChatPushSubscription();
    const rows = await dbGetAll("access").catch(() => []);
    const candidates = [...rows];
    if (preferredAccess?.chatToken) candidates.push(preferredAccess);
    const unique = new Map();
    candidates.forEach((access) => {
      if (
        access?.chatToken
        && access.seasonId === state.config?.seasonId
        && normalizeOrderId(access.orderId)
      ) unique.set(normalizeOrderId(access.orderId), access);
    });
    for (const access of unique.values()) {
      await saveChatPushSubscription(subscription, access);
    }
    return true;
  }

  function pushPromptSnoozed() {
    return Number(localStorage.getItem(CHAT_PUSH_SNOOZE_KEY) || 0) > Date.now();
  }

  function dismissChatPushPrompt(snooze = true) {
    if (snooze) localStorage.setItem(CHAT_PUSH_SNOOZE_KEY, String(Date.now() + CHAT_PUSH_SNOOZE_MS));
    setInlineError(elements.pushError, "");
    hideOverlay(elements.pushModal);
  }

  function scheduleChatPushPrompt(access) {
    if (!chatPushSupported() || !access?.chatToken) return;
    if (Notification.permission === "granted") {
      void syncChatPushSubscriptions(access).catch((error) => console.warn("Не удалось обновить Push-подписку", error));
      return;
    }
    if (Notification.permission === "denied" || pushPromptSnoozed()) return;
    if (state.pushPromptTimer) clearTimeout(state.pushPromptTimer);
    const revealDelay = state.current?.sellerRevealAt
      ? Math.max(900, state.current.sellerRevealAt - Date.now() + 900)
      : 900;
    const orderId = normalizeOrderId(access.orderId);
    state.pushPromptTimer = window.setTimeout(() => {
      state.pushPromptTimer = 0;
      if (
        Notification.permission === "default"
        && state.current
        && normalizeOrderId(state.current.order?.orderId) === orderId
      ) showOverlay(elements.pushModal);
    }, revealDelay);
  }

  async function enableChatPushNotifications() {
    if (!chatPushSupported()) {
      setInlineError(elements.pushError, "Уведомления не поддерживаются на этом устройстве.");
      return;
    }
    elements.enablePush.disabled = true;
    elements.enablePush.textContent = "Включаем…";
    setInlineError(elements.pushError, "");
    try {
      const permission = Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
      if (permission === "denied") {
        setInlineError(elements.pushError, "Уведомления запрещены. Разрешить их можно в настройках браузера.");
        return;
      }
      if (permission !== "granted") return;
      await syncChatPushSubscriptions(state.current?.access || null);
      localStorage.removeItem(CHAT_PUSH_SNOOZE_KEY);
      dismissChatPushPrompt(false);
      showToast("Уведомления включены");
    } catch (error) {
      setInlineError(elements.pushError, error.message || "Не удалось включить уведомления.");
    } finally {
      elements.enablePush.disabled = false;
      elements.enablePush.textContent = "Включить уведомления";
    }
  }

  async function cacheChat(orderId, payload) {
    const normalized = normalizeOrderId(orderId);
    const key = orderKey(normalized);
    const currentEntry = state.chatCache.get(key) || {};
    state.chatCache.set(key, {
      ...currentEntry,
      payload,
      updatedAt: Date.now(),
    });
    try {
      await dbPut("chats", {
        key,
        seasonId: state.config?.seasonId || "",
        orderId: normalized,
        payload: stripChatCacheBinary(payload),
        cachedAt: Date.now(),
      });
      return true;
    } catch (error) {
      console.warn("Не удалось сохранить локальную копию чата", error);
      return false;
    }
  }

  async function readCachedChat(orderId) {
    const key = orderKey(orderId);
    const memory = state.chatCache.get(key)?.payload;
    if (memory) return memory;
    try {
      const row = await dbGet("chats", key);
      if (row?.payload) {
        state.chatCache.set(key, {
          payload: row.payload,
          updatedAt: Number(row.cachedAt) || 0,
          request: null,
        });
      }
      return row?.payload || null;
    } catch {
      return null;
    }
  }

  function stripChatCacheBinary(payload) {
    if (!payload || !Array.isArray(payload.messages)) return payload;
    return {
      ...payload,
      messages: payload.messages.map((message) => ({
        ...message,
        retryRequest: undefined,
        attachment: message.attachment
          ? { ...message.attachment, localBase64: undefined }
          : message.attachment,
      })),
    };
  }

  function chatMessageKey(message) {
    const clientMessageId = String(
      message?.clientMessageId || message?.localRequestId || "",
    ).trim();
    if (clientMessageId) return `client:${clientMessageId}`;
    const messageId = String(message?.messageId || "").trim();
    if (messageId) return `id:${messageId}`;
    const attachment = message?.attachment || {};
    return `fallback:${[
      message?.createdAt || "",
      message?.sender || "",
      message?.type || "",
      message?.text || "",
      message?.attachmentId || attachment.attachmentId || "",
      attachment.fileName || "",
    ].join("|")}`;
  }

  function chatMessageSignature(message) {
    const attachment = message?.attachment || {};
    return JSON.stringify([
      chatMessageKey(message),
      message?.sender || "",
      message?.type || "",
      message?.text || "",
      message?.createdAt || "",
      message?.delivery || "",
      Boolean(message?.awaitingServerEcho),
      message?.localRequestId || "",
      attachment.attachmentId || "",
      attachment.mime || "",
      attachment.fileName || "",
      Number(attachment.sizeBytes) || 0,
      Boolean(attachment.localBase64),
      JSON.stringify(message?.snapshot || null),
    ]);
  }

  function summaryChanged(previous, next) {
    if (!previous || !next) return false;
    return String(previous.lastAt || "") !== String(next.lastAt || "")
      || String(previous.lastMessage || "") !== String(next.lastMessage || "")
      || Number(next.unread || 0) > Number(previous.unread || 0)
      || String(previous.status || "") !== String(next.status || "")
      || String(previous.statusLabel || "") !== String(next.statusLabel || "")
      || Number(previous.prepayment || 0) !== Number(next.prepayment || 0)
      || Number(previous.debt || 0) !== Number(next.debt || 0)
      || Number(previous.total || 0) !== Number(next.total || 0);
  }

  function suppressReadSummary(orderId, summary) {
    if (!summary) return summary;
    const readState = state.readStates.get(normalizeOrderId(orderId));
    if (!readState) return summary;
    const floor = Date.parse(readState.lastAt || "") || 0;
    const incoming = Date.parse(summary.lastAt || "") || 0;
    return incoming <= floor ? { ...summary, unread: 0 } : summary;
  }

  // Статус заказа в Каталоге берём только из Apps Script / Google Sheets.
  // Firestore остаётся realtime-транспортом сообщений и сигналом "заказ изменился".
  const AUTHORITATIVE_ORDER_FIELDS = [
    "status",
    "statusLabel",
    "prepayment",
    "debt",
    "total",
    "issued",
  ];

  function rememberAuthoritativeOrderState(orderIdValue, order = null, summary = null) {
    const orderId = normalizeOrderId(
      orderIdValue || order?.orderId || summary?.orderId,
    );
    if (!orderId) return null;

    const previous = state.authoritativeOrders.get(orderId) || {};
    const next = { ...previous };
    const sources = [summary || {}, order || {}];

    AUTHORITATIVE_ORDER_FIELDS.forEach((field) => {
      for (const source of sources) {
        if (
          Object.prototype.hasOwnProperty.call(source, field)
          && source[field] !== undefined
          && source[field] !== null
        ) {
          next[field] = source[field];
          break;
        }
      }
    });

    if (next.status === "issued") next.issued = true;
    else if (next.status) next.issued = false;

    state.authoritativeOrders.set(orderId, next);
    return next;
  }

  function applyLatestKnownOrderStatus(payload, orderIdValue) {
    if (!payload) return payload;
    const orderId = normalizeOrderId(
      orderIdValue || payload.order?.orderId || payload.summary?.orderId,
    );
    const latest = state.authoritativeOrders.get(orderId);
    if (!latest) return payload;

    const patch = {};
    AUTHORITATIVE_ORDER_FIELDS.forEach((field) => {
      if (
        Object.prototype.hasOwnProperty.call(latest, field)
        && latest[field] !== undefined
        && latest[field] !== null
      ) {
        patch[field] = latest[field];
      }
    });

    return {
      ...payload,
      order: payload.order ? { ...payload.order, ...patch } : payload.order,
      summary: payload.summary ? { ...payload.summary, ...patch } : { ...latest },
    };
  }

  function orderStatusSignature(source) {
    if (!source) return "";
    return JSON.stringify([
      source.status ?? "",
      source.statusLabel ?? "",
      Number(source.prepayment) || 0,
      Number(source.debt) || 0,
      Number(source.total) || 0,
      Boolean(source.issued),
    ]);
  }

  function requestAuthoritativeStatusRefresh(orderIdValue, firestoreOrder, firestoreSummary) {
    const orderId = normalizeOrderId(orderIdValue);
    const authoritative = state.authoritativeOrders.get(orderId);
    if (!orderId || !authoritative) return;

    const firestoreState = {
      ...(firestoreOrder || {}),
      ...(firestoreSummary || {}),
    };

    if (orderStatusSignature(authoritative) === orderStatusSignature(firestoreState)) {
      return;
    }

    // Firestore сказал, что состояние отличается. Само значение ему не доверяем:
    // один раз перечитываем source of truth через Apps Script.
    if (state.statusRefreshTimer || state.statusRefreshPromise) return;

    state.statusRefreshTimer = window.setTimeout(() => {
      state.statusRefreshTimer = 0;
      const request = refreshChatSummaries()
        .catch((error) => {
          console.warn("Не удалось сверить статус заказа с таблицей", error);
        })
        .finally(() => {
          if (state.statusRefreshPromise === request) {
            state.statusRefreshPromise = null;
          }
        });
      state.statusRefreshPromise = request;
    }, 250);
  }

  function clearUnreadLocally(orderId, payload = null) {
    const normalized = normalizeOrderId(orderId);
    const currentSummary = payload?.summary || state.summaries.get(normalized) || null;
    const previousState = state.readStates.get(normalized) || {};
    state.readStates.set(normalized, {
      ...previousState,
      lastAt: currentSummary?.lastAt || previousState.lastAt || "",
    });
    if (currentSummary) {
      const cleared = { ...currentSummary, unread: 0 };
      state.summaries.set(normalized, cleared);
      if (payload?.summary) payload.summary = cleared;
    }
    updateAppBadge();
    renderSavedOrdersSummary();
    if (payload) void cacheChat(normalized, payload);
  }

  function outboxKey(orderId, requestId) {
  return `${orderKey(orderId)}|${requestId}`;
}

async function saveOutboxRequest(
  request,
  createdAt
) {
  const orderId =
    normalizeOrderId(request.orderId);

  // Токен отдельно уже хранится в access.
  // В outbox его дублировать не нужно.
  const storedRequest = {
    action: "chat_send",
    orderId,
    requestId: request.requestId,
    clientMessageId: request.clientMessageId || request.requestId,
    text: request.text || "",
    attachment: request.attachment || null,
  };

  await dbPut("outbox", {
    key: outboxKey(
      orderId,
      request.requestId
    ),

    seasonId:
      state.config?.seasonId || "",

    orderId,
    requestId: request.requestId,
    createdAt:
      createdAt ||
      new Date().toISOString(),

    request: storedRequest,
  });
}

async function readOutboxForOrder(orderId) {
  const normalized =
    normalizeOrderId(orderId);

  const seasonId =
    state.config?.seasonId || "";

  const rows =
    await dbGetAll("outbox");

  return rows
    .filter(
      (row) =>
        row.orderId === normalized &&
        row.seasonId === seasonId
    )
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() -
        new Date(b.createdAt).getTime()
    );
}

async function removeOutboxRequest(
  orderId,
  requestId
) {
  await dbDelete(
    "outbox",
    outboxKey(orderId, requestId)
  );
}

  function lastServerMessageId(payload) {
    if (payload?.localPending) return "";
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      // ACK от sendText/chat_send ещё не означает, что chat_history/onSnapshot
      // уже успели вернуть это сообщение. Не используем такой локальный ACK
      // как серверный cursor, иначе можно запросить историю «после» записи,
      // которой в отстающем источнике пока ещё нет.
      if (
        message?.messageId
        && !message?.delivery
        && !message?.awaitingServerEcho
      ) return message.messageId;
    }
    return "";
  }

  function reconcileOptimisticMessages(messages) {
    // Reconciliation is based only on stable IDs. Equal text and nearby
    // timestamps are valid user actions and must never be collapsed.
    return [...messages];
  }

  function mergeChatPayload(cached, incoming) {
    if (!cached?.messages?.length) {
      return {
        ...incoming,
        messagesMode: "full",
        messages: Array.isArray(incoming?.messages) ? incoming.messages : [],
      };
    }

    const cachedMessages = Array.isArray(cached.messages) ? cached.messages : [];
    const incomingMessages = Array.isArray(incoming?.messages) ? incoming.messages : [];
    const localImages = new Map(cachedMessages.flatMap((message) => (
      message.attachment?.localBase64
        ? [[chatMessageKey(message), message.attachment.localBase64]]
        : []
    )));
    const preserveLocalState = (message, previous) => {
      const localBase64 = previous?.attachment?.localBase64 || localImages.get(chatMessageKey(message));
      const confirmed = Boolean(
        message?.messageId &&
        !String(message.messageId).startsWith("pending_") &&
        !message.delivery
      );
      // Если предыдущая версия была локальным ACK, а теперь тот же stable ID
      // пришёл из history/realtime без awaitingServerEcho — серверное эхо получено.
      const serverEchoArrived = Boolean(
        previous?.awaitingServerEcho &&
        !message?.awaitingServerEcho
      );
      return {
        ...previous,
        ...message,
        clientMessageId: message.clientMessageId || previous?.clientMessageId || previous?.localRequestId,
        localRequestId: message.clientMessageId || previous?.localRequestId,
        delivery: confirmed ? undefined : (message.delivery ?? previous?.delivery),
        retryRequest: confirmed ? undefined : (message.retryRequest ?? previous?.retryRequest),
        awaitingServerEcho: serverEchoArrived
          ? undefined
          : (message.awaitingServerEcho ?? previous?.awaitingServerEcho),
        attachment: message.attachment
          ? { ...previous?.attachment, ...message.attachment, ...(localBase64 ? { localBase64 } : {}) }
          : message.attachment,
      };
    };
    const merged = new Map();
    const positions = new Map();
    let position = 0;
    const put = (message) => {
      const key = chatMessageKey(message);
      const previous = merged.get(key);
      if (!positions.has(key)) positions.set(key, position++);
      merged.set(key, preserveLocalState(message, previous));
    };

    if (incoming?.messagesMode !== "delta") {
      // Полная серверная история может на несколько секунд/десятков секунд
      // отставать от только что подтверждённой записи. Пока не увидели серверное
      // эхо, держим локальный ACK рядом с обычными pending/error сообщениями.
      cachedMessages
        .filter((message) => message.delivery || message.awaitingServerEcho)
        .forEach(put);
      incomingMessages.forEach(put);
    } else {
      cachedMessages.forEach(put);
      incomingMessages.forEach(put);
    }

    const messages = reconcileOptimisticMessages(Array.from(merged.values()).sort((left, right) => {
      const leftTime = new Date(left.createdAt || 0).getTime();
      const rightTime = new Date(right.createdAt || 0).getTime();
      const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
      const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
      return safeLeft - safeRight
        || positions.get(chatMessageKey(left)) - positions.get(chatMessageKey(right));
    }));

    return {
      ...cached,
      ...incoming,
      order: incoming?.order || cached.order,
      summary: incoming?.summary || cached.summary,
      messagesMode: "full",
      messages,
    };
  }

  async function refreshChatCache(orderId, suppliedAccess = null) {
    const normalized = normalizeOrderId(orderId);
    const key = orderKey(normalized);
    let entry = state.chatCache.get(key);
    if (entry?.request) return entry.request;
    const request = (async () => {
      const order = findSavedOrder(normalized);
      if (!order) throw new Error("Сохранённый заказ не найден.");
      const access = suppliedAccess || await getAccess(normalized);
      if (!access?.chatToken) throw new Error("Чат ещё не создан.");
      const cached = entry?.payload || await readCachedChat(normalized);
      const incoming = await fetchChatHistory(order, access, lastServerMessageId(cached));

      // ВАЖНО: chat_history НЕ меняет authoritative-статус оплаты.
      // Источник истины для статуса — только chat_summaries (Google Sheets).
      // history/realtime используются для сообщений и могут содержать устаревшую копию статуса.

      const latest = state.chatCache.get(key)?.payload || await readCachedChat(normalized) || cached;
      let payload = mergeChatPayload(latest, incoming);
      payload.summary = suppressReadSummary(normalized, payload.summary);
      payload = applyLatestKnownOrderStatus(payload, normalized);
      access.initialPayload = null;
      await cacheChat(normalized, payload);
      return payload;
    })();
    entry = entry || { payload: null, updatedAt: 0 };
    entry.request = request;
    state.chatCache.set(key, entry);
    try {
      return await request;
    } finally {
      const currentEntry = state.chatCache.get(key);
      if (currentEntry?.request === request) currentEntry.request = null;
    }
  }

  async function showRefreshedChatIfOpen(orderId, payload, scrollToEnd = false) {
    if (
      !state.current
      || normalizeOrderId(state.current.order?.orderId) !== normalizeOrderId(orderId)
      || elements.chatModal.hidden
    ) return false;

    const normalized = normalizeOrderId(orderId);
    const currentPayload = state.current.payload;

    // За время сетевого refresh пользователь мог уже отправить сообщение.
    // Поэтому старый ответ никогда не ставим в state.current напрямую:
    // сначала повторно сливаем его с самым свежим локальным состоянием.
    payload = mergeChatPayload(currentPayload, payload);
    payload.summary = suppressReadSummary(normalized, payload.summary);
    payload = applyLatestKnownOrderStatus(payload, normalized);

    const previousSignature = (currentPayload?.messages || []).map(chatMessageSignature).join("\n");
    const nextSignature = (payload.messages || []).map(chatMessageSignature).join("\n");
    state.current.payload = payload;
    renderChatPayload(payload, scrollToEnd);
    if (previousSignature !== nextSignature) {
      state.chatActivityAt = Date.now();
      startChatPolling();
    }
    const readToken = state.current.access?.chatToken || "";
    if (Number(payload.summary?.unread || 0) > 0 && readToken) {
      void markChatReadSnapshot(orderId, readToken, payload);
    }
    return true;
  }

  function preloadOrderChat(orderId) {
    void refreshChatCache(orderId)
      .then((payload) => showRefreshedChatIfOpen(orderId, payload, false))
      .catch((error) => {
        if (
          state.current
          && normalizeOrderId(state.current.order?.orderId) === normalizeOrderId(orderId)
        ) setChatError("Не удалось обновить сообщения. Повторим автоматически.");
        else if (error?.code !== "REQUEST_TIMEOUT") console.warn("Предзагрузка чата отложена", error);
      });
  }

  async function clearClosedClientData() {
    stopRealtimeSubscriptions();
    [
      SAVED_ORDERS_KEY,
      "tomatoCart",
      ORDER_DRAFT_KEY,
      "pendingSheet",
      PENDING_ORDER_REQUEST_KEY,
    ].forEach((key) => localStorage.removeItem(key));
    savedOrders = [];
    state.summaries.clear();
    state.authoritativeOrders.clear();
    if (state.statusRefreshTimer) {
      clearTimeout(state.statusRefreshTimer);
      state.statusRefreshTimer = 0;
    }
    state.statusRefreshPromise = null;
    state.access.clear();
    state.chatCache.clear();
    try { await clearChatDatabase(); } catch (error) { console.warn("Не удалось очистить локальный чат", error); }
  }

  function seasonCloseDatePassed(config) {
    if (!config?.closeAt) return false;
    const closeTime = new Date(config.closeAt).getTime();
    return Number.isFinite(closeTime) && Date.now() >= closeTime;
  }

  async function initializeOrderChatClient() {
    try {
      state.config = await fetchChatConfig();
    } catch (error) {
      console.warn("Конфигурация чата недоступна, используем последнюю сохранённую", error);
      state.config = readCachedConfig();
    }

    if (!state.config) {
      renderSavedOrdersSummary();
      return;
    }

    const localSeasonId = localStorage.getItem(CHAT_SEASON_KEY);
    const changedSeason = Boolean(localSeasonId && localSeasonId !== state.config.seasonId);
    if (changedSeason || seasonCloseDatePassed(state.config)) {
      stopRealtimeSubscriptions();
      await clearClosedClientData();
    }
    localStorage.setItem(CHAT_SEASON_KEY, state.config.seasonId);

    if (!state.config.seasonClosed) {
      await refreshChatSummaries();
      if (chatPushSupported() && Notification.permission === "granted") {
        void syncChatPushSubscriptions().catch((error) => console.warn("Не удалось обновить Push-подписки", error));
      }
    }
    state.initialized = true;
    renderSavedOrdersSummary();
    const currentUrl = new URL(window.location.href);
    const requestedChatId = normalizeOrderId(currentUrl.searchParams.get("chat"));
    if (requestedChatId && findSavedOrder(requestedChatId)) {
      currentUrl.searchParams.delete("chat");
      window.history.replaceState({}, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      void openOrderChat(requestedChatId);
    }
  }

  async function refreshChatSummaries() {
    const previousSummaries = new Map(state.summaries);
    const pendingReads = Array.from(state.readStates.values())
      .map((item) => item?.promise)
      .filter(Boolean);
    if (pendingReads.length) await Promise.allSettled(pendingReads);
    if (!state.config || state.config.seasonClosed || !savedOrders.length) {
      state.summaries.clear();
      updateAppBadge();
      return;
    }
    const entries = [];
    for (const order of savedOrders.slice(0, SAVED_ORDERS_LIMIT)) {
      const access = await getAccess(order.orderId);
      entries.push({
        orderId: order.orderId,
        phone: order.phone,
        chatToken: access?.chatToken || "",
      });
    }

    try {
      const result = await apiPost({ action: "chat_summaries", orders: entries }, 30000);
      result.summaries.forEach((item) => {
        const key = normalizeOrderId(item.order?.orderId || item.summary?.orderId);
        if (!key) return;
        item.summary = suppressReadSummary(key, item.summary);

        // chat_summaries — подтверждённое состояние из Google Sheets.
        rememberAuthoritativeOrderState(key, item.order, item.summary);
        const authoritativePayload = applyLatestKnownOrderStatus(
          { order: item.order || {}, summary: item.summary || {} },
          key,
        );
        item.order = authoritativePayload.order;
        item.summary = authoritativePayload.summary;
        state.summaries.set(key, item.summary);

        const saved = findSavedOrder(key);
        if (saved && item.order) {
          saved.schemaVersion = 2;
          saved.seasonId = result.seasonId;
          saved.total = Number(item.order.total) || 0;
          saved.totalItems = Number(item.order.itemCount) || 0;
          saved.items = Array.isArray(item.order.items)
            ? item.order.items.map((product) => ({
              id: product.id,
              title: product.title,
              price: Number(product.price) || 0,
              qty: Number(product.qty) || 0,
            }))
            : saved.items;
        }
      });
      persistSavedOrders();
      const changedOrderIds = [];
      await Promise.all(result.summaries.map(async (item) => {
        const itemOrderId = item.order?.orderId || item.summary?.orderId;
        const cached = await readCachedChat(itemOrderId);
        const key = normalizeOrderId(itemOrderId);
        const previous = previousSummaries.get(key) || cached?.summary;
        await cacheChat(itemOrderId, {
          ...(cached || {}),
          order: item.order || cached?.order,
          summary: item.summary || cached?.summary,
          messagesMode: "full",
          messages: Array.isArray(cached?.messages) ? cached.messages : [],
        });
        if (summaryChanged(previous, item.summary)) changedOrderIds.push(itemOrderId);
        const access = await getAccess(itemOrderId).catch(() => null);
        const savedOrder = findSavedOrder(itemOrderId);
        if (access?.chatToken && savedOrder) {
          void ensureRealtimeOrder(savedOrder, access).catch((error) => {
            console.warn("Realtime-подписка заказа отложена", error);
          });
        }
      }));
      changedOrderIds.forEach(preloadOrderChat);
    } catch (error) {
      if (error?.code !== "REQUEST_TIMEOUT") {
        console.warn("Не удалось обновить сводки чата", error);
      }
      for (const order of savedOrders) {
        const cached = await readCachedChat(order.orderId);
        if (cached?.summary) {
          const normalized = normalizeOrderId(order.orderId);
          const corrected = applyLatestKnownOrderStatus(cached, normalized);
          state.summaries.set(normalized, corrected?.summary || cached.summary);
        }
      }
    }
    updateAppBadge();
    renderSavedOrdersSummary();
    if (document.getElementById("savedOrdersModal")?.style.display === "flex") {
      renderSavedOrdersList();
    }

    // Если чат открыт, сразу применяем подтверждённый Sheets-статус к шапке,
    // не дожидаясь нового Firestore snapshot.
    if (state.current?.payload && !elements.chatModal.hidden) {
      const currentOrderId = normalizeOrderId(state.current.order?.orderId);
      const correctedPayload = applyLatestKnownOrderStatus(
        state.current.payload,
        currentOrderId,
      );
      state.current.payload = correctedPayload;
      void cacheChat(currentOrderId, correctedPayload);
      renderChatPayload(correctedPayload, false);
    }
  }

  function getOrderChatUnreadTotal() {
    let total = 0;
    state.summaries.forEach((summary) => { total += Number(summary?.unread) || 0; });
    return total;
  }

  function updateAppBadge() {
    const unread = getOrderChatUnreadTotal();
    try {
      if (unread && navigator.setAppBadge) navigator.setAppBadge(unread);
      else if (!unread && navigator.clearAppBadge) navigator.clearAppBadge();
    } catch (error) {
      console.warn("Badge PWA недоступен", error);
    }
  }

  function statusClass(status) {
    return ["paid", "debt", "issued"].includes(status) ? status : "unpaid";
  }

  function formatChatTime(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  function chatDateKey(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function formatChatDate(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  }

  function renderChatDateDivider(value) {
    const divider = document.createElement("div");
    divider.className = "chat-date-divider";
    divider.textContent = formatChatDate(value);
    return divider;
  }

  function appendSavedOrderChatControls(card, order) {
    const orderId = normalizeOrderId(order.orderId);
    const summary = state.summaries.get(orderId) || null;
    const status = card.querySelector(".saved-order-card-status") || document.createElement("strong");
    status.className = `saved-order-card-status ${statusClass(summary?.status)}`;
    status.textContent = summary?.statusLabel || "СТАТУС ОБНОВЛЯЕТСЯ";
    if (!card.contains(status)) card.appendChild(status);

    const chatButton = document.createElement("button");
    chatButton.type = "button";
    chatButton.className = "saved-order-chat-link";
    const icon = document.createElement("span");
    icon.className = "saved-order-chat-icon";
    icon.setAttribute("aria-hidden", "true");
    const iconImage = document.createElement("img");
    iconImage.src = "./chat-icon.png";
    iconImage.alt = "";
    icon.appendChild(iconImage);

    const copy = document.createElement("span");
    copy.className = "saved-order-chat-copy";
    const title = document.createElement("strong");
    const preview = document.createElement("small");
    if (summary?.chatCreated) {
      title.textContent = `Чат по заказу ${orderId}`;
      preview.textContent = summary.lastMessage || "Сообщений пока нет";
    } else {
      title.textContent = "Написать продавцу";
      preview.textContent = "Задать вопрос по заказу";
    }
    copy.append(title, preview);

    const meta = document.createElement("span");
    meta.className = "saved-order-chat-meta";
    const time = document.createElement("span");
    time.textContent = formatChatTime(summary?.lastAt);
    meta.appendChild(time);
    if (Number(summary?.unread) > 0) {
      const unread = document.createElement("i");
      unread.className = "saved-order-chat-unread";
      unread.textContent = String(summary.unread);
      unread.title = `${summary.unread} новых`;
      meta.appendChild(unread);
    }

    const chevron = document.createElement("span");
    chevron.className = "saved-order-chat-chevron";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");
    chatButton.append(icon, copy, meta, chevron);
    chatButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openOrderChat(orderId);
    });
    card.appendChild(chatButton);
  }

  function showOverlay(element) {
    element.hidden = false;
    element.setAttribute("aria-hidden", "false");
    lockBody();
  }

  function hideOverlay(element) {
  // Перед скрытием убираем фокус с кнопки внутри окна.
  if (
    document.activeElement &&
    element.contains(document.activeElement)
  ) {
    document.activeElement.blur();
  }

  element.hidden = true;
  element.setAttribute("aria-hidden", "true");

  const savedOrdersModal =
    document.getElementById("savedOrdersModal");

  const anotherOpen = [
    elements.shareModal,
    elements.chatModal,
    elements.restoreModal,
    elements.pushModal
  ].some((item) => item && !item.hidden);

  if (
    anotherOpen ||
    savedOrdersModal?.style.display === "flex"
  ) {
    lockBody();
  } else {
    unlockBody();
  }
}

  function setInlineError(element, message = "") {
    element.textContent = message;
    element.hidden = !message;
  }

  function openOrderShareChooser(orderId) {
    state.shareOrderId = normalizeOrderId(orderId);
    setInlineError(elements.shareError, "");
    showOverlay(elements.shareModal);
  }

  async function chooseInternalChat() {
    const order = findSavedOrder(state.shareOrderId);
    if (!order) {
      setInlineError(elements.shareError, "Сохранённый заказ не найден.");
      return;
    }

    order.contactChannel = "chat";
    persistSavedOrders();

    elements.chooseChat.disabled = true;
    setInlineError(elements.shareError, "");
    try {
      hideOverlay(elements.shareModal);
      document.getElementById("sheetModal").style.display = "none";
      localStorage.removeItem("pendingSheet");
      await openOrderChat(order.orderId);
    } catch (error) {
      showOverlay(elements.shareModal);
      setInlineError(elements.shareError, error.message || "Не удалось открыть чат.");
    } finally {
      elements.chooseChat.disabled = false;
    }
  }

 async function chooseMax() {
  const order =
    findSavedOrder(state.shareOrderId);

  if (order) {
    order.contactChannel = "max";
    persistSavedOrders();
  }

  hideOverlay(elements.shareModal);
  await shareOrderCardToMax_();
}

  function showChatLoading(value) {
    elements.chatLoading.hidden = !value;
    if (value) elements.chatLoading.textContent = "Открываем чат…";
  }

  function setChatError(message = "") {
    elements.chatError.textContent = message;
    elements.chatError.hidden = !message;
  }

  async function ensureChatAccess(order) {
  let access =
    await getAccess(order.orderId);

  if (access?.chatToken) {
    return access;
  }

  const key =
    orderKey(order.orderId);

  if (state.createPromises.has(key)) {
    return state.createPromises.get(key);
  }

  const request = (async () => {
    const requestId =
      access?.pendingCreateRequestId ||
      randomRequestId("create");

    access = await putAccess(
      order.orderId,
      {
        pendingCreateRequestId:
          requestId
      }
    );

    const result = await apiPost({
      action: "chat_create",
      orderId: order.orderId,
      phone: order.phone,
      requestId,

      clientTimeZone:
        Intl.DateTimeFormat()
          .resolvedOptions()
          .timeZone,

      emptyInitialChat:
        order.contactChannel !== "chat",
      contactChannel: order.contactChannel === "max" || order.contactChannel === "chat"
        ? order.contactChannel
        : "",
    }, 25000);

    await putAccess(
      order.orderId,
      {
        chatToken: result.chatToken,
        pendingCreateRequestId: "",
        chatCreated: true,
      }
    );

    return {
      ...access,
      chatToken: result.chatToken,
      initialPayload: result,
    };
  })();

  state.createPromises.set(
    key,
    request
  );

  try {
    return await request;
  } finally {
    state.createPromises.delete(key);
  }
}

  function getChatGreeting() {
  const hour = new Date().getHours();

  if (hour >= 5 && hour <= 10) return "Доброе утро";
  if (hour >= 11 && hour <= 17) return "Добрый день";
  if (hour >= 18 && hour <= 22) return "Добрый вечер";

  return "Доброй ночи";
}

  function buildPendingInitialPayload(order) {
  const orderId = normalizeOrderId(order.orderId);
  const seasonId = state.config?.seasonId || order.seasonId || "";
  const orderKeyPart = orderId.replace(/[^0-9A-Za-z]/g, "");
  const now = Date.now();
  const summary = state.summaries.get(orderId) || {};

  const publicOrder = {
    seasonId,
    orderId,
    name: order.name || "",
    pickup: order.pickup || "",
    createdAt: order.createdAt || new Date(now).toISOString(),
    itemCount: Number(order.totalItems) || 0,
    varietyCount: Array.isArray(order.items) ? order.items.length : 0,
    total: Number(order.total) || 0,
    prepayment: Number(summary.prepayment) || 0,
    debt: Number(summary.debt) || Number(order.total) || 0,
    issued: summary.status === "issued",
    status: summary.status || "unpaid",
    statusLabel: summary.statusLabel || "НЕ ОПЛАЧЕН",
    items: Array.isArray(order.items) ? order.items : [],
  };

  const messageBase = `${seasonId}_${orderKeyPart}`;

  const messages = [];

if (order.contactChannel === "chat") {
  messages.push(
    {
      messageId:
        `auto_client_${messageBase}`,
      orderId,
      sender: "client",
      type: "text",
      text:
        `${getChatGreeting()}! Направляю заказ по семенам томатов для подтверждения и оплаты 🍅`,
      createdAt:
        new Date(now).toISOString(),
    },
    {
      messageId:
        `auto_order_${messageBase}`,
      orderId,
      sender: "client",
      type: "order_card",
      text: "",
      snapshot: publicOrder,
      createdAt:
        new Date(now + 1).toISOString(),
    },
    {
      messageId:
        `auto_seller_${messageBase}`,
      orderId,
      sender: "seller",
      type: "text",
      text:
        `${getChatGreeting()}! 🌱 Спасибо за заказ.`,
      createdAt:
        new Date(
          now + CHAT_SELLER_DELAY
        ).toISOString(),
    },
    {
      messageId:
        `auto_payment_${messageBase}`,
      orderId,
      sender: "seller",
      type: "payment_card",
      text: "",
      snapshot: {
        amount: publicOrder.total,
      },
      createdAt:
        new Date(
          now +
          CHAT_SELLER_DELAY +
          1
        ).toISOString(),
    }
  );
}

  return {
    localPending: true,
    order: publicOrder,
    summary: {
      ...summary,
      orderId,
      status: publicOrder.status,
      statusLabel: publicOrder.statusLabel,
      total: publicOrder.total,
      attachmentRemainingBytes: CHAT_ATTACHMENT_LIMIT,
    },

     messagesMode: "full",
  messages,
};
}

  async function fetchChatHistory(order, access, afterMessageId = "") {
    if (access.initialPayload) return access.initialPayload;
    return apiPost({
      action: "chat_history",
      orderId: order.orderId,
      chatToken: access.chatToken,
      afterMessageId,
    }, 20000);
  }

async function resumeOutboxForCurrentChat() {
  if (
    !state.current?.access?.chatToken ||
    !state.current?.payload
  ) {
    return;
  }

  const orderId =
    normalizeOrderId(
      state.current.order.orderId
    );

  let rows;

  try {
    rows =
      await readOutboxForOrder(orderId);
  } catch (error) {
    console.warn(
      "Не удалось прочитать outbox",
      error
    );
    return;
  }

  for (const row of rows) {
    // Пользователь за это время
    // мог закрыть другой чат.
    if (
      !state.current ||
      normalizeOrderId(
        state.current.order?.orderId
      ) !== orderId
    ) {
      return;
    }

    const request = {
      ...row.request,

      orderId:
        state.current.order.orderId,

      chatToken:
        state.current.access.chatToken,
    };

    const pendingId =
      `pending_${request.requestId}`;

    // Подтверждённое сообщение могло уже сохраниться локально,
    // а удаление outbox — не успеть до закрытия PWA.
    const locallyConfirmed =
      state.current.payload.messages.find(
        (message) =>
          message.localRequestId === request.requestId &&
          !message.delivery
      );

    if (locallyConfirmed) {
      try {
        await removeOutboxRequest(
          orderId,
          request.requestId
        );
      } catch (error) {
        console.warn(
          "Не удалось очистить подтверждённый outbox",
          error
        );
      }
      continue;
    }

    let optimistic =
      state.current.payload.messages.find(
        (message) =>
          message.messageId ===
          pendingId
      );

    if (!optimistic) {
      optimistic =
        buildOptimisticMessage(
          request,
          row.createdAt
        );

      state.current.payload.messages.push(
        optimistic
      );
    } else {
      optimistic.retryRequest =
        request;
    }

    // Текст уже надёжно лежит в outbox, поэтому визуально
    // выглядит отправленным. Для вложений оставляем загрузку.
    optimistic.delivery =
      queuedDelivery(request);

    await cacheChat(
      orderId,
      state.current.payload
    );

    renderChatPayload(
      state.current.payload,
      true
    );

    await transmitOptimisticMessage(
      optimistic
    );
  }
}

  async function openOrderChat(orderId) {
    const order = findSavedOrder(orderId);
    if (!order) throw new Error("Сохранённый заказ не найден.");
    const normalizedOrderId = normalizeOrderId(order.orderId);
    const sameChat = state.current
      && normalizeOrderId(state.current.order?.orderId) === normalizedOrderId;
    const previousCurrent = sameChat ? state.current : null;
    const earlyAccessPromise = getAccess(order.orderId).catch(() => null);
    state.chatActivityAt = Date.now();
    stopChatPolling();

  if (state.sellerRevealTimer) {
  clearTimeout(state.sellerRevealTimer);
  state.sellerRevealTimer = 0;
  }

  state.current = {
  order,
  access: previousCurrent?.access || null,
  payload: previousCurrent?.payload || state.chatCache.get(orderKey(order.orderId))?.payload || null,
  sellerRevealAt: previousCurrent?.sellerRevealAt || 0,
  maxWarningDismissed: false,
  };
    elements.chatTitle.textContent = `Чат по заказу ${normalizeOrderId(order.orderId)}`;
    elements.chatCustomer.textContent = order.name || "";
    elements.chatStatus.textContent = "ОБНОВЛЯЕМ";
    elements.chatStatus.className = "order-chat-status";
    if (!sameChat) {
      elements.chatMessages.replaceChildren();
      delete elements.chatMessages.dataset.orderId;
    }
    elements.chatComposer.hidden = true;
    elements.quota.textContent = "";
    setChatError("");
    showChatLoading(!state.current.payload);
    closeSavedOrders();
    showOverlay(elements.chatModal);
    clearUnreadLocally(normalizedOrderId, state.current.payload);
    const earlyReadPayload = state.current.payload;
    void earlyAccessPromise.then((earlyAccess) => {
      if (earlyAccess?.chatToken) {
        return markChatReadSnapshot(normalizedOrderId, earlyAccess.chatToken, earlyReadPayload);
      }
      return undefined;
    });

    let cached = state.current.payload || await readCachedChat(order.orderId);
    if (!state.current || normalizeOrderId(state.current.order?.orderId) !== normalizedOrderId) return;
    cached = applyLatestKnownOrderStatus(cached, normalizedOrderId);
    if (cached && Array.isArray(cached.messages)) {
  // Старый уже существующий чат открываем сразу, но статус оплаты берём
  // из самой свежей общей сводки, а не из устаревшего chat cache.
  state.current.payload = cached;
  renderChatPayload(cached, !sameChat);
  showChatLoading(false);

} else {
  // Новый чат: покупатель появляется сразу,
  // продавец — через 6 секунд.
  const pendingPayload = buildPendingInitialPayload(order);

  state.current.sellerRevealAt = Date.now() + CHAT_SELLER_DELAY;
  state.current.payload = pendingPayload;

  renderChatPayload(pendingPayload, true);
  showChatLoading(false);

  const revealOrderId = normalizeOrderId(order.orderId);

  state.sellerRevealTimer = window.setTimeout(() => {
    state.sellerRevealTimer = 0;

    if (
      !state.current ||
      normalizeOrderId(state.current.order?.orderId) !== revealOrderId
    ) {
      return;
    }

    state.current.sellerRevealAt = 0;

    if (state.current.payload) {
      renderChatPayload(state.current.payload, true);
    }
  }, CHAT_SELLER_DELAY);
}

    try {
      const earlyAccess = await earlyAccessPromise;
      const currentAccess = state.current &&
        normalizeOrderId(state.current.order?.orderId) === normalizedOrderId
        ? state.current.access
        : null;
      const access = currentAccess || (earlyAccess?.chatToken ? earlyAccess : null) || await ensureChatAccess(order);
      const currentReadPayload = state.current &&
        normalizeOrderId(state.current.order?.orderId) === normalizedOrderId
        ? state.current.payload
        : null;
      void markChatReadSnapshot(
        normalizedOrderId,
        access.chatToken,
        access.initialPayload || currentReadPayload,
      );
      if (!state.current || normalizeOrderId(state.current.order?.orderId) !== normalizedOrderId) return;
      state.current.access = access;
      scheduleChatPushPrompt({ ...access, orderId: order.orderId });
      const payload = await refreshChatCache(order.orderId, access);
      await showRefreshedChatIfOpen(order.orderId, payload, !cached?.messages?.length);

      // Сначала создаём/проверяем Firebase membership и подписку, и только
      // потом повторяем старый outbox. Так старые сообщения не стреляют в
      // Firestore до появления доступа.
      await ensureRealtimeOrder(order, access).catch((realtimeError) => {
        console.warn("Firestore недоступен, оставлен резервный канал", realtimeError);
      });
      await resumeOutboxForCurrentChat();

      setChatError("");
      if (!state.realtimeReady.has(orderKey(order.orderId))) startChatPolling();
    } catch (error) {
      if (state.current.payload?.messages?.length) {
        setChatError("Нет связи с сервером. Показана последняя сохранённая история.");
      } else {
        setChatError(error.message || "Не удалось открыть чат.");
      }
    } finally {
      showChatLoading(false);
    }
  }

  function closeOrderChat() {
    stopChatPolling();
    if (state.sellerRevealTimer) {
    clearTimeout(state.sellerRevealTimer);
    state.sellerRevealTimer = 0;
    }
    clearPendingFile();
    if (elements.maxWarning) elements.maxWarning.hidden = true;
    state.current = null;
    state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    state.objectUrls.clear();
    hideOverlay(elements.chatModal);
    if (typeof window.restoreCatalogAfterChat === "function") {
      window.restoreCatalogAfterChat();
    }
    void refreshChatSummaries();
  }

  function updateChatHeader(order) {
  elements.chatTitle.textContent =
    `Чат по заказу ${normalizeOrderId(order.orderId)}`;

  elements.chatCustomer.textContent = order.name || "";

  let statusLabel = order.statusLabel || "НЕ ОПЛАЧЕНО";

  if (order.status === "debt") {
    const debt = Number(order.debt) || 0;
    statusLabel = `ДОПЛАТИТЬ ${debt.toLocaleString("ru-RU")}\u00A0₽`;
  }

  elements.chatStatus.textContent = statusLabel;
  elements.chatStatus.className =
    `order-chat-status ${statusClass(order.status)}`;
}

  function renderChatPayload(payload, scrollToEnd = false) {
    if (!payload?.order || !Array.isArray(payload.messages)) return;

    // Последняя страховка от гонки Firestore/chat_history:
    // перед КАЖДЫМ render принудительно возвращаем статус из chat_summaries.
    const authoritativeOrderId = normalizeOrderId(
      payload.order?.orderId || payload.summary?.orderId || state.current?.order?.orderId,
    );
    payload = applyLatestKnownOrderStatus(payload, authoritativeOrderId);

    const hasCustomerMessage = payload.messages.some((message) => message.sender === "client");
    const showMaxWarning = Boolean(
      !payload.localPending &&
      (state.current?.order?.contactChannel === "max" || payload.summary?.contactChannel === "max") &&
      payload.summary?.isActive !== true &&
      !hasCustomerMessage &&
      !state.current?.maxWarningDismissed
    );
    if (elements.maxWarning) elements.maxWarning.hidden = !showMaxWarning;
    const orderId = normalizeOrderId(payload.order.orderId || state.current?.order?.orderId);
    const wasNearBottom = elements.chatMessages.scrollHeight - elements.chatMessages.scrollTop
      - elements.chatMessages.clientHeight < 90;
    const previousScrollTop = elements.chatMessages.scrollTop;
    updateChatHeader(payload.order);
    const visibleMessages = payload.messages.filter((message) => !(
    state.current?.sellerRevealAt &&
    Date.now() < state.current.sellerRevealAt &&
    message.sender === "seller"
    ));
    const newKeys = visibleMessages.map(chatMessageKey);
    const existingRows = Array.from(elements.chatMessages.querySelectorAll("[data-chat-message-key]"));
    const existingKeys = existingRows.map((row) => row.dataset.chatMessageKey);
    const canAppend = elements.chatMessages.dataset.orderId === orderId
      && existingKeys.length <= newKeys.length
      && existingKeys.every((key, index) => key === newKeys[index]
        && existingRows[index].dataset.chatMessageDate === chatDateKey(visibleMessages[index]?.createdAt));

    const appendMessage = (message, previousDate) => {
      const currentDate = chatDateKey(message.createdAt);
      if (currentDate && currentDate !== previousDate) {
        elements.chatMessages.appendChild(renderChatDateDivider(message.createdAt));
      }
      elements.chatMessages.appendChild(renderChatMessage(message));
      return currentDate || previousDate;
    };

    if (!canAppend) {
      elements.chatMessages.replaceChildren();
      let previousDate = "";
      visibleMessages.forEach((message) => { previousDate = appendMessage(message, previousDate); });
    } else {
      existingRows.forEach((row, index) => {
        const nextSignature = chatMessageSignature(visibleMessages[index]);
        if (row.dataset.chatMessageSignature !== nextSignature) {
          row.replaceWith(renderChatMessage(visibleMessages[index]));
        }
      });
      let previousDate = existingRows.length
        ? chatDateKey(visibleMessages[existingRows.length - 1]?.createdAt)
        : "";
      visibleMessages.slice(existingRows.length).forEach((message) => {
        previousDate = appendMessage(message, previousDate);
      });
    }
    elements.chatMessages.dataset.orderId = orderId;
    elements.chatComposer.hidden = false;
    updateQuota(payload.summary);
    if (scrollToEnd || wasNearBottom) {
      requestAnimationFrame(() => { elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight; });
    } else if (!canAppend) {
      requestAnimationFrame(() => { elements.chatMessages.scrollTop = previousScrollTop; });
    }
  }

  function renderChatMessage(message) {
    const row = document.createElement("div");
    row.className = `chat-message ${message.sender || "system"}`;
    row.dataset.chatMessageKey = chatMessageKey(message);
    row.dataset.chatMessageSignature = chatMessageSignature(message);
    row.dataset.chatMessageDate = chatDateKey(message.createdAt);
    if (message.type === "order_card") {
      row.appendChild(renderOrderCard(message));
      return row;
    }
    if (message.type === "payment_card") {
      row.appendChild(renderPaymentCard(message));
      return row;
    }
    if (message.type === "attachment") {
      row.appendChild(renderAttachmentCard(message));
      return row;
    }

    const bubble = document.createElement("div");
    bubble.className = "chat-message-bubble";
    if (message.sender === "client" || message.sender === "seller") {
      const role = document.createElement("b");
      role.className = "chat-role-label";
      role.textContent = message.sender === "seller" ? "Продавец" : "";
      bubble.appendChild(role);
    }
    const text = document.createElement("span");
    text.textContent = message.text || "";
    bubble.appendChild(text);
    if (message.delivery === "sending") {
      const delivery = document.createElement("small");
      delivery.className = "chat-message-time";
      delivery.textContent = "Отправляется…";
      bubble.appendChild(delivery);
    } else if (message.delivery === "error") {
      const delivery = document.createElement("small");
      delivery.className = "chat-message-time";
      delivery.textContent = "Не отправлено";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "chat-attachment-action";
      retry.textContent = "Повторить";
      retry.addEventListener("click", () => void retryOptimisticMessage(message));
      bubble.append(delivery, retry);
    } else {
      appendMessageTime(bubble, message.createdAt);
    }
    row.appendChild(bubble);
    return row;
  }

  function appendMessageTime(container, value) {
    const time = document.createElement("small");
    time.className = "chat-message-time";
    time.textContent = formatChatTime(value);
    container.appendChild(time);
  }

  function renderOrderCard(message) {
    const snapshot = message.snapshot || {};
    const card = document.createElement("button");
    card.type = "button";
    card.className = "chat-structured-card chat-order-card";

    const label = document.createElement("span");
    label.className = "chat-order-title";
    label.textContent = `Заказ ${snapshot.orderId || message.orderId || ""}`;

    const customer = document.createElement("span");
    customer.className = "chat-order-customer";
    customer.textContent = [snapshot.name, snapshot.pickup]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" · ");

    const summary = document.createElement("span");
    summary.className = "chat-order-summary";
    const packages = Number(snapshot.itemCount) || 0;
    summary.textContent = `Сумма: ${Number(snapshot.total || 0).toLocaleString("ru-RU")} ₽ · Кол-во: ${packages} п`;

    const action = document.createElement("span");
    action.className = "chat-order-action";
    const actionLabel = document.createElement("span");
    actionLabel.textContent = "Открыть заказ";
    const chevron = document.createElement("b");
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");
    action.append(actionLabel, chevron);

    card.addEventListener("click", () => {
      const order = findSavedOrder(snapshot.orderId || message.orderId);
      if (!order) return;
      stopChatPolling();
      window.returnToOrderChatId_ = normalizeOrderId(order.orderId);
      hideOverlay(elements.chatModal);
      openSavedOrderCard(order);
    });

    card.append(label);
    if (customer.textContent) card.append(customer);
    card.append(summary, action);
    appendMessageTime(card, message.createdAt);
    return card;
  }

  function renderPaymentCard(message) {
    const snapshot = message.snapshot || {};
    const card = document.createElement("article");
    card.className = "chat-structured-card chat-payment-card";
    const label = document.createElement("span");
    label.textContent = "К ОПЛАТЕ";
    const amount = document.createElement("strong");
    amount.textContent = `${Number(snapshot.amount || 0).toLocaleString("ru-RU")} ₽`;
    const details = document.createElement("div");
    details.className = "chat-payment-details";
    const addDetail = (labelText, valueText, tone = "") => {
      if (!valueText) return;
      const row = document.createElement("div");
      row.className = `chat-payment-detail${tone ? ` ${tone}` : ""}`;
      const label = document.createElement("span");
      label.textContent = labelText;
      const value = document.createElement("b");
      value.textContent = valueText;
      row.append(label, value);
      details.appendChild(row);
    };
    const paymentDigitsRaw = String(CHAT_PAYMENT.sbpPhone || "").replace(/\D/g, "");
    const paymentDigits = paymentDigitsRaw.length === 10
      ? `7${paymentDigitsRaw}`
      : paymentDigitsRaw.length === 11 && paymentDigitsRaw.startsWith("8")
        ? `7${paymentDigitsRaw.slice(1)}`
        : paymentDigitsRaw;
    const paymentPhone = paymentDigits ? `+${paymentDigits}` : "";
    addDetail("СБП", paymentPhone);

// Банки с логотипами
const bankRow = document.createElement("div");
bankRow.className = "chat-payment-detail";

const bankLabel = document.createElement("span");
bankLabel.textContent = "Банк";

const bankValue = document.createElement("div");
bankValue.className = "chat-payment-banks";

CHAT_PAYMENT.banks.forEach((bank) => {
  const bankItem = document.createElement("div");
  bankItem.className = "chat-payment-bank-item";

  const logo = document.createElement("img");
  logo.src = bank.logo;
  logo.alt = "";
  logo.className = "chat-payment-bank-logo";
  logo.setAttribute("aria-hidden", "true");

  const name = document.createElement("b");
  name.textContent = bank.name;

  bankItem.append(logo, name);
  bankValue.appendChild(bankItem);
});

bankRow.append(bankLabel, bankValue);
details.appendChild(bankRow);

addDetail("Получатель", CHAT_PAYMENT.recipient);
addDetail("Важно", CHAT_PAYMENT.paymentText, "note");
    if (!details.childElementCount) addDetail("Реквизиты", "Ещё не заполнены продавцом.");
    card.append(label, amount, details);
    if (paymentPhone) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "chat-copy-phone";
      copy.textContent = "Скопировать номер СБП";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(paymentPhone);
          copy.textContent = "✓ Скопировано";
          setTimeout(() => { copy.textContent = "Скопировать номер СБП"; }, 1600);
        } catch {
          showToast("Не удалось скопировать номер");
        }
      });
      card.appendChild(copy);
    }
    appendMessageTime(card, message.createdAt);
    return card;
  }

  function renderAttachmentCard(message) {
  const attachment = message.attachment || {};
  const card = document.createElement("article");
  card.className = "chat-structured-card chat-attachment-card";

  const isImage = String(attachment.mime || "").startsWith("image/");
  const isPdf = attachment.mime === "application/pdf";

  /* =========================
     PDF
     ========================= */
  if (isPdf) {
    card.classList.add("chat-pdf-card");

    const pdfRow = document.createElement("button");
    pdfRow.type = "button";
    pdfRow.className = "chat-pdf-row";

    const pdfBadge = document.createElement("span");
    pdfBadge.className = "chat-pdf-badge";
    pdfBadge.textContent = "PDF";

    const pdfName = document.createElement("span");
    pdfName.className = "chat-pdf-name";
    pdfName.textContent = attachment.fileName || "Документ.pdf";

    pdfRow.append(pdfBadge, pdfName);
    card.appendChild(pdfRow);

    /* PDF ещё отправляется */
    if (message.delivery === "sending") {
      pdfRow.disabled = true;

      const pending = document.createElement("small");
      pending.className = "chat-pdf-status";
      pending.textContent = "Загружается…";

      card.appendChild(pending);
      return card;
    }

    /* Ошибка отправки */
    if (message.delivery === "error") {
      pdfRow.disabled = true;

      const failed = document.createElement("small");
      failed.className = "chat-pdf-status error";
      failed.textContent = "Не отправлено";

      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "chat-pdf-retry";
      retry.textContent = "Повторить";

      retry.addEventListener("click", () => {
        void retryOptimisticMessage(message);
      });

      card.append(failed, retry);
      return card;
    }

    /* Обычный загруженный PDF */
    pdfRow.addEventListener("click", async () => {
      if (!attachment.attachmentId) return;

      pdfRow.disabled = true;

      try {
        const blob = await fetchCurrentAttachment(
          attachment.attachmentId
        );

        const url = URL.createObjectURL(blob);
        state.objectUrls.add(url);

        window.open(url, "_blank", "noopener");
      } catch (error) {
        setChatError(
          error.message || "Не удалось открыть PDF."
        );
      } finally {
        pdfRow.disabled = false;
      }
    });

    if (message.text) {
      const caption = document.createElement("small");
      caption.textContent = message.text;
      card.appendChild(caption);
    }

    appendMessageTime(card, message.createdAt);

    return card;
  }

  /* =========================
     ИЗОБРАЖЕНИЯ
     ========================= */

  if (isImage) {
  const image = document.createElement("img");
  image.className = "chat-attachment-image";
  image.alt = "Фото";
  image.loading = "lazy";

  card.appendChild(image);

  // Если фото только что отправили —
  // показываем локальное превью мгновенно.
  if (attachment.localBase64) {
    image.src =
      `data:${attachment.mime};base64,${attachment.localBase64}`;
  }

  // Если локального превью уже нет,
  // например после повторного открытия чата,
  // загружаем изображение с сервера.
  else if (
  attachment.attachmentId &&
  message.delivery !== "sending" &&
  state.current?.access?.chatToken
) {
    const load = async () => {
      if (image.dataset.loaded) return;
      image.dataset.loaded = "1";

      try {
        const blob = await fetchCurrentAttachment(
          attachment.attachmentId
        );

        const url = URL.createObjectURL(blob);
        state.objectUrls.add(url);

        image.src = url;
      } catch (error) {
        image.alt =
          error.message || "Не удалось загрузить изображение";
      }
    };

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) {
            return;
          }

          observer.disconnect();
          void load();
        },
        {
          root: elements.chatMessages,
          rootMargin: "80px"
        }
      );

      observer.observe(image);
    } else {
      void load();
    }
  }

  // Нажатие по готовой фотографии
  image.addEventListener("click", () => {
    if (image.src) {
      window.open(image.src, "_blank", "noopener");
    }
  });

  // Пока отправляется
  if (message.delivery === "sending") {
    const pending = document.createElement("small");
    pending.className = "chat-image-status";
    pending.textContent = "Загружается…";

    card.appendChild(pending);

    return card;
  }

  // Ошибка
  if (message.delivery === "error") {
    const failed = document.createElement("small");
    failed.className = "chat-image-status error";
    failed.textContent = "Не отправлено";

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "chat-pdf-retry";
    retry.textContent = "Повторить";

    retry.addEventListener("click", () => {
      void retryOptimisticMessage(message);
    });

    card.append(failed, retry);

    return card;
  }

  if (message.text) {
    const caption = document.createElement("small");
    caption.textContent = message.text;
    card.appendChild(caption);
  }

  appendMessageTime(card, message.createdAt);

  return card;
}

return card;
}

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    return bytes >= 1024 ? `${Math.round(bytes / 1024)} КБ` : `${bytes} Б`;
  }

  function updateQuota(summary) {
    const remaining = Number(summary?.attachmentRemainingBytes);
    const safeRemaining = Number.isFinite(remaining) ? Math.max(0, remaining) : CHAT_ATTACHMENT_LIMIT;
    elements.quota.textContent = `Для вложений осталось ${formatBytes(safeRemaining)}`;
    const attachLabel = document.querySelector(".order-chat-attach");
    attachLabel?.classList.toggle("disabled", safeRemaining <= 0);
    elements.chatFile.disabled = safeRemaining <= 0;
  }

  async function fetchCurrentAttachment(attachmentId) {
  const current = state.current;

  const orderId = current?.order?.orderId;
  const chatToken = current?.access?.chatToken;

  if (!orderId || !chatToken || !attachmentId) {
    throw new Error("Нет доступа к вложению.");
  }

  const result = await apiPost({
    action: "chat_attachment",
    orderId,
    chatToken,
    attachmentId,
  }, 25000);

  const attachment = result?.attachment;

  if (!attachment?.base64) {
    throw new Error("Изображение не получено.");
  }

  const binary = atob(attachment.base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob(
    [bytes],
    { type: attachment.mime || "application/octet-stream" }
  );
}

  async function markChatReadSnapshot(orderIdValue, chatToken, payload = null) {
    const orderId = normalizeOrderId(orderIdValue);
    if (!orderId || !chatToken) return;
    clearUnreadLocally(orderId, payload);
    const existingState = state.readStates.get(orderId) || {};
    if (existingState.promise) return existingState.promise;
    const bridge = realtimeBridge();
    const realtimeRequest = state.realtimeReady.has(orderKey(orderId)) && bridge
      ? bridge.markRead({
          seasonId: state.config?.seasonId || "",
          orderId,
          viewer: "client",
        })
      : Promise.resolve();
    const request = realtimeRequest.then(() => apiPost({
      action: "chat_read",
      orderId,
      chatToken,
      viewer: "customer",
    }).catch((error) => {
      console.warn("Не удалось отметить чат прочитанным", error);
    }).finally(() => {
      const latest = state.readStates.get(orderId);
      if (latest?.promise === request) state.readStates.set(orderId, { ...latest, promise: null });
    }));
    state.readStates.set(orderId, { ...existingState, promise: request });
    return request;
  }

  function startChatPolling(elapsedMs = 0) {
    stopChatPolling();
    if (state.current && state.realtimeReady.has(orderKey(state.current.order?.orderId))) return;
    if (!state.current || document.hidden || elements.chatModal.hidden) return;
    const recentlyActive = Date.now() - state.chatActivityAt < CHAT_POLL_FAST_WINDOW;
    const interval = recentlyActive ? CHAT_POLL_FAST_INTERVAL : CHAT_POLL_IDLE_INTERVAL;
    state.pollTimer = window.setTimeout(
      pollCurrentChat,
      Math.max(100, interval - elapsedMs),
    );
  }

  function activateChatPolling(refreshNow = false) {
    const wasIdle = Date.now() - state.chatActivityAt >= CHAT_POLL_FAST_WINDOW;
    state.chatActivityAt = Date.now();
    if (!state.current || document.hidden || elements.chatModal.hidden) return;
    if (refreshNow) {
      stopChatPolling();
      void pollCurrentChat();
    } else if (wasIdle || !state.pollTimer) {
      startChatPolling();
    }
  }

  function stopChatPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  }

  async function pollCurrentChat() {
    if (!state.current || document.hidden || elements.chatModal.hidden) return;
    const startedAt = Date.now();
    const orderId = state.current.order.orderId;
    try {
      const payload = await refreshChatCache(orderId, state.current.access);
      await showRefreshedChatIfOpen(orderId, payload, false);
      setChatError("");
    } catch (error) {
      console.warn("Обновление чата отложено", error);
      setChatError("Не удалось обновить сообщения. Повторим автоматически.");
    } finally {
      startChatPolling(Date.now() - startedAt);
    }
  }

  function clearPendingFile() {
    state.pendingFile = null;
    elements.chatFile.value = "";
    elements.chatFilePreview.hidden = true;
    elements.chatFileName.textContent = "";
  }

  async function fileToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.onerror = () => reject(reader.error || new Error("Не удалось прочитать файл"));
      reader.readAsDataURL(blob);
    });
  }

  async function canvasToWebp(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  }

  async function prepareImageAttachment(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      throw new Error("Не удалось открыть изображение. Для HEIC отправьте скриншот или сохраните файл как JPG/PNG.");
    }
    let width = bitmap.width;
    let height = bitmap.height;
    const maxSide = 1600;
    if (Math.max(width, height) > maxSide) {
      const ratio = maxSide / Math.max(width, height);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    let quality = 0.84;
    let blob = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      blob = await canvasToWebp(canvas, quality);
      if (blob && blob.size <= CHAT_TARGET_IMAGE_BYTES) break;
      if (quality > 0.54) quality -= 0.08;
      else {
        width = Math.max(640, Math.round(width * 0.84));
        height = Math.max(400, Math.round(height * 0.84));
      }
    }
    bitmap.close?.();
    if (!blob || blob.size > CHAT_ATTACHMENT_LIMIT) {
      throw new Error("Не удалось уменьшить изображение до 1 МБ.");
    }
    const baseName = file.name.replace(/\.[^.]+$/, "") || "Изображение";
    return {
      mime: "image/webp",
      fileName: `${baseName}.webp`,
      sizeBytes: blob.size,
      base64: await fileToBase64(blob),
    };
  }

  async function prepareAttachment(file) {
    if (file.type === "application/pdf") {
      if (file.size > CHAT_ATTACHMENT_LIMIT) {
        throw new Error("Файл слишком большой. Максимальный размер — 1 МБ.");
      }
      return {
        mime: "application/pdf",
        fileName: file.name || "Чек.pdf",
        sizeBytes: file.size,
        base64: await fileToBase64(file),
      };
    }
    if (file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name)) {
      return prepareImageAttachment(file);
    }
    throw new Error("Можно отправить JPG, PNG, WebP, поддерживаемый HEIC или PDF.");
  }

  async function selectChatFile(file) {
    if (!file) return;
    setChatError("");
    elements.chatFilePreview.hidden = false;
    elements.chatFileName.textContent = "Подготавливаем файл…";
    elements.sendChat.disabled = true;
    try {
      const prepared = await prepareAttachment(file);
      const remaining = Number(state.current?.payload?.summary?.attachmentRemainingBytes ?? CHAT_ATTACHMENT_LIMIT);
      if (prepared.sizeBytes > remaining) {
        throw new Error("Для этого файла не хватает оставшегося места в чате.");
      }
      state.pendingFile = prepared;
      elements.chatFileName.textContent = `${prepared.fileName} · ${formatBytes(prepared.sizeBytes)}`;
    } catch (error) {
      clearPendingFile();
      setChatError(error.message || "Не удалось подготовить файл.");
    } finally {
      elements.sendChat.disabled = false;
    }
  }

  function buildOptimisticMessage(
  request,
  createdAt = new Date().toISOString()
) {
  return {
    messageId:
      `pending_${request.requestId}`,

    orderId: request.orderId,
    sender: "client",

    type: request.attachment
      ? "attachment"
      : "text",

    text: request.text || "",

    attachment: request.attachment
      ? {
          attachmentId: "",
          mime: request.attachment.mime,
          fileName:
            request.attachment.fileName,
          sizeBytes:
            request.attachment.sizeBytes,

          localBase64:
            request.attachment.mime
              .startsWith("image/")
              ? request.attachment.base64
              : "",
        }
      : null,

    createdAt,
    delivery: "sending",
    localRequestId: request.requestId,
    clientMessageId: request.clientMessageId || request.requestId,
    retryRequest: request,
  };
}

function queuedDelivery(request) {
  return request?.attachment
    ? "sending"
    : "queued";
}

  async function sendComposerMessage(event) {
  event.preventDefault();

  if (
    !state.current?.access?.chatToken
  ) {
    return;
  }

  activateChatPolling(false);

  const text =
    elements.chatInput.value.trim();

  if (!text && !state.pendingFile) {
    return;
  }

  const clientMessageId = randomRequestId("message");
  const request = {
    action: "chat_send",
    orderId:
      state.current.order.orderId,

    chatToken:
      state.current.access.chatToken,

    requestId: clientMessageId,
    clientMessageId,

    text,
    attachment: state.pendingFile,
  };

  const payload = state.current.payload;

  const optimistic =
    buildOptimisticMessage(request);

  payload.messages.push(
    optimistic
  );

  // Вложение показывает превью и загрузку сразу.
  // Текст впервые рисуем уже после записи в outbox,
  // поэтому пользователь не видит промежуточный статус.
  if (request.attachment) {
    renderChatPayload(
      payload,
      true
    );
  }

  elements.chatInput.value = "";
  clearPendingFile();

  // ВАЖНО: сначала сохраняем сообщение локально,
  // только потом считаем текст визуально отправленным
  // и запускаем реальную отправку в фоне.
  try {
    await saveOutboxRequest(
      request,
      optimistic.createdAt
    );
  } catch (error) {
    console.warn(
      "Не удалось сохранить сообщение в outbox",
      error
    );

    optimistic.delivery = "error";
    await cacheChat(
      request.orderId,
      payload
    );
    if (state.current?.payload === payload) {
      renderChatPayload(payload, true);
      setChatError(
        "Сообщение не сохранено. Нажмите «Повторить»."
      );
    }
    return;
  }

  optimistic.delivery = queuedDelivery(request);
  await cacheChat(
    request.orderId,
    payload
  );
  if (state.current?.payload === payload) {
    renderChatPayload(payload, true);
  }

  void transmitOptimisticMessage(
    optimistic
  );
}

  async function transmitOptimisticMessage(
  optimistic
) {
  const request =
    optimistic?.retryRequest;

  if (!request?.requestId) {
    return;
  }

  const orderId =
    normalizeOrderId(request.orderId);

  const blocksComposer = Boolean(request.attachment);
  if (blocksComposer) {
    elements.sendChat.disabled = true;
  }

  try {
    const bridge = realtimeBridge();
    // Текст идёт напрямую в Firestore независимо от того, успел ли
    // onSnapshot уже прислать первый snapshot. Вложения остаются на Apps Script/Drive.
    const useRealtime = !request.attachment && bridge;
    const result = useRealtime
      ? await bridge.sendText({
          apiUrl: chatApiUrl(),
          seasonId: state.config?.seasonId || "",
          orderId: request.orderId,
          chatToken: request.chatToken,
          sender: "client",
          text: request.text,
          messageId: request.requestId,
        })
      : await apiPost(request, 30000);

    let confirmedMessage =
      result.message;

    // Не теряем мгновенное локальное
    // превью фотографии.
    const localBase64 =
      optimistic.attachment
        ?.localBase64 ||
      request.attachment?.base64 ||
      "";

    if (
      localBase64 &&
      confirmedMessage?.attachment
    ) {
      confirmedMessage = {
        ...confirmedMessage,

        attachment: {
          ...confirmedMessage.attachment,
          localBase64,
        },
      };
    }

    // Локальная связь с requestId позволяет безопасно
    // закончить очистку outbox после перезапуска PWA.
    confirmedMessage = {
      ...confirmedMessage,
      // Гарантируем общий stable ID даже для старого Apps Script ответа.
      clientMessageId:
        confirmedMessage?.clientMessageId ||
        request.clientMessageId ||
        request.requestId,
      localRequestId: request.requestId,
      // Ответ sendText/chat_send подтверждает приём, но realtime/history может
      // ещё вернуть предыдущий снимок. Держим сообщение локально до первого
      // серверного эха, не показывая пользователю отдельный статус.
      awaitingServerEcho: true,
    };

    const currentIsSameChat =
      state.current &&
      normalizeOrderId(
        state.current.order?.orderId
      ) === orderId;

    let confirmedPersisted = false;

    if (currentIsSameChat) {
      const messages =
        state.current.payload.messages;

      const pendingIndex =
        messages.findIndex(
          (item) =>
            item.messageId ===
            optimistic.messageId
        );

      const confirmedIndex =
        messages.findIndex(
          (item) =>
            item.messageId ===
            confirmedMessage.messageId
        );

      if (pendingIndex !== -1) {
        // Если серверное сообщение уже
        // успело прийти через синхронизацию,
        // просто убираем pending.
        if (
          confirmedIndex !== -1 &&
          confirmedIndex !== pendingIndex
        ) {
          messages.splice(
            pendingIndex,
            1
          );
        } else {
          messages.splice(
            pendingIndex,
            1,
            confirmedMessage
          );
        }
      } else if (
        confirmedIndex === -1
      ) {
        messages.push(
          confirmedMessage
        );
      }

      confirmedPersisted = await cacheChat(
        orderId,
        state.current.payload
      );

      renderChatPayload(
        state.current.payload,
        true
      );

      setChatError("");
    } else {
      // Клиент уже закрыл чат,
      // но сервер успел принять сообщение.
      const cached =
        await readCachedChat(orderId);

      if (cached?.messages) {
        const pendingIndex =
          cached.messages.findIndex(
            (item) =>
              item.messageId ===
              optimistic.messageId
          );

        const confirmedIndex =
          cached.messages.findIndex(
            (item) =>
              item.messageId ===
              confirmedMessage.messageId
          );

        if (pendingIndex !== -1) {
          if (
            confirmedIndex !== -1 &&
            confirmedIndex !==
              pendingIndex
          ) {
            cached.messages.splice(
              pendingIndex,
              1
            );
          } else {
            cached.messages.splice(
              pendingIndex,
              1,
              confirmedMessage
            );
          }
        } else if (
          confirmedIndex === -1
        ) {
          cached.messages.push(
            confirmedMessage
          );
        }

        confirmedPersisted = await cacheChat(
          orderId,
          cached
        );
      }
    }

    // Удаляем outbox только после подтверждения сервера
    // и сохранения подтверждённого сообщения локально.
    if (confirmedPersisted) {
      try {
        await removeOutboxRequest(
          orderId,
          request.requestId
        );
      } catch (error) {
        console.warn(
          "Не удалось очистить outbox",
          error
        );
      }
    }

    // Большой base64 больше
    // для повторной отправки не нужен.
    if (optimistic.retryRequest) {
      optimistic.retryRequest.attachment =
        null;
    }
  } catch (error) {
    // Outbox НЕ удаляем.
    // Если сервер всё-таки успел принять
    // сообщение, повторный requestId
    // безопасно вернёт duplicate.
    const currentIsSameChat =
      state.current &&
      normalizeOrderId(
        state.current.order?.orderId
      ) === orderId;

    if (currentIsSameChat) {
      optimistic.delivery = "error";

      await cacheChat(
        orderId,
        state.current.payload
      );

      renderChatPayload(
        state.current.payload,
        true
      );

      setChatError(
        error.message ||
          "Сообщение не отправлено. Нажмите «Повторить»."
      );
    }
  } finally {
    if (blocksComposer) {
      elements.sendChat.disabled = false;
    }
  }
}
  async function retryOptimisticMessage(
  message
) {
  if (
    !state.current?.access?.chatToken ||
    !message?.retryRequest
  ) {
    return;
  }

  message.retryRequest.chatToken =
    state.current.access.chatToken;

  try {
    await saveOutboxRequest(
      message.retryRequest,
      message.createdAt
    );
  } catch (error) {
    console.warn(
      "Не удалось обновить outbox",
      error
    );

    message.delivery = "error";
    await cacheChat(
      state.current.order.orderId,
      state.current.payload
    );
    renderChatPayload(
      state.current.payload,
      true
    );
    setChatError(
      "Сообщение не сохранено. Нажмите «Повторить»."
    );
    return;
  }

  message.delivery = queuedDelivery(
    message.retryRequest
  );
  await cacheChat(
    state.current.order.orderId,
    state.current.payload
  );

  renderChatPayload(
    state.current.payload,
    true
  );

  await transmitOptimisticMessage(
    message
  );
}

  function createInfoRestoreCard() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "info-restore-card";
    const icon = document.createElement("span");
    icon.textContent = "↻";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = "Восстановить заказ";
    const subtitle = document.createElement("small");
    subtitle.textContent = "Если вы сменили телефон или удалили приложение";
    copy.append(title, subtitle);
    const action = document.createElement("b");
    action.textContent = "Открыть";
    button.append(icon, copy, action);
    button.addEventListener("click", () => {
      elements.restoreId.value = "";
      elements.restorePhone.value = "";
      setInlineError(elements.restoreError, "");
      showOverlay(elements.restoreModal);
      setTimeout(() => elements.restoreId.focus(), 100);
    });
    return button;
  }

  async function restoreOrder() {
    const orderId = normalizeOrderId(elements.restoreId.value);
    const phone = elements.restorePhone.value.trim();
    if (!orderId || !phone) {
      setInlineError(elements.restoreError, "Введите номер заказа и полный телефон.");
      return;
    }
    elements.restoreSubmit.disabled = true;
    elements.restoreSubmit.textContent = "Проверяем…";
    setInlineError(elements.restoreError, "");
    try {
      const requestId = randomRequestId("restore");
      const result = await apiPost({
        action: "chat_recover",
        orderId,
        phone,
        requestId,
      }, 26000);
      const order = result.order;
      saveOrderSnapshot({
        orderId: order.orderId,
        title: `ЗАКАЗ ${order.orderId}`,
        mode: "normal",
        orderLabel: "",
        name: order.name,
        phone,
        pickup: order.pickup,
        createdAt: order.createdAt || new Date().toISOString(),
        dateLabel: order.createdAt ? new Date(order.createdAt).toLocaleDateString("ru-RU") : "",
        total: order.total,
        totalItems: order.itemCount,
        items: order.items,
        clientRequestId: `restored:${requestId}`,
        seasonId: result.seasonId,
        contactChannel: result.summary?.contactChannel || "",
      });
      if (result.chatCreated && result.chatToken) {
        await putAccess(order.orderId, { chatToken: result.chatToken, chatCreated: true });
      }
      if (result.summary) state.summaries.set(normalizeOrderId(order.orderId), result.summary);
      await refreshChatSummaries();
      hideOverlay(elements.restoreModal);
      showToast("Заказ восстановлен");
    } catch (error) {
      setInlineError(elements.restoreError, error.message || "Не удалось восстановить заказ.");
    } finally {
      elements.restoreSubmit.disabled = false;
      elements.restoreSubmit.textContent = "Восстановить";
    }
  }

  elements.closeShare?.addEventListener("click", () => hideOverlay(elements.shareModal));
  elements.shareModal?.addEventListener("click", (event) => {
    if (event.target === elements.shareModal) hideOverlay(elements.shareModal);
  });
  elements.chooseChat?.addEventListener("click", () => void chooseInternalChat());
  elements.chooseMax?.addEventListener("click", () => void chooseMax());
  elements.closeChat?.addEventListener("click", closeOrderChat);
  elements.maxBack?.addEventListener("click", closeOrderChat);
  elements.maxContinue?.addEventListener("click", () => {
    if (state.current) state.current.maxWarningDismissed = true;
    if (elements.maxWarning) elements.maxWarning.hidden = true;
    elements.chatInput?.focus();
  });
  elements.chatComposer?.addEventListener("submit", sendComposerMessage);
  const activateChatFromTouch = () => activateChatPolling(
    Date.now() - state.chatActivityAt >= CHAT_POLL_FAST_WINDOW,
  );
  elements.chatMessages?.addEventListener("pointerdown", activateChatFromTouch, { passive: true });
  elements.chatComposer?.addEventListener("pointerdown", activateChatFromTouch, { passive: true });
  elements.chatInput?.addEventListener("input", () => {
    activateChatPolling(false);
    elements.chatInput.style.height = "auto";
    elements.chatInput.style.height = `${Math.min(elements.chatInput.scrollHeight, 116)}px`;
  });
  elements.chatFile?.addEventListener("change", () => void selectChatFile(elements.chatFile.files?.[0]));
  elements.removeChatFile?.addEventListener("click", clearPendingFile);
  elements.closeRestore?.addEventListener("click", () => hideOverlay(elements.restoreModal));
  elements.restoreModal?.addEventListener("click", (event) => {
    if (event.target === elements.restoreModal) hideOverlay(elements.restoreModal);
  });
  elements.restoreSubmit?.addEventListener("click", () => void restoreOrder());
  elements.closePush?.addEventListener("click", () => dismissChatPushPrompt(true));
  elements.laterPush?.addEventListener("click", () => dismissChatPushPrompt(true));
  elements.enablePush?.addEventListener("click", () => void enableChatPushNotifications());
  elements.pushModal?.addEventListener("click", (event) => {
    if (event.target === elements.pushModal) dismissChatPushPrompt(true);
  });
  navigator.serviceWorker?.addEventListener("message", (event) => {
    const payload = event.data || {};
    if (payload.type !== "catalog-chat-message") return;
    const orderId = normalizeOrderId(payload.orderId);
    if (orderId) preloadOrderChat(orderId);
    if (state.current && normalizeOrderId(state.current.order?.orderId) === orderId) {
      activateChatPolling(false);
    } else {
      void refreshChatSummaries();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopChatPolling();
    else if (state.current && !elements.chatModal.hidden) {
      activateChatPolling(true);
    } else {
      void refreshChatSummaries();
    }
  });

  window.getOrderChatUnreadTotal_ = getOrderChatUnreadTotal;
  window.appendSavedOrderChatControls_ = appendSavedOrderChatControls;
  window.openOrderShareChooser_ = openOrderShareChooser;
  window.createInfoRestoreCard_ = createInfoRestoreCard;
  window.openOrderChat_ = openOrderChat;
  window.refreshChatSummaries_ = refreshChatSummaries;

  void initializeOrderChatClient();
})();
