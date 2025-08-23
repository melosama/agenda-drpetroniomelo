import express from "express";
import crypto from "crypto";
import { Storage } from "@google-cloud/storage";

// Dependências para agenda
import { google } from "googleapis";
import { DateTime, Interval } from "luxon";

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8080;
const API_VERSION = process.env.API_VERSION || "v22.0";

// WhatsApp
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN || "";
const META_APP_SECRET  = process.env.META_APP_SECRET || "";
const WHATSAPP_TOKEN   = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID || "";
const SECRETARIA_WA    = process.env.SECRETARIA_WA || "";

// OpenRouter (LLM)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_URL     = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || "";

// Telemetria opcional do OpenRouter
const HTTP_REFERER = process.env.HTTP_REFERER || "";
const X_TITLE      = process.env.X_TITLE || "";

// RAG (KB privada no GCS) + TEI (/embed com ID Token)
const RAG_ENABLED     = process.env.RAG_ENABLED === "1";
const RAG_KB_GCS      = process.env.RAG_KB_GCS  || "";  
const RAG_EMB_GCS     = process.env.RAG_EMB_GCS || "";  
const TEI_URL         = process.env.TEI_URL || "";      
const TEI_EMBED_PATH  = process.env.TEI_EMBED_PATH || "";
const TEI_AUDIENCE    = process.env.TEI_AUDIENCE || "";
const TEI_EMBED_FIELD = process.env.TEI_EMBED_FIELD || "";
const TEI_ID_TOKEN    = process.env.TEI_ID_TOKEN || "";

// Diagnóstico e política de RAG
const RAG_DIAG          = process.env.RAG_DIAG === "0";
const RAG_SIM_THRESHOLD = Number(process.env.RAG_SIM_THRESHOLD || "0.28");

// Mostrar extras técnicos ao PACIENTE? (padrão: desligado)
const APPEND_SOURCES_TO_PATIENT   = process.env.APPEND_SOURCES_TO_PATIENT === "1";
const APPEND_RAG_DIAG_TO_PATIENT  = process.env.APPEND_RAG_DIAG_TO_PATIENT === "1";

// === Configuração Calendar / Agenda ===
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const CALENDAR_ID          = process.env.CALENDAR_ID || "primary";
const TIMEZONE             = process.env.TIMEZONE || "America/Sao_Paulo";

// === Templates WhatsApp (24h antes) ===
const CONFIRM_TEMPLATE_NAME = process.env.CONFIRM_TEMPLATE_NAME || "confirm_consulta_24h";
const CONFIRM_TEMPLATE_LANG = process.env.CONFIRM_TEMPLATE_LANG || "pt_BR";

// === Fallbacks (se o RAG não trouxer) ===
const CLINIC_ADDRESS_FALLBACK = process.env.CLINIC_ADDRESS_FALLBACK || "Rua Domingos de Morais, 2187, conj. 210, Bloco Paris, Vila Mariana, São Paulo - SP, 04035-000";
const CONSULT_PRICE_FALLBACK   = process.env.CONSULT_PRICE_FALLBACK   || "R$ 700,00";

// Memória curta (LLM)
const SESS = new Map(); // wa_id -> [{role, content}]

// Memória de agendamento (estado da coleta pós-escolha do horário)
const BOOKINGS = new Map(); // wa_id -> { modality, slot, stage, data: {...} }

// ---------- APP ----------
const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// ---------- UTILS ----------
function constantTimeEqual(a, b) {
  const aBuf = Buffer.from(a || "", "utf8");
  const bBuf = Buffer.from(b || "", "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}
function normalize(pt) {
  return (pt || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function validateSignature(req) {
  if (!META_APP_SECRET) return true; // sem assinatura → aceitar (ambiente de teste)
  const sig = req.get("x-hub-signature-256") || "";
  if (!sig.startsWith("sha256=")) return false;
  const theirHash = sig.split("=")[1];
  const expected = crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex");
  return constantTimeEqual(theirHash, expected);
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function withTimeout(promiseFactory, ms, onTimeoutValue) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return promiseFactory(ctrl.signal)
    .catch(err => { if (err.name === "AbortError") return onTimeoutValue; throw err; })
    .finally(() => clearTimeout(t));
}

// ---------- WhatsApp helpers ----------
async function sendText(to, body) {
  if (!PHONE_NUMBER_ID) { console.error("[WA] PHONE_NUMBER_ID ausente"); return; }
  if (!WHATSAPP_TOKEN)  { console.error("[WA] WHATSAPP_TOKEN ausente"); return; }

  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body } };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await withTimeout(
      (signal) => fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal
      }),
      25000,
      { ok: false, status: 408, text: async () => "timeout" }
    );
    if (res?.ok) return;
    const t = res ? await res.text() : "no-res";
    console.error(`Erro ao enviar texto (tentativa ${attempt}):`, res?.status, t);
    if (attempt < 3) await sleep(600);
  }
}

// Botões interativos
async function sendButtons(to, bodyText, buttons) {
  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) return;
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: { buttons: buttons.slice(0,3) }
    }
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await withTimeout(
      (signal) => fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal
      }),
      25000,
      { ok: false, status: 408, text: async () => "timeout" }
    );
    if (res?.ok) return;
    const t = res ? await res.text() : "no-res";
    console.error(`Erro ao enviar botões (tentativa ${attempt}):`, res?.status, t);
    if (attempt < 3) await sleep(600);
  }
}

// Template (HSM) — confirmação 24h
async function sendTemplate(to, templateName, langCode, bodyParams = []) {
  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) return;
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const template = {
    name: templateName,
    language: { code: langCode || "pt_BR" }
  };
  if (bodyParams.length) {
    template.components = [{
      type: "body",
      parameters: bodyParams.map(t => ({ type: "text", text: String(t) }))
    }];
  }
  const payload = { messaging_product: "whatsapp", to, type: "template", template };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("[WA] sendTemplate falhou:", res.status, txt);
  }
}

