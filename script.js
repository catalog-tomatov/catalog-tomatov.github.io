function vibrate(ms = 20) {
  if ("vibrate" in navigator) {
    navigator.vibrate(ms);
  }
}

let products = [];

const CATALOG_API_URL =
  "https://script.google.com/macros/s/AKfycbwAIYzIGkeGriT_B4Z1M58oK1xqexMiyDpE4eGnQTTQt-CeJwbeh_vkqXMXipE1END2/exec";
const CATALOG_CACHE_KEY = "tomatoCatalogCacheV1";
const CATALOG_CLIENT_LOOKUP_VERSION = "v2-2026-08-06";
const CATALOG_CACHE_TTL = 60 * 1000;
const CATALOG_VISIBLE_REFRESH_INTERVAL = 60 * 1000;
const CATALOG_AVAILABILITY_REFRESH_INTERVAL = 10 * 1000;
const CATALOG_REQUEST_TIMEOUT = 30 * 1000;
const CATALOG_RESUME_REFRESH_AFTER = 0;
const ORDER_SUBMIT_REQUEST_TIMEOUT = 25 * 1000;

let catalogReady = false;
let catalogLastSuccessfulRefreshAt = 0;
let catalogRefreshPromise = null;
let catalogAvailabilityRefreshPromise = null;
let catalogLastLoadSource = "none";

const SAVED_ORDERS_KEY = "savedOrders";
const SAVED_ORDERS_LIMIT = 10;
const ORDER_DRAFT_KEY = "tomatoOrderDraft";
const PENDING_ORDER_REQUEST_KEY = "tomatoPendingOrderRequest";
const RESET_VERSION_KEY = "tomatoResetVersion";
const RESET_DATE = new Date("2027-06-01T00:00:00+03:00").getTime();
const RESET_VERSION = "2027-06-01";

function runScheduledStorageReset(now = Date.now()) {
  if (now < RESET_DATE) return false;
  if (localStorage.getItem(RESET_VERSION_KEY) === RESET_VERSION) return false;

  [
    SAVED_ORDERS_KEY,
    "tomatoCart",
    ORDER_DRAFT_KEY,
    "pendingSheet",
    PENDING_ORDER_REQUEST_KEY,
  ].forEach((key) => localStorage.removeItem(key));

  localStorage.setItem(RESET_VERSION_KEY, RESET_VERSION);

  if ("caches" in window) {
    void caches.delete("order-png-v1");
  }

  return true;
}

runScheduledStorageReset();

let tomatoLevel = 0;

let tomatoClicks = 0;

function lockBody() {
  document.body.style.overflow = "hidden";
}

function unlockBody() {
  document.body.style.overflow = "";
}

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");

  if (digits.length !== 11) return phone;

  return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

const EN_KEYBOARD_LAYOUT = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const RU_KEYBOARD_LAYOUT = "йцукенгшщзхъфывапролджэячсмитьбю";

function convertKeyboardLayout(value) {
  return Array.from(String(value || "").toLowerCase())
    .map((character) => {
      let index = EN_KEYBOARD_LAYOUT.indexOf(character);
      if (index !== -1) return RU_KEYBOARD_LAYOUT[index];

      index = RU_KEYBOARD_LAYOUT.indexOf(character);
      if (index !== -1) return EN_KEYBOARD_LAYOUT[index];

      return character;
    })
    .join("");
}

function getSearchVariants(value) {
  const normalized = normalizeSearchText(value);
  const converted = normalizeSearchText(convertKeyboardLayout(normalized));

  return Array.from(new Set([normalized, converted])).filter(Boolean);
}

function formatVarietyCount(count) {
  const mod100 = count % 100;
  const mod10 = count % 10;

  if (mod100 >= 11 && mod100 <= 14) return count + " сортов";
  if (mod10 === 1) return count + " сорт";
  if (mod10 >= 2 && mod10 <= 4) return count + " сорта";
  return count + " сортов";
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function loadSavedOrders() {
  try {
    const value = JSON.parse(localStorage.getItem(SAVED_ORDERS_KEY) || "[]");
    if (!Array.isArray(value)) return [];

    return value
      .filter((order) => order && order.orderId && Array.isArray(order.items))
      .slice(0, SAVED_ORDERS_LIMIT);
  } catch (error) {
    localStorage.removeItem(SAVED_ORDERS_KEY);
    return [];
  }
}

let savedOrders = loadSavedOrders();

function persistSavedOrders() {
  localStorage.setItem(
    SAVED_ORDERS_KEY,
    JSON.stringify(savedOrders.slice(0, SAVED_ORDERS_LIMIT)),
  );
}

function mergeSavedOrderItems(currentItems, addedItems) {
  const merged = new Map();

  [...currentItems, ...addedItems].forEach((item) => {
    const key = String(item.id);
    const previous = merged.get(key);

    if (previous) {
      previous.qty += Number(item.qty) || 0;
      if (item.title) previous.title = item.title;
      if (Number.isFinite(Number(item.price))) previous.price = Number(item.price);
    } else {
      merged.set(key, {
        id: item.id,
        title: String(item.title || ""),
        price: Number(item.price) || 0,
        qty: Number(item.qty) || 0,
      });
    }
  });

  return Array.from(merged.values()).filter((item) => item.qty > 0);
}

function saveOrderSnapshot(snapshot) {
  const orderId = String(snapshot.orderId || "").trim();
  if (!orderId) return;

  const requestId = String(snapshot.clientRequestId || "").trim();
  const existingIndex = savedOrders.findIndex(
    (order) => String(order.orderId) === orderId,
  );

  let nextOrder = {
    schemaVersion: 2,
    seasonId: String(snapshot.seasonId || ""),
    orderId,
    title: String(snapshot.title || "ЗАКАЗ " + orderId),
    mode: snapshot.mode === "addon" ? "addon" : "normal",
    orderLabel: String(snapshot.orderLabel || ""),
    name: String(snapshot.name || ""),
    phone: String(snapshot.phone || ""),
    pickup: String(snapshot.pickup || ""),
    createdAt: snapshot.createdAt || new Date().toISOString(),
    dateLabel: String(snapshot.dateLabel || ""),
    total: Number(snapshot.total) || 0,
    totalItems: Number(snapshot.totalItems) || 0,
    items: (snapshot.items || []).map((item) => ({
      id: item.id,
      title: String(item.title || ""),
      price: Number(item.price) || 0,
      qty: Number(item.qty) || 0,
    })),
    requestIds: requestId ? [requestId] : [],
  };

  if (existingIndex !== -1) {
    const existing = savedOrders[existingIndex];
    const requestIds = Array.isArray(existing.requestIds)
      ? existing.requestIds.map(String)
      : [];

    if (requestId && requestIds.includes(requestId)) return;

    if (nextOrder.mode === "addon") {
      nextOrder = {
        ...existing,
        ...nextOrder,
        title: existing.title || "ЗАКАЗ " + orderId,
        total: (Number(existing.total) || 0) + nextOrder.total,
        totalItems: (Number(existing.totalItems) || 0) + nextOrder.totalItems,
        items: mergeSavedOrderItems(existing.items || [], nextOrder.items),
        requestIds: requestId
          ? Array.from(new Set([...requestIds, requestId]))
          : requestIds,
      };
    }

    savedOrders.splice(existingIndex, 1);
  }

  savedOrders.unshift(nextOrder);
  savedOrders = savedOrders.slice(0, SAVED_ORDERS_LIMIT);
  persistSavedOrders();
  renderSavedOrdersSummary();
}

function createClientRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2) +
    "-" +
    Math.random().toString(36).slice(2)
  );
}

function getOrderRequestSignature(payload) {
  return JSON.stringify({
    name: payload.name,
    phone: payload.phone,
    pickup: payload.pickup,
    mode: payload.mode,
    selectedOrderId: payload.selectedOrderId || "",
    selectedOrderColumn: payload.selectedOrderColumn || "",
    orderLabel: payload.orderLabel || "",
    items: (payload.items || [])
      .map((item) => ({ id: String(item.id), qty: Number(item.qty) || 0 }))
      .sort((a, b) => a.id.localeCompare(b.id, "ru", { numeric: true })),
  });
}

function readPendingOrderRequest() {
  try {
    const pending = JSON.parse(
      localStorage.getItem(PENDING_ORDER_REQUEST_KEY) || "null",
    );

    return pending && pending.id ? pending : null;
  } catch (error) {
    localStorage.removeItem(PENDING_ORDER_REQUEST_KEY);
    return null;
  }
}

function getPendingOrderPayload(pending) {
  if (!pending) return null;

  if (pending.payload && typeof pending.payload === "object") {
    return pending.payload;
  }

  try {
    const payload = JSON.parse(String(pending.signature || ""));
    return payload && typeof payload === "object" ? payload : null;
  } catch (error) {
    return null;
  }
}

function getComparableOrderItems(items) {
  return (items || [])
    .map((item) => ({ id: String(item.id), qty: Number(item.qty) || 0 }))
    .filter((item) => item.id && item.qty > 0)
    .sort((a, b) => a.id.localeCompare(b.id, "ru", { numeric: true }));
}

function normalizeComparablePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function getRetryablePendingOrderRequest(phone, items) {
  const pending = readPendingOrderRequest();
  const payload = getPendingOrderPayload(pending);

  if (!pending || !payload) return null;
  if (
    normalizeComparablePhone(payload.phone) !== normalizeComparablePhone(phone)
  ) {
    return null;
  }

  const pendingItems = JSON.stringify(getComparableOrderItems(payload.items));
  const currentItems = JSON.stringify(getComparableOrderItems(items));

  return pendingItems === currentItems ? { ...pending, payload } : null;
}

function getOrCreateClientRequestId(payload) {
  const signature = getOrderRequestSignature(payload);

  const pending = readPendingOrderRequest();
  if (pending && pending.signature === signature) {
    return String(pending.id);
  }

  const id = createClientRequestId();
  localStorage.setItem(
    PENDING_ORDER_REQUEST_KEY,
    JSON.stringify({
      id,
      signature,
      payload: JSON.parse(signature),
      createdAt: new Date().toISOString(),
    }),
  );
  return id;
}

function clearClientRequestId(requestId) {
  try {
    const pending = JSON.parse(
      localStorage.getItem(PENDING_ORDER_REQUEST_KEY) || "null",
    );

    if (!pending || String(pending.id) === String(requestId)) {
      localStorage.removeItem(PENDING_ORDER_REQUEST_KEY);
    }
  } catch (error) {
    localStorage.removeItem(PENDING_ORDER_REQUEST_KEY);
  }
}
function getClientLookupUrl(phone, requestTime = Date.now()) {
  return (
    CATALOG_API_URL +
    "?phone=" + encodeURIComponent(phone) +
    "&_=" + encodeURIComponent(String(requestTime))
  );
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    return await response.json();
  } catch (error) {
    if (error && error.name === "AbortError") {
      const timeoutError = new Error("Сервер отвечает слишком долго");
      timeoutError.code = "REQUEST_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function readCatalogCache(allowExpired = false) {
  try {
    const cached = JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY) || "null");
    if (!cached || !cached.savedAt || !cached.data) return null;

    const isFresh = Date.now() - cached.savedAt < CATALOG_CACHE_TTL;
    return isFresh || allowExpired ? cached.data : null;
  } catch (error) {
    localStorage.removeItem(CATALOG_CACHE_KEY);
    return null;
  }
}

function writeCatalogCache(data) {
  try {
    if (isSeasonClosedResponse(data)) {
      localStorage.removeItem(CATALOG_CACHE_KEY);
      return;
    }

    localStorage.setItem(
      CATALOG_CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), data }),
    );
  } catch (error) {
    console.warn("Каталог не удалось сохранить в кэш", error);
  }
}

async function loadCatalogData({ forceNetwork = false } = {}) {
  if (!forceNetwork) {
    const freshCache = readCatalogCache();
    if (freshCache) {
      catalogLastLoadSource = "fresh-cache";
      return freshCache;
    }
  }

  try {
    const refreshUrl = forceNetwork
      ? `${CATALOG_API_URL}?refresh=${Date.now()}`
      : CATALOG_API_URL;
    const data = await fetchJsonWithTimeout(
      refreshUrl,
      forceNetwork ? { cache: "no-store" } : {},
      CATALOG_REQUEST_TIMEOUT,
    );
    catalogLastLoadSource = "network";
    writeCatalogCache(data);
    return data;
  } catch (error) {
    if (forceNetwork) throw error;

    const fallbackCache = readCatalogCache(true);
    if (fallbackCache) {
      catalogLastLoadSource = "fallback-cache";
      return fallbackCache;
    }
    throw error;
  }
}

/* ELEMENTS */

const catalog = document.getElementById("catalog");

const cartItems = document.getElementById("cartItems");

const sheetItems = document.getElementById("sheetItems");

const cartModal = document.getElementById("cartModal");

const checkoutModal = document.getElementById("checkoutModal");

const sheetModal = document.getElementById("sheetModal");

const popup = document.getElementById("popup");

const popupBox = document.querySelector(".popup-box");

const cartBox = document.querySelector(".cart-box");

const checkoutBox = document.querySelector(".checkout-box");

const sheetBox = document.querySelector(".sheet-box");

const accessibleDialogs = [
  "cartModal",
  "checkoutModal",
  "clientModal",
  "orderSelectModal",
  "orderLabelModal",
  "savedOrdersModal",
  "sheetModal",
  "popup",
]
  .map((id) => document.getElementById(id))
  .filter(Boolean);

const dialogFocusReturn = new WeakMap();
let activeAccessibleDialog = null;

function isDialogVisible(dialog) {
  return !dialog.hidden && getComputedStyle(dialog).display !== "none";
}

function getTopVisibleDialog() {
  return accessibleDialogs.filter(isDialogVisible).at(-1) || null;
}

function getDialogFocusables(dialog) {
  return Array.from(
    dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), [href], [tabindex]:not([tabindex="-1"]), [role="button"]',
    ),
  ).filter((element) => {
    const style = getComputedStyle(element);
    return !element.hidden && style.display !== "none" && style.visibility !== "hidden";
  });
}

