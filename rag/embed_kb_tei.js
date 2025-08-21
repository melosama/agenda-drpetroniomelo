// /assistente/rag/embed_kb_tei.js
// -----------------------------------------------------------
// Gera embeddings da sua KB chamando o TEI via endpoint /embed
// com autenticação por ID Token (JWT) no header Authorization.
//
// Como usar (Cloud Shell ou seu terminal com gcloud):
//   export TEI_URL="https://tei-embeddings-493472497692.southamerica-east1.run.app"        ← URL do serviço TEI
//   export TEI_AUDIENCE="$TEI_URL"                      ← audience = a própria URL
//   export TEI_ID_TOKEN=$(gcloud auth print-identity-token --audiences="$TEI_AUDIENCE")
//   node rag/embed_kb_tei.js
//
// Resultado: cria rag/kb_embeds.json
// -----------------------------------------------------------

import fs from "fs/promises";  // para ler/gravar arquivos

// URL base do TEI (ex.: https://tei-embeddings-xxxxx.run.app)
const TEI_URL = process.env.TEI_URL || "";

// Caminho do endpoint do seu TEI que gera embeddings (você usou /embed)
const TEI_EMBED_PATH = process.env.TEI_EMBED_PATH || "/embed";

// Nome da chave JSON que o seu endpoint /embed espera no corpo.
// Em 99% dos casos, "input". Se o seu for "inputs" ou "text", mude aqui.
const TEI_EMBED_FIELD = process.env.TEI_EMBED_FIELD || "input";

// ID Token (JWT) para chamar o TEI protegido por IAM.
// Gere assim no shell: gcloud auth print-identity-token --audiences="$TEI_URL"
const TEI_ID_TOKEN = process.env.TEI_ID_TOKEN || "";

// Caminhos dos arquivos
const KB_PATH  = process.env.KB_PATH  || "./rag/kb.json";
const OUT_PATH = process.env.OUT_PATH || "./rag/kb_embeds.json";

// Conferências básicas
if (!TEI_URL) {
  console.error("Defina TEI_URL (ex.: https://...run.app)");
  process.exit(1);
}
if (!TEI_ID_TOKEN) {
  console.error("Defina TEI_ID_TOKEN (use gcloud auth print-identity-token --audiences=TEI_URL)");
  process.exit(1);
}

// Monta corpo da requisição para o seu /embed.
// Aqui consideramos um único texto por chamada para simplificar (MVP).
function buildEmbedBody(texto) {
  // Cria um objeto { [TEI_EMBED_FIELD]: texto }
  const body = {};
  body[TEI_EMBED_FIELD] = texto;
  return body;
}

// Faz 1 chamada ao TEI (/embed) para obter o vetor de um texto.
async function embedOnce(texto) {
  // Monta a URL final do endpoint (/embed)
  const url = `${TEI_URL.replace(/\/+$/,"")}${TEI_EMBED_PATH}`;

  // Cabeçalhos: Authorization com ID Token + JSON
  const headers = {
    "Authorization": `Bearer ${TEI_ID_TOKEN}`,
    "Content-Type": "application/json"
  };

  // Corpo da requisição (JSON) conforme o seu endpoint espera
  const payload = buildEmbedBody(texto);

  // Faz o POST
  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  // Se falhar, mostra o texto do erro
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`/embed falhou: ${r.status} ${t}`);
  }

  // Interpreta a resposta.
  // Você disse que seu /embed retorna "um array puro de embeddings".
  // Então tratamos três possibilidades comuns:
  //  1) [n1, n2, ...]                  ← vetor único (mais comum)
  //  2) [[n1, n2, ...], [n1, n2, ...]] ← lote (pegamos o primeiro)
  //  3) { embedding: [n1, n2, ...] }   ← alguns endpoints usam objeto
  const data = await r.json();
  if (Array.isArray(data)) {
    // Se for um array de números, retornamos direto.
    if (data.length && typeof data[0] === "number") return data;
    // Se for array de arrays, pegamos o primeiro vetor.
    if (data.length && Array.isArray(data[0])) return data[0];
  }
  if (data && Array.isArray(data.embedding)) {
    return data.embedding;
  }

  // Se nada casou, jogamos um erro descritivo
  throw new Error("Resposta do /embed não está no formato esperado.");
}

// Transforma um item do KB em um "bloco" de texto (ajuda o recall do RAG)
function toChunk(item) {
  // Concatenamos pergunta + resposta + fonte
  return `${item.question}\n${item.answer}\n[${item.source}]`;
}

// Função principal: lê o KB, gera embeddings e grava o arquivo de saída
async function main() {
  // Lê e faz parse da KB
  const kb = JSON.parse(await fs.readFile(KB_PATH, "utf8"));

  // Vetores de saída
  const out = [];

  // Para cada item do KB, gera um embedding
  for (const it of kb) {
    const texto = toChunk(it);           // monta o bloco de texto
    const vector = await embedOnce(texto); // chama o TEI (/embed)
    out.push({ id: it.id, vector });     // guarda {id, vector}
  }

  // Garante que a pasta rag/ existe
  await fs.mkdir("./rag", { recursive: true });

  // Grava o arquivo final (JSON)
  await fs.writeFile(OUT_PATH, JSON.stringify(out));

  console.log(`OK — embeddings gerados: ${out.length} → ${OUT_PATH}`);
}

// Executa e captura erros
main().catch(e => {
  console.error("Erro ao gerar embeddings:", e);
  process.exit(1);
});