// Mark as read
async function markAsRead(messageId) {
  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) return;
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: "whatsapp", status: "read", message_id: messageId };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await withTimeout(
      (signal) => fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal
      }),
      15000,
      { ok: false, status: 408, text: async () => "timeout" }
    );
    if (res?.ok) return;
    const txt = res ? await res.text() : "no-res";
    console.warn(`markAsRead falhou (tentativa ${attempt}):`, res?.status, txt);
    if (attempt === 1) await sleep(400);
  }
}

function waLink(numeroE164SemMais, texto) {
  const encoded = encodeURIComponent(texto || "");
  return `https://wa.me/${numeroE164SemMais}?text=${encoded}`;
}

// ---------- Classificador leve ----------
function classify(text) {
  const t = normalize(text);
  
  // Emergência
  const emerg = /(febre( alta)?|sangram|sangue na urina|hematur(ia)?|dor intensa|dor muito forte|retencao urinaria|nao consigo urinar|nao estou urinando|urina nao sai|infec(c|ç)ao|infecc?ao)/;
  if (emerg.test(t)) return "emergency";
  
  // pedido de convênio/humano
  const billing = /(conv[eê]nio|plano de sa[úu]de|reembolso|carteirinha)/;
  if (billing.test(t)) return "handoff";
  
  // preço
  const price = /(pre[çc]o|valor|custa|quanto custa|tabela|particular)/;
  if (price.test(t)) return "other";

  // ligação
  const falaDeAudio = /(audio|mensagem de voz|nota de voz|voz)/;
  const pedidoLigacao = /(ligacao|ligar|me liga|pode ligar|telefone|falar por telefone)/;
  if (!falaDeAudio.test(t) && pedidoLigacao.test(t)) return "handoff_phone";
  
  // humano explícito
  const hand = /(secretaria|recepcao|falar com pessoa|falar com gente|atendente real|atendente de verdade|ser humano)/;
  if (hand.test(t)) return "handoff";
  
  // intenção de agendamento
  const booking = /(agendar|agenda|marcar|consulta|retorno|pos[- ]?op|p[óo]s[- ]?op|hor[aá]rio|horario|dispon[ií]vel|vagas?)/;
  if (booking.test(t)) return "booking";

  return "other";
}

function isCriticalFact(text) {
  const t = normalize(text);
  return /(endere[cç]o|endereço|telefone|whats(app)?|contato|hor[aá]rio|agenda|conv[eê]nio|pre[çc]o|valor|custa)/.test(t);
}

// ---------- Respostas rápidas ----------
async function replyEmergency(to) {
  const msg = [
    "Entendi. Vou te colocar com a secretária agora para priorizarmos o seu atendimento.",
    "Se houver piora súbita antes do nosso retorno, procure o pronto atendimento mais próximo.",
    `Para agilizar, você pode abrir aqui: ${waLink(SECRETARIA_WA, "Olá! Preciso de ajuda urgente, por favor.")}`
  ].join("\n");
  await sendText(to, msg);
}
async function replyHandoff(to) {
  const msg = [
    "Certo, já direciono você para a secretária.",
    `Clique aqui para falar direto com a recepção: ${waLink(SECRETARIA_WA, "Olá! Gostaria de falar com a secretária.")}`,
    "Se preferir, pode continuar por aqui também."
  ].join("\n");
  await sendText(to, msg);
}
async function replyHandoffPhone(to) {
  const msg = [
    "Perfeito. Posso pedir para a recepção te ligar.",
    "Este número é o melhor para contato agora? Se sim, me confirme e já aciono.",
    `Se preferir, pode chamar a secretária por aqui: ${waLink(SECRETARIA_WA, "Olá! Pode me ligar, por favor?")}`
  ].join("\n");
  await sendText(to, msg);
}

// ---------- RAG (GCS + TEI) ----------
const storage = new Storage();

function parseGcsUri(uri) {
  const m = /^gs:\/\/([^\/]+)\/(.+)$/.exec(uri || "");
  if (!m) throw new Error(`URI GCS inválida: ${uri}`);
  return { bucket: m[1], name: m[2] };
}
async function loadJSONFromGCS(gsUri) {
  const { bucket, name } = parseGcsUri(gsUri);
  const [buf] = await storage.bucket(bucket).file(name).download();
  const txt = buf.toString("utf8");
  return JSON.parse(txt);
}

// Similaridade
function dot(a,b){ let s=0; for (let i=0;i<a.length;i++) s+=a[i]*b[i]; return s; }
function norm(a){ return Math.sqrt(dot(a,a)); }
function cosine(a,b){ const na=norm(a), nb=norm(b); if(!na||!nb) return 0; return dot(a,b)/(na*nb); }

// Estado KB
let KB = [];
let KB_EMB = [];
let KB_MAP = new Map();

async function loadRAG() {
  if (!RAG_ENABLED) { console.log("[RAG] desativado"); return; }
  try {
    if (!RAG_KB_GCS || !RAG_EMB_GCS) {
      console.warn("[RAG] URIs GCS não definidas (RAG_KB_GCS/RAG_EMB_GCS).");
      return;
    }
    KB     = await loadJSONFromGCS(RAG_KB_GCS);
    KB_EMB = await loadJSONFromGCS(RAG_EMB_GCS);
    KB_MAP = new Map(KB.map(it => [it.id, it]));
    const dim = Array.isArray(KB_EMB?.[0]?.vector) ? KB_EMB[0].vector.length : "N/A";
    console.log(`[RAG] KB carregada: ${KB.length} itens; Embeds: ${KB_EMB.length}; Dim: ${dim}`);
  } catch (e) {
    console.error("[RAG] Erro ao carregar KB do GCS:", e);
  }
}

// ID Token (audience = TEI_URL)
async function getIdToken(audience) {
  const host = process.env.GCP_METADATA_HOST || "metadata.google.internal";
  const url = `http://${host}/computeMetadata/v1/instance/service-accounts/default/identity?audience=${
    encodeURIComponent(audience || "")
  }&format=full`;
  const r = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`metadata identity: ${r.status} ${t}`);
  }
  return await r.text();
}