function getPreferredDialogFocus(dialog) {
  const preferredById = {
    cartModal: "cartBackBtn",
    checkoutModal: "clientName",
    clientModal: "newOrderBtn",
    orderSelectModal: "closeOrderSelectBtn",
    orderLabelModal: "orderLabelInput",
    savedOrdersModal: "closeSavedOrdersBtn",
    sheetModal: "saveBtn",
    popup: "popupBack",
  };

  const preferred = document.getElementById(preferredById[dialog.id]);
  if (preferred && getComputedStyle(preferred).display !== "none") return preferred;
  return getDialogFocusables(dialog)[0] || dialog;
}

function syncDialogAccessibility() {
  const topDialog = getTopVisibleDialog();

  accessibleDialogs.forEach((dialog) => {
    dialog.setAttribute("aria-hidden", isDialogVisible(dialog) ? "false" : "true");
  });

  if (topDialog === activeAccessibleDialog) return;

  const previousDialog = activeAccessibleDialog;
  activeAccessibleDialog = topDialog;

  if (topDialog) {
    if (!dialogFocusReturn.has(topDialog)) {
      dialogFocusReturn.set(topDialog, document.activeElement);
    }

    requestAnimationFrame(() => getPreferredDialogFocus(topDialog)?.focus());
    return;
  }

  if (previousDialog) {
    const returnTarget = dialogFocusReturn.get(previousDialog);
    dialogFocusReturn.delete(previousDialog);
    const fallback = document.getElementById("openCartBtn");
    requestAnimationFrame(() => {
      const target = returnTarget && document.contains(returnTarget)
        ? returnTarget
        : fallback;
      target?.focus();
    });
  }
}

function closeTopDialogFromKeyboard(dialog) {
  if (dialog.id === "cartModal") document.getElementById("cartBackBtn").click();
  else if (dialog.id === "checkoutModal") document.getElementById("checkoutBackBtn").click();
  else if (dialog.id === "popup") document.getElementById("popupBack").click();
  else if (dialog.id === "savedOrdersModal") document.getElementById("closeSavedOrdersBtn").click();
  else if (dialog.id === "orderSelectModal") document.getElementById("closeOrderSelectBtn").click();
  else if (dialog.id === "orderLabelModal") document.getElementById("closeOrderLabelModal").click();
  else if (dialog.id === "clientModal") {
    dialog.style.display = "none";
    checkoutModal.style.display = "flex";
    lockBody();
  } else if (dialog.id === "sheetModal" && savedSheetMode) {
    document.getElementById("closeSavedOrderCardBtn").click();
  }
}

document.addEventListener("keydown", (event) => {
  const dialog = getTopVisibleDialog();
  if (!dialog) return;

  if (event.key === "Escape") {
    if (orderSending) return;
    event.preventDefault();
    closeTopDialogFromKeyboard(dialog);
    return;
  }

  if (event.key !== "Tab") return;
  const focusables = getDialogFocusables(dialog);

  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

const dialogObserver = new MutationObserver(syncDialogAccessibility);
accessibleDialogs.forEach((dialog) => {
  dialogObserver.observe(dialog, {
    attributes: true,
    attributeFilter: ["style", "hidden"],
  });
});
syncDialogAccessibility();

function isSeasonClosedResponse(data) {
  return Boolean(
    data &&
      !Array.isArray(data) &&
      (data.seasonClosed === true ||
        data.code === "SEASON_CLOSED" ||
        data.status === "season_closed"),
  );
}

function showCatalogSeasonClosed(fromSubmission = false) {
  document.getElementById("catalog").style.display = "none";
  document.getElementById("catalogClosed").style.display = "block";
  document.getElementById("loadingScreen")?.remove();
  document.querySelector(".header")?.classList.add("season-closed");
  document.getElementById("loadingBlocker")?.remove();

  [
    "cartModal",
    "checkoutModal",
    "clientModal",
    "orderSelectModal",
    "orderLabelModal",
  ].forEach((id) => {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = "none";
  });

  orderSending = false;
  unlockBody();

  if (fromSubmission) {
    showToast("Сезон закрыт. Заказ не был отправлен");
  }
}

function showCatalogSeasonOpen() {
  document.getElementById("catalog").style.removeProperty("display");
  document.getElementById("catalogClosed").style.display = "none";
  document.querySelector(".header")?.classList.remove("season-closed");
}

const catalogPdfLink = document.getElementById("catalogPdfLink");

catalogPdfLink?.addEventListener("click", (event) => {
  if (catalogPdfLink.getAttribute("href") === "#") {
    event.preventDefault();
    showToast("PDF-каталог будет добавлен позже");
  }
});

/* CART */

let cart = [];

let activeQuickFilter = "";
let catalogScrollPosition = 0;

const savedCart = localStorage.getItem("tomatoCart");

if (savedCart) {
  try {
    const parsedCart = JSON.parse(savedCart);
    cart = Array.isArray(parsedCart) ? parsedCart : [];
  } catch (error) {
    localStorage.removeItem("tomatoCart");
  }
}

function getCartQuantity(productId) {
  const item = cart.find((cartItem) => String(cartItem.id) === String(productId));
  return item ? Number(item.qty) || 0 : 0;
}

function changeCartQuantity(productId, delta) {
  const index = cart.findIndex(
    (item) => String(item.id) === String(productId),
  );

  if (index === -1) return false;

  cart[index].qty = Math.max(0, (Number(cart[index].qty) || 0) + delta);

  if (cart[index].qty === 0) {
    cart.splice(index, 1);
  }

  updateCart();
  return true;
}

function syncProductCardsFromCart() {
  document.querySelectorAll(".product").forEach((card) => {
    const inCart = getCartQuantity(card.dataset.productId);
    const button = card.querySelector(".add-btn");
    const stamp = card.querySelector(".cart-stamp");

    if (!button || card.classList.contains("out-of-stock")) return;

    card.classList.toggle("in-cart", inCart > 0);
    button.classList.remove("added");
    button.textContent = inCart > 0 ? "+ Ещё" : "Добавить";
    button.setAttribute(
      "aria-label",
      inCart > 0 ? "Добавить ещё. В корзине " + inCart : "Добавить в корзину",
    );

    if (stamp) {
      stamp.textContent = inCart > 0 ? "✓ Добавлено " + inCart : "";
      stamp.setAttribute("aria-hidden", inCart > 0 ? "false" : "true");
    }

    if (typeof card.setDisplayedQuantity === "function") {
      card.setDisplayedQuantity(inCart > 0 ? inCart : 1);
    }
  });
}

function getCatalogProductsFromResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.products)) return data.products;
  return null;
}

function getCatalogAvailabilityFromResponse(data) {
  const source = Array.isArray(data)
    ? data
    : data && Array.isArray(data.availability)
      ? data.availability
      : null;

  if (!source) return null;

  return new Map(
    source.map((item) => [String(item.id), item.available === true]),
  );
}

async function refreshCatalogAvailabilityInBackground() {
  if (document.hidden || orderSending || !catalogReady || !products.length) {
    return null;
  }
  if (catalogRefreshPromise) return catalogRefreshPromise;
  if (catalogAvailabilityRefreshPromise) {
    return catalogAvailabilityRefreshPromise;
  }

  catalogAvailabilityRefreshPromise = (async () => {
    const url =
      `${CATALOG_API_URL}?availability=1&_=${encodeURIComponent(Date.now())}`;
    const data = await fetchJsonWithTimeout(
      url,
      { cache: "no-store" },
      CATALOG_REQUEST_TIMEOUT,
    );

    if (isSeasonClosedResponse(data)) {
      catalogReady = false;
      showCatalogSeasonClosed();
      return null;
    }

    const availability = getCatalogAvailabilityFromResponse(data);
    if (!availability) {
      throw new Error("Сервер вернул некорректную доступность сортов");
    }

    const nextProducts = products.map((product) => {
      const id = String(product.id);
      return availability.has(id)
        ? { ...product, available: availability.get(id) }
        : product;
    });

    return applyCatalogProducts(nextProducts, {
      notify: true,
      preserveViewport: true,
    });
  })()
    .catch((error) => {
      console.warn("Доступность сортов не обновилась", error);
      return null;
    })
    .finally(() => {
      catalogAvailabilityRefreshPromise = null;
    });

  return catalogAvailabilityRefreshPromise;
}

function getCatalogSignature(list) {
  return JSON.stringify(
    (list || []).map((product) => [
      String(product.id),
      String(product.title || ""),
      String(product.description || ""),
      String(product.image || ""),
      Number(product.price) || 0,
      product.available === true,
      product.isHit === true,
      product.isNew === true,
    ]),
  );
}

function syncCartWithCatalog(nextProducts) {
  const freshById = new Map(
    nextProducts.map((product) => [String(product.id), product]),
  );
  const removed = [];
  const priceChanges = [];

  cart = cart.flatMap((item) => {
    const fresh = freshById.get(String(item.id));

    if (!fresh || fresh.available !== true) {
      removed.push(String(item.title || item.id));
      return [];
    }

    const previousPrice = Number(item.price) || 0;
    const nextPrice = Number(fresh.price) || 0;

    if (previousPrice !== nextPrice) {
      priceChanges.push({
        title: String(fresh.title || item.title || item.id),
        previousPrice,
        nextPrice,
      });
    }

    return [
      {
        ...fresh,
        qty: Math.max(1, Number(item.qty) || 1),
      },
    ];
  });

  updateCart();
  return { removed, priceChanges };
}

function notifyCatalogCartChanges({ removed, priceChanges }) {
  const messages = [];

  if (removed.length === 1) {
    messages.push(`Сорт «${removed[0]}» закончился и удалён из корзины`);
  } else if (removed.length > 1) {
    messages.push(`Закончились сорта и удалены из корзины: ${removed.length}`);
  }

  if (priceChanges.length === 1) {
    const change = priceChanges[0];
    messages.push(
      `Цена «${change.title}» обновилась: ` +
        `${change.previousPrice.toLocaleString("ru-RU")} → ` +
        `${change.nextPrice.toLocaleString("ru-RU")} ₽`,
    );
  } else if (priceChanges.length > 1) {
    messages.push(`Цены в корзине обновились: ${priceChanges.length}`);
  }

  if (messages.length) showToast(`🍅 ${messages.join(". ")}`);
}

function captureCatalogViewport() {
  const firstVisibleCard = Array.from(document.querySelectorAll(".product")).find(
    (card) => {
      if (card.style.display === "none") return false;
      const rect = card.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    },
  );

  return {
    scrollY: window.scrollY,
    productId: firstVisibleCard?.dataset.productId || "",
    offsetTop: firstVisibleCard?.getBoundingClientRect().top || 0,
  };
}

function restoreCatalogViewport(viewport) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const anchor = viewport.productId
        ? Array.from(document.querySelectorAll(".product")).find(
            (card) => card.dataset.productId === viewport.productId,
          )
        : null;

      if (anchor && anchor.style.display !== "none") {
        const delta = anchor.getBoundingClientRect().top - viewport.offsetTop;
        window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: "auto" });
        return;
      }

      window.scrollTo({ top: viewport.scrollY, behavior: "auto" });
    });
  });
}

function applyCatalogProducts(
  nextProducts,
  { notify = false, preserveViewport = false } = {},
) {
  const previousSignature = getCatalogSignature(products);
  const nextSignature = getCatalogSignature(nextProducts);
  const viewport = preserveViewport ? captureCatalogViewport() : null;

  products = nextProducts;
  const cartChanges = syncCartWithCatalog(products);
  const catalogChanged = previousSignature !== nextSignature;

  if (catalogChanged || !catalog.children.length) {
    renderProducts();
    applyProductSearch();
  }

  if (viewport && catalogChanged) restoreCatalogViewport(viewport);
  if (notify) notifyCatalogCartChanges(cartChanges);

  return {
    catalogChanged,
    availableCount: products.filter((product) => product.available === true).length,
    ...cartChanges,
  };
}

/* PRODUCTS */

function fitProductTitles(root = document) {
  root.querySelectorAll(".product-title").forEach((title) => {
    const card = title.closest(".product");
    if (card && card.style.display === "none") return;
    title.style.removeProperty("font-size");

    const availableWidth = title.clientWidth;
    const words = title.querySelectorAll(".product-title-word");

    if (!availableWidth || !words.length) return;

    const baseSize = Number.parseFloat(getComputedStyle(title).fontSize) || 16;
    let widestWord = 0;

    words.forEach((word) => {
      widestWord = Math.max(widestWord, word.getBoundingClientRect().width);
    });

    if (widestWord <= availableWidth) return;

    const fittedSize = Math.max(
      11.5,
      Math.floor((baseSize * availableWidth * 0.96) / widestWord * 10) / 10,
    );

    title.style.setProperty("font-size", fittedSize + "px", "important");
  });
}

let titleFitObserver = null;

function observeProductTitleFitting() {
  if (titleFitObserver) {
    titleFitObserver.disconnect();
  }

  if (!("IntersectionObserver" in window)) {
    fitProductTitles();
    return;
  }

  titleFitObserver = new IntersectionObserver(
    (entries, observer) => {
      const cards = entries
        .filter((entry) => entry.isIntersecting)
        .map((entry) => entry.target);

      if (!cards.length) return;

      requestAnimationFrame(() => {
        cards.forEach((card) => {
          fitProductTitles(card);

          // Карточка уже обработана — больше её не пересчитываем
          observer.unobserve(card);
        });
      });
    },
    {
      rootMargin: "250px 0px",
    },
  );

  document.querySelectorAll(".product").forEach((card) => {
    titleFitObserver.observe(card);
  });
}

let titleResizeTimer = null;

window.addEventListener("resize", () => {
  clearTimeout(titleResizeTimer);

  titleResizeTimer = setTimeout(() => {
    fitProductTitles();
  }, 100);
});

const catalogImageWarmers = new Set();

function testProductImageHost(productList, timeoutMs = 5000) {
  const testImageUrl = String(
    productList?.find((product) => product?.image)?.image || ""
  ).trim();

  if (!testImageUrl) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const image = new Image();
    let finished = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;

      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;

      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);

    image.onload = () => finish(true);
    image.onerror = () => finish(false);

    const url = new URL(testImageUrl, window.location.href);

    // Реальная проверка сети, а не старой картинки из кэша
    url.searchParams.set("__vpn_test", Date.now().toString());

    image.src = url.href;
  });
}

