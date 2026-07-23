function vibrate(ms = 20) {
  if ("vibrate" in navigator) {
    navigator.vibrate(ms);
  }
}

let products = [];

const CATALOG_API_URL =
  "https://script.google.com/macros/s/AKfycbwAIYzIGkeGriT_B4Z1M58oK1xqexMiyDpE4eGnQTTQt-CeJwbeh_vkqXMXipE1END2/exec";
const CATALOG_CACHE_KEY = "tomatoCatalogCacheV1";
const CATALOG_CACHE_TTL = 5 * 60 * 1000;

const SAVED_ORDERS_KEY = "savedOrders";
const SAVED_ORDERS_LIMIT = 10;
const ORDER_DRAFT_KEY = "tomatoOrderDraft";
const PENDING_ORDER_REQUEST_KEY = "tomatoPendingOrderRequest";
const RESET_VERSION_KEY = "tomatoResetVersion";
const RESET_DATE = new Date("2027-05-01T00:00:00+03:00").getTime();
const RESET_VERSION = "2027-05-01";

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
    schemaVersion: 1,
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
    orderLabel: payload.orderLabel || "",
    items: (payload.items || [])
      .map((item) => ({ id: String(item.id), qty: Number(item.qty) || 0 }))
      .sort((a, b) => a.id.localeCompare(b.id, "ru", { numeric: true })),
  });
}

function getOrCreateClientRequestId(payload) {
  const signature = getOrderRequestSignature(payload);

  try {
    const pending = JSON.parse(
      localStorage.getItem(PENDING_ORDER_REQUEST_KEY) || "null",
    );

    if (pending && pending.id && pending.signature === signature) {
      return String(pending.id);
    }
  } catch (error) {
    localStorage.removeItem(PENDING_ORDER_REQUEST_KEY);
  }

  const id = createClientRequestId();
  localStorage.setItem(
    PENDING_ORDER_REQUEST_KEY,
    JSON.stringify({ id, signature, createdAt: new Date().toISOString() }),
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
    localStorage.setItem(
      CATALOG_CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), data }),
    );
  } catch (error) {
    console.warn("Каталог не удалось сохранить в кэш", error);
  }
}