// Embedding da query
async function embedQuery(text) {
  if (!TEI_URL) return null;

  let idToken = TEI_ID_TOKEN || "";
  if (!idToken) {
    try { idToken = await getIdToken(TEI_AUDIENCE); }
    catch (e) { console.error("[RAG] getIdToken falhou:", e); return null; }
  }

  const url = `${TEI_URL.replace(/\/+$/,"")}${TEI_EMBED_PATH}`;
  const payload = {}; payload[TEI_EMBED_FIELD || "input"] = text;

  const started = Date.now();
  let r = await withTimeout(
    (signal) => fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal
    }),
    30000,
    null
  );
  if (!r) {
    await sleep(600);
    r = await withTimeout(
      (signal) => fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal
      }),
      30000,
      null
    );
  }
  if (!r) { console.error("[RAG] /embed timeout"); return null; }
  if (!r.ok) {
    const t = await r.text();
    console.error("[RAG] /embed falhou:", r.status, t);
    return null;
  }

  const data = await r.json();
  let vec = null;
  if (Array.isArray(data) && typeof data[0] === "number") vec = data;
  else if (Array.isArray(data) && Array.isArray(data[0])) vec = data[0];
  else if (data && Array.isArray(data.embedding)) vec = data.embedding;

  if (!vec) { console.error("[RAG] Resposta /embed inesperada", data); return null; }
  if (RAG_DIAG) console.log(`[RAG] qvec dim=${vec.length} dt=${Date.now()-started}ms`);
  return vec;
}

// Recupera top-k como contexto
async function retrieveContext(query, k = 3) {
  if (!RAG_ENABLED || KB.length === 0 || KB_EMB.length === 0) {
    if (RAG_DIAG) console.log("[RAG] inativo ou KB vazia");
    return { context: "", sources: [], scored: [], picks: [] };
  }
  const qvec = await embedQuery(query);
  if (!qvec) { if (RAG_DIAG) console.log("[RAG] qvec nulo"); return { context: "", sources: [], scored: [], picks: [] }; }

  // Checagem de dimensão
  const dimEmb = Array.isArray(KB_EMB?.[0]?.vector) ? KB_EMB[0].vector.length : 0;
  if (dimEmb && qvec.length !== dimEmb) {
    console.error(`[RAG] Dimensão diferente (query=${qvec.length} vs kb=${dimEmb}) → sem contexto`);
    return { context: "", sources: [], scored: [], picks: [] };
  }

  const scored = KB_EMB
    .map(v => ({ id: v.id, score: cosine(qvec, v.vector) }))
    .sort((a,b)=> b.score - a.score);

  const top = scored.slice(0, k);
  if (RAG_DIAG) console.log("[RAG] top3:", top);

  if (!top.length || top[0].score < RAG_SIM_THRESHOLD) {
    if (RAG_DIAG) console.log(`[RAG] abaixo do threshold (${RAG_SIM_THRESHOLD}) → sem contexto`);
    return { context: "", sources: [], scored: top, picks: [] };
  }

  const picks = top.map(s => KB_MAP.get(s.id)).filter(Boolean);
  const context = picks.map((it,idx)=>`[${idx+1}] ${it.question}\n${it.answer}\nFonte: ${it.source}`).join("\n\n");
  const sources = picks.map((it,idx)=>`[${idx+1}] ${it.source}`);

  return { context, sources, scored: top, picks };
}

// Helpers para extrair do RAG (preço e endereço) com fallback
async function getConsultPriceStr() {
  const q = "qual o preço da consulta particular";
  const { picks } = await retrieveContext(q, 1);
  if (picks?.[0]?.answer) {
    const txt = String(picks[0].answer).trim();
    // usa a primeira linha se for parágrafo grande
    return txt.split("\n").find(x => x.trim()) || CONSULT_PRICE_FALLBACK;
  }
  return CONSULT_PRICE_FALLBACK;
}
async function getClinicAddressStr() {
  const q = "qual o endereço do consultório";
  const { picks } = await retrieveContext(q, 1);
  if (picks?.[0]?.answer) {
    const txt = String(picks[0].answer).trim();
    return txt.split("\n").find(x => x.trim()) || CLINIC_ADDRESS_FALLBACK;
  }
  return CLINIC_ADDRESS_FALLBACK;
}
async function getPreConsultationText() {
  const q = "orientações pré-consulta";
  const { picks } = await retrieveContext(q, 1);
  if (picks?.[0]?.answer) {
    return String(picks[0].answer).trim();
  }
  // fallback simples e neutro
  const addr = await getClinicAddressStr();
  return [
    "Orientações pré-consulta:",
    "- Chegue com 10 minutos de antecedência.",
    `- Endereço: ${addr}`,
    "- Leve documento com foto e exames anteriores, se houver.",
    "- Em caso de sintomas importantes (dor intensa, sangramento, febre), avise-nos imediatamente."
  ].join("\n");
}

// ---------- Prompt ----------
function systemPrompt(context = "") {
  return [
    "Você é a Maria, secretária do consultório do Dr. Petronio Melo (urologista).",
    "Estilo: humano, claro, educado, objetivo. Frases curtas.",
    "NÃO use emojis, emoticons ou qualquer formatação Markdown (sem **negrito**, _itálico_, listas, cabeçalhos).",
    "Nunca invente informações (endereço, horários, preços). Quando não tiver certeza, diga que vai verificar e ofereça contato com a secretária humana.",
    "Orientações de urgência DEVEM aparecer apenas quando a mensagem do paciente contiver sinais de alerta (febre alta, dor intensa, sangramento, retenção urinária) ou quando o paciente perguntar sobre urgência.",
    "Se o paciente pedir consulta/horário, NÃO explique regras. Ofereça dois horários (um por dia nas duas próximas datas) e pergunte qual prefere.",
    context
      ? "Use o CONTEXTO CONFIÁVEL abaixo como fonte principal. Se a resposta não estiver no contexto, diga que vai confirmar e ofereça encaminhamento para a secretária."
      : "Se não houver contexto suficiente, responda com bom senso e ofereça encaminhamento para a secretária.",
    "Responda em português do Brasil. Se o paciente escrever em outra língua, responda na mesma língua.",
    context ? `\n--- CONTEXTO ---\n${context}\n--- FIM DO CONTEXTO ---` : ""
  ].join("\n");
}

