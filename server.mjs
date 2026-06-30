import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const productsPayload = JSON.parse(await fs.readFile(path.join(root, "data", "options.json"), "utf8"));
const products = productsPayload.products;
const productPageCache = new Map();
const port = Number(process.env.PORT || 4173);
let openaiApiKey = process.env.OPENAI_API_KEY || "";
const openaiModel = process.env.OPENAI_MODEL || "gpt-5.4-mini";
let rateLimitResetAt = null;

function rateLimitResetFromMessage(message = "") {
  const match = message.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (!match) return null;
  const milliseconds = ((Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0)) * 1000;
  return milliseconds > 0 ? Date.now() + milliseconds : null;
}

const colorCodes = {
  블랙: "BK", 화이트: "WH", 아이보리: "IV", 베이지: "BE", 브라운: "BR",
  네이비: "NY", 그레이: "GY", 차콜: "CG", 핑크: "PK", 블루: "BL",
  그린: "GN", 카키: "KH", 와인: "WI", 오렌지: "OR", 레드: "RE",
  퍼플: "PP", 옐로우: "YE", 민트: "MT", 소라: "SB", 크림: "CR",
};
const sizeCodes = { FREE: "FF", 프리: "FF", F: "FF", S: "S", M: "M", L: "L", XL: "XL", XXL: "XXL" };

function outputText(response) {
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
}