function waitForInitialProductImages(limit = 24, timeoutMs = 8000) {
  const allImages = Array.from(
    document.querySelectorAll(".product-image img"),
  );
  const images = allImages.filter((image, index) => {
    if (index < limit) return true;

    const rect = image.getBoundingClientRect();
    return rect.bottom >= -window.innerHeight && rect.top <= window.innerHeight * 2;
  });

  if (!images.length) {
    return Promise.resolve({ total: 0, loaded: 0, failed: 0, timedOut: false });
  }

  const waitForImage = (image) => {
    const decodeImage = async () => {
      if (typeof image.decode === "function") {
        await image.decode().catch(() => undefined);
      }
      return image.naturalWidth > 0;
    };

    if (image.complete) return decodeImage();

    return new Promise((resolve) => {
      const finish = () => {
        image.removeEventListener("load", finish);
        image.removeEventListener("error", finish);
        resolve(image.naturalWidth > 0);
      };

      image.addEventListener("load", finish, { once: true });
      image.addEventListener("error", finish, { once: true });
    }).then((loaded) => loaded && decodeImage());
  };

  const completed = Promise.all(images.map(waitForImage)).then((results) => ({
    total: images.length,
    loaded: results.filter(Boolean).length,
    failed: results.filter((loaded) => !loaded).length,
    timedOut: false,
  }));

  const timedOut = new Promise((resolve) => {
    setTimeout(() => {
      const loaded = images.filter(
        (image) => image.complete && image.naturalWidth > 0,
      ).length;
      resolve({
        total: images.length,
        loaded,
        failed: images.length - loaded,
        timedOut: true,
      });
    }, timeoutMs);
  });

  return Promise.race([completed, timedOut]);
}

function showCatalogConnectionError(message) {
  const loadingScreen = document.getElementById("loadingScreen");
  const loadingText = loadingScreen?.querySelector(".loading-text");
  const loadingTomato = document.getElementById("loadingTomato");

  if (loadingScreen && loadingText) {
    loadingScreen.classList.remove("is-finishing");
    loadingText.classList.add("loading-error");
    loadingText.innerHTML =
      "<strong>Нет связи</strong>" +
      `<span>${escapeHtml(message)}</span>` +
      '<button type="button" onclick="location.reload()">Повторить</button>';

    if (loadingTomato) {
      loadingTomato.src = "./tomato/tomato-angry.png";
    }
    return;
  }

  catalog.innerHTML =
    '<div class="catalog-load-error">' +
      '<div class="catalog-load-error-icon">🍅</div>' +
      "<strong>Нет связи</strong>" +
      `<span>${escapeHtml(message)}</span>` +
      '<button type="button" onclick="location.reload()">Повторить</button>' +
    "</div>";
}

function warmRemainingProductImages(startIndex = 24, concurrency = 10) {
  const urls = Array.from(document.querySelectorAll(".product-image img"))
    .slice(startIndex)
    .map((image) => image.currentSrc || image.src)
    .filter(Boolean);

  let nextIndex = 0;

  const loadNext = () => {
    if (nextIndex >= urls.length) return;

    const image = new Image();
    const url = urls[nextIndex++];
    catalogImageWarmers.add(image);

    const finish = () => {
      catalogImageWarmers.delete(image);
      loadNext();
    };

    image.decoding = "async";
    image.onload = finish;
    image.onerror = finish;
    image.src = url;
  };

  for (let index = 0; index < Math.min(concurrency, urls.length); index++) {
    loadNext();
  }
}

function renderProducts() {
  const fragment = document.createDocumentFragment();
  const displayedProducts = products;

  displayedProducts.forEach((product, productIndex) => {
    const isHit = product.isHit || product.title.includes("[hit]");

    const isNew = product.isNew || product.title.includes("[new]");

    const cleanTitle = product.title;

    const card = document.createElement("div");

    card.className = "product";

    if (productIndex < 8) {
      card.classList.add("product-enter");
      card.style.setProperty("--enter-delay", productIndex * 35 + "ms");
    }

    card.dataset.productId = String(product.id);
    card.dataset.available = product.available === true ? "true" : "false";
    card.dataset.isHit = isHit ? "true" : "false";
    card.dataset.isNew = isNew ? "true" : "false";

    card.dataset.search = normalizeSearchText(`
${product.id}
#${product.id}
№${product.id}
${product.title}
${product.description}
${isHit ? "hit хит" : ""}
${isNew ? "new новинка" : ""}
${product.available === true ? "" : "нет в наличии недоступен"}
`);

    card.innerHTML = `

  <div class="product-number">
    ${escapeHtml(product.id)}
  </div>

  <div class="product-image">

  <img
    src="${escapeHtml(product.image)}"
    alt="${escapeHtml(product.title)}"
    width="104"
    height="116"
    loading="${productIndex < 24 ? "eager" : "lazy"}"
    fetchpriority="${productIndex < 4 ? "high" : "auto"}"
    decoding="async"
  >

</div>

  <div class="product-info">

   <div class="product-title">
  ${escapeHtml(cleanTitle)}
</div>

${isHit ? '<div class="badge-hit">🔥ХИТ</div>' : ""}

${isNew ? '<div class="badge-new">⭐НОВИНКА</div>' : ""}

${product.available === true ? "" : '<div class="badge-stock">Нет в наличии</div>'}

<div class="cart-stamp" aria-live="polite" aria-hidden="true"></div>
  </div>

  <div class="product-right">

    <div class="product-price">
      ${escapeHtml(product.price)} ₽
    </div>

    <div class="controls">

      <button class="minus" aria-label="Уменьшить количество">
        −
      </button>

      <span class="qty">

  <span class="qty-value">
    1
  </span>

</span>

      <button class="plus" aria-label="Увеличить количество">
        +
      </button>

    </div>

    <button class="add-btn">
      Добавить
    </button>

  </div>

`;

    const titleEl = card.querySelector(".product-title");
    const titleLength = String(product.title || "").length;
    const titleWords = String(product.title || "").trim().split(/\s+/);

    titleEl.replaceChildren();

    titleWords.forEach((wordText) => {
      const word = document.createElement("span");

      word.className = "product-title-word";
      word.textContent = wordText;
      titleEl.appendChild(word);
    });

    if (titleLength > 24) titleEl.classList.add("title-long");
    if (titleLength > 40) titleEl.classList.add("title-very-long");

    let qty = 1;

    let qtyAnimating = false;

    const qtyBubble = card.querySelector(".qty");

    const qtyText = card.querySelector(".qty-value");

    const addBtn = card.querySelector(".add-btn");

    const plusBtn = card.querySelector(".plus");

    const minusBtn = card.querySelector(".minus");

    card.setDisplayedQuantity = (value) => {
      qty = Math.max(1, Number(value) || 1);
      qtyText.textContent = String(qty);
    };

    /* PLUS */

    card.querySelector(".plus").addEventListener("click", (e) => {
      e.stopPropagation();
      press(e.currentTarget);
      vibrate(15);

      if (qtyAnimating) return;

      const cartQty = getCartQuantity(product.id);

      if (cartQty > 0) {
        qtyBubble.classList.add("qty-bounce");
        changeCartQuantity(product.id, 1);

        setTimeout(() => {
          qtyBubble.classList.remove("qty-bounce");
        }, 220);

        return;
      }

      qtyAnimating = true;

      qty++;

      const oldValue = qtyText.textContent;

      qtyText.innerHTML = `
  <span class="qty-inner old">
    ${oldValue}
  </span>

  <span class="qty-inner new">
    ${qty}
  </span>
`;

      qtyBubble.classList.add("qty-bounce");

      setTimeout(() => {
        qtyBubble.classList.remove("qty-bounce");

        qtyText.textContent = qty;

        qtyAnimating = false;
      }, 220);
    });

    /* MINUS */

    card.querySelector(".minus").addEventListener("click", (e) => {
      e.stopPropagation();
      press(e.currentTarget);
      vibrate(15);
      if (qtyAnimating) return;

      const cartQty = getCartQuantity(product.id);

      if (cartQty > 0) {
        qtyBubble.classList.add("qty-bounce");
        changeCartQuantity(product.id, -1);

        setTimeout(() => {
          qtyBubble.classList.remove("qty-bounce");
        }, 220);

        return;
      }

      qtyAnimating = true;

      if (qty > 1) {
        qty--;

        qtyText.innerHTML = `
  <span class="qty-inner new">
    ${qty}
  </span>
`;

        qtyBubble.classList.add("qty-bounce");

        setTimeout(() => {
          qtyBubble.classList.remove("qty-bounce");

          qtyText.textContent = qty;

          qtyAnimating = false;
        }, 220);
      } else {
        qtyAnimating = false;
      }
    });

    if (!product.available) {
      addBtn.textContent = "Добавить";

      qtyText.textContent = "0";

      addBtn.disabled = true;

      plusBtn.disabled = true;

      minusBtn.disabled = true;

      card.classList.add("out-of-stock");
      card.setAttribute("aria-disabled", "true");
    }
    /* ADD BUTTON */

    card.querySelector(".add-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      press(e.currentTarget);
      const cartQty = getCartQuantity(product.id);
      addToCart(product, cartQty > 0 ? 1 : qty);
      vibrate(15);
    });

    /* POPUP */

    card.addEventListener("click", (e) => {
      if (e.target.closest(".controls") || e.target.closest(".add-btn")) {
        return;
      }

      press(card);

      setTimeout(() => {
        popup.style.display = "flex";
        lockBody();
      }, 140);

      popupBox.classList.add("modal-open-soft");

      setTimeout(() => {
        popupBox.classList.remove("modal-open-soft");
      }, 300);

      document.getElementById("popupImage").src = product.image;

      document.getElementById("popupTitle").textContent = product.title;

      document.getElementById("popupDescription").textContent =
        product.description;
    });

    const img = card.querySelector(".product-image img");
    const imageBox = card.querySelector(".product-image");

    if (img && imageBox) {
      const showImage = () => {
        imageBox.classList.remove("image-failed");
        imageBox.classList.add("image-ready");
        img.classList.add("loaded");
      };
      const showImageFallback = () => {
        img.classList.remove("loaded");
        imageBox.classList.remove("image-ready");
        imageBox.classList.add("image-failed");
      };

      if (img.complete) {
        if (img.naturalWidth > 0) {
          showImage();
        } else {
          showImageFallback();
        }
      } else {
        img.addEventListener("load", showImage, { once: true });
        img.addEventListener("error", showImageFallback, { once: true });
      }
    }

    fragment.appendChild(card);
  });

  catalog.replaceChildren(fragment);

observeProductTitleFitting();
syncProductCardsFromCart();
}

function restoreCatalogAfterChat() {
  if (!catalog || catalog.children.length || !products.length) return false;

  renderProducts();
  applyProductSearch();
  return true;
}

window.restoreCatalogAfterChat = restoreCatalogAfterChat;

/* ADD TO CART */

function addToCart(product, qty) {
  const existing = cart.find((item) => {
    return String(item.id) === String(product.id);
  });

  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({
      ...product,
      qty,
    });
  }

  updateCart();

  tomatoClicks++;

  if (tomatoClicks % 2 === 0) {
    const random = Math.random();

    if (random < 0.6) {
      launchTomatoHeart();
    } else if (random < 0.9) {
      launchTomatoKiss();
    } else {
      launchTomatoCrown();
    }
  }
}

/* UPDATE CART */

function updateCart() {
  const totalItems = cart.reduce((sum, item) => {
    return sum + item.qty;
  }, 0);

  const totalPrice = cart.reduce((sum, item) => {
    return sum + item.price * item.qty;
  }, 0);

  const logoTomato = document.getElementById("logoTomato");

  const currentLevel = Math.floor(totalPrice / 300);

  if (currentLevel > tomatoLevel) {
    tomatoLevel = currentLevel;
  }

  document.getElementById("cartCount").textContent = `${totalItems} пак.`;

  const cartPrice = document.getElementById("cartPrice");
  const formattedTotalPrice = `${totalPrice.toLocaleString("ru-RU")} ₽`;
  const priceChanged = cartPrice.textContent.trim() !== formattedTotalPrice;

  cartPrice.textContent = formattedTotalPrice;

  if (priceChanged) {
    cartPrice.classList.remove("price-pop");

    void cartPrice.offsetWidth;

    cartPrice.classList.add("price-pop");
  }

  document.getElementById("cartFooterCount").textContent = `${totalItems} пак.`;

  document.getElementById("cartFooterPrice").textContent =
    `${totalPrice.toLocaleString("ru-RU")} ₽`;

  const checkoutBtn = document.getElementById("checkoutBtn");

  const isCartEmpty = cart.length === 0;
  checkoutBtn.disabled = isCartEmpty;
  checkoutBtn.classList.toggle("disabled-btn", isCartEmpty);
  checkoutBtn.setAttribute("aria-disabled", isCartEmpty ? "true" : "false");

  renderCart();
  syncProductCardsFromCart();

  if (activeQuickFilter === "added") {
    requestAnimationFrame(applyProductSearch);
  }

  localStorage.setItem("tomatoCart", JSON.stringify(cart));
}

/* RENDER CART */

function renderCart() {
  cartItems.innerHTML = "";

  cart.forEach((item) => {
    const div = document.createElement("div");

    div.className = "cart-item";

    div.innerHTML = `

      <div>
        ${escapeHtml(item.id)} ${escapeHtml(item.title)}
      </div>

      <div class="cart-controls">

        <button class="minus" aria-label="Уменьшить количество">
          −
        </button>

        <span class="cart-qty">
        ${Number(item.qty) || 0}
        </span>

        <button class="plus" aria-label="Увеличить количество">
          +
        </button>

      </div>

    `;

    /* PLUS */

    div.querySelector(".plus").addEventListener("click", () => {
      item.qty++;

      updateCart();
    });

    /* MINUS */

    div.querySelector(".minus").addEventListener("click", () => {
      item.qty--;

      if (item.qty <= 0) {
        cart = cart.filter((cartItem) => {
          return cartItem.id !== item.id;
        });
      }

      updateCart();
    });

    cartItems.appendChild(div);
  });
}