// ---------- LLM (OpenRouter) + fallback RAG ----------
async function llmReply(wa_id, userText) {
  const { context, sources, scored, picks } = await retrieveContext(userText, 3);

  const history = SESS.get(wa_id) || [];
  const messages = [
    { role: "system", content: systemPrompt(context || "") },
    ...history,
    { role: "user", content: userText }
  ];

  const headers = { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" };
  if (HTTP_REFERER) headers["HTTP-Referer"] = HTTP_REFERER;
  if (X_TITLE)      headers["X-Title"]      = X_TITLE;

  const body = {
    model: OPENROUTER_MODEL,
    messages,
    temperature: 0.3,
    top_p: 0.9
  };

  let r = await withTimeout(
    (signal) => fetch(OPENROUTER_URL, { method: "POST", headers, body: JSON.stringify(body), signal }),
    15000, null
  );

  if (r && (r.status === 429 || r.status === 503)) {
    await sleep(600);
    r = await withTimeout(
      (signal) => fetch(OPENROUTER_URL, { method: "POST", headers, body: JSON.stringify(body), signal }),
      12000, null
    );
  }

  if (!r || !r.ok) {
    // Fallback determinístico via RAG
    if (context && picks?.length) {
      const best = picks[0];
      let text = best.answer.trim();
      try {
        const body2 = {
          model: OPENROUTER_MODEL,
          messages: [
            { role: "system", content: systemPrompt("") },
            { role: "user", content: `Responda de forma breve e natural ao paciente usando o texto a seguir como referência:\n\n${best.answer}` }
          ],
          temperature: 0.5,
          top_p: 0.9
        };
        const rr = await withTimeout(
          (signal) => fetch(OPENROUTER_URL, { method: "POST", headers, body: JSON.stringify(body2), signal }),
          12000, null
        );
        if (rr && rr.ok) {
          const t = (await rr.json())?.choices?.[0]?.message?.content?.trim();
          if (t) text = t;
        }
      } catch {}
      return text;
    }
    return "Entendi. Pode me contar um pouco mais para eu te ajudar melhor?";
  }

  let text = (await r.json())?.choices?.[0]?.message?.content?.trim()
           || "Certo! Pode me dar mais detalhes, por favor?";

  if (RAG_DIAG) {
    const best = scored?.[0]?.score != null ? scored[0].score.toFixed(3) : "n/a";
    console.log(`[RAG] decision=${context ? "ON" : "OFF"} best=${best} thr=${RAG_SIM_THRESHOLD}`);
  }

  if (APPEND_SOURCES_TO_PATIENT && context && sources?.length) {
    text += "\n\nFontes:\n" + sources.map(s => `- ${s}`).join("\n");
  }
  if (APPEND_RAG_DIAG_TO_PATIENT) {
    const best = scored?.[0]?.score != null ? scored[0].score.toFixed(3) : "n/a";
    text += `\n\n(RAG: ${context ? "ON" : "OFF"} | best=${best} thr=${RAG_SIM_THRESHOLD})`;
  }

  const historyNew = [...history, { role: "user", content: userText }, { role: "assistant", content: text }];
  SESS.set(wa_id, historyNew.slice(-6));

  return text;
}

// ---- DIAGNÓSTICOS ----
app.get("/", (req, res) => res.status(200).send("OK / (webhook-assistente)"));
app.get("/_diag/net", async (req, res) => {
  const out = {};
  const tryFetch = async (label, url) => {
    const started = Date.now();
    try {
      const r = await withTimeout((signal) => fetch(url, { method: "GET", signal }), 8000, null);
      if (!r) { out[label] = "TIMEOUT (8s)"; return; }
      out[label] = `HTTP ${r.status} em ${Date.now()-started}ms`;
    } catch (e) {
      out[label] = `ERRO: ${e && e.message || e}`;
    }
  };
  await tryFetch("graph", "https://graph.facebook.com");
  await tryFetch("google204", "https://www.google.com/generate_204");
  await tryFetch("openrouter", "https://openrouter.ai/api/v1/models");
  if (TEI_URL) await tryFetch("tei", TEI_URL);
  res.json(out);
});
app.get("/_diag/wa", async (req, res) => {
  try {
    const to = process.env.TEST_WA || SECRETARIA_WA;
    await sendText(to, "diag: ping " + new Date().toISOString());
    res.status(200).send("OK — mensagem enviada (verifique o WhatsApp do destino).");
  } catch (e) {
    res.status(500).send("Falhou: " + (e && e.message || e));
  }
});
app.get("/_diag/rag", async (req, res) => {
  try {
    const q = String(req.query.q || "");
    const { context, sources, scored, picks } = await retrieveContext(q || "teste", 3);
    res.json({ q, context, sources, scored, picks });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

// === Locale PT-BR (nomes de dias) ===
const WD_PT = {
  1: "Segunda-feira",
  2: "Terça-feira",
  3: "Quarta-feira",
  4: "Quinta-feira",
  5: "Sexta-feira",
  6: "Sábado",
  7: "Domingo"
};
function fmtDatePt(dt) {
  const z = dt.setZone(TIMEZONE);
  return `${z.toFormat("dd/LL")} (${WD_PT[z.weekday]})`;
}
function fmtTime(dt) { return dt.setZone(TIMEZONE).toFormat("HH:mm"); }

// Google Calendar (via OAuth2 com refresh token)
function getOAuth2Client() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN ausentes");
  }
  const oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, "http://localhost");
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

async function gcalFreeBusy(dayStart) {
  const start = dayStart.startOf("day").setZone(TIMEZONE);
  const end   = dayStart.endOf("day").setZone(TIMEZONE);
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: start.toISO(),
      timeMax: end.toISO(),
      timeZone: TIMEZONE,
      items: [{ id: CALENDAR_ID }]
    }
  });
  const busy = (fb.data?.calendars?.[CALENDAR_ID]?.busy || []).map(b => ({
    start: DateTime.fromISO(b.start, { zone: TIMEZONE }),
    end:   DateTime.fromISO(b.end,   { zone: TIMEZONE })
  }));
  return busy;
}

