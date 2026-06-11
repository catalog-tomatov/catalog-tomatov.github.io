function vibrate(ms = 20) {
  if ("vibrate" in navigator) {
    navigator.vibrate(ms);
  }
}

let products = [];

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

/* CART */

let cart = [];

const savedCart = localStorage.getItem("tomatoCart");

if (savedCart) {
  cart = JSON.parse(savedCart);
}

/* PRODUCTS */

function renderProducts() {
  catalog.innerHTML = "";

  const fragment = document.createDocumentFragment();

  products.forEach((product) => {
    const isHit = product.isHit || product.title.includes("[hit]");

    const isNew = product.isNew || product.title.includes("[new]");

    const cleanTitle = product.title;

    const card = document.createElement("div");

    card.className = "product";

    card.dataset.search = `
${product.id}
#${product.id}
№${product.id}
${product.title}
${product.description}
${isHit ? "hit хит" : ""}
${isNew ? "new новинка" : ""}
`.toLowerCase();

    card.innerHTML = `

  <div class="product-number">
    ${product.id}
  </div>

  <div class="product-image">

  <img
    src="${product.image}"
    loading="${product.id <= 8 ? "eager" : "lazy"}"
  >

</div>

  <div class="product-info">

   <div class="product-title">
  ${cleanTitle}
</div>

${isHit ? '<div class="badge-hit">🔥ХИТ</div>' : ""}

${isNew ? '<div class="badge-new">⭐НОВИНКА</div>' : ""}
  </div>

  <div class="product-right">

    <div class="product-price">
      ${product.price} ₽
    </div>

    <div class="controls">

      <button class="minus">
        -
      </button>

      <span class="qty">

  <span class="qty-value">
    1
  </span>

</span>

      <button class="plus">
        +
      </button>

    </div>

    <button class="add-btn">
      Добавить
    </button>

  </div>

`;

    const titleEl = card.querySelector(".product-title");

    let size = window.innerWidth <= 390 ? 15.8 : 16;

    const len = product.title.length;

    if (len > 15) size -= 0.3;
    if (len > 20) size -= 0.5;
    if (len > 24) size -= 0.8;
    if (len > 36) size -= 1;

    titleEl.style.fontSize = size + "px";

    let qty = 1;

    let qtyAnimating = false;

    const qtyBubble = card.querySelector(".qty");

    const qtyText = card.querySelector(".qty-value");

    const addBtn = card.querySelector(".add-btn");

    const plusBtn = card.querySelector(".plus");

    const minusBtn = card.querySelector(".minus");

    /* PLUS */

    card.querySelector(".plus").addEventListener("click", (e) => {
      e.stopPropagation();
      vibrate(15);

      if (qtyAnimating) return;

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
      vibrate(15);
      if (qtyAnimating) return;

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

      addToCart(product, qty);
      vibrate(15);
    });

    /* POPUP */

    card.addEventListener("click", (e) => {
      if (e.target.closest(".controls") || e.target.closest(".add-btn")) {
        return;
      }
      clearSearchBtn.classList.add("clear-search-pressed");

      setTimeout(() => {
        clearSearch();
      }, 120);

      setTimeout(() => {
        popup.style.display = "flex";
        lockBody();
      }, 140);

      popupBox.classList.add("modal-open-soft");

      setTimeout(() => {
        popupBox.classList.remove("modal-open-soft");
      }, 300);

      document.getElementById("popupImage").src = product.image;

      document.getElementById("popupTitle").innerHTML = product.title;

      document.getElementById("popupDescription").innerHTML =
        product.description;
    });

    const img = card.querySelector('.product-image img');
if (img) {
  // Если изображение уже загружено (кеш)
  if (img.complete) {
    img.classList.add('loaded');
  } else {
    img.onload = () => img.classList.add('loaded');
  }
}

    fragment.appendChild(card);
  });

  catalog.appendChild(fragment);
}

/* ADD TO CART */