/* OPEN CART */

document.getElementById("openCartBtn").onclick = () => {
  vibrate(15);
  void refreshCatalogAvailabilityInBackground();

  catalogScrollPosition = window.scrollY;
  sessionStorage.setItem("tomatoCatalogScroll", String(catalogScrollPosition));

  lockBody();

  setTimeout(() => {
    cartModal.style.display = "flex";
  }, 110);

  cartBox.classList.add("modal-open-heavy");

  setTimeout(() => {
    cartBox.classList.remove("modal-open-heavy");
  }, 700);
};

/* CHECKOUT */

document.getElementById("checkoutBtn").onclick = () => {
  vibrate(20);
  void refreshCatalogAvailabilityInBackground();
  if (!foundClient) setCheckoutIdentityFieldsVisible(true);
  cartBox.classList.add("modal-hide");

  setTimeout(() => {
    cartModal.style.display = "none";

    unlockBody();

    cartBox.classList.remove("modal-hide");

    checkoutModal.style.display = "flex";
    lockBody();

    checkoutBox.classList.add("modal-open-medium");

    setTimeout(() => {
      checkoutBox.classList.remove("modal-open-medium");
    }, 650);
  }, 180);
};

async function submitOrder(options = {}) {

  if (orderSending) return;

  orderSending = true;

  const btn = document.getElementById("createOrderBtn");
  const orderSubmitError = document.getElementById("orderSubmitError");

  if (orderSubmitError) orderSubmitError.hidden = true;

  const nameInput = document.getElementById("clientName");

  const phoneInput = document.getElementById("clientPhone");

  const pickupPoint = document.getElementById("pickupPoint");

  if (foundClient) {
    setCheckoutIdentityFieldsVisible(false);
  }

  btn.classList.add("loading-btn");
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");

  btn.innerHTML = '<div class="loading-spinner"></div>';

  const blocker = document.createElement("div");

blocker.id = "loadingBlocker";

blocker.style.cssText = `
position:fixed;
inset:0;
z-index:999999;
background:transparent;
background: rgba(0,0,0,0.02);
touch-action:none;
`;

document.body.appendChild(blocker);

  const pendingRequest = options.pendingRequest || null;
  const pendingPayload = getPendingOrderPayload(pendingRequest);

  let name = pendingPayload
    ? String(pendingPayload.name || "").trim()
    : nameInput.value.trim();

  let phone = pendingPayload
    ? String(pendingPayload.phone || "").trim()
    : phoneInput.value.trim();

  const selectedPickupName =
    pickupPoint.selectedOptions[0]?.textContent.trim() || "";
  let pickupText = pendingPayload
    ? String(pendingPayload.pickup || "").trim()
    : pickupRequiresAddress()
      ? `${selectedPickupName} • ${pvzAddress.value.trim()}`
      : selectedPickupName;

  if (foundClient && !pendingPayload) {
  name = foundClient.name;

  phone = formatPhone(foundClient.phone);

  pickupText = foundClient.pickup;
}

  const payloadItems = pendingPayload ? pendingPayload.items || [] : cart;
  const submittedItems = payloadItems.map((payloadItem) => {
    const cartItem = cart.find(
      (item) => String(item.id) === String(payloadItem.id),
    );

    return {
      id: payloadItem.id,
      title: cartItem ? cartItem.title : String(payloadItem.title || ""),
      price: cartItem
        ? Number(cartItem.price) || 0
        : Number(payloadItem.price) || 0,
      qty: Number(payloadItem.qty) || 0,
    };
  });

  const totalPrice = submittedItems.reduce((sum, item) => {
    return sum + item.price * item.qty;
  }, 0);

  const totalItems = submittedItems.reduce((sum, item) => {
    return sum + item.qty;
  }, 0);

  const submittedOrderLabel = pendingPayload
    ? String(pendingPayload.orderLabel || "")
    : orderLabel;

  const orderPayload = pendingPayload ? { ...pendingPayload } : {
    name,
    phone,
    pickup: pickupText,
    mode: orderMode,
    selectedOrderColumn,
    selectedOrderId,
    orderLabel,
    items: submittedItems.map((item) => ({
      id: item.id,
      qty: item.qty,
    })),
    total: totalPrice,
  };

  orderPayload.items = submittedItems.map((item) => ({
    id: item.id,
    qty: item.qty,
  }));
  orderPayload.total = totalPrice;

  const clientRequestId = pendingRequest
    ? String(pendingRequest.id)
    : getOrCreateClientRequestId(orderPayload);
  orderPayload.clientRequestId = clientRequestId;

  fetchJsonWithTimeout(CATALOG_API_URL, {
    method: "POST",
    body: JSON.stringify(orderPayload),
  }, ORDER_SUBMIT_REQUEST_TIMEOUT)
    .then((result) => {
      if (isSeasonClosedResponse(result)) {
        const seasonError = new Error("Сезон закрыт");
        seasonError.code = "SEASON_CLOSED";
        throw seasonError;
      }

      if (!result || !result.success || !result.orderId) {
        throw new Error(
          result && result.error
            ? String(result.error)
            : "Сервер не вернул номер заказа",
        );
      }

      if (result.mode === "addon" || result.mode === "normal") {
        orderMode = result.mode;
      }

      const orderId = result.orderId;
      const serverAddedTotal = Number(result.addedTotal ?? result.total);
      const confirmedTotalPrice = Number.isFinite(serverAddedTotal)
        ? serverAddedTotal
        : totalPrice;
      const serverOrderTotal = Number(result.orderTotal);
      const confirmedOrderTotal = Number.isFinite(serverOrderTotal)
        ? serverOrderTotal
        : orderMode === "addon"
          ? null
          : confirmedTotalPrice;

      lastOrderId = orderId;
      const copyOrderIdBtn = document.getElementById("copyOrderIdBtn");
      copyOrderIdBtn.style.display = "inline-flex";
      copyOrderIdBtn.textContent = "Скопировать " + orderId;
      const today = new Date();

      document.getElementById("clientModal").style.display = "none";
      unlockBody();

      document.getElementById("orderSelectModal").style.display = "none";
      unlockBody();

      const orderNumber = result.orderNumber || (foundClient ? foundClient.orderCount + 1 : 1);

      document.getElementById("sheetTitle").textContent =
        orderMode === "addon"
          ? "ДОЗАКАЗ " + orderId
          : "ЗАКАЗ " + orderId;

      document.getElementById("sheetDate").innerHTML =
        today.toLocaleDateString("ru-RU");

      document.getElementById("sheetOrderLabel").textContent = submittedOrderLabel;


      document.getElementById("sheetClient").innerHTML = `
    ${escapeHtml(name)}
    <br>
    ${escapeHtml(phone)}

    <div class="sheet-pickup">
      ${escapeHtml(pickupText)}
    </div>
  `;

      setSheetAddonSummary({
        isAddon: orderMode === "addon",
        addedTotal: confirmedTotalPrice,
        orderTotal: confirmedOrderTotal,
      });

      document.getElementById("sheetTotalItems").textContent = `${totalItems} п`;

      try {
        saveOrderSnapshot({
          orderId,
          title: document.getElementById("sheetTitle").textContent,
          mode: orderMode,
          orderLabel: submittedOrderLabel,
          name,
          phone,
          pickup: pickupText,
          createdAt: today.toISOString(),
          dateLabel: today.toLocaleDateString("ru-RU"),
          total: confirmedTotalPrice,
          totalItems,
          items: submittedItems,
          clientRequestId,
          seasonId: result.seasonId || "",
        });
      } catch (storageError) {
        console.error("Не удалось сохранить локальную копию заказа", storageError);
      }

      localStorage.removeItem(ORDER_DRAFT_KEY);

      localStorage.setItem(
        "pendingSheet",
        JSON.stringify({
          title: document.getElementById("sheetTitle").textContent,
          date: today.toLocaleDateString("ru-RU"),
          client: `
      ${escapeHtml(name)}
      <br>
      ${escapeHtml(phone)}
      <div class="sheet-pickup">
        ${escapeHtml(pickupText)}
      </div>
    `,
          total: `${confirmedTotalPrice.toLocaleString("ru-RU")} ₽`,
          totalItems: `${totalItems} п`,
          orderId: orderId,
          mode: orderMode,
          addedTotal: confirmedTotalPrice,
          orderTotal: confirmedOrderTotal,
          items: submittedItems,
        }),
      );

      sheetItems.innerHTML = "";

      sheetItems.innerHTML = cart
        .map((item) => {
          const shortTitle =
            item.title.length > 14
              ? item.title.slice(0, 12) + ".."
              : item.title;

          return `
  <div class="sheet-chip">

    <span class="sheet-name">
      ${escapeHtml(item.id)} ${escapeHtml(shortTitle)}
    </span>

    <span class="sheet-qty">
      ${Number(item.qty) || 0}п
    </span>

  </div>
`;
        })
        .join("");

      btn.innerHTML = `
  <div class="success-check">
    ✓
  </div>
`;
      navigator.vibrate?.([80, 50, 80]);
      clearClientRequestId(clientRequestId);
      setTimeout(() => {
        document.getElementById("loadingBlocker")?.remove();

        checkoutModal.style.display = "none";

        unlockBody();

        sheetModal.style.display = "flex";
        catalog.innerHTML = "";
        document.getElementById("saveBtn").style.display = "none";

        lockBody();

        cart = [];

        updateCart();

       localStorage.removeItem("tomatoCart");

        savedSheetMode = false;
        document.getElementById("savedSheetActions").hidden = true;
        document.querySelector(".sheet-message").style.display = "block";
        document.querySelector(".sheet-buttons").style.display = "flex";

        document.body.style.overflow = "hidden";

        if (
          typeof window.confetti === "function" &&
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          const duration = 800;
          const end = Date.now() + duration;
          const colors = ["#0e8f6c", "#ffd76d", "#9b1801", "#ffffff"];

          (function frame() {
            window.confetti({
              particleCount: 4,
              angle: 60,
              spread: 70,
              origin: { x: 0 },
              colors,
            });

            window.confetti({
              particleCount: 4,
              angle: 120,
              spread: 70,
              origin: { x: 1 },
              colors,
            });

            if (Date.now() < end) {
              requestAnimationFrame(frame);
            }
          })();
        }
        const pngToken = ++sheetGenerationToken;
        const savedOrderForPng = savedOrders.find(
          (order) => String(order.orderId) === String(orderId),
        );
        createSheetPngFile({
          orderId,
          cacheKey: getSavedOrderPngCacheKey(savedOrderForPng),
          delayMs: 900,
          token: pngToken,
        })
          .then((file) => {
            if (!file || pngToken !== sheetGenerationToken) return;
            generatedFile = file;
            document.getElementById("saveBtn").style.display = "flex";
          })
          .catch((error) => {
            console.error("Не удалось подготовить карточку заказа", error);
            if (pngToken === sheetGenerationToken) {
              showToast("Заказ создан, но карточку не удалось подготовить");
            }
          });
      }, 900);
    })

    .catch((err) => {

      console.error("Не удалось создать заказ", err);
      document.getElementById("loadingBlocker")?.remove();

      if (err && err.code === "SEASON_CLOSED") {
        showCatalogSeasonClosed(true);
        return;
      }

      orderSending = false;

      btn.classList.remove("loading-btn");
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.innerHTML = "Повторить";

      if (orderSubmitError) {
        orderSubmitError.textContent =
          err && err.code === "REQUEST_TIMEOUT"
            ? "Сервер отвечает дольше обычного. Корзина сохранена — нажмите «Повторить»."
            : "Сервер не ответил. Корзина сохранена — нажмите «Повторить».";
        orderSubmitError.hidden = false;
      }

      showToast(
        err && err.code === "REQUEST_TIMEOUT"
          ? "⚠️ Ответ задерживается. Корзина сохранена"
          : "⚠️ Google временно не ответил. Корзина сохранена",
      );
    });
}

/* CREATE ORDER */

document.getElementById("createOrderBtn").onclick = async () => {
  if (orderSending) return;
  if (!validateCheckoutForm()) return;

  const phone = document.getElementById("clientPhone").value.trim().replace(/\D/g, "");
  const pendingRequest = getRetryablePendingOrderRequest(phone, cart);

  if (pendingRequest) {
    submitOrder({ pendingRequest });
    return;
  }

  orderSending = true;

  const btn = document.getElementById("createOrderBtn");
  const orderSubmitError = document.getElementById("orderSubmitError");

  if (orderSubmitError) orderSubmitError.hidden = true;

  btn.classList.add("loading-btn");
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");

  btn.innerHTML = '<div class="loading-spinner"></div>';

  const nameInput = document.getElementById("clientName");

  const phoneInput = document.getElementById("clientPhone");

  const pickupPoint = document.getElementById("pickupPoint");


  try {
    const data = await fetchJsonWithTimeout(
      getClientLookupUrl(phone),
      { cache: "no-store" },
      10000,
    );

    if (isSeasonClosedResponse(data)) {
      showCatalogSeasonClosed(true);
      return;
    }

    if (
      !data ||
      Array.isArray(data) ||
      data.lookupVersion !== CATALOG_CLIENT_LOOKUP_VERSION
    ) {
      const versionError = new Error(
        "Сервер поиска клиентов не обновлён"
      );
      versionError.code = "CLIENT_LOOKUP_VERSION_MISMATCH";
      throw versionError;
    }

    if (data.found || data["Найдено"]) {
      orderSending = false;

      foundClient = data;

      clientOrders = data.orders || [];

      document.getElementById("clientFoundInfo").innerHTML = `

  <div class="client-row">
  <span class="client-icon person-icon"></span>
  <span>${escapeHtml(data.name)}</span>
</div>

<div class="client-row">
  <span class="client-icon phone-icon"></span>
  <span>${escapeHtml(formatPhone(data.phone))}</span>
</div>

<div class="client-row">
  <span class="client-icon map-icon"></span>
  <span>${escapeHtml(data.pickup)}</span>
</div>

  <div class="client-orders">

  <span
    class="client-icon order-icon"
  ></span>

  Предыдущих заказов:
  ${data.orderCount}

</div>

  <div class="client-next-order">

    <div class="client-next-order-title">
      Будет создан:
    </div>

    <div class="client-next-order-number">
      ЗАКАЗ ${data.orderCount + 1}
    </div>

  </div>

`;
      document.getElementById("clientModal").style.display = "flex";
      lockBody();
      btn.classList.remove("loading-btn");

      btn.disabled = false;
  btn.removeAttribute("aria-busy");

  btn.innerHTML = "Создать заказ";
      return;
    }
  } catch (err) {
    console.error("Не удалось проверить клиента", err);

    orderSending = false;
    btn.classList.remove("loading-btn");
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.innerHTML = "Создать заказ";

    showToast(
      err && err.code === "CLIENT_LOOKUP_VERSION_MISMATCH"
        ? "⚠️ Сервер каталога не обновлён. Заказ не отправлен"
        : "⚠️ Не удалось проверить номер. Повторите ещё раз",
    );
    return;
  }

  orderMode = "normal";

  orderSending = false;

  submitOrder();

  return;
};

