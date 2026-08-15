#!/bin/bash
# vLLM server for Qwen3.8-27B on one RTX 5090 (32 GB).
#
# The checkpoint is ModelOpt NVFP4 W4A4 for the large linear layers. It is
# mixed precision rather than every tensor being 4-bit: embeddings, lm_head,
# Gated DeltaNet state projections, MTP, and the vision tower stay in BF16.
#
# The default is the dependable 128K setup:
#   - The BF16 vision tower remains loaded, so image inputs are supported.
#   - FP8 KV cache is about 4 GiB at 128K for the full-attention layers.
#   - 0.92 GPU utilization leaves about 2.5 GiB outside vLLM for display,
#     CUDA compilation, and transient buffers.
#   - max-num-seqs=1 matches the sequential executor workload.
#
# QWEN38_MAX_MODEL_LEN is the combined prompt + generated-token limit, not a
# 128K output allowance. Full native 256K is available, but uses the tight
# 0.97 memory profile automatically:
#
#   QWEN38_MAX_MODEL_LEN=262144 ./run_qwen3.8-27b-nvfp4.sh
#
# Ordinary per-request KV caching is always active. Automatic prefix caching
# is separate and defaults off here because older long Qwen runs in this repo
# showed corrupted reused blocks. Opt in after validation with:
#
#   QWEN38_ENABLE_PREFIX_CACHING=1 ./run_qwen3.8-27b-nvfp4.sh
#
# First launch downloads about 20.6 GB and may JIT-compile RTX 5090 kernels.
# Tool calls use the same Qwen3 XML parser as run_qwen3.6-35b-a3b-awq.sh.
# A separate reasoning parser is intentionally omitted because the executor
# sends chat_template_kwargs.enable_thinking=false for the Qwen3 family.

set -euo pipefail

VLLM_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VLLM_PYTHON="${VLLM_PYTHON:-${VLLM_DIR}/venv/bin/python}"
QWEN38_MODEL_ID="${QWEN38_MODEL_ID:-gittensor-model-hub/Qwen3.8-27B-NVFP4-RTX5090}"
QWEN38_MAX_MODEL_LEN="${QWEN38_MAX_MODEL_LEN:-131072}"
QWEN38_MAX_NUM_SEQS="${QWEN38_MAX_NUM_SEQS:-1}"
QWEN38_HOST="${QWEN38_HOST:-0.0.0.0}"
QWEN38_PORT="${QWEN38_PORT:-30000}"

# /tmp is a 32 GiB tmpfs on this host and is normally close to full. Keep the
# first-run SM120/Ninja builds on the NVMe filesystem instead. These paths sit
# inside the ignored venv so successful kernels persist across launches.
QWEN38_RUNTIME_DIR="${QWEN38_RUNTIME_DIR:-${VLLM_DIR}/venv/qwen38-runtime}"
QWEN38_DISK_TMP_DIR="${QWEN38_RUNTIME_DIR}/tmp"
mkdir -p \
    "${QWEN38_DISK_TMP_DIR}" \
    "${QWEN38_RUNTIME_DIR}/flashinfer" \
    "${QWEN38_RUNTIME_DIR}/torchinductor" \
    "${QWEN38_RUNTIME_DIR}/triton"

# ZMQ IPC sockets have a 107-character Unix-path ceiling. The NVMe directory
# above is too deep, so expose it through a short /tmp symlink. Files written
# through the link still live on NVMe rather than the tmpfs.
if [[ -z "${QWEN38_TMPDIR:-}" ]]; then
    QWEN38_SHORT_TMP_LINK="${QWEN38_SHORT_TMP_LINK:-/tmp/q38-${UID}}"
    if [[ -L "${QWEN38_SHORT_TMP_LINK}" ]]; then
        QWEN38_LINK_TARGET="$(readlink -f -- "${QWEN38_SHORT_TMP_LINK}")"
        QWEN38_EXPECTED_TARGET="$(readlink -f -- "${QWEN38_DISK_TMP_DIR}")"
        if [[ "${QWEN38_LINK_TARGET}" != "${QWEN38_EXPECTED_TARGET}" ]]; then
            echo "${QWEN38_SHORT_TMP_LINK} points to the wrong directory" >&2
            exit 2
        fi
    elif [[ -e "${QWEN38_SHORT_TMP_LINK}" ]]; then
        echo "${QWEN38_SHORT_TMP_LINK} exists and is not a symlink" >&2
        exit 2
    else
        ln -s -- "${QWEN38_DISK_TMP_DIR}" "${QWEN38_SHORT_TMP_LINK}"
    fi
    QWEN38_TMPDIR="${QWEN38_SHORT_TMP_LINK}"
else
    mkdir -p "${QWEN38_TMPDIR}"
fi
export TMPDIR="${QWEN38_TMPDIR}"
export FLASHINFER_WORKSPACE_BASE="${FLASHINFER_WORKSPACE_BASE:-${QWEN38_RUNTIME_DIR}/flashinfer}"
export TORCHINDUCTOR_CACHE_DIR="${TORCHINDUCTOR_CACHE_DIR:-${QWEN38_RUNTIME_DIR}/torchinductor}"
export TRITON_CACHE_DIR="${TRITON_CACHE_DIR:-${QWEN38_RUNTIME_DIR}/triton}"

# Sampling does not need the model's NVFP4 kernels. Use vLLM's native Torch
# sampler to avoid an additional FlashInfer SM120 JIT build during engine init.
export VLLM_USE_FLASHINFER_SAMPLER="${VLLM_USE_FLASHINFER_SAMPLER:-0}"

if ! [[ "${QWEN38_MAX_MODEL_LEN}" =~ ^[0-9]+$ ]] ||
    (( QWEN38_MAX_MODEL_LEN < 1 )); then
    echo "QWEN38_MAX_MODEL_LEN must be a positive integer" >&2
    exit 2
fi

# The published 256K profile needs the extra KV-cache reservation. Contexts
# through 192K keep the safer default unless explicitly overridden.
if [[ -z "${QWEN38_GPU_MEMORY_UTILIZATION:-}" ]]; then
    if (( QWEN38_MAX_MODEL_LEN > 196608 )); then
        QWEN38_GPU_MEMORY_UTILIZATION=0.97
    else
        QWEN38_GPU_MEMORY_UTILIZATION=0.92
    fi
fi

QWEN38_PREFIX_CACHE_ARG="--no-enable-prefix-caching"
if [[ "${QWEN38_ENABLE_PREFIX_CACHING:-0}" == "1" ]]; then
    QWEN38_PREFIX_CACHE_ARG="--enable-prefix-caching"
fi

# Limit parallel compiler jobs during the first-run FlashInfer build. Override
# this if the host has plenty of currently available RAM.
export MAX_JOBS="${MAX_JOBS:-2}"

exec "${VLLM_PYTHON}" -m vllm.entrypoints.openai.api_server \
    --model "${QWEN38_MODEL_ID}" \
    --served-model-name Qwen3.8-27B \
    --quantization modelopt \
    --host "${QWEN38_HOST}" \
    --port "${QWEN38_PORT}" \
    --max-model-len "${QWEN38_MAX_MODEL_LEN}" \
    --max-num-seqs "${QWEN38_MAX_NUM_SEQS}" \
    --gpu-memory-utilization "${QWEN38_GPU_MEMORY_UTILIZATION}" \
    --kv-cache-dtype fp8 \
    --enable-chunked-prefill \
    "${QWEN38_PREFIX_CACHE_ARG}" \
    --enable-auto-tool-choice \
    --tool-call-parser qwen3_xml \
    --no-enable-log-requests
