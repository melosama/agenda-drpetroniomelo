/// Louvor e Glória a Ti, Senhor

import express from "express";
import crypto from "crypto";
import { Storage } from "@google-cloud/storage";

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8080;
const API_VERSION = process.env.API_VERSION || "v22.0";

// WhatsApp
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN || "";
const META_APP_SECRET  = process.env.META_APP_SECRET || "";
const WHATSAPP_TOKEN   = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID || "";
const SECRETARIA_WA    = process.env.SECRETARIA_WA || "5511910601374";

// OpenRouter (LLM)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_URL     = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || "";

// Telemetria opcional do OpenRouter
const HTTP_REFERER = process.env.HTTP_REFERER || "";
const X_TITLE      = process.env.X_TITLE || "Maria | Consultório Dr Petronio Melo";

// RAG (KB privada no GCS) + TEI (/embed com ID Token)
const RAG_ENABLED     = process.env.RAG_ENABLED === "1";
const RAG_KB_GCS      = process.env.RAG_KB_GCS  || "";  // ex.: gs://drp-rag-drpetronio/kb/kb.json
const RAG_EMB_GCS     = process.env.RAG_EMB_GCS || "";  // ex.: gs://drp-rag-drpetronio/kb/kb_embeds.json
const TEI_URL         = process.env.TEI_URL || "";      // ex.: https://tei-embeddings-...run.app
const TEI_EMBED_PATH  = process.env.TEI_EMBED_PATH || "/embed";
const TEI_AUDIENCE    = process.env.TEI_AUDIENCE || TEI_URL;
const TEI_EMBED_FIELD = process.env.TEI_EMBED_FIELD || "input";
const TEI_ID_TOKEN    = process.env.TEI_ID_TOKEN || ""; // opcional, útil p/ teste local

// Diagnóstico e política de RAG
const RAG_DIAG          = process.env.RAG_DIAG === "1";
const RAG_SIM_THRESHOLD = Number(process.env.RAG_SIM_THRESHOLD || "0.28");

// Memória curta
const SESS = new Map(); // wa_id -> [{role, content}]

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

  // 3 tentativas, timeouts mais generosos
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await withTimeout(
      (signal) => fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal
      }),
      25000, // 25s
      { ok: false, status: 408, text: async () => "timeout" }
    );
    if (res.ok) return;
    const t = await res.text();
    console.error(`Erro ao enviar texto (tentativa ${attempt}):`, res.status, t);
    if (attempt < 3) await sleep(600);
  }
}

// Mark as read — erros 400/403/404 não devem bloquear o fluxo
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
    if (res.ok) return;
    const txt = await res.text();
    // Muitos 400 aqui são “Unsupported post request ...” → ignorar
    console.warn(`markAsRead falhou (tentativa ${attempt}):`, res.status, txt);
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
  const emerg = /(febre( alta)?|sangram|sangue na urina|hematur(ia)?|dor intensa|dor muito forte|retencao urinaria|nao consigo urinar|nao estou urinando|urina nao sai)/;
  if (emerg.test(t)) return "emergency";
  const billing = /(pre[çc]o|valor|custa|quanto custa|tabela|conv[eê]nio|plano de sa[úu]de|reembolso|particular|carteirinha)/;
  if (billing.test(t)) return "handoff";
  const falaDeAudio = /(audio|mensagem de voz|nota de voz|voz)/;
  const pedidoLigacao = /(ligacao|ligar|me liga|pode ligar|telefone|falar por telefone)/;
  if (!falaDeAudio.test(t) && pedidoLigacao.test(t)) return "handoff_phone";
  const hand = /(secretaria|recepcao|falar com pessoa|falar com gente|atendente real|atendente de verdade|ser humano)/;
  if (hand.test(t)) return "handoff";
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
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri || "");
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

// ID Token (audience = TEI_URL) — host correto do Metadata Server
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
  const r = await withTimeout(
    (signal) => fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal
    }),
    15000,
    null
  );
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