async function loadCatalogData() {
  const freshCache = readCatalogCache();
  if (freshCache) return freshCache;

  try {
    const data = await fetchJsonWithTimeout(CATALOG_API_URL, {}, 12000);
    writeCatalogCache(data);
    return data;
  } catch (error) {
    const fallbackCache = readCatalogCache(true);
    if (fallbackCache) return fallbackCache;
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
    button.textContent = "Добавить";
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
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          fitProductTitles(entry.target);
        }
      });
    },
    { rootMargin: "350px 0px" },
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
      loadingTomato.src = "./tomato/tomato-angry-ui.png";
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
  catalog.innerHTML = "";

  const fragment = document.createDocumentFragment();

  products.forEach((product, productIndex) => {
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
`);

    card.innerHTML = `

  <div class="product-number">
    ${product.id}
  </div>

  <div class="product-image">

  <img
    src="${product.image}"
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
  ${cleanTitle}
</div>

${isHit ? '<div class="badge-hit">🔥ХИТ</div>' : ""}

${isNew ? '<div class="badge-new">⭐НОВИНКА</div>' : ""}

<div class="cart-stamp" aria-live="polite" aria-hidden="true"></div>
  </div>

  <div class="product-right">

    <div class="product-price">
      ${product.price} ₽
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
      addBtn.innerHTML = "Нет<br>в наличии";

      qtyText.textContent = "0";

      addBtn.disabled = true;

      plusBtn.disabled = true;

      minusBtn.disabled = true;

      card.classList.add("out-of-stock");
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

  catalog.appendChild(fragment);
  observeProductTitleFitting();
  syncProductCardsFromCart();
}

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

  document.getElementById("cartCount").innerHTML = `${totalItems} пак.`;

  const cartPrice = document.getElementById("cartPrice");

  cartPrice.innerHTML = `${totalPrice.toLocaleString("ru-RU")} ₽`;

  cartPrice.classList.remove("price-pop");

  void cartPrice.offsetWidth;

  cartPrice.classList.add("price-pop");

  document.getElementById("cartPrice").innerHTML =
    `${totalPrice.toLocaleString("ru-RU")} ₽`;

  document.getElementById("cartFooterCount").innerHTML = `${totalItems} пак.`;

  document.getElementById("cartFooterPrice").innerHTML =
    `${totalPrice.toLocaleString("ru-RU")} ₽`;

  const checkoutBtn = document.getElementById("checkoutBtn");

  if (cart.length === 0) {
    checkoutBtn.classList.add("disabled-btn");
  } else {
    checkoutBtn.classList.remove("disabled-btn");
  }

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
        ${item.id} ${item.title}
      </div>

      <div class="cart-controls">

        <button class="minus" aria-label="Уменьшить количество">
          −
        </button>

        <span class="cart-qty">
        ${item.qty}
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

async function submitOrder() {

  if (orderSending) return;

  orderSending = true;

  const btn = document.getElementById("createOrderBtn");
  const orderSubmitError = document.getElementById("orderSubmitError");

  if (orderSubmitError) orderSubmitError.hidden = true;

  const nameInput = document.getElementById("clientName");

  const phoneInput = document.getElementById("clientPhone");

  const pickupPoint = document.getElementById("pickupPoint");

  if (foundClient) {
    document.getElementById("clientName").style.display = "none";

    document.getElementById("clientPhone").style.display = "none";

    document.getElementById("pickupTrigger").style.display = "none";

    document.getElementById("pvzAddress").style.display = "none";
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

  let name = nameInput.value.trim();

  let phone = phoneInput.value.trim();

  let pickupText =
    pickupPoint.value === "ozon"
      ? `Ozon • ${pvzAddress.value}`
      : pickupPoint.options[pickupPoint.selectedIndex].text;

  if (foundClient) {
  name = foundClient.name;

  phone = formatPhone(foundClient.phone);

  pickupText = foundClient.pickup;
}

  const submittedItems = cart.map((item) => ({
    id: item.id,
    title: item.title,
    price: Number(item.price) || 0,
    qty: Number(item.qty) || 0,
  }));

  const totalPrice = submittedItems.reduce((sum, item) => {
    return sum + item.price * item.qty;
  }, 0);

  const totalItems = submittedItems.reduce((sum, item) => {
    return sum + item.qty;
  }, 0);

  const orderPayload = {
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

  const clientRequestId = getOrCreateClientRequestId(orderPayload);
  orderPayload.clientRequestId = clientRequestId;

  fetch(CATALOG_API_URL, {
    method: "POST",
    body: JSON.stringify(orderPayload),
  })
    .then((res) => {
      if (!res.ok) {
        throw new Error("HTTP " + res.status);
      }

      return res.json();
    })
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

      const orderId = result.orderId;
      const serverTotal = Number(result.total);
      const confirmedTotalPrice = Number.isFinite(serverTotal)
        ? serverTotal
        : totalPrice;

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

      document.getElementById("sheetOrderLabel").textContent = orderLabel || "";


      document.getElementById("sheetClient").innerHTML = `
    ${escapeHtml(name)}
    <br>
    ${escapeHtml(phone)}

    <div class="sheet-pickup">
      ${escapeHtml(pickupText)}
    </div>
  `;

      document.getElementById("sheetTotal").innerHTML =
        `${confirmedTotalPrice.toLocaleString("ru-RU")} ₽`;

      document.getElementById("sheetTotalItems").innerHTML = `${totalItems} п`;

      try {
        saveOrderSnapshot({
          orderId,
          title: document.getElementById("sheetTitle").textContent,
          mode: orderMode,
          orderLabel,
          name,
          phone,
          pickup: pickupText,
          createdAt: today.toISOString(),
          dateLabel: today.toLocaleDateString("ru-RU"),
          total: confirmedTotalPrice,
          totalItems,
          items: submittedItems,
          clientRequestId,
        });
      } catch (storageError) {
        console.error("Не удалось сохранить локальную копию заказа", storageError);
      } finally {
        clearClientRequestId(clientRequestId);
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
        orderSubmitError.hidden = false;
      }

      showToast("⚠️ Google временно не ответил. Корзина сохранена");
    });
}

/* CREATE ORDER */

document.getElementById("createOrderBtn").onclick = async () => {
  if (orderSending) return;
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

  // RESET

  nameInput.classList.remove("input-error");

  phoneInput.classList.remove("input-error");

  pickupPoint.classList.remove("input-error");

  let hasError = false;

  // NAME

  const nameRegex = /^[A-Za-zА-Яа-яЁё\s-]+$/;

  if (!nameInput.value.trim() || !nameRegex.test(nameInput.value.trim())) {
    nameInput.classList.add("input-error");

    hasError = true;
  }

  // PHONE

  const phoneRegex = /^\+7 \(\d{3}\) \d{3}-\d{2}-\d{2}$/;

  if (!phoneInput.value.trim() || !phoneRegex.test(phoneInput.value.trim())) {
    phoneInput.classList.add("input-error");

    hasError = true;
  }

  // PICKUP

  if (!pickupPoint.value) {
    pickupTrigger.classList.add("input-error");

    hasError = true;
  }

  /* PVZ */

  const pvzInput = document.getElementById("pvzAddress");

  if (pickupPoint.value === "ozon" && !pvzInput.value.trim()) {
    pvzInput.classList.add("input-error");

    hasError = true;
  }

  if (hasError) {
    btn.classList.remove("loading-btn");

    btn.disabled = false;
  btn.removeAttribute("aria-busy");

  btn.innerHTML = "Создать заказ";

    orderSending = false;

    return;
  }

  const phone = phoneInput.value.trim().replace(/\D/g, "");

  try {
    const data = await fetchJsonWithTimeout(
      CATALOG_API_URL + "?phone=" +
        encodeURIComponent(phone),
      {},
      10000,
    );

    if (isSeasonClosedResponse(data)) {
      showCatalogSeasonClosed(true);
      return;
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

    showToast("⚠️ Не удалось проверить номер. Повторите ещё раз");
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

document.getElementById("saveBtn").onclick = async () => {
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
  if (pickupPoint.value === "ozon") {
    pvzAddress.style.display = "block";
  } else {
    pvzAddress.style.display = "none";
  }
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

  const columns = itemRows.length > 120 ? 4 : itemRows.length > 45 ? 3 : 2;
  const rowHeight = itemRows.length > 120 ? 46 : 54;
  const rows = Math.max(1, Math.ceil(itemRows.length / columns));
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = Math.max(720, 410 + rows * rowHeight);

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

  count.textContent = String(savedOrders.length);
  banner.hidden = savedOrders.length === 0;
}

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
    const row = document.createElement("button");
    row.type = "button";
    row.className = "saved-order-row";

    const main = document.createElement("span");
    main.className = "saved-order-row-main";

    const title = document.createElement("span");
    title.className = "saved-order-row-title";
    title.textContent = `${order.orderId} · ${order.name || "Без имени"}`;

    const total = document.createElement("span");
    total.className = "saved-order-row-total";
    total.textContent = `${(Number(order.total) || 0).toLocaleString("ru-RU")} ₽`;

    const date = document.createElement("span");
    date.className = "saved-order-row-date";
    date.textContent = getSavedOrderDate(order);

    main.append(title, total);
    row.append(main, date);
    row.addEventListener("click", () => {
      if (row.disabled) return;
      row.disabled = true;
      row.classList.add("saved-orders-pressed");
      setTimeout(() => openSavedOrderCard(order), 110);
    });
    list.appendChild(row);
  });
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
  document.getElementById("sheetTotal").textContent =
    `${(Number(order.total) || 0).toLocaleString("ru-RU")} ₽`;
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
  sheetGenerationToken++;
  savedSheetMode = false;
  generatedFile = null;
  sheetModal.style.display = "none";
  document.getElementById("savedSheetActions").hidden = true;
  document.querySelector(".sheet-buttons").style.display = "flex";
  document.querySelector(".sheet-message").style.display = "block";
  unlockBody();
  openSavedOrders();
}

renderSavedOrdersSummary();
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
    pvzAddress.style.display = pickupPoint.value === "ozon" ? "block" : "none";
  } catch (error) {
    localStorage.removeItem(ORDER_DRAFT_KEY);
  }
}

