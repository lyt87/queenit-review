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

function htmlToText(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function collectDetailContent(pageProduct) {
  let descriptionHtml = "";
  const descriptionUrl = pageProduct?.contents?.descriptionPageUrl?.replace(/^http:/, "https:");
  if (descriptionUrl) {
    const response = await fetch(descriptionUrl, { headers: { "User-Agent": "Mozilla/5.0 QueenitReviewMaker/4.0" } });
    if (response.ok) descriptionHtml = await response.text();
  }
  const imageUrls = [...new Set([
    pageProduct?.imageUrl,
    pageProduct?.thumbnailUrl,
    ...(pageProduct?.contents?.imageUrls || []),
    ...[...descriptionHtml.matchAll(/(?:src|data-src)=["']([^"']+)["']/gi)].map((match) => match[1]),
  ].filter((url) => /^https?:\/\//.test(url)))].slice(0, 8);
  return { imageUrls, detailText: htmlToText(descriptionHtml).slice(0, 5000) };
}

async function analyzeReviewFacts(base, pageProduct) {
  const detail = await collectDetailContent(pageProduct);
  if (!openaiApiKey || (!detail.imageUrls.length && !detail.detailText)) {
    return { reviewFacts: detail.detailText ? [detail.detailText.slice(0, 500)] : [], detailText: detail.detailText };
  }
  const content = [{
    type: "input_text",
    text: `상품명: ${base.productName}\n카테고리: ${base.category || "여성의류"}\n브랜드: ${base.brand || ""}\n상세페이지 텍스트: ${detail.detailText || "텍스트 없음"}\n상세 이미지에서 리뷰에 활용할 수 있는 사실만 추출하세요. 보이지 않는 소재나 기능은 추측하지 마세요.`,
  }, ...detail.imageUrls.map((image_url) => ({ type: "input_image", image_url }))];
  const result = await callOpenAI({
    instructions: "여성의류 상세페이지 분석가입니다. 상품명과 상세 이미지·설명에서 직접 확인되는 소재감, 디자인, 핏 구조, 기장, 디테일, 코디 활용 특징을 짧은 한국어 사실 문장으로 정리하세요. 모델 체형이나 효능을 추측하지 마세요.",
    input: [{ role: "user", content }],
    schemaName: "queenit_review_facts",
    schema: {
      type: "object", additionalProperties: false,
      properties: { reviewFacts: { type: "array", minItems: 2, maxItems: 8, items: { type: "string", minLength: 5, maxLength: 100 } } },
      required: ["reviewFacts"],
    },
  });
  return { reviewFacts: result.reviewFacts, detailText: detail.detailText };
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

  const detail = await collectDetailContent(product);

  const content = [{
    type: "input_text",
    text: `상품명: ${base.productName}\n카테고리: ${base.category}\n판매자 상품 코드: ${base.sellerCode}\n상세페이지 텍스트: ${detail.detailText || "텍스트 없음"}\n상세 이미지에서 실제 판매 컬러와 사이즈 조합을 추출하고, 리뷰에 활용할 수 있는 확인된 상품 특징도 정리하세요. 확실하지 않은 값은 추측하지 말고 confidence를 low로 표시하세요.`,
  }, ...detail.imageUrls.map((image_url) => ({ type: "input_image", image_url }))];
  const analysis = await callOpenAI({
    instructions: "당신은 한국 여성의류 쇼핑몰 상품 분석가입니다. 이미지와 상품 정보를 근거로 컬러·사이즈 옵션 조합을 중복 없이 추출하고, 소재감·디자인·핏 구조·기장·디테일·활용 특징 중 직접 확인되는 사실을 정리합니다.",
    input: [{ role: "user", content }],
    schemaName: "queenit_product_options",
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        options: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", additionalProperties: false, properties: { color: { type: "string" }, size: { type: "string" } }, required: ["color", "size"] } },
        reviewFacts: { type: "array", minItems: 2, maxItems: 8, items: { type: "string", minLength: 5, maxLength: 100 } },
      },
      required: ["confidence", "options", "reviewFacts"],
    },
  });
  base.options = analysis.options.map(({ color, size }) => ({
    label: `${color},${size}`,
    code: optionCode(base.sellerCode, color, size),
    inferred: true,
    confidence: analysis.confidence,
  }));
  base.analysisNote = `상세 이미지 AI 분석 · 신뢰도 ${analysis.confidence}`;
  base.reviewFacts = analysis.reviewFacts;
  base.detailText = detail.detailText;
  return base;
}

async function resolveProduct(productId) {
  if (!products[productId]) return discoverProduct(productId);
  const base = products[productId];
  if (productPageCache.has(productId)) return { ...base, ...productPageCache.get(productId) };
  try {
    const response = await fetch(`https://web.queenit.kr/product/${encodeURIComponent(productId)}`, { headers: { "User-Agent": "Mozilla/5.0 QueenitReviewMaker/3.0" } });
    const html = response.ok ? await response.text() : "";
    const pageProduct = extractJsonObject(html, '"product":{"productId"');
    if (!pageProduct?.productId) throw new Error("상세페이지 상품 정보를 찾지 못했습니다.");
    const enrichedBase = {
      ...base,
      imageUrl: pageProduct.imageUrl || pageProduct.thumbnailUrl || base.imageUrl || "",
      category: pageProduct.category?.title || base.category || "여성의류",
      brand: pageProduct.brand || base.brand || "",
    };
    const detailAnalysis = await analyzeReviewFacts(enrichedBase, pageProduct);
    const extra = {
      imageUrl: enrichedBase.imageUrl,
      category: enrichedBase.category,
      brand: enrichedBase.brand,
      reviewFacts: detailAnalysis.reviewFacts,
      detailText: detailAnalysis.detailText,
      analysisNote: "상세페이지 전체 AI 분석 완료",
    };
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
  const reviewType = preferences.reviewType || "핏감";
  const focusPhrases = {
    "핏감": [
      "입어보니 몸에 달라붙지 않으면서도 전체 핏이 단정하게 떨어져요.",
      "어깨와 품이 어색하게 뜨지 않아 입었을 때 모양이 괜찮네요.",
      "너무 크거나 조이지 않고 적당히 여유 있는 핏이라 마음에 들어요.",
      "옆에서 봐도 부해 보이지 않고 선이 자연스럽게 잡힙니다.",
      "기장과 품의 균형이 잘 맞아서 편안하면서도 흐트러져 보이지 않아요.",
    ],
    "컬러감": [
      `${color} 색상이 화면보다 튀지 않고 얼굴빛을 편안하게 살려줘요.`,
      `${color} 컬러가 칙칙하지 않아 평소 입던 옷과 잘 어울립니다.`,
      "실제로 보니 색감이 과하지 않고 은은해서 손이 자주 갈 것 같아요.",
      "밝은 곳과 실내에서 봐도 색이 부담스럽지 않고 차분하네요.",
      "기본 하의에 받쳐 입기 쉬운 색이라 코디하기 편합니다.",
    ],
    "착용감": [
      "입었을 때 피부에 거슬리는 느낌이 없고 움직이기도 편해요.",
      "오래 앉아 있어도 조이는 곳이 없어 착용감이 편안합니다.",
      "옷이 무겁지 않고 팔을 움직일 때도 불편하지 않네요.",
      "몸에 닿는 촉감이 무난하고 답답하지 않아 일상복으로 좋아요.",
      "입고 벗기 편하고 활동할 때 당기는 부분이 없어 만족스럽습니다.",
    ],
    "체형커버": [
      "배와 옆선이 그대로 드러나지 않아 체형을 자연스럽게 가려줘요.",
      "팔과 상체에 적당한 여유가 있어 신경 쓰이던 부분이 덜 보여요.",
      "몸선을 꽉 잡지 않고 자연스럽게 떨어져 한결 날씬해 보입니다.",
      "허리 부분이 달라붙지 않아 편하면서도 체형이 정돈돼 보여요.",
      "뒤쪽까지 기장이 안정적이라 부담 없이 입기 좋습니다.",
    ],
    "가성비": [
      "가격을 생각하면 소재와 전체 마무리가 무난해서 만족스러워요.",
      "부담 없는 가격에 평소 자주 입을 수 있어 실용적입니다.",
      "비슷한 옷과 비교해도 활용도가 높아 가격 대비 괜찮네요.",
      "한철만 입을 느낌은 아니고 기본 옷으로 활용하기 좋아 보여요.",
      "디자인과 착용감을 함께 보면 지불한 가격이 아깝지 않습니다.",
    ],
  };

  const reviews = [];
  const detailFacts = Array.isArray(product.reviewFacts) ? product.reviewFacts.filter(Boolean) : [];
  const variantOffset = Math.max(0, (Number(preferences.variantIndex) || 1) - 1);
  const requestedLines = Math.min(5, Math.max(1, Number.parseInt(preferences.length, 10) || 2));
  const isChat = preferences.tone === "채팅";
  const chatEndings = ["ㅎㅎ", "ㅋㅋ", "ㅎㅎ^^", "^^", "ㅋㅋㅋ~"];
  for (let i = 0; i < count; i += 1) {
    const sentences = [
      (focusPhrases[reviewType] || focusPhrases["핏감"])[(variantOffset + i) % 5],
      detailFacts.length ? detailFacts[(variantOffset + i) % detailFacts.length] : openings[(variantOffset + i) % openings.length],
      fitByType[type][(variantOffset + i) % fitByType[type].length],
      materials[(variantOffset * 3 + i) % materials.length],
      usage[(variantOffset * 2 + i) % usage.length],
    ].slice(0, requestedLines);
    if (isChat) sentences[sentences.length - 1] += chatEndings[i % chatEndings.length];
    reviews.push(sentences.join("\n"));
  }
  return reviews;
}

function reviewMatchesType(review, reviewType) {
  const patterns = {
    "핏감": /핏|품|어깨|기장|달라붙|떨어지|여유|크거나|조이|실루엣/,
    "컬러감": /색|컬러|배색|색감|얼굴빛|밝|차분|은은|코디/,
    "착용감": /착용|편안|편하|촉감|피부|움직|활동|답답|무겁|가볍|입고 벗/,
    "체형커버": /체형|커버|가려|날씬|몸선|배와|뱃살|옆선|팔뚝|허리|뒤쪽|부해 보이지/,
    "가성비": /가격|가성비|가격 대비|부담 없|실용|활용도|아깝지|마무리|값/,
  };
  return (patterns[reviewType] || /./).test(String(review || ""));
}

async function makeAiReviews(product, optionLabel, previousReviews = [], preferences = {}, count = 5) {
  if (!openaiApiKey) return { reviews: makeReviews(product, optionLabel, count, preferences), source: "template" };
  const recent = previousReviews.filter(Boolean).slice(-40);
  const tone = preferences.tone || "다정하게";
  const reviewType = preferences.reviewType || "종합";
  const reviewLength = preferences.length || "2줄";
  const requestedLines = Math.min(5, Math.max(1, Number.parseInt(reviewLength, 10) || 2));
  const chatGuide = tone === "채팅"
    ? `친한 사람과 인터넷 채팅하듯 편하게 쓰세요. 리뷰 번호에 따라 끝표현을 다르게 사용하세요: 1번 ㅎㅎ, 2번 ㅋㅋ, 3번 ㅎㅎ^^, 4번 ^^, 5번 ㅋㅋㅋ~. 같은 표현만 반복하지 말고 문맥에 맞게 한 번 정도만 자연스럽게 사용하세요.`
    : "선택한 말투에 맞춰 자연스럽게 작성하세요.";
  const sequentialDiversityGuide = [
    "리뷰를 배열 순서대로 1번부터 작성하세요.",
    "2번부터는 바로 앞 번호까지 이미 작성한 모든 리뷰를 먼저 비교한 뒤 작성하세요.",
    "앞 리뷰와 첫 문장, 중심 소재, 장점, 문장 구조, 어미가 겹치면 다른 표현과 관점으로 다시 작성하세요.",
    `현재 선택된 리뷰 종류인 '${reviewType}'가 리뷰 전체의 핵심 주제입니다. 첫 문장부터 이 종류에 관한 구체적인 경험을 쓰세요.`,
    "선택되지 않은 다른 리뷰 종류를 중심 소재로 바꾸지 마세요.",
    "다섯 리뷰에 같은 칭찬이나 결론을 단어만 바꿔 반복하지 마세요.",
  ].join("\n");
  let result;
  try {
    result = await callOpenAI({
    instructions: [
      `최우선 작성 기준: 리뷰 종류는 '${reviewType}'입니다. 결과의 첫 문장과 중심 내용은 반드시 이 기준을 직접 다뤄야 합니다.`,
      "당신은 40~50대 한국 여성 고객의 자연스러운 쇼핑 후기 작성자입니다.",
      "서로 다른 사람이 쓴 것처럼 말투, 문장 길이, 관심 포인트를 확실히 다르게 하세요.",
      "광고 문구나 지나친 칭찬을 피하고 일상적인 표현을 사용하세요.",
      "직접 확인할 수 없는 세탁 결과, 배송 속도, 내구성은 단정하지 마세요.",
      "이전에 생성한 리뷰와 문장 구조나 핵심 표현이 겹치지 않게 하세요.",
      sequentialDiversityGuide,
      chatGuide,
      `각 리뷰는 반드시 정확히 ${requestedLines}줄로 작성하고, 줄 사이는 줄바꿈 문자로 구분하세요. 임의로 줄 수를 늘리거나 줄이지 마세요.`,
    ].join("\n"),
    input: `상품명: ${product.productName}\n카테고리: ${product.category || productType(product.productName)}\n옵션: ${optionLabel}\n브랜드: ${product.brand || ""}\n상세페이지에서 확인된 특징:\n${Array.isArray(product.reviewFacts) && product.reviewFacts.length ? product.reviewFacts.map((fact) => `- ${fact}`).join("\n") : (product.detailText || "확인된 추가 특징 없음")}\n작성자 성별: ${preferences.gender || "여성"}\n연령대: ${preferences.age || "41~45"}\n말투: ${tone}\n리뷰 번호: ${preferences.variantIndex || 1}/5\n리뷰 종류: ${reviewType}\n리뷰 길이: 정확히 ${requestedLines}줄\n추가 명령: ${preferences.command || "없음"}\n\n앞 번호까지 생성된 리뷰(반복 금지):\n${recent.length ? recent.map((v, i) => `${i + 1}. ${v}`).join("\n") : "없음"}\n\n현재 번호의 리뷰를 작성하기 전에 앞 리뷰들의 내용을 비교하세요. 선택된 리뷰 종류를 중심으로 쓰고, 상세페이지에서 확인된 특징 중 관련 있는 사실을 자연스럽게 반영하세요. 앞 리뷰와 소재·첫 문장·핵심 장점·말투가 겹치면 새 관점으로 바꿔 작성하세요.`,
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
  const typeSafeFallbacks = makeReviews(product, optionLabel, count, preferences);
  let reviews = result.reviews.map((review, index) =>
    reviewMatchesType(review, reviewType) ? review : typeSafeFallbacks[index]
  );
  if (tone === "채팅") {
    const chatEndings = ["ㅎㅎ", "ㅋㅋ", "ㅎㅎ^^", "^^", "ㅋㅋㅋ~"];
    const startIndex = Math.max(0, (Number(preferences.variantIndex) || 1) - 1);
    reviews = reviews.map((review, index) => {
      const ending = chatEndings[(startIndex + index) % chatEndings.length];
      const cleaned = String(review).trimEnd().replace(/(?:ㅎㅎ+|ㅋㅋ+|\^\^|[~!])+\s*$/u, "").trimEnd();
      return `${cleaned} ${ending}`;
    });
  }
  return { reviews, source: "openai" };
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
  const ExcelJSImport = await import("exceljs");
  const ExcelJS = ExcelJSImport.default || ExcelJSImport;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(root, "assets", "review-template.xlsx"));
  const sheet = workbook.getWorksheet("Sheet1") || workbook.worksheets[0];
  if (!sheet) throw new Error("엑셀 템플릿의 Sheet1 시트를 찾지 못했습니다.");

  const rows = entries.flatMap((entry) => entry.reviews.map((review) => [
    entry.productId, entry.optionCode, review, null, null, null, null, null, null, null, null,
  ]));
  const thinBorder = { style: "thin", color: { argb: "FFB7B7B7" } };
  rows.forEach((values, index) => {
    const row = sheet.getRow(6 + index);
    row.values = values;
    row.height = 82.5;
    for (let column = 1; column <= 11; column += 1) {
      const cell = row.getCell(column);
      cell.font = { name: "Arial", size: 9, color: { argb: "FF000000" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };
      cell.border = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };
      cell.alignment = {
        horizontal: column <= 3 ? "left" : "center",
        vertical: "top",
        wrapText: true,
      };
    }
    row.commit();
  });
  const output = await workbook.xlsx.writeBuffer();
  return Buffer.from(output);
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

server.listen(port, "0.0.0.0", () => {
  console.log(`퀸잇 리뷰 메이커가 http://127.0.0.1:${port} 에서 실행 중입니다.`);
});