// ---------- Prompt ----------
function systemPrompt(context = "") {
  return [
    "Você é a Maria, secretária do consultório do Dr. Petronio Melo (urologista).",
    "Estilo: humano, claro, educado, objetivo. Frases curtas.",
    "NÃO use emojis, emoticons ou qualquer formatação Markdown (sem **negrito**, _itálico_, listas, cabeçalhos).",
    "Nunca invente informações (endereço, horários, preços). Quando não tiver certeza, diga que vai verificar e ofereça contato com a secretária humana.",
    "Orientações de urgência DEVEM aparecer apenas quando a mensagem do paciente contiver sinais de alerta (febre alta, dor intensa, sangramento, retenção urinária) ou quando o paciente perguntar sobre urgência.",
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
    temperature: 0.1,
    top_p: 0.9,
    // max_tokens: 256, // se quiser limitar
  };

  let r = await withTimeout(
    (signal) => fetch(OPENROUTER_URL, { method: "POST", headers, body: JSON.stringify(body), signal }),
    15000, null
  );

  // retry curto em 429/503
  if (r && (r.status === 429 || r.status === 503)) {
    await sleep(600);
    r = await withTimeout(
      (signal) => fetch(OPENROUTER_URL, { method: "POST", headers, body: JSON.stringify(body), signal }),
      12000, null
    );
  }

  if (!r || !r.ok) {
    const status = r ? r.status : "TIMEOUT";
    let details = "";
    try { details = r ? await r.text() : ""; } catch {}
    console.error("Erro OpenRouter:", status, details);

    // ✅ Fallback determinístico via RAG (melhor item)
    if (context && picks?.length) {
      const best = picks[0];
      let text = best.answer.trim();
      if (sources?.length) text += "\n\nFontes:\n" + sources.map(s => `- ${s}`).join("\n");
      if (RAG_DIAG) {
        const bestScore = scored?.[0]?.score != null ? scored[0].score.toFixed(3) : "n/a";
        text += `\n\n(RAG: ON | best=${bestScore} thr=${RAG_SIM_THRESHOLD} | LLM: ${status})`;
      }
      return text;
    }
    // Sem RAG → genérico
    return "Entendi. Pode me contar um pouco mais para eu te ajudar melhor?";
  }

  let text = (await r.json())?.choices?.[0]?.message?.content?.trim()
           || "Certo! Pode me dar mais detalhes, por favor?";

  if (context && sources?.length) {
    text += "\n\nFontes:\n" + sources.map(s => `- ${s}`).join("\n");
  }
  if (RAG_DIAG) {
    const best = scored?.[0]?.score != null ? scored[0].score.toFixed(3) : "n/a";
    console.log(`[RAG] decision=${context ? "ON" : "OFF"} best=${best} thr=${RAG_SIM_THRESHOLD}`);
    text += `\n\n(RAG: ${context ? "ON" : "OFF"} | best=${best} thr=${RAG_SIM_THRESHOLD})`;
  }

  const newHist = [...history, { role: "user", content: userText }, { role: "assistant", content: text }];
  SESS.set(wa_id, newHist.slice(-6));

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

app.post("/webhook", (req, res) => {
  if (!validateSignature(req)) return res.status(401).send("Invalid signature");
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      if (value?.statuses) return; // acks de entrega/visualização

      const msg = value?.messages?.[0];
      if (!msg) return;

      const from = msg.from;
      const mid  = msg.id;
      if (alreadyProcessed(mid)) return;

      if (msg.type === "interactive") {
        const i = msg.interactive || {};
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
      }

      if (msg.type === "text") {
        const userText = msg.text?.body || "";
        try { await markAsRead(mid); } catch (e) { console.warn("markAsRead falhou:", e); }

        const intent = classify(userText);
        const norm = normalize(userText);

        if (intent === "emergency" || intent === "handoff" || intent === "handoff_phone") {
          if (shouldSuppress(from, intent, norm)) {
            await sendText(from, "Já estamos cuidando disso, por favor aguarde um instante.");
            return;
          }
          LAST_INTENT.set(from, { intent, norm, ts: Date.now() });
        }

        if (intent === "emergency")      { await replyEmergency(from); return; }
        if (intent === "handoff_phone")  { await replyHandoffPhone(from); return; }
        if (intent === "handoff")        { await replyHandoff(from); return; }

        // Caso geral (inclui “qual seu nome?”)
        if (/qual( é| e)? (seu|seu\s+nome|o\s+seu\s+nome)\??$/i.test(userText.trim())) {
          await sendText(from, "Sou a Maria, secretária do Dr. Petronio.");
          return;
        }

        // Bloqueio de alucinação para fatos críticos se RAG não tiver contexto
        if (isCriticalFact(userText)) {
          const { context, sources, scored, picks } = await retrieveContext(userText, 3);
          if (!context) {
            const seguro = [
              "Para te informar com precisão, vou confirmar com a recepção e já retorno por aqui.",
              `Se preferir falar agora com a secretária: ${waLink(SECRETARIA_WA, "Olá! Poderia me informar o endereço/telefone/horário, por favor?")}`
              ].join("\n");
              await sendText(from, seguro + (RAG_DIAG ? "\n\n(RAG: OFF — bloqueio de alucinação)" : ""));
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
    "RAG_SIM_THRESHOLD:", RAG_SIM_THRESHOLD
  );
});

// Segurança extra de logs
process.on("unhandledRejection", (r) => console.error("unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