async function gcalCreateEvent({
  start, end, modality,
  patientName, patientPhone, patientEmail, patientDOB,
  hasInsurance, insuranceName, wantsInvoice, referral, priceStr, addressStr
}) {
  
  const location = modality === "presencial"
    ? (addressStr || CLINIC_ADDRESS_FALLBACK)
    : "Consulta online";

  const descriptionLines = [
    `Consulta ${modality}`,
    `Paciente: ${patientName}`,
    `Telefone: +${patientPhone}`,
    patientEmail ? `E-mail: ${patientEmail}` : null,
    patientDOB ? `Nascimento: ${patientDOB}` : null,
    hasInsurance != null ? `Convênio: ${hasInsurance ? (insuranceName || "Sim") : "Não"}` : null,
    wantsInvoice != null ? `Nota fiscal: ${wantsInvoice ? "Sim" : "Não"}` : null,
    referral ? `Como conheceu: ${referral}` : null,
    priceStr ? `Preço informado: ${priceStr}` : null,
    `Agendado via WhatsApp (Maria).`
  ].filter(Boolean);

  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const event = {
    summary: patientName || "Paciente",
    location,
    description: descriptionLines.join("\n"),
    start: { dateTime: start.toISO(), timeZone: TIMEZONE },
    end:   { dateTime: end.toISO(),   timeZone: TIMEZONE },
    extendedProperties: {
      private: {
        modality,
        patientPhone: String(patientPhone || ""),
        patientEmail: String(patientEmail || ""),
        patientDOB: String(patientDOB || ""),
        hasInsurance: String(!!hasInsurance),
        insuranceName: String(insuranceName || ""),
        wantsInvoice: String(!!wantsInvoice),
        referral: String(referral || ""),
        priceStr: String(priceStr || ""),
        confirm24hSent: "false"
      }
    }
  };
  
  if (patientEmail) {
    event.attendees = [{ email: patientEmail }];
  }

  const resp = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event
  });
  return resp.data;
}

// === Grades de horário ===
// Presencial: Terça (14–20) → 14..19; Quinta (9–13) → 9..12
function presencialSlotsForDay(dt) {
  const w = dt.setZone(TIMEZONE).weekday;
  const z = dt.setZone(TIMEZONE);
  let hours = [];
  if (w === 2)       hours = [14,15,16,17,18,19];
  else if (w === 4)  hours = [9,10,11,12];
  return hours.map(h => z.set({ hour: h, minute: 0, second: 0, millisecond: 0 }));
}
// Online:
function onlineSlotsForDay(dt) {
  const w = dt.setZone(TIMEZONE).weekday;
  const z = dt.setZone(TIMEZONE);
  let hours = [];
  if (w === 1)       hours = [19,20];                // Segunda 19–21
  else if (w === 2)  hours = [20];                   // Terça 20–21
  else if (w === 3)  hours = [9,10];                 // Quarta 9–11
  else if (w === 4)  hours = [15,16,17,18];          // Quinta 15–19
  else if (w === 5)  hours = [14,15,16,17];          // Sexta 14–18
  return hours.map(h => z.set({ hour: h, minute: 0, second: 0, millisecond: 0 }));
}
function slotListForDay(dt, modality) {
  return (modality === "online" ? onlineSlotsForDay(dt) : presencialSlotsForDay(dt));
}
function isFree(slotStart, busyIntervals) {
  const slotEnd = slotStart.plus({ hours: 1 });
  const slot = Interval.fromDateTimes(slotStart, slotEnd);
  return !busyIntervals.some(b => slot.overlaps(Interval.fromDateTimes(b.start, b.end)));
}
// Ofertas: 1 por dia, nas duas datas úteis mais próximas da modalidade
async function nextTwoOffers(now, modality) {
  const offers = [];
  let cursor = now.setZone(TIMEZONE).startOf("day");
  let guard = 0;
  while (offers.length < 2 && guard < 60) {
    guard++;
    cursor = cursor.plus({ days: 1 });
    const daySlots = slotListForDay(cursor, modality);
    if (!daySlots.length) continue;

    let busy = [];
    try { busy = await gcalFreeBusy(cursor); } catch (e) {
      console.error("[GCAL] freeBusy falhou:", e?.message || e);
      return [];
    }
        
    const firstFree = daySlots.find(s => s > now && isFree(s, busy));
    if (firstFree) {
      offers.push({ start: firstFree, end: firstFree.plus({ hours: 1 }) });
    }
  }
  return offers;
}

// ---------- WEBHOOK ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"] || "";
  const challenge = req.query["hub.challenge"] || "";
  if (mode === "subscribe" && VERIFY_TOKEN && constantTimeEqual(token, VERIFY_TOKEN)) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Idempotência/supressão
const PROCESSED_LAST5MIN = new Map(); // mid -> ts
function alreadyProcessed(mid) {
  const now = Date.now();
  for (const [k, ts] of PROCESSED_LAST5MIN) if (now - ts > 5*60*1000) PROCESSED_LAST5MIN.delete(k);
  if (PROCESSED_LAST5MIN.has(mid)) return true;
  PROCESSED_LAST5MIN.set(mid, now);
  return false;
}
const LAST_INTENT = new Map(); // wa_id -> { intent, norm, ts }
function shouldSuppress(wa_id, intent, norm) {
  const prev = LAST_INTENT.get(wa_id);
  const now = Date.now();
  if (!prev) return false;
  if (prev.intent !== intent) return false;
  if (now - prev.ts > 60*1000) return false;
  if (prev.norm !== norm) return false;
  return true;
}