/* SAVE */

function downloadOrderPng(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function shareOrderCardToMax_() {
  if (!generatedFile) {
    showToast("⏳ Карточка ещё создаётся");
    return;
  }

  const hour = new Date().getHours();
  let greeting;

  if (hour >= 5 && hour <= 10) {
    greeting = "Доброе утро";
  } else if (hour >= 11 && hour <= 17) {
    greeting = "Добрый день";
  } else if (hour >= 18 && hour <= 22) {
    greeting = "Добрый вечер";
  } else {
    greeting = "Доброй ночи";
  }

  const shareData = {
    files: [generatedFile],
    title: "Заказ по семенам томатов",
    text: `${greeting}! Направляю заказ по семенам томатов для подтверждения и оплаты. 🍅`,
  };

  try {
    if (
      navigator.share &&
      (!navigator.canShare || navigator.canShare({ files: [generatedFile] }))
    ) {
      await navigator.share(shareData);
    } else {
      downloadOrderPng(generatedFile);
    }

    localStorage.removeItem("pendingSheet");
    setTimeout(() => location.reload(), 300);
  } catch (error) {
    if (error && error.name === "AbortError") return;

    console.warn("Системная отправка недоступна, сохраняем PNG", error);
    try {
      downloadOrderPng(generatedFile);
      localStorage.removeItem("pendingSheet");
    } catch (downloadError) {
      console.error("Не удалось отправить карточку", downloadError);
      showToast("Не удалось открыть карточку для отправки");
    }
  }
}

document.getElementById("saveBtn").onclick = async () => {
  if (typeof openOrderShareChooser_ === "function") {
    openOrderShareChooser_(lastOrderId);
    return;
  }
  await shareOrderCardToMax_();
};

document.getElementById("saveBtn").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.currentTarget.click();
});
/* CLOSE MODALS */

cartModal.addEventListener("click", (e) => {
  if (e.target === cartModal) {
    cartBox.classList.add("modal-hide");

    setTimeout(() => {
      cartModal.style.display = "none";

      unlockBody();

      cartBox.classList.remove("modal-hide");
    }, 200);
  }
});

checkoutModal.addEventListener("click", (e) => {

  if (orderSending) return;

  if (e.target === checkoutModal) {
    checkoutBox.classList.add("modal-hide");

    setTimeout(() => {
      checkoutModal.style.display = "none";

      unlockBody();

      checkoutBox.classList.remove("modal-hide");
    }, 200);
  }

});

popup.addEventListener("click", (e) => {
  if (e.target === popup) {
    popupBox.classList.add("modal-hide");

    requestAnimationFrame(() => {
      setTimeout(() => {
        popup.style.display = "none";
        unlockBody();

        popupBox.classList.remove("modal-hide");
      }, 200);
    });
  }
});
const pickupPoint = document.getElementById("pickupPoint");

const pvzAddress = document.getElementById("pvzAddress");

const pickupTrigger = document.getElementById("pickupTrigger");

const pickupMenu = document.getElementById("pickupMenu");

document.getElementById("pickupPoint").selectedIndex = 0;

pickupPoint.value = "";

pickupTrigger.textContent = "Выберите точку выдачи";

pickupMenu.classList.remove("open");

pickupPoint.addEventListener("change", () => {
  syncPickupMenuSelection();
  setPvzAddressVisibility();
  if (pickupPoint.value) clearCheckoutFieldError(pickupTrigger);
});

const nameInput = document.getElementById("clientName");

const phoneInput = document.getElementById("clientPhone");

let foundClient = null;

let clientOrders = [];

let selectedOrderColumn = null;

let selectedOrderId = null;

let orderMode = "normal";

let orderLabel = "";

let orderSending = false;

const pvzAddressField = document.getElementById("pvzAddressField");

const checkoutErrorTargets = new Map([
  [nameInput, document.getElementById("clientNameError")],
  [phoneInput, document.getElementById("clientPhoneError")],
  [pickupTrigger, document.getElementById("pickupPointError")],
  [pvzAddress, document.getElementById("pvzAddressError")],
]);

function setCheckoutFieldError(control, message) {
  const error = checkoutErrorTargets.get(control);
  control.classList.add("input-error");
  control.setAttribute("aria-invalid", "true");
  control.closest(".checkout-field, .pickup-dropdown")?.classList.add("has-error");
  if (error) error.textContent = message;
}

function clearCheckoutFieldError(control) {
  const error = checkoutErrorTargets.get(control);
  control.classList.remove("input-error");
  control.removeAttribute("aria-invalid");
  control.closest(".checkout-field, .pickup-dropdown")?.classList.remove("has-error");
  if (error) error.textContent = "";
}

function pickupRequiresAddress() {
  return pickupPoint.selectedOptions[0]?.dataset.requiresAddress === "true";
}

function setPvzAddressVisibility() {
  const requiresAddress = pickupRequiresAddress();
  pvzAddressField.hidden = !requiresAddress;
  pvzAddress.style.removeProperty("display");
  if (!requiresAddress) clearCheckoutFieldError(pvzAddress);
}

function validateCheckoutForm() {
  [nameInput, phoneInput, pickupTrigger, pvzAddress].forEach(clearCheckoutFieldError);

  const errors = [];
  const name = nameInput.value.trim();
  const nameRegex = /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё\s.'’\-]*$/;
  const phoneDigits = phoneInput.value.replace(/\D/g, "");

  if (name.length < 2 || name.length > 120 || !nameRegex.test(name)) {
    errors.push([nameInput, "Укажите имя буквами"]);
  }

  if (phoneDigits.length !== 11 || phoneDigits[0] !== "7") {
    errors.push([phoneInput, "Введите номер полностью"]);
  }

  if (!pickupPoint.value) {
    errors.push([pickupTrigger, "Выберите точку выдачи"]);
  }

  if (pickupRequiresAddress() && !pvzAddress.value.trim()) {
    errors.push([pvzAddress, "Укажите адрес пункта выдачи"]);
  }

  errors.forEach(([control, message]) => setCheckoutFieldError(control, message));

  if (errors.length > 0) {
    errors[0][0].focus({ preventScroll: false });
    return false;
  }

  return true;
}

function setCheckoutIdentityFieldsVisible(visible) {
  document.getElementById("clientNameField").hidden = !visible;
  document.getElementById("clientPhoneField").hidden = !visible;
  document.querySelector(".pickup-dropdown").hidden = !visible;
  if (visible) {
    setPvzAddressVisibility();
  } else {
    pvzAddressField.hidden = true;
  }
}

function getPickupMenuOptions() {
  return Array.from(pickupMenu.querySelectorAll(".pickup-option"));
}

function syncPickupMenuSelection() {
  const selected = pickupPoint.selectedOptions[0];
  pickupTrigger.textContent = selected && selected.value
    ? selected.textContent.trim()
    : "Выберите точку выдачи";

  getPickupMenuOptions().forEach((option) => {
    option.setAttribute(
      "aria-selected",
      option.dataset.value === pickupPoint.value ? "true" : "false",
    );
  });
}

function setPickupMenuOpen(open, focusOption = false) {
  pickupMenu.classList.toggle("open", open);
  pickupTrigger.setAttribute("aria-expanded", open ? "true" : "false");

  if (open && focusOption) {
    const options = getPickupMenuOptions();
    const selected = options.find((option) => option.dataset.value === pickupPoint.value);
    (selected || options[0])?.focus();
  }
}

function initializePickupDropdown() {
  pickupMenu.replaceChildren();

  Array.from(pickupPoint.options)
    .filter((option) => option.value && !option.disabled)
    .forEach((sourceOption) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "pickup-option";
      option.dataset.value = sourceOption.value;
      option.textContent = sourceOption.textContent.trim();
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");

      option.addEventListener("click", () => {
        pickupPoint.value = option.dataset.value;
        pickupPoint.dispatchEvent(new Event("change", { bubbles: true }));
        setPickupMenuOpen(false);
        pickupTrigger.focus();
      });

      option.addEventListener("keydown", (event) => {
        const options = getPickupMenuOptions();
        const currentIndex = options.indexOf(option);

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          options[(currentIndex + direction + options.length) % options.length]?.focus();
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          options[event.key === "Home" ? 0 : options.length - 1]?.focus();
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          option.click();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setPickupMenuOpen(false);
          pickupTrigger.focus();
        }
      });

      pickupMenu.appendChild(option);
    });

  pickupTrigger.addEventListener("click", () => {
    setPickupMenuOpen(!pickupMenu.classList.contains("open"));
  });

  pickupTrigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setPickupMenuOpen(true, true);
    }
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".pickup-dropdown")) setPickupMenuOpen(false);
  });

  syncPickupMenuSelection();
  setPvzAddressVisibility();
}

let cardDownloaded = false;

let generatedFile = null;

let lastOrderId = "";
let savedSheetMode = false;
let sheetGenerationToken = 0;
const sheetPngCache = new Map();
const SHEET_PNG_CACHE_LIMIT = 10;
const SHEET_PNG_PERSISTENT_CACHE = "order-png-v1";

function getSavedOrderPngCacheKey(order) {
  const requestIds = Array.isArray(order?.requestIds)
    ? order.requestIds.join(",")
    : "";

  return [
    order?.orderId || "",
    order?.createdAt || "",
    Number(order?.total) || 0,
    Number(order?.totalItems) || 0,
    requestIds,
  ].join("|");
}

function getCachedSheetPng(cacheKey) {
  if (!cacheKey || !sheetPngCache.has(cacheKey)) return null;

  const file = sheetPngCache.get(cacheKey);
  sheetPngCache.delete(cacheKey);
  sheetPngCache.set(cacheKey, file);
  return file;
}

function cacheSheetPng(cacheKey, file) {
  if (!cacheKey || !file) return;

  sheetPngCache.delete(cacheKey);
  sheetPngCache.set(cacheKey, file);

  while (sheetPngCache.size > SHEET_PNG_CACHE_LIMIT) {
    const oldestKey = sheetPngCache.keys().next().value;
    sheetPngCache.delete(oldestKey);
  }
}

function getSheetPngPersistentCacheUrl(cacheKey) {
  return new URL(
    `./.order-png-cache/${encodeURIComponent(cacheKey)}.png`,
    window.location.href,
  ).href;
}

async function getPersistentSheetPng(cacheKey, orderId) {
  if (!cacheKey || !("caches" in window)) return null;

  try {
    const cache = await caches.open(SHEET_PNG_PERSISTENT_CACHE);
    const response = await cache.match(getSheetPngPersistentCacheUrl(cacheKey));
    if (!response) return null;

    const blob = await response.blob();
    const safeOrderId = String(orderId || "order").replace(
      /[^0-9A-Za-zА-Яа-я_-]/g,
      "",
    );
    return new File([blob], `order-${safeOrderId || "order"}.png`, {
      type: blob.type || "image/png",
    });
  } catch (error) {
    console.warn("Сохранённый PNG не удалось прочитать из кэша", error);
    return null;
  }
}

async function persistSheetPng(cacheKey, file) {
  if (!cacheKey || !file || !("caches" in window)) return;

  try {
    const cache = await caches.open(SHEET_PNG_PERSISTENT_CACHE);
    const response = new Response(file, {
      headers: { "Content-Type": "image/png" },
    });
    await cache.put(getSheetPngPersistentCacheUrl(cacheKey), response);

    const keys = await cache.keys();
    while (keys.length > SHEET_PNG_CACHE_LIMIT) {
      await cache.delete(keys.shift());
    }
  } catch (error) {
    console.warn("PNG не удалось сохранить между запусками", error);
  }
}

function resolveWithin(promise, timeoutMs, fallbackValue = null) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve(fallbackValue);
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(fallbackValue);
      },
    );
  });
}

function rejectAfter(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function dataUrlToBlob(dataUrl) {
  const commaIndex = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, commaIndex);
  const mimeMatch = header.match(/^data:([^;]+)/);
  const binary = atob(dataUrl.slice(commaIndex + 1));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], {
    type: mimeMatch ? mimeMatch[1] : "image/png",
  });
}

async function canvasToPngBlob(canvas) {
  if (typeof canvas.toBlob === "function") {
    const blob = await resolveWithin(
      new Promise((resolve) => canvas.toBlob(resolve, "image/png")),
      2500,
      null,
    );
    if (blob) return blob;
  }

  return dataUrlToBlob(canvas.toDataURL("image/png"));
}

function makeOrderPngFile(blob, orderId) {
  const safeOrderId = String(orderId || "order").replace(
    /[^0-9A-Za-zА-Яа-я_-]/g,
    "",
  );

  return new File([blob], `order-${safeOrderId || "order"}.png`, {
    type: "image/png",
  });
}

