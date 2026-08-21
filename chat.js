(function () {
  "use strict";

  const CHAT_DB_NAME = "tomato-order-chat-v1";
  const CHAT_DB_VERSION = 1;
  const CHAT_SEASON_KEY = "tomatoChatSeasonId";
  const CHAT_CONFIG_KEY = "tomatoChatSeasonConfig";
  const CHAT_POLL_INTERVAL = 12000;
  const CHAT_TARGET_IMAGE_BYTES = 350 * 1024;
  const CHAT_ATTACHMENT_LIMIT = 1024 * 1024;
  const chatApiUrl = () => `${CATALOG_API_URL}?chat=1`;

  const state = {
    config: null,
    summaries: new Map(),
    access: new Map(),
    current: null,
    pendingFile: null,
    shareOrderId: "",
    pollTimer: 0,
    objectUrls: new Set(),
    createPromises: new Map(),
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

  async function clearChatDatabase() {
    const db = await openDb();
    try {
      await Promise.all(["access", "chats", "meta"].map((storeName) => new Promise((resolve, reject) => {
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

  async function cacheChat(orderId, payload) {
    try {
      await dbPut("chats", {
        key: orderKey(orderId),
        seasonId: state.config?.seasonId || "",
        orderId: normalizeOrderId(orderId),
        payload,
        cachedAt: Date.now(),
      });
    } catch (error) {
      console.warn("Не удалось сохранить локальную копию чата", error);
    }
  }

  async function readCachedChat(orderId) {
    try {
      return (await dbGet("chats", orderKey(orderId)))?.payload || null;
    } catch {
      return null;
    }
  }

  function lastServerMessageId(payload) {
    if (payload?.localPending) return "";
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.messageId && !messages[index]?.delivery) return messages[index].messageId;
    }
    return "";
  }

  function mergeChatPayload(cached, incoming) {
    if (!cached?.messages?.length || incoming?.messagesMode !== "delta") return incoming;
    const known = new Set(cached.messages.map((message) => message.messageId));
    const additions = (incoming.messages || []).filter((message) => !known.has(message.messageId));
    return {
      ...cached,
      ...incoming,
      order: incoming.order || cached.order,
      summary: incoming.summary || cached.summary,
      messagesMode: "full",
      messages: [...cached.messages, ...additions],
    };
  }

  async function clearClosedClientData() {
    [
      SAVED_ORDERS_KEY,
      "tomatoCart",
      ORDER_DRAFT_KEY,
      "pendingSheet",
      PENDING_ORDER_REQUEST_KEY,
    ].forEach((key) => localStorage.removeItem(key));
    savedOrders = [];
    state.summaries.clear();
    state.access.clear();
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
      await clearClosedClientData();
    }
    localStorage.setItem(CHAT_SEASON_KEY, state.config.seasonId);

    if (!state.config.seasonClosed) {
      await refreshChatSummaries();
    }
    state.initialized = true;
    renderSavedOrdersSummary();
  }

  async function refreshChatSummaries() {
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
      await Promise.all(result.summaries.map(async (item) => {
        const itemOrderId = item.order?.orderId || item.summary?.orderId;
        const cached = await readCachedChat(itemOrderId);
        return cacheChat(itemOrderId, {
          ...(cached || {}),
          order: item.order || cached?.order,
          summary: item.summary || cached?.summary,
          messagesMode: "full",
          messages: Array.isArray(cached?.messages) ? cached.messages : [],
        });
      }));
    } catch (error) {
      if (error?.code !== "REQUEST_TIMEOUT") {
        console.warn("Не удалось обновить сводки чата", error);
      }
      for (const order of savedOrders) {
        const cached = await readCachedChat(order.orderId);
        if (cached?.summary) state.summaries.set(normalizeOrderId(order.orderId), cached.summary);
      }
    }
    updateAppBadge();
    renderSavedOrdersSummary();
    if (document.getElementById("savedOrdersModal")?.style.display === "flex") {
      renderSavedOrdersList();
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
    element.hidden = true;
    element.setAttribute("aria-hidden", "true");
    const savedOrdersModal = document.getElementById("savedOrdersModal");
    const anotherOpen = [elements.shareModal, elements.chatModal, elements.restoreModal]
      .some((item) => item && !item.hidden);
    if (anotherOpen || savedOrdersModal?.style.display === "flex") lockBody();
    else unlockBody();
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
    let access = await getAccess(order.orderId);
    if (access?.chatToken) return access;
    const key = orderKey(order.orderId);
    if (state.createPromises.has(key)) return state.createPromises.get(key);
    const request = (async () => {
      const requestId = access?.pendingCreateRequestId || randomRequestId("create");
      access = await putAccess(order.orderId, { pendingCreateRequestId: requestId });
      const result = await apiPost({
        action: "chat_create",
        orderId: order.orderId,
        phone: order.phone,
        requestId,
      }, 25000);
      await putAccess(order.orderId, {
        chatToken: result.chatToken,
        pendingCreateRequestId: "",
        chatCreated: true,
      });
      return { ...access, chatToken: result.chatToken, initialPayload: result };
    })();
    state.createPromises.set(key, request);
    try {
      return await request;
    } finally {
      state.createPromises.delete(key);
    }
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
      messages: [{
        messageId: `auto_client_${messageBase}`,
        orderId,
        sender: "client",
        type: "text",
        text: "Здравствуйте! Направляю заказ по семенам томатов для подтверждения и оплаты 🍅",
        createdAt: new Date(now).toISOString(),
      }, {
        messageId: `auto_order_${messageBase}`,
        orderId,
        sender: "client",
        type: "order_card",
        text: "",
        snapshot: publicOrder,
        createdAt: new Date(now + 1).toISOString(),
      }, {
        messageId: `auto_seller_${messageBase}`,
        orderId,
        sender: "seller",
        type: "text",
        text: "Здравствуйте! 🌱 Спасибо за заказ.",
        createdAt: new Date(now + 2).toISOString(),
      }],
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

  async function openOrderChat(orderId) {
    const order = findSavedOrder(orderId);
    if (!order) throw new Error("Сохранённый заказ не найден.");
    stopChatPolling();
    state.current = { order, access: null, payload: null };
    elements.chatTitle.textContent = `Чат по заказу ${normalizeOrderId(order.orderId)}`;
    elements.chatCustomer.textContent = order.name || "";
    elements.chatStatus.textContent = "ОБНОВЛЯЕМ";
    elements.chatStatus.className = "order-chat-status";
    elements.chatMessages.replaceChildren();
    elements.chatComposer.hidden = true;
    elements.quota.textContent = "";
    setChatError("");
    showChatLoading(true);
    closeSavedOrders();
    showOverlay(elements.chatModal);

    const cached = await readCachedChat(order.orderId);
    if (cached?.messages?.length) {
      state.current.payload = cached;
      renderChatPayload(cached, true);
      showChatLoading(false);
    } else {
      const pendingPayload = buildPendingInitialPayload(order);
      state.current.payload = pendingPayload;
      renderChatPayload(pendingPayload, true);
      showChatLoading(false);
    }

    try {
      const access = await ensureChatAccess(order);
      state.current.access = access;
      const incoming = await fetchChatHistory(order, access, lastServerMessageId(state.current.payload));
      const payload = mergeChatPayload(state.current.payload, incoming);
      state.current.payload = payload;
      await cacheChat(order.orderId, payload);
      renderChatPayload(payload, true);
      await markCurrentChatRead();
      startChatPolling();
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
    clearPendingFile();
    state.current = null;
    state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    state.objectUrls.clear();
    hideOverlay(elements.chatModal);
    void refreshChatSummaries();
  }

  function updateChatHeader(order) {
    elements.chatTitle.textContent = `Чат по заказу ${normalizeOrderId(order.orderId)}`;
    elements.chatCustomer.textContent = order.name || "";
    elements.chatStatus.textContent = order.statusLabel || "НЕ ОПЛАЧЕН";
    elements.chatStatus.className = `order-chat-status ${statusClass(order.status)}`;
  }

  function renderChatPayload(payload, scrollToEnd = false) {
    if (!payload?.order || !Array.isArray(payload.messages)) return;
    const wasNearBottom = elements.chatMessages.scrollHeight - elements.chatMessages.scrollTop
      - elements.chatMessages.clientHeight < 90;
    updateChatHeader(payload.order);
    elements.chatMessages.replaceChildren();
    let previousDate = "";
    payload.messages.forEach((message) => {
      const currentDate = chatDateKey(message.createdAt);
      if (currentDate && currentDate !== previousDate) {
        elements.chatMessages.appendChild(renderChatDateDivider(message.createdAt));
        previousDate = currentDate;
      }
      elements.chatMessages.appendChild(renderChatMessage(message));
    });
    elements.chatComposer.hidden = false;
    updateQuota(payload.summary);
    if (scrollToEnd || wasNearBottom) {
      requestAnimationFrame(() => { elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight; });
    }
  }

  function renderChatMessage(message) {
    const row = document.createElement("div");
    row.className = `chat-message ${message.sender || "system"}`;
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
      role.textContent = message.sender === "seller" ? "Продавец" : "Покупатель";
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
    const card = document.createElement("article");
    card.className = "chat-structured-card chat-order-card";
    const label = document.createElement("span");
    label.textContent = `ЗАКАЗ ${snapshot.orderId || message.orderId || ""}`;
    const amount = document.createElement("strong");
    amount.textContent = `${Number(snapshot.total || 0).toLocaleString("ru-RU")} ₽`;
    const detail = document.createElement("small");
    const packages = Number(snapshot.itemCount) || 0;
    detail.textContent = `${packages} п`;
    const action = document.createElement("button");
    action.type = "button";
    action.className = "chat-card-action";
    action.textContent = "Открыть заказ";
    action.addEventListener("click", () => {
      const order = findSavedOrder(snapshot.orderId || message.orderId);
      if (!order) return;
      stopChatPolling();
      window.returnToOrderChatId_ = normalizeOrderId(order.orderId);
      hideOverlay(elements.chatModal);
      openSavedOrderCard(order);
    });
    card.append(label, amount, detail, action);
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
    const paymentDigitsRaw = String(snapshot.sbpPhone || "").replace(/\D/g, "");
    const paymentDigits = paymentDigitsRaw.length === 10
      ? `7${paymentDigitsRaw}`
      : paymentDigitsRaw.length === 11 && paymentDigitsRaw.startsWith("8")
        ? `7${paymentDigitsRaw.slice(1)}`
        : paymentDigitsRaw;
    const paymentPhone = paymentDigits ? `+${paymentDigits}` : "";
    addDetail("СБП", paymentPhone);
    addDetail("Банк", snapshot.bank || "");
    addDetail("Получатель", snapshot.recipient || "");
    addDetail("Важно", snapshot.paymentText || "", "note");
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
    const meta = document.createElement("div");
    meta.className = "chat-attachment-meta";
    const icon = document.createElement("span");
    icon.textContent = attachment.mime === "application/pdf" ? "📄" : "🖼️";
    const copy = document.createElement("span");
    copy.textContent = `${attachment.fileName || "Вложение"} · ${formatBytes(attachment.sizeBytes)}`;
    meta.append(icon, copy);
    card.appendChild(meta);

    if (message.delivery === "sending") {
      const pending = document.createElement("small");
      pending.textContent = message.text
        ? `${message.text}\nОтправляется…`
        : "Отправляется…";
      card.appendChild(pending);
      return card;
    }

    if (message.delivery === "error") {
      const failed = document.createElement("small");
      failed.textContent = message.text
        ? `${message.text}\nНе отправлено`
        : "Не отправлено";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "chat-attachment-action";
      retry.textContent = "Повторить";
      retry.addEventListener("click", () => void retryOptimisticMessage(message));
      card.append(failed, retry);
      return card;
    }

    if (String(attachment.mime || "").startsWith("image/")) {
      const image = document.createElement("img");
      image.className = "chat-attachment-image";
      image.alt = attachment.fileName || "Изображение в чате";
      image.loading = "lazy";
      card.appendChild(image);
      const load = async () => {
        if (image.dataset.loaded) return;
        image.dataset.loaded = "1";
        try {
          const blob = await fetchCurrentAttachment(attachment.attachmentId);
          const url = URL.createObjectURL(blob);
          state.objectUrls.add(url);
          image.src = url;
          image.addEventListener("click", () => window.open(url, "_blank", "noopener"));
        } catch (error) {
          image.alt = error.message || "Не удалось загрузить изображение";
        }
      };
      if ("IntersectionObserver" in window) {
        const observer = new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer.disconnect();
          void load();
        }, { root: elements.chatMessages, rootMargin: "80px" });
        observer.observe(image);
      } else {
        void load();
      }
    } else {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "chat-attachment-action";
      open.textContent = "Открыть";
      open.addEventListener("click", async () => {
        open.disabled = true;
        try {
          const blob = await fetchCurrentAttachment(attachment.attachmentId);
          const url = URL.createObjectURL(blob);
          state.objectUrls.add(url);
          window.open(url, "_blank", "noopener");
        } catch (error) {
          setChatError(error.message || "Не удалось открыть файл.");
        } finally {
          open.disabled = false;
        }
      });
      card.appendChild(open);
    }
    if (message.text) {
      const caption = document.createElement("small");
      caption.textContent = message.text;
      card.appendChild(caption);
    }
    appendMessageTime(card, message.createdAt);
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
    if (!state.current?.access?.chatToken || !state.current?.order) {
      throw new Error("Нет доступа к вложению.");
    }
    const result = await apiPost({
      action: "chat_attachment",
      orderId: state.current.order.orderId,
      chatToken: state.current.access.chatToken,
      attachmentId,
    }, 25000);
    const binary = atob(result.attachment.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: result.attachment.mime });
  }

  async function markCurrentChatRead() {
    if (!state.current?.access?.chatToken) return;
    try {
      await apiPost({
        action: "chat_read",
        orderId: state.current.order.orderId,
        chatToken: state.current.access.chatToken,
      });
      const key = normalizeOrderId(state.current.order.orderId);
      const summary = state.summaries.get(key);
      if (summary) state.summaries.set(key, { ...summary, unread: 0 });
      updateAppBadge();
      renderSavedOrdersSummary();
    } catch (error) {
      console.warn("Не удалось отметить чат прочитанным", error);
    }
  }

  function startChatPolling() {
    stopChatPolling();
    if (!state.current || document.hidden) return;
    state.pollTimer = window.setTimeout(pollCurrentChat, CHAT_POLL_INTERVAL);
  }

  function stopChatPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  }

  async function pollCurrentChat() {
    if (!state.current || document.hidden || elements.chatModal.hidden) return;
    try {
      const incoming = await fetchChatHistory(
        state.current.order,
        state.current.access,
        lastServerMessageId(state.current.payload),
      );
      const payload = mergeChatPayload(state.current.payload, incoming);
      const previousIds = (state.current.payload?.messages || []).map((item) => item.messageId).join("|");
      const previousStatus = state.current.payload?.order?.status || "";
      const nextIds = (payload.messages || []).map((item) => item.messageId).join("|");
      state.current.payload = payload;
      state.current.access.initialPayload = null;
      await cacheChat(state.current.order.orderId, payload);
      if (previousIds !== nextIds || previousStatus !== payload.order?.status) {
        renderChatPayload(payload, true);
      } else {
        updateChatHeader(payload.order);
        updateQuota(payload.summary);
      }
      await markCurrentChatRead();
      setChatError("");
    } catch (error) {
      console.warn("Обновление чата отложено", error);
    } finally {
      startChatPolling();
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

  async function sendComposerMessage(event) {
    event.preventDefault();
    if (!state.current?.access?.chatToken) return;
    const text = elements.chatInput.value.trim();
    if (!text && !state.pendingFile) return;
    const request = {
      action: "chat_send",
      orderId: state.current.order.orderId,
      chatToken: state.current.access.chatToken,
      requestId: randomRequestId("message"),
      text,
      attachment: state.pendingFile,
    };
    const optimistic = {
      messageId: `pending_${request.requestId}`,
      orderId: request.orderId,
      sender: "client",
      type: request.attachment ? "attachment" : "text",
      text,
      attachment: request.attachment ? {
        attachmentId: "",
        mime: request.attachment.mime,
        fileName: request.attachment.fileName,
        sizeBytes: request.attachment.sizeBytes,
      } : null,
      createdAt: new Date().toISOString(),
      delivery: "sending",
      retryRequest: request,
    };
    state.current.payload.messages.push(optimistic);
    renderChatPayload(state.current.payload, true);
    elements.chatInput.value = "";
    clearPendingFile();
    await transmitOptimisticMessage(optimistic);
  }

  async function transmitOptimisticMessage(optimistic) {
    elements.sendChat.disabled = true;
    try {
      const result = await apiPost(optimistic.retryRequest, 30000);
      const index = state.current.payload.messages.indexOf(optimistic);
      if (index !== -1) state.current.payload.messages.splice(index, 1, result.message);
      optimistic.retryRequest.attachment = null;
      renderChatPayload(state.current.payload, true);
      const incoming = await fetchChatHistory(
        state.current.order,
        state.current.access,
        lastServerMessageId(state.current.payload),
      );
      const payload = mergeChatPayload(state.current.payload, incoming);
      state.current.payload = payload;
      await cacheChat(state.current.order.orderId, payload);
      renderChatPayload(payload, true);
      setChatError("");
    } catch (error) {
      optimistic.delivery = "error";
      renderChatPayload(state.current.payload, true);
      setChatError(error.message || "Сообщение не отправлено. Нажмите «Повторить».");
    } finally {
      elements.sendChat.disabled = false;
    }
  }

  async function retryOptimisticMessage(message) {
    message.delivery = "sending";
    renderChatPayload(state.current.payload, true);
    await transmitOptimisticMessage(message);
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
  elements.chatComposer?.addEventListener("submit", sendComposerMessage);
  elements.chatInput?.addEventListener("input", () => {
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
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopChatPolling();
    else if (state.current && !elements.chatModal.hidden) {
      void pollCurrentChat();
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