// helpers de fluxo
function modalityFromText(t) {
  const n = normalize(t);
  if (/(online|telemed|video|ídeo|teleconsulta|remoto)/.test(n)) return "online";
  if (/(presencial|consultorio|consultório|no consultorio|no consultório)/.test(n)) return "presencial";
  return null;
}
async function startBookingFlow(from, textHint) {
  // zera estado anterior
  BOOKINGS.set(from, { stage: "await_modality", data: {} });
  const hint = modalityFromText(textHint || "");
  if (hint) {
    BOOKINGS.get(from).modality = hint;
    await offerSlotsForModality(from, hint);
  } else {
    await sendButtons(from, "Prefere consulta presencial no consultório ou online?", [
      { type: "reply", reply: { id: "mod|presencial", title: "Presencial" } },
      { type: "reply", reply: { id: "mod|online",     title: "Online" } },
    ]);
  }
}
async function offerSlotsForModality(from, modality) {
  BOOKINGS.set(from, { ...(BOOKINGS.get(from) || {}), modality, stage: "await_slot" });
  const offers = await nextTwoOffers(DateTime.now(), modality);
  if (!offers.length) {
    await sendText(from, "No momento não encontrei oportunidade imediata. Posso verificar novas datas e te retorno por aqui.");
    return;
  }
  const buttons = offers.slice(0, 2).map(o => ({
    type: "reply",
    reply: { id: `slot|${o.start.toISO()}|${modality}`, title: `${fmtDatePt(o.start)} • ${fmtTime(o.start)}` }
  }));
  await sendButtons(from, "Tenho estas oportunidades de consulta. Qual prefere?", buttons);
}

// validações
function isValidEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||"").trim()); }
function parseDOB(s) {
  const t = String(s||"").trim();
  const dt = DateTime.fromFormat(t, "dd/LL/yyyy");
  if (!dt.isValid) return null;
  const age = Math.floor(DateTime.now().diff(dt, "years").years);
  if (age < 0 || age > 120) return null;
  return dt.toFormat("dd/LL/yyyy");
}

// Recebe respostas de coleta de dados
async function handleBookingTextAnswer(from, text) {
  const st = BOOKINGS.get(from);
  if (!st) return false;

  switch (st.stage) {
    case "await_fullname": {
      const name = String(text||"").trim();
      if (name.length < 5) { await sendText(from, "Por favor, informe seu nome completo."); return true; }
      st.data.fullName = name;
      st.stage = "await_dob";
      await sendText(from, "Obrigado. Qual sua data de nascimento? (formato DD/MM/AAAA)");
      return true;
    }
    case "await_dob": {
      const dob = parseDOB(text);
      if (!dob) { await sendText(from, "Formato inválido. Informe como DD/MM/AAAA."); return true; }
      st.data.dob = dob;
      st.stage = "await_email";
      await sendText(from, "Seu e-mail para confirmação e envio das orientações?");
      return true;
    }
    case "await_email": {
      const em = String(text||"").trim();
      if (!isValidEmail(em)) { await sendText(from, "E-mail inválido. Pode conferir e me enviar novamente?"); return true; }
      st.data.email = em;
      st.stage = "await_has_insurance";
      await sendButtons(from, "Possui plano de saúde?", [
        { type: "reply", reply: { id: "yn|hasins|yes", title: "Sim" } },
        { type: "reply", reply: { id: "yn|hasins|no",  title: "Não" } }
      ]);
      return true;
    }
    case "await_insurance_name": {
      const plano = String(text||"").trim();
      st.data.insuranceName = plano || "";
      st.stage = "await_invoice";
      await sendButtons(from, "Deseja nota fiscal da consulta?", [
        { type: "reply", reply: { id: "yn|invoice|yes", title: "Sim" } },
        { type: "reply", reply: { id: "yn|invoice|no",  title: "Não" } }
      ]);
      return true;
    }
    case "await_referral": {
      st.data.referral = String(text||"").trim() || "";
      st.stage = "await_confirm";
      await sendButtons(from, "Conferi tudo. Posso confirmar o agendamento?", [
        { type: "reply", reply: { id: "confirm|yes", title: "Confirmar" } },
        { type: "reply", reply: { id: "confirm|no",  title: "Corrigir" } }
      ]);
      return true;
    }
    default:
      return false;
  }
}