function drawRoundedCanvasRect(context, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function shortenCanvasText(context, value, maxWidth) {
  const text = String(value || "").trim();
  if (context.measureText(text).width <= maxWidth) return text;

  let shortened = text;
  while (
    shortened.length > 1 &&
    context.measureText(shortened + "…").width > maxWidth
  ) {
    shortened = shortened.slice(0, -1);
  }
  return shortened + "…";
}

async function createFallbackSheetPngFile(orderId, cacheKey) {
  const sheet = document.getElementById("sheetBox");
  if (!sheet) throw new Error("Карточка заказа не найдена");

  const itemRows = Array.from(sheet.querySelectorAll("#sheetItems .sheet-chip")).map(
    (chip) => ({
      name: chip.querySelector(".sheet-name")?.textContent?.trim() || "",
      qty: chip.querySelector(".sheet-qty")?.textContent?.trim() || "",
    }),
  );
  const clientLines = (
    sheet.querySelector("#sheetClient")?.innerText || ""
  )
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);

  const grandTotalElement = sheet.querySelector("#sheetGrandTotal");
  const grandTotalText =
    grandTotalElement && !grandTotalElement.hidden
      ? sheet.querySelector("#sheetGrandTotalValue")?.textContent?.trim() || ""
      : "";
  const columns = itemRows.length > 120 ? 4 : itemRows.length > 45 ? 3 : 2;
  const rowHeight = itemRows.length > 120 ? 46 : 54;
  const rows = Math.max(1, Math.ceil(itemRows.length / columns));
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = Math.max(720, 410 + rows * rowHeight + (grandTotalText ? 54 : 0));

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas недоступен");

  context.fillStyle = "#fffaf4";
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.fillStyle = "#0e8f6c";
  drawRoundedCanvasRect(context, 32, 32, canvas.width - 64, 130, 28);
  context.fill();

  context.fillStyle = "#ffffff";
  context.font = "700 46px Arial, sans-serif";
  context.fillText(
    shortenCanvasText(
      context,
      sheet.querySelector("#sheetTitle")?.textContent || "ЗАКАЗ",
      760,
    ),
    74,
    105,
  );
  context.font = "600 28px Arial, sans-serif";
  context.textAlign = "right";
  context.fillText(
    sheet.querySelector("#sheetDate")?.textContent?.trim() || "",
    canvas.width - 74,
    100,
  );
  context.textAlign = "left";

  context.fillStyle = "#303832";
  context.font = "600 27px Arial, sans-serif";
  clientLines.forEach((line, index) => {
    context.fillText(shortenCanvasText(context, line, 650), 60, 215 + index * 38);
  });

  context.fillStyle = "#9b1801";
  context.font = "800 38px Arial, sans-serif";
  context.textAlign = "right";
  context.fillText(
    sheet.querySelector("#sheetTotal")?.textContent?.trim() || "",
    canvas.width - 60,
    220,
  );
  context.fillStyle = "#303832";
  context.font = "600 25px Arial, sans-serif";
  context.fillText(
    sheet.querySelector("#sheetTotalItems")?.textContent?.trim() || "",
    canvas.width - 60,
    262,
  );
  context.textAlign = "left";

  const gridTop = 340;
  const gap = 14;
  const side = 52;
  const cellWidth =
    (canvas.width - side * 2 - gap * (columns - 1)) / columns;

  itemRows.forEach((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = side + column * (cellWidth + gap);
    const y = gridTop + row * rowHeight;

    context.fillStyle = "#ffffff";
    context.strokeStyle = "#d8e3dc";
    context.lineWidth = 2;
    drawRoundedCanvasRect(context, x, y, cellWidth, rowHeight - 8, 13);
    context.fill();
    context.stroke();

    context.fillStyle = "#303832";
    context.font =
      columns === 4
        ? "600 20px Arial, sans-serif"
        : "600 23px Arial, sans-serif";
    context.fillText(
      shortenCanvasText(context, item.name, cellWidth - 88),
      x + 16,
      y + 31,
    );

    context.fillStyle = "#0e8f6c";
    context.font = "800 22px Arial, sans-serif";
    context.textAlign = "right";
    context.fillText(item.qty, x + cellWidth - 14, y + 31);
    context.textAlign = "left";
  });

  if (grandTotalText) {
    context.fillStyle = "#4f5651";
    context.font = "700 24px Arial, sans-serif";
    context.fillText("ВСЕГО В ЗАКАЗЕ", side, canvas.height - 76);
    context.fillStyle = "#9b1801";
    context.font = "800 28px Arial, sans-serif";
    context.textAlign = "right";
    context.fillText(grandTotalText, canvas.width - side, canvas.height - 76);
    context.textAlign = "left";
  }

  context.fillStyle = "#637069";
  context.font = "500 21px Arial, sans-serif";
  context.fillText(
    sheet.querySelector("#sheetOrderLabel")?.textContent?.trim() || "",
    side,
    canvas.height - 34,
  );

  const blob = await canvasToPngBlob(canvas);
  const file = makeOrderPngFile(blob, orderId);
  cacheSheetPng(cacheKey, file);
  void persistSheetPng(cacheKey, file);
  return file;
}

async function createSheetPngFile({
  orderId,
  cacheKey = "",
  delayMs = 0,
  renderScale = 2,
  token = sheetGenerationToken,
}) {
  const cachedFile = getCachedSheetPng(cacheKey);
  if (cachedFile) return cachedFile;

  // Safari иногда задерживает Cache API. Кэш не должен блокировать новый PNG.
  const persistentFile = await resolveWithin(
    getPersistentSheetPng(cacheKey, orderId),
    700,
    null,
  );
  if (persistentFile && token === sheetGenerationToken) {
    cacheSheetPng(cacheKey, persistentFile);
    return persistentFile;
  }

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (token !== sheetGenerationToken) return null;
  if (typeof window.html2canvas !== "function") {
    return createFallbackSheetPngFile(orderId, cacheKey);
  }

  const original = document.getElementById("sheetBox");
  if (!original) throw new Error("Карточка заказа не найдена");

  const clone = original.cloneNode(true);
  clone
    .querySelectorAll('img, [data-html2canvas-ignore="true"]')
    .forEach((element) => element.remove());
  clone.style.borderRadius = "28px";
  clone.style.overflow = "hidden";
  clone.style.maxHeight = "none";

  const cloneItems = clone.querySelector("#sheetItems");
  if (cloneItems) {
    cloneItems.style.maxHeight = "none";
    cloneItems.style.overflow = "visible";
  }

  clone.querySelectorAll("*").forEach((element) => {
    element.style.backgroundImage = "none";
  });

  const sandbox = document.createElement("div");
  sandbox.style.position = "fixed";
  sandbox.style.left = "-99999px";
  sandbox.style.top = "0";
  sandbox.style.pointerEvents = "none";
  sandbox.appendChild(clone);
  document.body.appendChild(sandbox);

  // html2canvas клонирует весь документ. В Safari скрытые lazy-изображения
  // могут задержать этот этап, поэтому явно исключаем их на время снимка.
  const pageImagesToRestore = Array.from(document.images).filter(
    (image) => !image.hasAttribute("data-html2canvas-ignore"),
  );
  pageImagesToRestore.forEach((image) =>
    image.setAttribute("data-html2canvas-ignore", "true"),
  );

  try {
    if (token !== sheetGenerationToken) return null;

    const canvas = await rejectAfter(
      window.html2canvas(clone, {
        scale: Math.max(1, Math.min(2, Number(renderScale) || 2)),
        useCORS: false,
        imageTimeout: 1000,
        backgroundColor: null,
        logging: false,
        ignoreElements: (element) =>
          element.tagName === "IMG" ||
          element.hasAttribute("data-html2canvas-ignore"),
      }),
      7000,
      "Создание карточки заняло слишком много времени",
    );

    if (token !== sheetGenerationToken) return null;

    const blob = await canvasToPngBlob(canvas);
    if (!blob) throw new Error("Не удалось создать PNG");
    if (token !== sheetGenerationToken) return null;

    const file = makeOrderPngFile(blob, orderId);
    cacheSheetPng(cacheKey, file);
    void persistSheetPng(cacheKey, file);
    return file;
  } catch (error) {
    console.warn("Основной PNG недоступен, создаём совместимую карточку", error);
    if (token !== sheetGenerationToken) return null;
    return createFallbackSheetPngFile(orderId, cacheKey);
  } finally {
    pageImagesToRestore.forEach((image) =>
      image.removeAttribute("data-html2canvas-ignore"),
    );
    sandbox.remove();
  }
}
function renderSavedOrdersSummary() {
  const banner = document.getElementById("savedOrdersBanner");
  const count = document.getElementById("savedOrdersCount");
  if (!banner || !count) return;

  const unread = typeof getOrderChatUnreadTotal_ === "function"
    ? Number(getOrderChatUnreadTotal_()) || 0
    : 0;
  count.textContent = unread ? String(unread) : "";
  count.setAttribute(
    "aria-label",
    unread ? `${unread} непрочитанных сообщений` : "",
  );
  count.hidden = unread === 0;
  banner.hidden = savedOrders.length === 0;
}

renderSavedOrdersSummary();

function getSavedOrderDate(order) {
  if (order.dateLabel) return order.dateLabel;

  const date = new Date(order.createdAt);
  return Number.isNaN(date.getTime())
    ? "Дата не указана"
    : date.toLocaleDateString("ru-RU");
}

function renderSavedOrdersList() {
  const list = document.getElementById("savedOrdersList");
  if (!list) return;

  list.innerHTML = "";

  savedOrders.forEach((order) => {
    const card = document.createElement("article");
    card.className = "saved-order-card";

    const row = document.createElement("button");
    row.type = "button";
    row.className = "saved-order-row";

    const main = document.createElement("span");
    main.className = "saved-order-row-main";

    const sub = document.createElement("span");
    sub.className = "saved-order-row-sub";

    const title = document.createElement("span");
    title.className = "saved-order-row-title";
    title.textContent = `${order.orderId} · ${order.name || "Без имени"}`;

    const total = document.createElement("span");
    total.className = "saved-order-row-total";
    total.textContent = `${(Number(order.total) || 0).toLocaleString("ru-RU")} ₽`;

    const date = document.createElement("span");
    date.className = "saved-order-row-date";
    date.textContent = getSavedOrderDate(order);

    const status = document.createElement("strong");
    status.className = "saved-order-card-status";
    status.textContent = "СТАТУС ОБНОВЛЯЕТСЯ";

    main.append(title, total);
    sub.append(date, status);
    row.append(main, sub);
    row.addEventListener("click", () => {
      if (row.disabled) return;
      row.disabled = true;
      row.classList.add("saved-orders-pressed");
      setTimeout(() => openSavedOrderCard(order), 110);
    });
    card.appendChild(row);

    if (typeof appendSavedOrderChatControls_ === "function") {
      appendSavedOrderChatControls_(card, order);
    }

    list.appendChild(card);
  });

  const total = document.createElement("p");
  total.className = "saved-orders-total";
  total.textContent = `Всего заказов: ${savedOrders.length}`;
  list.appendChild(total);
}

function openSavedOrders() {
  renderSavedOrdersList();
  const modal = document.getElementById("savedOrdersModal");
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  lockBody();
}

function closeSavedOrders() {
  const modal = document.getElementById("savedOrdersModal");
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  unlockBody();
}

function setSheetAddonSummary({
  isAddon = false,
  addedTotal = 0,
  orderTotal = null,
} = {}) {
  const total = document.getElementById("sheetTotal");
  const caption = document.getElementById("sheetTotalCaption");
  const grandTotal = document.getElementById("sheetGrandTotal");
  const grandTotalValue = document.getElementById("sheetGrandTotalValue");
  const numericAddedTotal = Number(addedTotal) || 0;
  const hasOrderTotal =
    orderTotal !== null &&
    orderTotal !== undefined &&
    orderTotal !== "" &&
    Number.isFinite(Number(orderTotal));
  const numericOrderTotal = hasOrderTotal ? Number(orderTotal) : 0;

  total.textContent =
    `${isAddon ? "+" : ""}${numericAddedTotal.toLocaleString("ru-RU")} ₽`;
  caption.hidden = !isAddon;

  const showOrderTotal = isAddon && hasOrderTotal;
  grandTotal.hidden = !showOrderTotal;

  if (showOrderTotal) {
    grandTotalValue.textContent = `${numericOrderTotal.toLocaleString("ru-RU")} ₽`;
  } else {
    grandTotalValue.textContent = "";
  }
}

function fillSheetItems(items) {
  sheetItems.innerHTML = (items || [])
    .map((item) => {
      const title = String(item.title || "");
      const shortTitle = title.length > 14 ? title.slice(0, 12) + ".." : title;

      return `
        <div class="sheet-chip">
          <span class="sheet-name">
            ${escapeHtml(item.id)} ${escapeHtml(shortTitle)}
          </span>
          <span class="sheet-qty">
            ${Number(item.qty) || 0}п
          </span>
        </div>
      `;
    })
    .join("");
}

async function generateSavedOrderPng(order) {
  const token = ++sheetGenerationToken;
  const saveButton = document.getElementById("saveSavedOrderBtn");
  saveButton.disabled = true;
  saveButton.textContent = "Подготавливаем карточку…";
  generatedFile = null;

  try {
    const file = await createSheetPngFile({
      orderId: order.orderId,
      cacheKey: getSavedOrderPngCacheKey(order),
      delayMs: 0,
      renderScale: 2,
      token,
    });
    if (!file || token !== sheetGenerationToken) return;

    generatedFile = file;
    saveButton.disabled = false;
    saveButton.textContent = "Сохранить в галерею";
  } catch (error) {
    console.error("Не удалось восстановить карточку", error);
    if (token === sheetGenerationToken) {
      saveButton.textContent = "Не удалось создать PNG";
      showToast("Карточку не удалось подготовить");
    }
  }
}

function openSavedOrderCard(order) {
  closeSavedOrders();
  savedSheetMode = true;
  lastOrderId = order.orderId;

  document.getElementById("sheetTitle").textContent =
    order.title || "ЗАКАЗ " + order.orderId;
  document.getElementById("sheetDate").textContent = getSavedOrderDate(order);
  document.getElementById("sheetOrderLabel").textContent = order.orderLabel || "";
  document.getElementById("sheetClient").innerHTML = `
    ${escapeHtml(order.name)}
    <br>
    ${escapeHtml(order.phone)}
    <div class="sheet-pickup">${escapeHtml(order.pickup)}</div>
  `;
  setSheetAddonSummary({
    isAddon: false,
    addedTotal: Number(order.total) || 0,
  });
  document.getElementById("sheetTotalItems").textContent =
    `${Number(order.totalItems) || 0} п`;

  const copyButton = document.getElementById("copyOrderIdBtn");
  copyButton.style.display = "inline-flex";
  copyButton.textContent = "Скопировать " + order.orderId;
  fillSheetItems(order.items);

  document.querySelector(".sheet-buttons").style.display = "none";
  document.querySelector(".sheet-message").style.display = "none";
  document.getElementById("savedSheetActions").hidden = false;
  sheetModal.style.display = "flex";
  lockBody();
  generateSavedOrderPng(order);
}

