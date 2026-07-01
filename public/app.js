const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const tbody = $("#reviewTableBody");
const states = new Map();
const toast = $("#toast");
const REVIEW_TYPES = ["핏감", "컬러감", "착용감", "체형커버", "가성비", "종합적", "소재", "디테일"];
const REVIEW_IMAGE_URL = "https://images002.sabangnet.co.kr/v1/AUTH_c55e59a8ec2149e7ad5e61ca73645bd9/mw167657/image/1782893977980.jpg";
let aiStatusState = { aiConnected: false, model: null, rateLimitResetAt: null };

function renderAiStatus() {
  const element = $("#aiStatus");
  const resetAt = Number(aiStatusState.rateLimitResetAt) || 0;
  const remaining = Math.max(0, resetAt - Date.now());
  if (remaining > 0) {
    const totalSeconds = Math.ceil(remaining / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const time = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
    element.textContent = `GPT 한도 리셋까지 ${time} · 기본 생성 중`;
    element.classList.add("limited");
    return;
  }
  aiStatusState.rateLimitResetAt = null;
  element.textContent = aiStatusState.aiConnected ? `GPT 연결 · ${aiStatusState.model}` : "GPT 미연결";
  element.classList.remove("limited");
}

function updateAiStatus(next) {
  aiStatusState = { ...aiStatusState, ...next };
  renderAiStatus();
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    const error = contentType.includes("json") ? await response.json() : { message: "요청에 실패했습니다." };
    throw new Error(error.message);
  }
  return contentType.includes("json") ? response.json() : response.blob();
}

function busy(button, on, text) {
  if (!button.dataset.html) button.dataset.html = button.innerHTML;
  button.disabled = on;
  button.innerHTML = on ? text : button.dataset.html;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function ids() {
  return [...new Set($("#productId").value.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean))].slice(0, 20);
}

function preferences(toneOverride, lengthOverride, typeOverride) {
  return {
    gender: $("#gender").value,
    age: $("#age").value,
    tone: toneOverride || $("#tone").value,
    length: lengthOverride || $("#reviewLength").value,
    reviewType: typeOverride || $("#reviewType").value,
    command: $("#command").value.trim(),
  };
}

function colorName(label) {
  return String(label || "").split(/[,/|]/)[0].trim().toLowerCase();
}

function distributeOptions(options) {
  const colors = [];
  for (const option of options) {
    const color = colorName(option.label) || option.code;
    if (!colors.some((item) => item.color === color)) colors.push({ color, option });
  }
  const colorOptions = colors.map((item) => item.option);
  if (!colorOptions.length) return [];
  return Array.from({ length: 5 }, (_, index) => colorOptions[index % colorOptions.length].code);
}

function allReviews(state) {
  return state.reviews
    .map((value) => value.trim())
    .filter((value) => value && value !== "리뷰 작성 중...");
}