restoreOrderDraft();

[nameInput, phoneInput, pvzAddress].forEach((input) => {
  input.addEventListener("input", saveOrderDraft);
});

pickupPoint.addEventListener("change", saveOrderDraft);

/* REMOVE ERROR */

nameInput.addEventListener("input", () => {
  const nameRegex = /^[A-Za-zА-Яа-яЁё\s-]+$/;

  if (nameRegex.test(nameInput.value.trim())) {
    nameInput.classList.remove("input-error");
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
    phoneInput.classList.remove("input-error");
  }
});

pickupPoint.addEventListener("change", () => {
  pickupTrigger.classList.remove("input-error");
});

pvzAddress.addEventListener("input", () => {
  if (pvzAddress.value.trim()) {
    pvzAddress.classList.remove("input-error");
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

  logoTomato.src = "./tomato/tomato-idle-closed-ui.png";

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
    logoTomato.src = "./tomato/tomato-idle-ui.png";
  }, 700);
}

const logoTomato = document.getElementById("logoTomato");

let tomatoAngry = false;

logoTomato.addEventListener("click", () => {
  vibrate(10);

  if (tomatoAngry) return;

  tomatoAngry = true;

  logoTomato.classList.add("tomato-bonk");

  logoTomato.src = "./tomato/tomato-angry-ui.png";

  setTimeout(() => {
    logoTomato.src = "./tomato/tomato-idle-ui.png";

    logoTomato.classList.remove("tomato-bonk");

    tomatoAngry = false;
  }, 250);
});