async function callOpenAI({ instructions, input, schemaName, schema }) {
  if (!openaiApiKey) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiApiKey}` },
    body: JSON.stringify({
      model: openaiModel,
      instructions,
      input,
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || "OpenAI API 요청에 실패했습니다.");
  const text = outputText(payload);
  if (!text) throw new Error("AI 응답에서 결과를 찾지 못했습니다.");
  return JSON.parse(text);
}

function extractJsonObject(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = html.indexOf("{", markerIndex);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  return null;
}

function optionCode(sellerCode, color, size) {
  const normalizedSize = String(size || "FREE").toUpperCase();
  const colorCode = colorCodes[color] || String(color || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "ET";
  const sizeCode = sizeCodes[normalizedSize] || (/^\d+$/.test(normalizedSize) ? normalizedSize : normalizedSize);
  return `${sellerCode}${colorCode}${sizeCode}`;
}

async function discoverProduct(productId) {
  const pageResponse = await fetch(`https://web.queenit.kr/product/${encodeURIComponent(productId)}`, {
    headers: { "User-Agent": "Mozilla/5.0 QueenitReviewMaker/2.0" },
  });
  if (!pageResponse.ok) throw new Error(`상품 상세페이지를 불러오지 못했습니다. (${pageResponse.status})`);
  const html = await pageResponse.text();
  const product = extractJsonObject(html, '"product":{"productId"');
  if (!product?.productId) throw new Error("상세페이지에서 상품 정보를 찾지 못했습니다.");

  const base = {
    productId: product.productId,
    productName: product.name || "새 상품",
    sellerCode: product.mallProductCode || "",
    brand: product.brand || "",
    saleStatus: product.salesStatus || "",
    category: product.category?.title || "여성의류",
    options: [],
    imageUrl: product.imageUrl || product.thumbnailUrl || "",
    discovered: true,
  };
  if (!openaiApiKey) {
    base.options = [{ label: "컬러미상,FREE", code: `${base.sellerCode}ETFF`, inferred: true, confidence: "low" }];
    base.analysisNote = "GPT 연결 후 상세 이미지의 컬러·사이즈를 자동 분석할 수 있습니다.";
    return base;
  }

  let descriptionHtml = "";
  const descriptionUrl = product?.contents?.descriptionPageUrl?.replace(/^http:/, "https:");
  if (descriptionUrl) {
    const descriptionResponse = await fetch(descriptionUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (descriptionResponse.ok) descriptionHtml = await descriptionResponse.text();
  }
  const imageUrls = [...new Set([
    ...(product?.contents?.imageUrls || []),
    ...[...descriptionHtml.matchAll(/(?:src|data-src)=["']([^"']+)["']/gi)].map((m) => m[1]),
  ].filter((url) => /^https?:\/\//.test(url)))].slice(0, 8);

  const content = [{
    type: "input_text",
    text: `상품명: ${base.productName}\n카테고리: ${base.category}\n판매자 상품 코드: ${base.sellerCode}\n상세 이미지에서 실제 판매 컬러와 사이즈 조합만 추출하세요. 확실하지 않은 값은 추측하지 말고 confidence를 low로 표시하세요.`,
  }, ...imageUrls.map((image_url) => ({ type: "input_image", image_url }))];
  const analysis = await callOpenAI({
    instructions: "당신은 한국 여성의류 쇼핑몰 상품 옵션 검수자입니다. 이미지와 상품 정보를 근거로 컬러·사이즈 옵션 조합을 중복 없이 추출합니다.",
    input: [{ role: "user", content }],
    schemaName: "queenit_product_options",
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        options: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", additionalProperties: false, properties: { color: { type: "string" }, size: { type: "string" } }, required: ["color", "size"] } },
      },
      required: ["confidence", "options"],
    },
  });
  base.options = analysis.options.map(({ color, size }) => ({
    label: `${color},${size}`,
    code: optionCode(base.sellerCode, color, size),
    inferred: true,
    confidence: analysis.confidence,
  }));
  base.analysisNote = `상세 이미지 AI 분석 · 신뢰도 ${analysis.confidence}`;
  return base;
}

async function resolveProduct(productId) {
  if (!products[productId]) return discoverProduct(productId);
  const base = products[productId];
  if (base.imageUrl) return base;
  if (productPageCache.has(productId)) return { ...base, ...productPageCache.get(productId) };
  try {
    const response = await fetch(`https://web.queenit.kr/product/${encodeURIComponent(productId)}`, { headers: { "User-Agent": "Mozilla/5.0 QueenitReviewMaker/3.0" } });
    const html = response.ok ? await response.text() : "";
    const pageProduct = extractJsonObject(html, '"product":{"productId"');
    const extra = { imageUrl: pageProduct?.imageUrl || pageProduct?.thumbnailUrl || "", category: pageProduct?.category?.title || "" };
    productPageCache.set(productId, extra);
    return { ...base, ...extra };
  } catch {
    return base;
  }
}

const pick = (items) => items[Math.floor(Math.random() * items.length)];
const shuffle = (items) => [...items].sort(() => Math.random() - 0.5);

function productType(name) {
  if (/원피스/.test(name)) return "원피스";
  if (/가디건/.test(name)) return "가디건";
  if (/니트/.test(name)) return "니트";
  if (/팬츠|바지/.test(name)) return "바지";
  if (/블라우스|셔츠/.test(name)) return "블라우스";
  if (/스커트/.test(name)) return "스커트";
  return "상의";
}

function makeReviews(product, optionLabel, count = 5, preferences = {}) {
  const [color = "", size = ""] = optionLabel.split(",");
  const type = productType(product.productName);
  const colorPhrases = [
    `${color} 색상이 생각보다 과하지 않고 얼굴이 환해 보여요.`,
    `화면에서 본 색감과 크게 다르지 않고 실제로 입으니 더 자연스럽네요.`,
    `${color} 컬러라 코디가 어려울까 했는데 흰색이나 검정 바지에 잘 어울려요.`,
    `색 조합이 촌스럽지 않고 은근히 포인트가 돼서 마음에 들어요.`,
    `평소 어두운 옷만 입다가 골랐는데 얼굴빛이 밝아 보여 좋네요.`,
  ];
  const fitByType = {
    원피스: ["허리와 배 부분이 달라붙지 않아 편해요.", "길이도 부담스럽지 않고 움직일 때 편합니다.", "한 벌만 입어도 갖춰 입은 느낌이 나네요."],
    가디건: ["팔과 몸통이 너무 끼지 않아 안에 받쳐 입기 좋아요.", "가볍게 걸치기 좋고 체형도 자연스럽게 가려줍니다.", "실내에서 입었다 벗기 편해서 손이 자주 갈 것 같아요."],
    니트: ["니트인데 몸에 심하게 달라붙지 않아 편해요.", "팔뚝과 배 부분을 자연스럽게 가려줘서 마음에 듭니다.", "생각보다 가볍고 답답한 느낌이 덜해요."],
    바지: ["허리와 배가 조이지 않아 오래 입어도 편해요.", "다리선이 너무 드러나지 않고 떨어지는 모양이 괜찮네요.", "앉았다 일어날 때도 불편하지 않아 자주 입을 것 같아요."],
    블라우스: ["가슴과 팔 부분이 끼지 않아 편하게 잘 맞아요.", "단정하면서도 너무 딱딱해 보이지 않아 좋습니다.", "팔뚝을 적당히 가려주고 바지에 꺼내 입어도 괜찮아요."],
    스커트: ["허리가 답답하지 않고 배 부분도 자연스럽게 정리돼 보여요.", "걷거나 앉을 때 불편하지 않고 길이도 마음에 듭니다.", "블라우스나 기본 티에 입기 좋아 활용도가 높아요."],
    상의: ["몸에 딱 붙지 않고 적당히 여유가 있어 편해요.", "팔뚝과 배 부분을 자연스럽게 가려줘서 마음에 듭니다.", "길이가 너무 짧지 않아 바지 위로 편하게 입기 좋아요."],
  };
  const usage = [
    "동네 모임이나 장 보러 갈 때 편하게 입기 좋겠어요.",
    "청바지에도 잘 어울리고 외출할 때 자주 손이 갈 것 같아요.",
    "꾸민 듯 안 꾸민 듯 보여서 평소에 입기 딱 좋네요.",
    "검정 바지 하나만 받쳐 입어도 차려입은 느낌이 납니다.",
    "여행이나 가족 모임에 입고 가도 괜찮을 것 같아요.",
    "세탁 전이라 오래 입어보진 않았지만 첫인상은 만족스럽습니다.",
  ];
  const openings = [
    `평소 ${size || "FREE"} 사이즈가 잘 맞을지 걱정했는데 받아보니 괜찮네요.`,
    `${product.productName} 찾다가 색상이 마음에 들어 주문했어요.`,
    `너무 젊어 보일까 망설였는데 막상 입어보니 생각보다 잘 어울려요.`,
    `사진만 보고 주문해서 걱정했는데 직접 입어보니 더 마음에 듭니다.`,
    `편하게 입을 옷이 필요해서 골랐는데 기대보다 괜찮네요.`,
    `요즘 입을 옷이 마땅치 않았는데 오랜만에 마음에 드는 옷을 찾았어요.`,
  ];
  const materials = [
    "소재가 무겁지 않고 피부에 닿는 느낌도 거슬리지 않아요.",
    "생각보다 가볍고 하루 종일 입어도 답답하지 않네요.",
    "천이 뻣뻣하지 않아 움직이기 편합니다.",
    "가격을 생각하면 소재와 마무리도 무난한 편이에요.",
    "입었을 때 부해 보이지 않고 전체 모양이 자연스럽습니다.",
  ];

  const reviews = [];
  const variantOffset = Math.max(0, (Number(preferences.variantIndex) || 1) - 1);
  const requestedLines = Math.min(5, Math.max(1, Number.parseInt(preferences.length, 10) || 2));
  const isChat = preferences.tone === "채팅";
  const chatEndings = ["ㅎㅎ", "ㅋㅋㅋ", "~", "!!", "ㅎㅎㅎ"];
  for (let i = 0; i < count; i += 1) {
    const sentences = [
      openings[(variantOffset + i) % openings.length],
      colorPhrases[(variantOffset * 2 + i) % colorPhrases.length],
      fitByType[type][(variantOffset + i) % fitByType[type].length],
      materials[(variantOffset * 3 + i) % materials.length],
      usage[(variantOffset * 2 + i) % usage.length],
    ].slice(0, requestedLines);
    if (isChat) sentences[sentences.length - 1] += chatEndings[i % chatEndings.length];
    reviews.push(sentences.join("\n"));
  }
  return reviews;
}

async function makeAiReviews(product, optionLabel, previousReviews = [], preferences = {}, count = 5) {
  if (!openaiApiKey) return { reviews: makeReviews(product, optionLabel, count, preferences), source: "template" };
  const recent = previousReviews.filter(Boolean).slice(-40);
  const tone = preferences.tone || "다정하게";
  const reviewLength = preferences.length || "2줄";
  const requestedLines = Math.min(5, Math.max(1, Number.parseInt(reviewLength, 10) || 2));
  const chatGuide = tone === "채팅"
    ? "친한 사람과 인터넷 채팅하듯 편하게 쓰고, ㅎㅎㅎ·ㅋㅋㅋ·~·!! 같은 표현을 문맥에 맞게 자연스럽게 섞으세요. 모든 문장에 반복하거나 과하게 사용하지 마세요."
    : "선택한 말투에 맞춰 자연스럽게 작성하세요.";
  let result;
  try {
    result = await callOpenAI({
    instructions: [
      "당신은 40~50대 한국 여성 고객의 자연스러운 쇼핑 후기 작성자입니다.",
      "서로 다른 사람이 쓴 것처럼 말투, 문장 길이, 관심 포인트를 확실히 다르게 하세요.",
      "광고 문구나 지나친 칭찬을 피하고 일상적인 표현을 사용하세요.",
      "직접 확인할 수 없는 세탁 결과, 배송 속도, 내구성은 단정하지 마세요.",
      "이전에 생성한 리뷰와 문장 구조나 핵심 표현이 겹치지 않게 하세요.",
      chatGuide,
      `각 리뷰는 반드시 정확히 ${requestedLines}줄로 작성하고, 줄 사이는 줄바꿈 문자로 구분하세요. 임의로 줄 수를 늘리거나 줄이지 마세요.`,
    ].join("\n"),
    input: `상품명: ${product.productName}\n카테고리: ${product.category || productType(product.productName)}\n옵션: ${optionLabel}\n브랜드: ${product.brand || ""}\n작성자 성별: ${preferences.gender || "여성"}\n연령대: ${preferences.age || "41~45"}\n말투: ${tone}\n리뷰 번호: ${preferences.variantIndex || 1}/5\n리뷰 길이: 정확히 ${requestedLines}줄\n추가 명령: ${preferences.command || "없음"}\n\n이전에 생성한 리뷰(반복 금지):\n${recent.length ? recent.map((v, i) => `${i + 1}. ${v}`).join("\n") : "없음"}\n\n서로 다른 리뷰 ${count}개를 작성하세요. 이전 리뷰와 소재, 첫 문장, 핵심 장점을 반드시 다르게 하세요.`,
    schemaName: "queenit_reviews",
    schema: {
      type: "object", additionalProperties: false,
      properties: { reviews: { type: "array", minItems: count, maxItems: count, items: { type: "string", minLength: 40, maxLength: 320 } } },
      required: ["reviews"],
    },
    });
    rateLimitResetAt = null;
  } catch (error) {
    if (/rate limit|quota|requests per day|too many requests/i.test(error?.message || "")) {
      rateLimitResetAt = rateLimitResetFromMessage(error.message) || rateLimitResetAt;
      return { reviews: makeReviews(product, optionLabel, count, preferences), source: "template-rate-limit" };
    }
    throw error;
  }
  return { reviews: result.reviews, source: "openai" };
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("요청이 너무 큽니다.");
  }
  return raw ? JSON.parse(raw) : {};
}