function render() {
  if (!states.size) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="10">퀸잇 ID를 입력하고 상품 불러오기를 눌러주세요.</td></tr>';
    return;
  }

  tbody.innerHTML = [...states.values()].map((state) => state.reviews.map((review, index) => {
    const product = state.product;
    const first = index === 0;
    const image = product.imageUrl
      ? `<img class="product-image" src="${esc(product.imageUrl)}" alt="${esc(product.productName)}">`
      : '<div class="image-placeholder">이미지<br>없음</div>';
    const selectedCode = state.optionCodes[index];
    const options = product.options.map((option) =>
      `<option value="${esc(option.code)}" ${option.code === selectedCode ? "selected" : ""}>${esc(option.label)} · ${esc(option.code)}</option>`
    ).join("");
    const toneOptions = ["다정하게", "편안하게", "솔직하게", "담백하게", "채팅"].map((tone) =>
      `<option value="${tone}" ${tone === state.tones[index] ? "selected" : ""}>${tone}</option>`
    ).join("");
    const lengthOptions = ["1문장", "2문장", "3문장", "4문장", "5문장"].map((length) =>
      `<option value="${length}" ${length === state.lengths[index] ? "selected" : ""}>${length}</option>`
    ).join("");
    const typeOptions = REVIEW_TYPES.map((type) =>
      `<option value="${type}" ${type === state.reviewTypes[index] ? "selected" : ""}>${type}</option>`
    ).join("");

    return `<tr data-id="${esc(product.productId)}" data-index="${index}">
      ${first ? `<td rowspan="5"><button class="cell-button refresh-product">이 상품 리뷰<br>새로고침</button></td>
      <td rowspan="5" class="product-name-cell"><strong>${esc(product.productName)}</strong>${product.discovered ? '<small class="inferred">상세페이지 AI 분석 상품</small>' : ""}</td>
      <td rowspan="5">${image}</td><td rowspan="5" class="queenit-id-cell">${esc(product.productId)}</td>` : ""}
      <td class="option-code-cell"><select class="option-select" title="${esc(product.options.find((option) => option.code === selectedCode)?.label || "")} · ${esc(selectedCode)}" aria-label="리뷰 ${index + 1} 옵션 컬러">${options}</select>${product.analysisNote && first ? `<small class="inferred">${esc(product.analysisNote)}</small>` : ""}</td>
      <td><select class="row-tone-select" aria-label="리뷰 ${index + 1} 말투 구분자">${toneOptions}</select></td>
      <td><select class="row-length-select" aria-label="리뷰 ${index + 1} 리뷰 길이 구분자">${lengthOptions}</select></td>
      <td><select class="row-type-select" aria-label="리뷰 ${index + 1} 리뷰 종류 구분자">${typeOptions}</select></td>
      <td><span class="review-index">${index + 1}</span><textarea class="review-text" aria-label="${esc(product.productName)} 리뷰 ${index + 1}">${esc(review)}</textarea></td>
      <td><button class="cell-button refresh-one">리뷰 새로고침</button></td>
    </tr>`;
  }).join("")).join("");

  $("#resultCount").textContent = `상품 ${states.size}개 · 리뷰 ${states.size * 5}개`;
  $$(".review-text", tbody).forEach((textarea) => textarea.addEventListener("input", () => {
    const row = textarea.closest("tr");
    states.get(row.dataset.id).reviews[Number(row.dataset.index)] = textarea.value;
  }));
  $$(".refresh-one", tbody).forEach((button) => button.addEventListener("click", () => refreshOne(button.closest("tr"))));
  $$(".refresh-product", tbody).forEach((button) => button.addEventListener("click", () => refreshProduct(button.closest("tr").dataset.id, button)));
  $$(".option-select", tbody).forEach((select) => select.addEventListener("change", async () => {
    const row = select.closest("tr");
    const state = states.get(row.dataset.id);
    state.optionCodes[Number(row.dataset.index)] = select.value;
    await refreshOne(row);
  }));
  $$(".row-tone-select", tbody).forEach((select) => select.addEventListener("change", async () => {
    const row = select.closest("tr");
    const state = states.get(row.dataset.id);
    state.tones[Number(row.dataset.index)] = select.value;
    await refreshOne(row);
  }));
  $$(".row-length-select", tbody).forEach((select) => select.addEventListener("change", async () => {
    const row = select.closest("tr");
    const state = states.get(row.dataset.id);
    state.lengths[Number(row.dataset.index)] = select.value;
    await refreshOne(row);
  }));
  $$(".row-type-select", tbody).forEach((select) => select.addEventListener("change", async () => {
    const row = select.closest("tr");
    const state = states.get(row.dataset.id);
    state.reviewTypes[Number(row.dataset.index)] = select.value;
    await refreshOne(row);
  }));
}

async function generateOne(state, index) {
  state.history.push(...allReviews(state));
  state.history = [...new Set(state.history)].slice(-40);
  const result = await request("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      productId: state.product.productId,
      optionCode: state.optionCodes[index],
      previousReviews: state.history,
      preferences: { ...preferences(state.tones[index], state.lengths[index], state.reviewTypes[index]), variantIndex: index + 1 },
      count: 1,
    }),
  });
  updateAiStatus({ rateLimitResetAt: result.rateLimitResetAt || null });
  return result;
}