// ---------- WEBHOOK ----------
app.post("/webhook", (req, res) => {
  if (!validateSignature(req)) return res.status(401).send("Invalid signature");
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      if (value?.statuses) return; // acks

      const msg = value?.messages?.[0];
      if (!msg) return;

      const from = msg.from;
      const mid  = msg.id;
      if (alreadyProcessed(mid)) return;

      // INTERACTIVE
      if (msg.type === "interactive") {
        const i = msg.interactive || {};
        
        // Flow/Form (mantido)
        if (i.type === "nfm_reply" && i.nfm_reply?.response_json) {
          const data = i.nfm_reply.response_json;
          const linhas = [];
          if (data.nome)      linhas.push(`Nome: ${data.nome}`);
          if (data.data_nasc) linhas.push(`Nascimento: ${data.data_nasc}`);
          if (data.motivo)    linhas.push(`Motivo: ${data.motivo}`);
          if (data.periodo)   linhas.push(`Preferência: ${data.periodo}`);
          if (data.obs)       linhas.push(`Obs: ${data.obs}`);
          const resumo = linhas.length ? ("\n" + linhas.join("\n")) : "";
          await sendText(from, `Perfeito, recebi seus dados.${resumo}\nJá vou verificar horários disponíveis e te retorno por aqui.`);
          return;
        }
       
        // Botões do fluxo de agendamento
        const br = i.button_reply;
        
        // Modalidade
        if (br?.id === "mod|presencial" || br?.id === "mod|online") {
          const modality = br.id.endsWith("online") ? "online" : "presencial";
          await offerSlotsForModality(from, modality);
          return;
        }

        // Escolha de horário
        if (br?.id && String(br.id).startsWith("slot|")) {
          try {
            const parts = String(br.id).split("|"); // slot|ISO|mod
            const startISO = parts[1];
            const modality = parts[2] || "presencial";
            const start = DateTime.fromISO(startISO, { zone: TIMEZONE });
            const end   = start.plus({ hours: 1 });

            // Guarda a escolha e inicia coleta
            const priceStr = await getConsultPriceStr();
            const addressStr = await getClinicAddressStr();

            BOOKINGS.set(from, {
              modality,
              slot: { start, end },
              stage: "await_fullname",
              data: { priceStr, addressStr }
            });

            const quando = `${fmtDatePt(start)} às ${fmtTime(start)} (${modality === "presencial" ? "Presencial" : "Online"})`;
            await sendText(from, [
              `Perfeito, reservei provisoriamente ${quando}.`,
              `O valor da consulta é ${priceStr}.`,
              "Para confirmar, preciso de alguns dados.",
              "Qual é o seu nome completo?"
            ].join("\n"));
          } catch (e) {
            console.error("[Agenda] erro após escolher slot:", e?.message || e);
            await sendText(from, "Tive uma dificuldade técnica ao reservar agora. Vou confirmar com a recepção e retorno em instantes.");
          }
          return;
        }

        // Sim/Não — possui plano?
        if (br?.id === "yn|hasins|yes" || br?.id === "yn|hasins|no") {
          const st = BOOKINGS.get(from);
          if (st) {
            st.data.hasInsurance = br.id.endsWith("|yes");
            if (st.data.hasInsurance) {
              st.stage = "await_insurance_name";
              await sendText(from, "Qual o nome do seu plano de saúde?");
            } else {
              st.stage = "await_invoice";
              await sendButtons(from, "Deseja nota fiscal da consulta?", [
                { type: "reply", reply: { id: "yn|invoice|yes", title: "Sim" } },
                { type: "reply", reply: { id: "yn|invoice|no",  title: "Não" } }
              ]);
            }
          }
          return;
        }

        // Sim/Não — nota fiscal?
        if (br?.id === "yn|invoice|yes" || br?.id === "yn|invoice|no") {
          const st = BOOKINGS.get(from);
          if (st) {
            st.data.wantsInvoice = br.id.endsWith("|yes");
            st.stage = "await_referral";
            await sendText(from, "Como você conheceu o Dr. Petronio? (Ex.: Google, Instagram, indicação, etc.)");
          }
          return;
        }

        // Confirmação final
        if (br?.id === "confirm|yes" || br?.id === "confirm|no") {
          const st = BOOKINGS.get(from);
          if (!st) return;
          if (br.id.endsWith("|no")) {
            await sendText(from, "Sem problemas. Posso te colocar com a secretária para ajustar os dados.");
            await replyHandoff(from);
            BOOKINGS.delete(from);
            return;
          }

          // Confirmar e criar evento
          try {
            const patientName   = st.data.fullName;
            const patientEmail  = st.data.email;
            const patientDOB    = st.data.dob;
            const hasInsurance  = !!st.data.hasInsurance;
            const insuranceName = st.data.insuranceName || "";
            const wantsInvoice  = !!st.data.wantsInvoice;
            const referral      = st.data.referral || "";
            const priceStr      = st.data.priceStr || CONSULT_PRICE_FALLBACK;
            const addressStr    = st.data.addressStr || CLINIC_ADDRESS_FALLBACK;
            const modality      = st.modality;

            const ev = await gcalCreateEvent({
              start: st.slot.start, end: st.slot.end, modality,
              patientName, patientPhone: from, patientEmail, patientDOB,
              hasInsurance, insuranceName, wantsInvoice, referral,
              priceStr, addressStr
            });

            const quando = `${fmtDatePt(st.slot.start)} às ${fmtTime(st.slot.start)} (${modality === "presencial" ? "Presencial" : "Online"})`;
            await sendText(from, [
              "Agendamento confirmado.",
              `Nome: ${patientName}`,
              `Quando: ${quando}`,
              modality === "presencial" ? `Endereço: ${addressStr}` : "Consulta online",
              `Preço: ${priceStr}`,
              "Se precisar remarcar, me avise por aqui.",
            ].join("\n"));

            // Enviar orientações pré-consulta
            const pre = await getPreConsultationText();
            await sendText(from, pre);

            
          } catch (e) {
            console.error("[GCAL] falha ao criar evento:", e?.message || e);
            await sendText(from, "Não consegui concluir o agendamento agora. Vou acionar a recepção e retorno em instantes.");
          } finally {
            BOOKINGS.delete(from);
          }
          return;
        }
      }
      
      // TEXT
      if (msg.type === "text") {
        const userText = msg.text?.body || "";
        try { await markAsRead(mid); } catch (e) { console.warn("markAsRead falhou:", e); }

        // se estamos no meio da coleta pós-slot, priorize esse fluxo
        const stActive = BOOKINGS.get(from);
        if (stActive) {
          const handled = await handleBookingTextAnswer(from, userText);
          if (handled) {
            // avança para próxima etapa automaticamente
            if (stActive.stage === "await_invoice" || stActive.stage === "await_has_insurance" || stActive.stage === "await_referral") {
              // já há handlers para botões; nada aqui
            } else if (stActive.stage === "await_dob" || stActive.stage === "await_email" || stActive.stage === "await_insurance_name") {
              // aguardando texto — o handler acima conduz
            } else if (stActive.stage === "await_fullname") {
              // aguardando nome — handler acima conduz
            }
            return;
          }
        }

        const intent = classify(userText);
        const norm = normalize(userText);

        if (intent === "emergency" || intent === "handoff" || intent === "handoff_phone" || intent === "booking") {
          if (shouldSuppress(from, intent, norm)) {
            await sendText(from, "Já estamos cuidando disso, por favor aguarde um instante.");
            return;
          }
          LAST_INTENT.set(from, { intent, norm, ts: Date.now() });
        }

        if (intent === "emergency")      { await replyEmergency(from); return; }
        if (intent === "handoff_phone")  { await replyHandoffPhone(from); return; }
        if (intent === "handoff")        { await replyHandoff(from); return; }

        if (intent === "booking") {
          await startBookingFlow(from, userText);
          return;
        }

        // Caso geral
        if (/qual( é| e)? (seu|seu\s+nome|o\s+seu\s+nome)\??$/i.test(userText.trim())) {
          await sendText(from, "Sou a Maria, secretária do Dr. Petronio.");
          return;
        }

        if (isCriticalFact(userText)) {
          const { context } = await retrieveContext(userText, 3);
          if (!context) {
            const seguro = [
              "Para te informar com precisão, vou confirmar com a recepção e já retorno por aqui.",
              `Se preferir falar agora com a secretária: ${waLink(SECRETARIA_WA, "Olá! Poderia me informar o endereço/telefone/horário, por favor?")}`
            ].join("\n");
            await sendText(from, seguro + (APPEND_RAG_DIAG_TO_PATIENT ? "\n\n(RAG: OFF — bloqueio de alucinação)" : ""));
            return;
          }
        }
        
        const reply = await llmReply(from, userText);
        await sleep(200 + Math.floor(Math.random()*300));
        await sendText(from, reply);
      }
    } catch (e) {
      console.error("Erro no processamento assíncrono:", e);
    }
  });
});