async function saveRestoredOrderPng() {
  if (!generatedFile) {
    showToast("Карточка ещё создаётся");
    return;
  }

  try {
    if (
      navigator.share &&
      (!navigator.canShare || navigator.canShare({ files: [generatedFile] }))
    ) {
      await navigator.share({
        files: [generatedFile],
        title: "Карточка заказа " + lastOrderId,
      });
      return;
    }

    const url = URL.createObjectURL(generatedFile);
    const link = document.createElement("a");
    link.href = url;
    link.download = generatedFile.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    if (error && error.name !== "AbortError") {
      console.error("Не удалось сохранить карточку", error);
      showToast("Не удалось сохранить карточку");
    }
  }
}

function closeSavedOrderCard() {
  const returnToChatId = String(window.returnToOrderChatId_ || "");
  window.returnToOrderChatId_ = "";
  sheetGenerationToken++;
  savedSheetMode = false;
  generatedFile = null;
  sheetModal.style.display = "none";
  document.getElementById("savedSheetActions").hidden = true;
  document.querySelector(".sheet-buttons").style.display = "flex";
  document.querySelector(".sheet-message").style.display = "block";
  unlockBody();
  if (returnToChatId && typeof window.openOrderChat_ === "function") {
    void window.openOrderChat_(returnToChatId);
    return;
  }
  openSavedOrders();
}

document.getElementById("savedOrdersBanner").addEventListener("click", openSavedOrders);

const savedOrdersModalElement = document.getElementById("savedOrdersModal");
const closeSavedOrdersButton = document.getElementById("closeSavedOrdersBtn");

closeSavedOrdersButton.addEventListener("click", () => {
  closeSavedOrdersButton.classList.add("saved-orders-pressed");
  setTimeout(() => {
    closeSavedOrdersButton.classList.remove("saved-orders-pressed");
    closeSavedOrders();
  }, 110);
});

savedOrdersModalElement.addEventListener("click", (event) => {
  if (event.target === savedOrdersModalElement) {
    closeSavedOrders();
  }
});

document.getElementById("saveSavedOrderBtn").addEventListener("click", saveRestoredOrderPng);
document
  .getElementById("closeSavedOrderCardBtn")
  .addEventListener("click", closeSavedOrderCard);


function saveOrderDraft() {
  localStorage.setItem(
    ORDER_DRAFT_KEY,
    JSON.stringify({
      name: nameInput.value,
      phone: phoneInput.value,
      pickup: pickupPoint.value,
      pickupText: pickupTrigger.textContent,
      pvz: pvzAddress.value,
    }),
  );
}

function restoreOrderDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(ORDER_DRAFT_KEY) || "null");
    if (!draft) return;

    nameInput.value = draft.name || "";
    phoneInput.value = draft.phone || "+7";
    pickupPoint.value = draft.pickup || "";
    pickupTrigger.textContent = draft.pickupText || "Выберите точку выдачи";
    pvzAddress.value = draft.pvz || "";
    syncPickupMenuSelection();
    setPvzAddressVisibility();
  } catch (error) {
    localStorage.removeItem(ORDER_DRAFT_KEY);
  }
}

initializePickupDropdown();
restoreOrderDraft();

[nameInput, phoneInput, pvzAddress].forEach((input) => {
  input.addEventListener("input", saveOrderDraft);
});

pickupPoint.addEventListener("change", saveOrderDraft);

/* REMOVE ERROR */

nameInput.addEventListener("input", () => {
  const nameRegex = /^[A-Za-zА-Яа-яЁё\s-]+$/;

  if (nameRegex.test(nameInput.value.trim())) {
    clearCheckoutFieldError(nameInput);
  }
});

phoneInput.addEventListener("input", () => {
  let value = phoneInput.value.replace(/\D/g, "");

  if (
  value.length === 2 &&
  value[1] === "7" &&
  value[0] !== "7"
) {
  value = "7" + value[0];
}

  if (value.startsWith("8")) {
    value = "7" + value.slice(1);
  }

 
  if (!value.startsWith("7")) {
    value = "7" + value;
  }

  value = value.substring(0, 11);

  let result = "+7";

  if (value.length > 1) {
    result += " (" + value.substring(1, 4);
  }

  if (value.length >= 5) {
    result += ") " + value.substring(4, 7);
  }

  if (value.length >= 8) {
    result += "-" + value.substring(7, 9);
  }

  if (value.length >= 10) {
    result += "-" + value.substring(9, 11);
  }

  phoneInput.value = result;

  const phoneRegex = /^\+7 \(\d{3}\) \d{3}-\d{2}-\d{2}$/;

  if (phoneRegex.test(result)) {
    clearCheckoutFieldError(phoneInput);
  }
});

pickupPoint.addEventListener("change", () => {
  clearCheckoutFieldError(pickupTrigger);
});

pvzAddress.addEventListener("input", () => {
  if (pvzAddress.value.trim()) {
    clearCheckoutFieldError(pvzAddress);
  }
});

document.getElementById("popupBack").onclick = () => {
  popupBox.classList.add("modal-hide");

  setTimeout(() => {
    popup.style.display = "none";
    unlockBody();

    popupBox.classList.remove("modal-hide");
  }, 200);
};

catalog.innerHTML = `

  <div class="skeleton"></div>
  <div class="skeleton"></div>
  <div class="skeleton"></div>
  <div class="skeleton"></div>

`;

function launchTomatoHeart() {
  const container = document.getElementById("tomatoHearts");

  if (!container) return;

  const logoTomato = document.getElementById("logoTomato");

  logoTomato.src = "./tomato/tomato-idle-closed.png";

  const hearts = [
    "./tomato/heart1-anim.png",
    "./tomato/heart2-anim.png",
    "./tomato/heart3-anim.png",
  ];

  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      const heart = document.createElement("div");

      heart.className = "tomato-heart";

      heart.innerHTML = `
        <img
          src="${hearts[i]}"
          class="heart-png"
        >
      `;

      const positions = [
        { left: -8, top: -2 },
        { left: 11, top: -11 },
        { left: 33, top: 2 },
      ];

      heart.style.left = `${positions[i].left}px`;

      heart.style.top = `${positions[i].top}px`;

      container.appendChild(heart);

      setTimeout(() => {
        heart.remove();
      }, 1200);
    }, i * 160);
  }

  setTimeout(() => {
    logoTomato.src = "./tomato/tomato-idle.png";
  }, 700);
}

const logoTomato = document.getElementById("logoTomato");

let tomatoAngry = false;

logoTomato.addEventListener("click", () => {
  vibrate(10);

  if (tomatoAngry) return;

  tomatoAngry = true;

  logoTomato.classList.add("tomato-bonk");

  logoTomato.src = "./tomato/tomato-angry.png";

  setTimeout(() => {
    logoTomato.src = "./tomato/tomato-idle.png";

    logoTomato.classList.remove("tomato-bonk");

    tomatoAngry = false;
  }, 250);
});

function launchTomatoKiss() {
  const container = document.getElementById("tomatoHearts");

  if (!container) return;

  const logoTomato = document.getElementById("logoTomato");

  logoTomato.src = "./tomato/tomato-kiss.png";

  const kiss = document.createElement("img");

  kiss.src = "./tomato/kiss.png";

  kiss.className = "kiss-pop";

  kiss.style.left = "18px";

  kiss.style.top = "6px";

  container.appendChild(kiss);

  setTimeout(() => {
    kiss.remove();
  }, 1400);

  setTimeout(() => {
    logoTomato.src = "./tomato/tomato-idle.png";
  }, 800);
}

function launchTomatoBlink() {
  const logoTomato = document.getElementById("logoTomato");

  if (!logoTomato) return;

  logoTomato.src = "./tomato/tomato-idle-closed.png";

  setTimeout(() => {
    logoTomato.src = "./tomato/tomato-idle.png";
  }, 180);
}

function launchTomatoCrown() {
  const container = document.getElementById("tomatoHearts");

  if (!container) return;

  const crown = document.createElement("img");

  crown.src = "./tomato/crown.png";

  crown.className = "crown-pop";

  container.appendChild(crown);

  setTimeout(() => {
    crown.remove();
  }, 1000);
}

loadCatalogData()
  .then(async (data) => {
    const initialCatalogLoadSource = catalogLastLoadSource;

    if (isSeasonClosedResponse(data)) {
      showCatalogSeasonClosed();
      return;
    }

    const catalogProducts = getCatalogProductsFromResponse(data);

    if (!catalogProducts) {
      throw new Error("Сервер вернул некорректный каталог");
    }

    const initialSync = applyCatalogProducts(catalogProducts, { notify: true });

    if (initialSync.availableCount === 0) {
      showCatalogSeasonClosed();
      return;
    }

    if (initialCatalogLoadSource === "fresh-cache") {
      catalogReady = true;
      catalogLastSuccessfulRefreshAt = Date.now();
      void refreshCatalogInBackground();
    }

    const [initialImages] = await Promise.all([
      waitForInitialProductImages(24, 8000),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);

    if (document.querySelector(".header")?.classList.contains("season-closed")) {
      return;
    }

    if (
      initialImages.timedOut ||
      initialImages.failed > 0 ||
      initialImages.loaded < initialImages.total
    ) {
      showCatalogConnectionError(
        "Проверьте интернет или выключите VPN.",
      );
      return;
    }

    warmRemainingProductImages(24, 10);
    updateCart();
    catalogReady = true;
    catalogLastSuccessfulRefreshAt = Date.now();

    const loadingTomato = document.getElementById("loadingTomato");
    const loadingScreen = document.getElementById("loadingScreen");

    // стартуем с надутого
    if (!loadingTomato || !loadingScreen) return;

    loadingTomato.src = "./tomato/tomato-breath-loader.png";

    setTimeout(() => {
      // стал обычным
      loadingTomato.src = "./tomato/tomato-idle-loader.png";
    }, 400);

    setTimeout(() => {
      // полетел после возврата
      const target = document.querySelector(".logo-tomato-wrap");

      if (!target) {
        loadingScreen.remove();
        return;
      }

      const rect = target.getBoundingClientRect();

      loadingScreen.classList.add("is-finishing");
      const loadingText = loadingScreen.querySelector(".loading-text");
      if (loadingText) {
        loadingText.style.opacity = "0";
        loadingText.style.transform = "translateY(6px)";
      }

      loadingTomato.style.transition =
        "left 0.52s cubic-bezier(0.22,1,0.36,1), " +
        "top 0.52s cubic-bezier(0.22,1,0.36,1), " +
        "width 0.52s cubic-bezier(0.22,1,0.36,1), " +
        "transform 0.52s cubic-bezier(0.22,1,0.36,1)";

      loadingTomato.style.left = `${rect.left}px`;

      loadingTomato.style.top = `${rect.top}px`;

      loadingTomato.style.width = `${rect.width}px`;

      loadingTomato.style.transform = "translate(0,0)";
    }, 480);

    setTimeout(() => {
      document.getElementById("loadingScreen")?.remove();
    }, 1060);
  })
  .catch(() => {
    showCatalogConnectionError(
      "Каталог не загрузился. Проверьте интернет или VPN.",
    );
  });

async function refreshCatalogInBackground({ minimumAge = 0 } = {}) {
  const seasonClosed = document
    .querySelector(".header")
    ?.classList.contains("season-closed");

  if (document.hidden || orderSending) return null;
  if (!catalogReady && !seasonClosed) return null;

  const now = Date.now();

  if (now - catalogLastSuccessfulRefreshAt < minimumAge) return null;

  if (catalogRefreshPromise) return catalogRefreshPromise;

  catalogRefreshPromise = (async () => {
    const data = await loadCatalogData({ forceNetwork: true });

    if (isSeasonClosedResponse(data)) {
      catalogReady = false;
      showCatalogSeasonClosed();
      return null;
    }

    const nextProducts = getCatalogProductsFromResponse(data);
    if (!nextProducts) throw new Error("Сервер вернул некорректный каталог");

    const syncResult = applyCatalogProducts(nextProducts, {
      notify: true,
      preserveViewport: true,
    });

    if (syncResult.availableCount === 0) {
      catalogReady = false;
      showCatalogSeasonClosed();
      return null;
    }

    if (seasonClosed) showCatalogSeasonOpen();
    catalogReady = true;
    catalogLastSuccessfulRefreshAt = Date.now();
    return syncResult;
  })()
    .catch((error) => {
      console.warn("Фоновое обновление каталога не удалось", error);
      return null;
    })
    .finally(() => {
      catalogRefreshPromise = null;
    });

  return catalogRefreshPromise;
}

setInterval(() => {
  void refreshCatalogInBackground();
}, CATALOG_VISIBLE_REFRESH_INTERVAL);

setInterval(() => {
  void refreshCatalogAvailabilityInBackground();
}, CATALOG_AVAILABILITY_REFRESH_INTERVAL);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;

  const chatModal =
    document.getElementById("orderChatModal");

  // Возврат из выбора фото / PDF в чат.
  // Каталог в этот момент обновлять не нужно.
  if (chatModal && !chatModal.hidden) {
    return;
  }

  void refreshCatalogInBackground({
    minimumAge: CATALOG_RESUME_REFRESH_AFTER
  });
});

window.addEventListener("pageshow", () => {
  void refreshCatalogInBackground({ minimumAge: CATALOG_RESUME_REFRESH_AFTER });
});

window.addEventListener("online", () => {
  void refreshCatalogInBackground();
});

setInterval(() => {
  if (document.hidden) return;

  if (document.querySelector(".header")?.classList.contains("season-closed")) {
    return;
  }

  launchTomatoBlink();
}, 7000);

const searchInput = document.getElementById("searchInput");