async function generateAll(state) {
  // API 요청을 동시에 몰아 보내면 일시적인 처리 제한이 생길 수 있어 순서대로 생성합니다.
  for (let index = 0; index < 5; index += 1) {
    const result = await generateOne(state, index);
    state.reviews[index] = result.reviews[0];
  }
  return [...state.reviews];
}

async function refreshProduct(id, button) {
  const state = states.get(id);
  busy(button, true, "작성 중...");
  try {
    state.reviews = await generateAll(state);
    render();
  } catch (error) {
    notify(error.message);
  } finally {
    if (document.body.contains(button)) busy(button, false);
  }
}

async function refreshOne(row) {
  const id = row.dataset.id;
  const index = Number(row.dataset.index);
  const state = states.get(id);
  const button = $(".refresh-one", row);
  busy(button, true, "작성 중...");
  try {
    const result = await generateOne(state, index);
    state.reviews[index] = result.reviews[0];
    render();
  } catch (error) {
    notify(error.message);
  } finally {
    if (document.body.contains(button)) busy(button, false);
  }
}

$("#loadButton").addEventListener("click", async () => {
  const list = ids();
  const button = $("#loadButton");
  if (!list.length) return notify("상품 ID를 입력해 주세요.");
  busy(button, true, "불러오는 중...");
  try {
    const response = await request("/api/products", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productIds: list }),
    });
    states.clear();
    for (const item of response.results) {
      if (!item.ok) { notify(`${item.productId}: ${item.message}`); continue; }
      states.set(item.product.productId, {
        product: item.product,
        optionCodes: distributeOptions(item.product.options),
        tones: Array(5).fill($("#tone").value),
        lengths: Array(5).fill($("#reviewLength").value),
        reviewTypes: $("#reviewType").value === "순차 적용"
          ? REVIEW_TYPES.slice(0, 5)
          : Array(5).fill($("#reviewType").value),
        reviews: Array(5).fill("리뷰 작성 중..."),
        history: [],
      });
    }
    render();
    for (const state of states.values()) {
      state.reviews = await generateAll(state);
      render();
    }
  } catch (error) {
    notify(error.message);
  } finally {
    busy(button, false);
  }
});

$("#refreshAllButton").addEventListener("click", async () => {
  const button = $("#refreshAllButton");
  busy(button, true, "전체 작성 중...");
  try {
    for (const state of states.values()) {
      state.reviews = await generateAll(state);
      render();
    }
  } catch (error) {
    notify(error.message);
  } finally {
    busy(button, false);
  }
});

$("#downloadButton").addEventListener("click", async () => {
  const entries = [...states.values()].flatMap((state) => state.reviews.map((review, index) => ({
    productId: state.product.productId,
    optionCode: state.optionCodes[index],
    reviews: [review.trim()],
    imageUrls: [REVIEW_IMAGE_URL],
  })).filter((entry) => entry.reviews[0]));
  if (!entries.length) return notify("먼저 상품을 불러와 주세요.");
  const button = $("#downloadButton");
  busy(button, true, "엑셀 생성 중...");
  try {
    const blob = await request("/api/download", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries }),
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `퀸잇_판매자리뷰_${states.size}개상품.xlsx`;
    link.click();
    URL.revokeObjectURL(link.href);
    notify("엑셀 파일을 만들었습니다.");
  } catch (error) {
    notify(error.message);
  } finally {
    busy(button, false);
  }
});

$("#openApiButton").addEventListener("click", () => $("#apiPanel").classList.toggle("hidden"));
$("#connectApiButton").addEventListener("click", async () => {
  const apiKey = $("#apiKey").value.trim();
  const button = $("#connectApiButton");
  if (!apiKey) return notify("API 키를 입력해 주세요.");
  busy(button, true, "연결 중...");
  try {
    const result = await request("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }),
    });
    $("#apiKey").value = "";
    updateAiStatus({ aiConnected: true, model: result.model, rateLimitResetAt: null });
    $("#apiPanel").classList.add("hidden");
    notify("GPT 연결 완료");
  } catch (error) {
    notify(error.message);
  } finally {
    busy(button, false);
  }
});

request("/api/status").then(updateAiStatus).catch(() => {});
setInterval(renderAiStatus, 1000);