async function createWorkbook(entries) {
  const { FileBlob, SpreadsheetFile } = await import("@oai/artifact-tool");
  const template = await FileBlob.load(path.join(root, "assets", "review-template.xlsx"));
  const workbook = await SpreadsheetFile.importXlsx(template);
  const sheet = workbook.worksheets.getItem("Sheet1");
  const rows = entries.flatMap((entry) => entry.reviews.map((review) => [entry.productId, entry.optionCode, review, null, null, null, null, null, null, null, null]));
  const endRow = 5 + rows.length;
  sheet.getRange(`A6:K${endRow}`).values = rows;
  sheet.getRange(`A6:K${endRow}`).format = {
    fill: "#FFFFFF",
    font: { typeface: "Arial", fontSize: 9, color: "#000000" },
    borders: { preset: "all", style: "thin", color: "#B7B7B7" },
    wrapText: true,
    verticalAlignment: "top",
  };
  sheet.getRange(`A6:C${endRow}`).format.horizontalAlignment = "left";
  sheet.getRange(`D6:K${endRow}`).format.horizontalAlignment = "center";
  sheet.getRange(`A6:K${endRow}`).format.rowHeight = 110;
  const blob = await SpreadsheetFile.exportXlsx(workbook);
  const tempPath = path.join(os.tmpdir(), `queenit-reviews-${crypto.randomUUID()}.xlsx`);
  try {
    await blob.save(tempPath);
    return await fs.readFile(tempPath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/status") {
      if (rateLimitResetAt && rateLimitResetAt <= Date.now()) rateLimitResetAt = null;
      return json(res, 200, { aiConnected: Boolean(openaiApiKey), model: openaiApiKey ? openaiModel : null, rateLimitResetAt });
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readJson(req);
      const apiKey = String(body.apiKey || "").trim();
      if (!apiKey.startsWith("sk-") || apiKey.length < 20) return json(res, 400, { message: "올바른 OpenAI API 키를 입력해 주세요." });
      openaiApiKey = apiKey;
      return json(res, 200, { aiConnected: true, model: openaiModel });
    }
    if (req.method === "GET" && url.pathname === "/api/product") {
      const id = (url.searchParams.get("id") || "").trim();
      const product = await resolveProduct(id);
      return json(res, 200, product);
    }
    if (req.method === "POST" && url.pathname === "/api/products") {
      const body = await readJson(req);
      const ids = [...new Set((body.productIds || []).map((id) => String(id).trim()).filter(Boolean))].slice(0, 20);
      if (!ids.length) return json(res, 400, { message: "상품 ID를 한 개 이상 입력해 주세요." });
      const results = [];
      for (const id of ids) {
        try { results.push({ ok: true, product: await resolveProduct(id) }); }
        catch (error) { results.push({ ok: false, productId: id, message: error.message }); }
      }
      return json(res, 200, { results });
    }
    if (req.method === "POST" && url.pathname === "/api/generate") {
      const body = await readJson(req);
      const product = await resolveProduct(String(body.productId || "").trim());
      const option = product.options.find((item) => item.code === body.optionCode) || product.options[0];
      const count = Math.max(1, Math.min(5, Number(body.count) || 5));
      const generated = await makeAiReviews(product, option.label, Array.isArray(body.previousReviews) ? body.previousReviews : [], body.preferences || {}, count);
      return json(res, 200, { product, option, reviews: generated.reviews, source: generated.source, rateLimitResetAt });
    }
    if (req.method === "POST" && url.pathname === "/api/download") {
      const body = await readJson(req);
      const entries = Array.isArray(body.entries) ? body.entries.map((entry) => ({
        productId: String(entry.productId || "").trim(),
        optionCode: String(entry.optionCode || "").trim(),
        reviews: Array.isArray(entry.reviews) ? entry.reviews.map((v) => String(v).trim()).filter(Boolean) : [],
      })).filter((entry) => entry.productId && entry.optionCode && entry.reviews.length) : [];
      if (!entries.length) return json(res, 400, { message: "상품, 옵션, 리뷰를 확인해 주세요." });
      const buffer = await createWorkbook(entries);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="queenit_seller_reviews.xlsx"',
        "Content-Length": buffer.length,
      });
      return res.end(buffer);
    }

    const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(publicDir, safePath);
    if (!filePath.startsWith(publicDir)) return json(res, 403, { message: "접근할 수 없습니다." });
    const ext = path.extname(filePath);
    const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
    const file = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(file);
  } catch (error) {
    if (error?.code === "ENOENT") return json(res, 404, { message: "페이지를 찾지 못했습니다." });
    console.error(error);
    json(res, 500, { message: error?.message || "처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요." });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`퀸잇 리뷰 메이커가 http://127.0.0.1:${port} 에서 실행 중입니다.`);
});
