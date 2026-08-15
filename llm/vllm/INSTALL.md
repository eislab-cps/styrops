# Install vLLM for Qwen3.8-27B on RTX 5090

These instructions install the environment used by
`run_qwen3.8-27b-nvfp4.sh`. They were validated on Debian 13 with Python 3.13
and one NVIDIA GeForce RTX 5090 with 32 GB VRAM.

The launcher serves
`gittensor-model-hub/Qwen3.8-27B-NVFP4-RTX5090` as `Qwen3.8-27B` on port
30000. This is a ModelOpt NVFP4 checkpoint, not the GGUF checkpoint. Its large
linear layers use NVFP4 W4A4; the vision tower and several other tensors remain
BF16, so it is a mixed-precision model rather than every tensor being 4-bit.

## Tested versions

| Component | Version |
|---|---:|
| Python | 3.13.5 |
| vLLM | 0.27.1 |
| PyTorch | 2.13.0+cu130 |
| Transformers | 5.15.0 |
| flashinfer-python | 0.6.16.post3 |
| flashinfer-cubin | 0.6.16.post3 |

Keep the two FlashInfer versions identical. A mismatch prevents the vLLM
engine from starting.

## Disk and driver prerequisites

Allow at least 50 GiB of free disk space before installing:

- The Python environment currently occupies about 16 GiB.
- The Hugging Face model cache occupies about 20 GiB.
- The first launch can create additional compiled-kernel and temporary files.

Confirm that the NVIDIA driver sees the card:

```bash
nvidia-smi
```

On Debian 13, install the host-side build tools if they are missing:

```bash
sudo apt update
sudo apt install -y \
  python3.13 \
  python3.13-venv \
  python3.13-dev \
  build-essential \
  ninja-build \
  git \
  curl
```

The pinned Python wheels provide the CUDA 13 runtime and compiler components.
Do not install packages into this environment with `sudo pip`.

## Create the environment

Run this section only when `vllm/venv` does not already exist. A working venv
can skip directly to the verification section.

```bash
cd ~/dev/github/eislab-cps/styrops/llm/vllm
python3.13 -m venv venv
source venv/bin/activate
python -m pip install --upgrade pip setuptools wheel
python -m pip install "vllm==0.27.1"
```

For Fish shell, activate it with:

```fish
source venv/bin/activate.fish
```

Install matching FlashInfer Python and cubin distributions. `--no-deps` keeps
this repair from replacing the PyTorch version selected by vLLM:

```bash
python -m pip install --upgrade --force-reinstall --no-deps \
  "flashinfer-python==0.6.16.post3" \
  "flashinfer-cubin==0.6.16.post3"
python -m pip check
```

Make the launcher executable:

```bash
chmod +x run_qwen3.8-27b-nvfp4.sh
```

## Verify the installation

Check the installed versions without importing CUDA kernels:

```bash
python - <<'PY'
from importlib.metadata import version

for package in (
    "vllm",
    "torch",
    "transformers",
    "flashinfer-python",
    "flashinfer-cubin",
):
    print(f"{package}: {version(package)}")
PY
```

Then verify CUDA from outside a sandbox or container that hides the GPU:

```bash
python - <<'PY'
import torch

print("PyTorch:", torch.__version__)
print("CUDA runtime:", torch.version.cuda)
print("CUDA available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))
    print("Compute capability:", torch.cuda.get_device_capability(0))
PY
```

The expected GPU is the RTX 5090 with compute capability `(12, 0)`.

## Start the server

The dependable default is a 128K combined prompt-and-output context, one active
sequence, FP8 KV cache, vision enabled, and the `qwen3_xml` tool-call parser:

```bash
cd ~/dev/github/eislab-cps/styrops/llm/vllm
./run_qwen3.8-27b-nvfp4.sh
```

The first start downloads approximately 20 GiB and may compile RTX 5090
kernels. Subsequent starts reuse both caches.

The launcher stores compilation data under `venv/qwen38-runtime` rather than
the 32 GiB `/tmp` tmpfs. It exposes that directory through the short
`/tmp/q38-<uid>` symlink because ZeroMQ Unix sockets have a 107-character path
limit. Do not replace `TMPDIR` with the long repository path.

### Monitor the initial download

In another terminal:

```bash
watch -n 2 'du -sh /home/johan/.cache/huggingface/hub/models--gittensor-model-hub--Qwen3.8-27B-NVFP4-RTX5090 2>/dev/null; df -h ~/dev/github/eislab-cps/styrops/llm/vllm'
```

An optional explicit pre-download also displays progress:

```bash
cd ~/dev/github/eislab-cps/styrops/llm/vllm
source venv/bin/activate
hf download gittensor-model-hub/Qwen3.8-27B-NVFP4-RTX5090
```

### Context-size profiles

The default 128K profile leaves more GPU headroom and is recommended:

```bash
./run_qwen3.8-27b-nvfp4.sh
```

The full 256K profile automatically raises vLLM's GPU reservation from 0.92 to
0.97 and is much tighter on a display-attached 32 GB card:

```bash
QWEN38_MAX_MODEL_LEN=262144 ./run_qwen3.8-27b-nvfp4.sh
```

`QWEN38_MAX_MODEL_LEN` is the combined input and output limit. Ordinary KV
caching is always enabled. Automatic prefix caching is a separate feature and
defaults off; enable it only after validating the workload:

```bash
QWEN38_ENABLE_PREFIX_CACHING=1 ./run_qwen3.8-27b-nvfp4.sh
```

## Check the OpenAI-compatible API

After the startup log reports that the server is listening, inspect the served
model:

```bash
curl -s http://127.0.0.1:30000/v1/models | python -m json.tool
```

Text request:

```bash
curl -s http://127.0.0.1:30000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Qwen3.8-27B",
    "messages": [{"role": "user", "content": "Reply with exactly: ready"}],
    "max_tokens": 32
  }' | python -m json.tool
```

Vision request; replace the example URL with an image reachable by the vLLM
host:

```bash
curl -s http://127.0.0.1:30000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Qwen3.8-27B",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe this image briefly."},
        {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
      ]
    }],
    "max_tokens": 256
  }' | python -m json.tool
```

## Configure Exec

The `llm-vllm` entry in `/home/johan/.config/exec/executors.yaml` should contain
these values:

```yaml
model: Qwen3.8-27B
context_size: 131072
max_tokens: 32768
tool_call_parser: qwen3_xml
family: qwen3
max_concurrent: 1
```

The knowledge executor uses the same multimodal server:

```yaml
vision_host: http://10.0.0.200:30000
vision_model: Qwen3.8-27B
```

Restart Exec after changing its configuration. The vLLM server itself is still
started with `run_qwen3.8-27b-nvfp4.sh`.

## Troubleshooting

### FlashInfer version mismatch

If startup reports that `flashinfer-cubin` does not match `flashinfer`, reinstall
both pinned packages. Do not bypass the check with
`FLASHINFER_DISABLE_VERSION_CHECK=1`:

```bash
source venv/bin/activate
python -m pip install --upgrade --force-reinstall --no-deps \
  "flashinfer-python==0.6.16.post3" \
  "flashinfer-cubin==0.6.16.post3"
```

### No space left during a Ninja build

Check both filesystems:

```bash
df -h /tmp ~/dev/github/eislab-cps/styrops/llm/vllm
du -sh venv/qwen38-runtime /home/johan/.cache/huggingface 2>/dev/null
```

The launcher already redirects new JIT files away from `/tmp`. A failure can
still leave old compiler directories behind; inspect them before deleting
anything.

### ZeroMQ IPC path is longer than 107 characters

Use the launcher without overriding `QWEN38_TMPDIR`. It creates the short
`/tmp/q38-<uid>` symlink automatically. If that path already exists as a regular
file or points elsewhere, the launcher stops with an explicit error instead of
overwriting it.

### CUDA is unavailable

If `nvidia-smi` works but `torch.cuda.is_available()` is false, confirm that the
command is running on the host with GPU access and that the driver supports the
CUDA 13 runtime installed with PyTorch.

## Updating later

Treat the versions above as one tested set. When upgrading vLLM, let it select
its required PyTorch version, then install a `flashinfer-cubin` version exactly
matching vLLM's required `flashinfer-python` version. Run `python -m pip check`
before starting the server.

The older Gemma-specific patch documented in `README.md` was for vLLM 0.19.0.
Do not apply that patch to this Qwen3.8 environment.