function addToCart(product, qty) {
  const existing = cart.find((item) => {
    return item.id === product.id;
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

        <button class="minus">
          -
        </button>

        <span class="cart-qty">
        ${item.qty}
        </span>

        <button class="plus">
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
  console.log("submitOrder", orderSending, orderMode, foundClient);

  if (orderSending) return;

  orderSending = true;

  const btn = document.getElementById("createOrderBtn");

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

  const totalPrice = cart.reduce((sum, item) => {
    return sum + item.price * item.qty;
  }, 0);

  const totalItems = cart.reduce((sum, item) => {
    return sum + item.qty;
  }, 0);

  console.log("DEBUG", orderMode, selectedOrderColumn, orderLabel);

  fetch(
    "https://script.google.com/macros/s/AKfycbwAIYzIGkeGriT_B4Z1M58oK1xqexMiyDpE4eGnQTTQt-CeJwbeh_vkqXMXipE1END2/exec",
    {
      method: "POST",

      body: JSON.stringify({
        name: name,

        phone: phone,

        pickup: pickupText,

        mode: orderMode,

        selectedOrderColumn: selectedOrderColumn,

        orderLabel: orderLabel,

        items: cart.map((item) => ({
          id: item.id,
          qty: item.qty,
        })),

        total: totalPrice,
      }),
    },
  )
    .then((res) => {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    })
    .then(() => {
      const today = new Date();

      console.log("OPEN CLIENT MODAL", new Date().toLocaleTimeString());

      console.log("OPEN SHEET MODAL", new Date().toLocaleTimeString());
      document.getElementById("clientModal").style.display = "none";
      unlockBody();

      document.getElementById("orderSelectModal").style.display = "none";
      unlockBody();

      const orderNumber = foundClient ? foundClient.orderCount + 1 : 1;

      document.getElementById("sheetTitle").textContent =
        orderMode === "addon"
          ? "ДОЗАКАЗАТЬ"
          : orderNumber > 1
            ? "КАРТОЧКА ЗАКАЗА " + orderNumber
            : "КАРТОЧКА ЗАКАЗА";

      document.getElementById("sheetDate").innerHTML =
        today.toLocaleDateString("ru-RU");

      document.getElementById("sheetOrderLabel").textContent = orderLabel || "";

      const pickupText =
        pickupPoint.value === "ozon"
          ? `Ozon • ${pvzAddress.value}`
          : pickupPoint.options[pickupPoint.selectedIndex].text;

      document.getElementById("sheetClient").innerHTML = `
    ${name}
    <br>
    ${phone}

    <div class="sheet-pickup">
      ${pickupText}
    </div>
  `;

      document.getElementById("sheetTotal").innerHTML =
        `${totalPrice.toLocaleString("ru-RU")} ₽`;

      document.getElementById("sheetTotalItems").innerHTML = `${totalItems} п`;
      localStorage.setItem(
        "pendingSheet",
        JSON.stringify({
          title: document.getElementById("sheetTitle").textContent,
          date: today.toLocaleDateString("ru-RU"),
          client: `
      ${name}
      <br>
      ${phone}
      <div class="sheet-pickup">
        ${pickupText}
      </div>
    `,
          total: `${totalPrice.toLocaleString("ru-RU")} ₽`,
          totalItems: `${totalItems} п`,
          items: cart,
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
      ${item.id} ${shortTitle}
    </span>

    <span class="sheet-qty">
      ${item.qty}п
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

        document.querySelector(".sheet-buttons").style.display = "flex";

        document.body.style.overflow = "hidden";

        const duration = 800;

        const end = Date.now() + duration;

        const colors = ["#18b978", "#ffd76d", "#9b1801", "#ffffff"];

        (function frame() {
          confetti({
            particleCount: 4,
            angle: 60,
            spread: 70,
            origin: { x: 0 },
            colors,
          });

          confetti({
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
        setTimeout(() => {
          document.querySelectorAll("canvas").forEach((c) => c.remove());
          const original = document.getElementById("sheetBox");

          const clone = original.cloneNode(true);

          clone.querySelectorAll("img").forEach((img) => {
            img.remove();
          });

          clone.style.borderRadius = "28px";
          clone.style.overflow = "hidden";

          clone.style.maxHeight = "none";
          

          const cloneItems = clone.querySelector("#sheetItems");

          if (cloneItems) {
            cloneItems.style.maxHeight = "none";
            cloneItems.style.overflow = "visible";
          }

          const sandbox = document.createElement("div");

          sandbox.style.position = "fixed";
          sandbox.style.left = "-99999px";
          sandbox.style.top = "0";

          sandbox.appendChild(clone);

          document.body.appendChild(sandbox);

          clone.querySelectorAll("*").forEach((el) => {
            el.style.backgroundImage = "none";
          });

          html2canvas(clone, {
            scale: 2,
            useCORS: false,
            imageTimeout: 0,
            backgroundColor: null,
          }).then((canvas) => {
            sandbox.remove();

            canvas.toBlob((blob) => {
              generatedFile = new File([blob], "order.png", {
                type: "image/png",
              });

              document.getElementById("saveBtn").style.display = "flex";
            }, "image/png");
          });
        }, 1800);
      }, 900);
    })

    .catch((err) => {

  document.getElementById("loadingBlocker")?.remove();

  orderSending = false;

  btn.classList.remove("loading-btn");

  btn.innerHTML = "Создать заказ";

  showToast("⚠️ Нет соединения с интернетом");
});
}

/* CREATE ORDER */

document.getElementById("createOrderBtn").onclick = async () => {
  if (orderSending) return;
  orderSending = true;

  const btn = document.getElementById("createOrderBtn");

  btn.classList.add("loading-btn");

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

    btn.innerHTML = "Создать заказ";

    orderSending = false;

    return;
  }

  const phone = phoneInput.value.trim().replace(/\D/g, "");

  try {
    const res = await fetch(
      "https://script.google.com/macros/s/AKfycbwAIYzIGkeGriT_B4Z1M58oK1xqexMiyDpE4eGnQTTQt-CeJwbeh_vkqXMXipE1END2/exec?phone=" +
        phone,
    );

    const data = await res.json();

    if (data.found || data["Найдено"]) {
      orderSending = false;

      foundClient = data;

      clientOrders = data.orders || [];

      document.getElementById("clientFoundInfo").innerHTML = `

  <div class="client-row">
  <span class="client-icon person-icon"></span>
  <span>${data.name}</span>
</div>

<div class="client-row">
  <span class="client-icon phone-icon"></span>
  <span>${data.phone}</span>
</div>

<div class="client-row">
  <span class="client-icon map-icon"></span>
  <span>${data.pickup}</span>
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

      btn.innerHTML = "Создать заказ";
      return;
    }
  } catch (err) {
    console.log(err);
  }

  orderMode = "normal";

  orderSending = false;

  submitOrder();

  return;
};

/* SAVE */

document.getElementById("saveBtn").onclick = async () => {
  if (!generatedFile) {
    showToast("⏳ Карточка ещё создаётся");
    return;
  }

  try {
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

    await navigator.share({
      files: [generatedFile],
      title: "Заказ по семенам томатов",
      text: `${greeting}! Направляю заказ по семенам томатов для подтверждения и оплаты. 🍅`,
    });

    localStorage.removeItem("pendingSheet");

    setTimeout(() => {
      location.reload();
    }, 300);
  } catch (err) {
    console.log("Отправка отменена", err);
  }
};

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

let orderMode = "normal";

let orderLabel = "";

let orderSending = false;

let cardDownloaded = false;

let generatedFile = null;

/* REMOVE ERROR */

nameInput.addEventListener("input", () => {
  const nameRegex = /^[A-Za-zА-Яа-яЁё\s-]+$/;

  if (nameRegex.test(nameInput.value.trim())) {
    nameInput.classList.remove("input-error");
  }
});

phoneInput.addEventListener("input", () => {
  let value = phoneInput.value.replace(/\D/g, "");

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

    clearSearch();
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

fetch(
  "https://script.google.com/macros/s/AKfycbwAIYzIGkeGriT_B4Z1M58oK1xqexMiyDpE4eGnQTTQt-CeJwbeh_vkqXMXipE1END2/exec",
)
  .then((res) => res.json())

  .then((data) => {
    products = data;
    const availableProducts = products.filter((p) => p.available === true);

    if (availableProducts.length === 0) {
      document.getElementById("catalog").style.display = "none";

      document.getElementById("catalogClosed").style.display = "block";
      document.getElementById("loadingScreen")?.remove();

      document.querySelector(".header").classList.add("season-closed");
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

    const style = document.createElement("style");

    style.textContent = `
@keyframes warningFloat {
  0%   { transform: translateY(0); }
  50%  { transform: translateY(-8px); }
  100% { transform: translateY(0); }
}

`;

    document.head.appendChild(style);

    document.querySelectorAll("img").forEach((img) => {
      if (!img.src.includes("imgfy.ru")) return;

      img.addEventListener(
        "error",
        () => {
          document.body.innerHTML = `
      <div style="
        min-height:80vh;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        padding:24px;
        text-align:center;
      ">
   
        <div style="
        font-size:72px;
        margin-bottom:20px;
         animation: warningFloat 3s cubic-bezier(0.42, 0, 0.58, 1) infinite;
        ">
        ⚠️
      </div>

        <div style="
          font-size:20px;
          line-height:1.6;
        ">
          Отключите VPN и перезапустите каталог
        </div>
        <button
    onmousedown="this.style.transform='scale(.97)'"
    onmouseup="this.style.transform='scale(1)'"
    ontouchstart="this.style.transform='scale(.97)'"
    ontouchend="this.style.transform='scale(1)'"
    onclick="location.reload()"
    style="
    margin-top:24px;
    min-width:220px;
    height:52px;
    border:none;
    border-radius:26px;
    font-size:17px;
    letter-spacing: 0.3px;
    font-weight:600;
    background:#18b978;
    color:#fff;
    cursor:pointer;
    box-shadow:0 4px 14px rgba(24,185,120,.25);

    
  "
>
  Перезапустить каталог
</button>
  
      </div>
    `;
        },
        { once: true },
      );
    });

    updateCart();

    const loadingTomato = document.getElementById("loadingTomato");

    // стартуем с надутого
    loadingTomato.src = "./tomato/tomato-breath.png";

    setTimeout(() => {
      // стал обычным
      loadingTomato.src = "./tomato/tomato-idle.png";
    }, 400);

    setTimeout(() => {
      // полетел после возврата
      const target = document.querySelector(".logo-tomato-wrap");

      const rect = target.getBoundingClientRect();

      loadingTomato.style.transition = "all 0.55s cubic-bezier(0.22,1,0.36,1)";

      loadingTomato.style.left = `${rect.left}px`;

      loadingTomato.style.top = `${rect.top}px`;

      loadingTomato.style.width = `${rect.width}px`;

      loadingTomato.style.transform = "translate(0,0)";
    }, 900);

    setTimeout(() => {
      document.getElementById("loadingScreen").remove();
    }, 1000);
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

searchInput.addEventListener("input", () => {
  let search = searchInput.value.toLowerCase().trim();

  if (search === "🔥") {
    search = "хит";
  }

  if (search === "⭐") {
    search = "новинка";
  }

  clearSearchBtn.style.display = search ? "block" : "none";

  document.querySelectorAll(".product").forEach((card) => {
    const text = card.dataset.search || "";

    card.style.display = text.includes(search) ? "" : "none";
  });
});

function clearSearch() {
  searchInput.value = "";

  const clearBtn = document.getElementById("clearSearch");

  if (clearBtn) {
    clearBtn.style.display = "none";
  }

  document.querySelectorAll(".product").forEach((card) => {
    card.style.display = "";
  });
}

clearSearchBtn.addEventListener("click", () => {
  setTimeout(() => {
    clearSearch();
  }, 80);
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

const infoPopup = document.getElementById("infoPopup");

infoToggle.addEventListener("click", () => {
  vibrate(15);

  infoToggle.src = "./tomato/info-click.png";

  infoToggle.style.opacity = "0";

  const start = infoToggle.getBoundingClientRect();

  const fly = document.createElement("img");

  fly.src = "./tomato/info-popup.png";

  fly.className = "info-fly";

  fly.style.left = start.left + "px";

  fly.style.top = start.top + "px";

  fly.style.width = start.width + "px";

  fly.style.height = start.height + "px";

  fly.src = "./tomato/info-popup.png";

  fly.className = "info-fly";

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

    infoToggle.src = "./tomato/info.png";
  });

  overlay.addEventListener("click", () => {
    fly.remove();

    closeBtn.remove();

    overlay.remove();

    infoToggle.style.opacity = "1";

    infoToggle.src = "./tomato/info.png";
  });

  fly.addEventListener("click", (e) => {
    e.stopPropagation();
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

    const title = parts[3] || "Свой заказ";

    const label = parts[4] || "";

    card.innerHTML = `

      <div class="order-select-top">

        <div>${title}</div>

        <div class="order-select-qty">
          ${order.totalQty} п
        </div>

      </div>

      ${label ? `<div class="order-select-label">${label}</div>` : ""}

    `;

    card.onclick = () => {
      selectedOrderColumn = order.column;

      document.getElementById("orderSelectModal").style.display = "none";

      document.getElementById("clientModal").style.display = "none";

      submitOrder();
    };

    list.appendChild(card);
  });

  document.getElementById("orderSelectModal").style.display = "flex";
  lockBody();
}

document.getElementById("hitFilter")?.addEventListener("click", () => {
  searchInput.value = "хит";

  searchInput.dispatchEvent(new Event("input"));
});

document.getElementById("newFilter")?.addEventListener("click", () => {
  searchInput.value = "новинка";

  searchInput.dispatchEvent(new Event("input"));
});

const hints = document.getElementById("searchHints");

let hintsOpened = false;

/* показать / скрыть по нажатию */

searchInput.addEventListener("click", (e) => {
  e.stopPropagation();

  if (hintsOpened) {
    hints.style.display = "none";
    hintsOpened = false;
  } else {
    hints.style.display = "block";
    hintsOpened = true;
  }
});

/* начал печатать -> скрыть */

searchInput.addEventListener("input", () => {
  hints.style.display = "none";
  hintsOpened = false;
});

/* клик вне поиска -> скрыть */

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box") && !e.target.closest("#searchHints")) {
    hints.style.display = "none";
    hintsOpened = false;
  }
});

document.querySelectorAll(".search-hint").forEach((item) => {
  item.addEventListener("click", () => {
    if (item.dataset.search === "хит") {
      searchInput.value = "🔥";
    } else if (item.dataset.search === "новинка") {
      searchInput.value = "⭐";
    } else {
      searchInput.value = item.dataset.search;
    }

    searchInput.dispatchEvent(new Event("input"));

    hints.style.display = "none";
  });
});

document.getElementById("cartBackBtn").onclick = () => {
  cartBox.classList.add("modal-hide");

  setTimeout(() => {
    cartModal.style.display = "none";

    unlockBody();

    cartBox.classList.remove("modal-hide");
  }, 200);
};

const pendingSheet = localStorage.getItem("pendingSheet");

if (pendingSheet) {
  const data = JSON.parse(pendingSheet);

  document.getElementById("sheetTitle").textContent = data.title;

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
            ${item.id} ${shortTitle}
          </span>

          <span class="sheet-qty">
            ${item.qty}п
          </span>
        </div>
      `;
    })
    .join("");

  sheetModal.style.display = "flex";

  lockBody();

  document.getElementById("saveBtn").style.display = "none";

  setTimeout(() => {

  const original = document.getElementById("sheetBox");

  const clone = original.cloneNode(true);

  clone.querySelectorAll("img").forEach(img => {
    img.remove();
  });

  clone.style.borderRadius = "28px";
  clone.style.overflow = "hidden";

  const sandbox = document.createElement("div");

  sandbox.style.position = "fixed";
  sandbox.style.left = "-99999px";

  sandbox.appendChild(clone);

  document.body.appendChild(sandbox);

  html2canvas(clone, {
    scale: 2,
    useCORS: false,
    imageTimeout: 0,
    backgroundColor: null
  }).then(canvas => {

    sandbox.remove();

    canvas.toBlob(blob => {

      generatedFile = new File(
        [blob],
        "order.png",
        {
          type: "image/png"
        }
      );

      document.getElementById("saveBtn").style.display = "flex";

    }, "image/png");

  });

}, 300);
}
