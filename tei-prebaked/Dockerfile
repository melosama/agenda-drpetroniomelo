# ===== Stage 1: baixar o modelo com Python e pip =====
FROM python:3.11-slim AS downloader

# Model ID e token (se precisar aceitar licença no HF)
ARG MODEL_ID=ibm-granite/granite-embedding-278m-multilingual
ARG HF_TOKEN=""

# Acelera download e permite uso de token (se passado no build)
ENV HF_HUB_ENABLE_HF_TRANSFER=1
ENV HUGGINGFACE_HUB_TOKEN=${HF_TOKEN}

# Dependências mínimas
RUN apt-get update \
 && apt-get install -y --no-install-recommends git-lfs ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Libs necessárias para snapshot_download + turbo
RUN pip install --no-cache-dir "huggingface_hub>=0.23" hf_transfer

# Baixa o snapshot do modelo (sem heredoc, via python -c)
RUN python -c "from huggingface_hub import snapshot_download; import os, pathlib; mid=os.environ.get('MODEL_ID'); path=f'/models/{mid}'; pathlib.Path(path).mkdir(parents=True, exist_ok=True); snapshot_download(repo_id=mid, local_dir=path, local_dir_use_symlinks=False)"

# ===== Stage 2: imagem final do servidor TEI =====
FROM ghcr.io/huggingface/text-embeddings-inference:cpu-1.8

# Mesmo ARG para manter consistência de caminho
ARG MODEL_ID=ibm-granite/granite-embedding-278m-multilingual

# Copia o diretório com os pesos baixados para dentro da imagem final
COPY --from=downloader /models /data/models

# Direciona o TEI para usar o CAMINHO LOCAL (não o repo_id remoto)
ENV MODEL_ID=/data/models/${MODEL_ID}
# A imagem base do TEI já sobe na porta 80; não alterar entrypoint.