const clearSearchBtn = document.getElementById("clearSearch");

const searchResultCount = document.getElementById("searchResultCount");
const catalogEmpty = document.getElementById("catalogEmpty");
const resetCatalogFilters = document.getElementById("resetCatalogFilters");


let searchFrame = 0;

function applyProductSearch() {
  searchFrame = 0;

  let normalizedSearch = normalizeSearchText(searchInput.value);

  if (normalizedSearch === "🔥") normalizedSearch = "хит";
  if (normalizedSearch === "⭐") normalizedSearch = "новинка";

  const searchVariants = getSearchVariants(normalizedSearch);
  const numericMatch = normalizedSearch.match(/^(?:#|№)?(\d+)$/);

  clearSearchBtn.style.display = normalizedSearch ? "block" : "none";

  let visibleCount = 0;

  document.querySelectorAll(".product").forEach((card) => {
    const cardSearch = card.dataset.search || "";

    const matchesSearch = !normalizedSearch
      ? true
      : numericMatch
        ? String(card.dataset.productId) === numericMatch[1]
        : searchVariants.some((variant) => cardSearch.includes(variant));

    let matchesFilter = true;

    if (activeQuickFilter === "hit") {
      matchesFilter = card.dataset.isHit === "true";
    } else if (activeQuickFilter === "new") {
      matchesFilter = card.dataset.isNew === "true";
    } else if (activeQuickFilter === "added") {
      matchesFilter = getCartQuantity(card.dataset.productId) > 0;
    }

    const visible = matchesSearch && matchesFilter;
    card.style.display = visible ? "" : "none";
    if (visible) visibleCount++;
  });

  const hasActiveSelection = Boolean(normalizedSearch || activeQuickFilter);

  searchResultCount.textContent = hasActiveSelection
    ? "Найдено: " + formatVarietyCount(visibleCount)
    : "";
  searchResultCount.classList.toggle("visible", hasActiveSelection);
  catalogEmpty.hidden = !(hasActiveSelection && visibleCount === 0);
  catalog.setAttribute("aria-busy", "false");


  requestAnimationFrame(() => fitProductTitles());
}

searchInput.addEventListener("input", () => {
  if (searchFrame) cancelAnimationFrame(searchFrame);
  searchFrame = requestAnimationFrame(applyProductSearch);
});

document.querySelectorAll(".quick-filter").forEach((button) => {
  button.addEventListener("click", () => {
    const requestedFilter = button.dataset.filter || "";
    activeQuickFilter = activeQuickFilter === requestedFilter ? "" : requestedFilter;

    document.querySelectorAll(".quick-filter").forEach((item) => {
      const isActive = item.dataset.filter === activeQuickFilter;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    applyProductSearch();
  });
});

function clearSearch() {
  searchInput.value = "";

  if (clearSearchBtn) {
    clearSearchBtn.style.display = "none";
  }

  applyProductSearch();
}

clearSearchBtn.addEventListener("click", () => {
  setTimeout(() => {
    clearSearch();
  }, 80);
});


resetCatalogFilters.addEventListener("click", () => {
  searchInput.value = "";
  activeQuickFilter = "";

  document.querySelectorAll(".quick-filter").forEach((button) => {
    button.classList.remove("active");
    button.setAttribute("aria-pressed", "false");
  });

  clearSearchBtn.style.display = "none";
  applyProductSearch();
  searchInput.focus();
});
const backToTopBtn = document.getElementById("backToTopBtn");
let backToTopFrame = 0;

function updateBackToTopVisibility() {
  backToTopFrame = 0;
  backToTopBtn?.classList.toggle("visible", window.scrollY > 700);
}

window.addEventListener('scroll', () => {
  if (backToTopFrame) return;
  backToTopFrame = requestAnimationFrame(updateBackToTopVisibility);
}, { passive: true });

backToTopBtn?.addEventListener("click", () => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
});

setTimeout(() => {
  if (document.querySelector(".header")?.classList.contains("season-closed")) {
    return;
  }

  const infoTag = document.getElementById("infoToggle");

  if (!infoTag) return;

  infoTag.classList.add("info-tag-attention");
}, 6000);

const infoToggle = document.getElementById("infoToggle");

infoToggle.addEventListener("click", () => {
  vibrate(15);

  infoToggle.src = "./tomato/info-click-tag.png";

  infoToggle.style.opacity = "0";

  const start = infoToggle.getBoundingClientRect();

  const fly = document.createElement("img");

  fly.src = "./tomato/info-popup.png";

  fly.className = "info-fly";

  fly.style.left = start.left + "px";

  fly.style.top = start.top + "px";

  fly.style.width = start.width + "px";

  fly.style.height = start.height + "px";

  const closeBtn = document.createElement("div");

  closeBtn.innerHTML = "✕";

  closeBtn.style.position = "fixed";

  closeBtn.style.width = "26px";
  closeBtn.style.height = "26px";

  closeBtn.style.borderRadius = "50%";

  closeBtn.style.background = "rgba(0,0,0,.18)";

  closeBtn.style.color = "#fff";

  closeBtn.style.display = "flex";
  closeBtn.style.alignItems = "center";
  closeBtn.style.justifyContent = "center";

  closeBtn.style.fontSize = "20px";

  closeBtn.style.zIndex = "100001";

  document.body.appendChild(closeBtn);

  const overlay = document.createElement("div");

  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "99998";

  document.body.appendChild(overlay);
  document.body.appendChild(fly);

  const restoreBlock = typeof createInfoRestoreCard_ === "function"
    ? createInfoRestoreCard_()
    : null;

  if (restoreBlock) document.body.appendChild(restoreBlock);

  closeBtn.addEventListener("click", () => {
    fly.remove();

    closeBtn.remove();

    overlay.remove();

    restoreBlock?.remove();

    infoToggle.style.opacity = "1";

    infoToggle.src = "./tomato/info-tag.png";
  });

  overlay.addEventListener("click", () => {
    fly.remove();

    closeBtn.remove();

    overlay.remove();

    restoreBlock?.remove();

    infoToggle.style.opacity = "1";

    infoToggle.src = "./tomato/info-tag.png";
  });

  fly.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  requestAnimationFrame(() => {
    const ratio = 420 / 600;

    const finalWidth = Math.min(
      window.innerWidth * 0.92,
      420,
      Math.max(250, (window.innerHeight - (restoreBlock ? 128 : 42)) * ratio),
    );

    const finalHeight = finalWidth / ratio;

    closeBtn.style.left =
      (window.innerWidth - finalWidth) / 2 + finalWidth - 20 + "px";

    closeBtn.style.top = (window.innerHeight - finalHeight) / 2 - 20 + "px";

    fly.style.transition = "all .55s cubic-bezier(.22,1,.36,1)";

    fly.style.left = (window.innerWidth - finalWidth) / 2 + "px";

    fly.style.top = (window.innerHeight - finalHeight) / 2 + "px";

    fly.style.width = finalWidth + "px";

    fly.style.height = finalHeight + "px";

    if (restoreBlock) {
      restoreBlock.style.left = (window.innerWidth - finalWidth) / 2 + "px";
      restoreBlock.style.top =
        (window.innerHeight - finalHeight) / 2 + finalHeight + 7 + "px";
      restoreBlock.style.width = finalWidth + "px";
    }
  });
});

function showToast(text) {
  const toast = document.getElementById("toast");

  toast.textContent = text;

  toast.classList.add("show");

  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

document.getElementById("copyOrderIdBtn").onclick = async () => {
  if (!lastOrderId) return;

  await navigator.clipboard.writeText(lastOrderId);
  showToast("📋 Номер заказа скопирован");
};

document.getElementById("copyPhoneBtn").onclick = async () => {
  await navigator.clipboard.writeText("+79991210877");

  showToast("📋 Номер скопирован");
};

newOrderBtn.onclick = () => {
  selectedOrderId = null;
  selectedOrderColumn = null;
  orderMode = "normal";

  document.getElementById("clientModal").style.display = "none";

  document.getElementById("orderLabelModal").style.display = "flex";
  lockBody();

  const nextOrderNumber = (foundClient?.orderCount || 0) + 1;

  document.getElementById("orderLabelTitle").textContent =
    "🍅 ЗАКАЗ " + nextOrderNumber;
};

document.getElementById("closeOrderLabelModal").onclick = () => {
  document.getElementById("orderLabelModal").style.display = "none";

  document.getElementById("clientModal").style.display = "flex";
};

document.getElementById("createLabeledOrderBtn").onclick = () => {
  orderLabel = document.getElementById("orderLabelInput").value.trim();

  orderMode = "normal";
  selectedOrderId = null;
  selectedOrderColumn = null;

  document.getElementById("orderLabelModal").style.display = "none";

  submitOrder();
};

document.getElementById("addonOrderBtn").onclick = () => {
  orderMode = "addon";

  if (clientOrders.length <= 1) {
    selectedOrderId = clientOrders[0]?.orderId || null;
    selectedOrderColumn = clientOrders[0]?.column || null;
    document.getElementById("clientModal").style.display = "none";

    submitOrder();

    return;
  }

  showOrderSelectModal();
};

function showOrderSelectModal() {
  document.getElementById("closeOrderSelectBtn").onclick = () => {
    vibrate(15);

    document.getElementById("orderSelectModal").style.display = "none";

    document.getElementById("clientModal").style.display = "flex";
  };

  const list = document.getElementById("orderSelectList");

  list.innerHTML = "";

  clientOrders.forEach((order) => {
    const card = document.createElement("button");

    card.className = "order-select-card";
    card.type = "button";

    const parts = order.header.split("  ");

    const title = order.title || parts[3] || "Свой заказ";

    const label = order.label || "";

    const orderIdText = order.orderId
      ? " • " + order.orderId
      : "";

    card.innerHTML = `

      <div class="order-select-top">

        <div>${escapeHtml(title)}${escapeHtml(orderIdText)}</div>

        <div class="order-select-qty">
          ${order.totalQty} п
        </div>

      </div>

      ${label ? `<div class="order-select-label">${escapeHtml(label)}</div>` : ""}

    `;

    card.onclick = () => {
      selectedOrderColumn = order.column;
      selectedOrderId = order.orderId || null;

      document.getElementById("orderSelectModal").style.display = "none";

      document.getElementById("clientModal").style.display = "none";

      submitOrder();
    };

    list.appendChild(card);
  });

  document.getElementById("orderSelectModal").style.display = "flex";
  lockBody();
}

document.getElementById("cartBackBtn").onclick = () => {
  cartBox.classList.add("modal-hide");

  setTimeout(() => {
    cartModal.style.display = "none";

    unlockBody();

    cartBox.classList.remove("modal-hide");

    const savedPosition = Number(
      sessionStorage.getItem("tomatoCatalogScroll") || catalogScrollPosition,
    );

    requestAnimationFrame(() => {
      window.scrollTo({ top: savedPosition, behavior: "auto" });
    });
  }, 200);
};

document.getElementById("checkoutBackBtn").onclick = () => {

  if (orderSending) return;

  checkoutBox.classList.add("modal-hide");

  setTimeout(() => {
    checkoutModal.style.display = "none";
    checkoutBox.classList.remove("modal-hide");
    cartModal.style.display = "flex";
    lockBody();
    cartBox.classList.add("modal-open-medium");
    setTimeout(() => cartBox.classList.remove("modal-open-medium"), 450);
  }, 200);

};

let pendingSheetData = null;

try {
  const pendingSheet = localStorage.getItem("pendingSheet");
  pendingSheetData = pendingSheet ? JSON.parse(pendingSheet) : null;
} catch (error) {
  localStorage.removeItem("pendingSheet");
}

if (pendingSheetData) {
  const data = pendingSheetData;

  document.getElementById("sheetTitle").textContent = data.title;
  lastOrderId = data.orderId || "";
  const copyOrderIdBtn = document.getElementById("copyOrderIdBtn");
  copyOrderIdBtn.style.display = lastOrderId ? "inline-flex" : "none";
  copyOrderIdBtn.textContent = lastOrderId ? "Скопировать " + lastOrderId : "Скопировать номер";

  document.getElementById("sheetDate").innerHTML = data.date;

  document.getElementById("sheetClient").innerHTML = data.client;

  setSheetAddonSummary({
    isAddon: data.mode === "addon",
    addedTotal: Number.isFinite(Number(data.addedTotal))
      ? Number(data.addedTotal)
      : Number(String(data.total || "").replace(/\D/g, "")) || 0,
    orderTotal: data.orderTotal,
  });

  document.getElementById("sheetTotalItems").textContent = data.totalItems;

  sheetItems.innerHTML = data.items
    .map((item) => {
      const shortTitle =
        item.title.length > 14 ? item.title.slice(0, 12) + ".." : item.title;

      return `
        <div class="sheet-chip">
          <span class="sheet-name">
            ${escapeHtml(item.id)} ${escapeHtml(shortTitle)}
          </span>

          <span class="sheet-qty">
            ${Number(item.qty) || 0}п
          </span>
        </div>
      `;
    })
    .join("");

  sheetModal.style.display = "flex";

  lockBody();

  document.getElementById("saveBtn").style.display = "none";

  generatedFile = null;
  const pngToken = ++sheetGenerationToken;
  const restoredOrderForPng = savedOrders.find(
    (order) => String(order.orderId) === String(data.orderId),
  );
  createSheetPngFile({
    orderId: data.orderId || "order",
    cacheKey: getSavedOrderPngCacheKey(restoredOrderForPng),
    delayMs: 50,
    token: pngToken,
  })
    .then((file) => {
      if (!file || pngToken !== sheetGenerationToken) return;
      generatedFile = file;
      document.getElementById("saveBtn").style.display = "flex";
    })
    .catch((error) => {
      console.error("Не удалось подготовить сохраненную карточку", error);
      if (pngToken === sheetGenerationToken) {
        showToast("Карточку заказа не удалось подготовить");
      }
    });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register("./sw.js?v=91");
  });
}

function press(btn) {
  btn.classList.remove("pressed");

  void btn.offsetWidth;

  btn.classList.add("pressed");

  setTimeout(() => {
    btn.classList.remove("pressed");
  }, 120);
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button");

  if (!btn) return;

  press(btn);
});