function launchTomatoKiss() {
  const container = document.getElementById("tomatoHearts");

  if (!container) return;

  const logoTomato = document.getElementById("logoTomato");

  logoTomato.src = "./tomato/tomato-kiss-ui.png";

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
    logoTomato.src = "./tomato/tomato-idle-ui.png";
  }, 800);
}

function launchTomatoBlink() {
  const logoTomato = document.getElementById("logoTomato");

  if (!logoTomato) return;

  logoTomato.src = "./tomato/tomato-idle-closed-ui.png";

  setTimeout(() => {
    logoTomato.src = "./tomato/tomato-idle-ui.png";
  }, 180);
}

function launchTomatoCrown() {
  const container = document.getElementById("tomatoHearts");

  if (!container) return;

  const crown = document.createElement("img");

  crown.src = "./tomato/crown-ui.png";

  crown.className = "crown-pop";

  container.appendChild(crown);

  setTimeout(() => {
    crown.remove();
  }, 1000);
}

loadCatalogData()
  .then(async (data) => {
    if (isSeasonClosedResponse(data)) {
      showCatalogSeasonClosed();
      return;
    }

    const catalogProducts = Array.isArray(data)
      ? data
      : data && Array.isArray(data.products)
        ? data.products
        : null;

    if (!catalogProducts) {
      throw new Error("Сервер вернул некорректный каталог");
    }

    products = catalogProducts;
    const availableProducts = products.filter((p) => p.available === true);

    if (availableProducts.length === 0) {
      showCatalogSeasonClosed();
      return;
    }

    const removed = [];

    cart = cart.filter((item) => {
      const fresh = products.find((p) => p.id == item.id);

      if (!fresh || !fresh.available) {
        removed.push(item.title);

        return false;
      }

      return true;
    });

    updateCart();

    if (removed.length > 0) {
      if (removed.length === 1) {
        showToast(`🍅 Сорт "${removed[0]}" закончился`);
      } else {
        showToast(`🍅 Закончились сорта (${removed.length})`);
      }
    }

    const pickupMenu = document.getElementById("pickupMenu");

    const pickupPoint = document.getElementById("pickupPoint");

    pickupTrigger.addEventListener("click", () => {
      pickupMenu.classList.toggle("open");
    });

    document.addEventListener("click", (e) => {

  if (
    !e.target.closest(".pickup-dropdown")
  ) {
    pickupMenu.classList.remove("open");
  }

});

    document.querySelectorAll(".pickup-option").forEach((option) => {
      option.addEventListener("click", () => {
        const text = option.textContent.trim();

        const value = option.dataset.value;

        pickupTrigger.textContent = text;

        pickupPoint.value = value;

        pickupPoint.dispatchEvent(new Event("change"));

        pickupMenu.classList.remove("open");
      });
    });

    renderProducts();
    const [initialImages] = await Promise.all([
      waitForInitialProductImages(24, 8000),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);

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

  requestAnimationFrame(fitProductTitles);
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

  fly.src = "./tomato/info-popup-ui.png";

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

  closeBtn.addEventListener("click", () => {
    fly.remove();

    closeBtn.remove();

    overlay.remove();

    infoToggle.style.opacity = "1";

    infoToggle.src = "./tomato/info-tag.png";
  });

  overlay.addEventListener("click", () => {
    fly.remove();

    closeBtn.remove();

    overlay.remove();

    infoToggle.style.opacity = "1";

    infoToggle.src = "./tomato/info-tag.png";
  });

  fly.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  requestAnimationFrame(() => {
    const finalWidth = Math.min(window.innerWidth * 0.92, 420);

    const ratio = 420 / 600;

    const finalHeight = finalWidth / ratio;

    closeBtn.style.left =
      (window.innerWidth - finalWidth) / 2 + finalWidth - 20 + "px";

    closeBtn.style.top = (window.innerHeight - finalHeight) / 2 - 20 + "px";

    fly.style.transition = "all .55s cubic-bezier(.22,1,.36,1)";

    fly.style.left = (window.innerWidth - finalWidth) / 2 + "px";

    fly.style.top = (window.innerHeight - finalHeight) / 2 + "px";

    fly.style.width = finalWidth + "px";

    fly.style.height = finalHeight + "px";
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
    const card = document.createElement("div");

    card.className = "order-select-card";

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

    unlockBody();

    checkoutBox.classList.remove("modal-hide");
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

  document.getElementById("sheetTotal").innerHTML = data.total;

  document.getElementById("sheetTotalItems").innerHTML = data.totalItems;

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
    navigator.serviceWorker.register("./sw.js");
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