// === Endpoint CRON: enviar template 24h antes ===
app.get("/_cron/send-24h-reminders", async (req, res) => {
  try {
    const auth = getOAuth2Client();
    const calendar = google.calendar({ version: "v3", auth });

    // janela de 15min ao redor de 24h (roda de 15 em 15 minutos)
    const now = DateTime.now().setZone(TIMEZONE);
    const timeMin = now.plus({ hours: 23, minutes: 45 }).toISO();
    const timeMax = now.plus({ hours: 24, minutes: 15 }).toISO();

    const list = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime"
    });

    const events = list.data.items || [];
    let sent = 0;

    for (const ev of events) {
      const ep = ev.extendedProperties?.private || {};
      const already = ep.confirm24hSent === "true";
      const phone = ep.patientPhone || "";
      if (already || !phone) continue;

      const startISO = ev.start?.dateTime || ev.start?.date;
      if (!startISO) continue;
      const start = DateTime.fromISO(startISO, { zone: TIMEZONE });
      const modality = (ep.modality || "presencial") === "online" ? "Online" : "Presencial";
      const dateStr = start.toFormat("dd/LL/yyyy");
      const timeStr = start.toFormat("HH:mm");

      const address = ev.location || CLINIC_ADDRESS_FALLBACK;

      // Envia template
      await sendTemplate(phone, CONFIRM_TEMPLATE_NAME, CONFIRM_TEMPLATE_LANG, [
        ep.patientName || ev.summary || "Paciente",
        dateStr,
        timeStr,
        modality,
        modality === "Presencial" ? address : "Consulta online"
      ]);

      // marca como enviado
      ep.confirm24hSent = "true";
      await calendar.events.patch({
        calendarId: CALENDAR_ID,
        eventId: ev.id,
        requestBody: { extendedProperties: { private: ep } }
      });
      sent++;
      await sleep(200);
    }

    res.status(200).json({ ok: true, checked: events.length, sent });
  } catch (e) {
    console.error("CRON 24h erro:", e?.message || e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", async () => {
  await loadRAG();
  const mask = (s) => (!s ? "(ausente)" : s.length <= 8 ? "*".repeat(s.length) : "*".repeat(s.length - 6) + s.slice(-6));
  console.log("Webhook listening on :%s/webhook", PORT);
  console.log("Env check →",
    "API_VERSION:", process.env.API_VERSION,
    "VERIFY_TOKEN:", !!VERIFY_TOKEN,
    "META_APP_SECRET:", mask(META_APP_SECRET),
    "WHATSAPP_TOKEN:", mask(WHATSAPP_TOKEN),
    "PHONE_NUMBER_ID:", PHONE_NUMBER_ID,
    "SECRETARIA_WA:", SECRETARIA_WA,
    "OPENROUTER_API_KEY:", mask(OPENROUTER_API_KEY),
    "OPENROUTER_MODEL:", OPENROUTER_MODEL,
    "RAG_ENABLED:", RAG_ENABLED,
    "RAG_KB_GCS:", RAG_KB_GCS,
    "RAG_EMB_GCS:", RAG_EMB_GCS,
    "TEI_URL:", TEI_URL,
    "TEI_EMBED_PATH:", TEI_EMBED_PATH,
    "TEI_AUDIENCE:", TEI_AUDIENCE,
    "TEI_EMBED_FIELD:", TEI_EMBED_FIELD,
    "RAG_DIAG:", RAG_DIAG,
    "RAG_SIM_THRESHOLD:", RAG_SIM_THRESHOLD,
    "CALENDAR_ID:", CALENDAR_ID,
    "TIMEZONE:", TIMEZONE,
    "GOOGLE_CLIENT_ID:", GOOGLE_CLIENT_ID,
    "GOOGLE_CLIENT_SECRET:", GOOGLE_CLIENT_SECRET,
    "GOOGLE_REFRESH_TOKEN:", GOOGLE_REFRESH_TOKEN,
    "CONFIRM_TEMPLATE_NAME:", CONFIRM_TEMPLATE_NAME,
    "CONFIRM_TEMPLATE_LANG:", CONFIRM_TEMPLATE_LANG            
  );
});

// Segurança extra de logs
process.on("unhandledRejection", (r) => console.error("unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

