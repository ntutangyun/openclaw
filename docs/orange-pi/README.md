# Orange Pi / GMKtec MiniPC Setup

## BIOS / Kernel

- Explicitly enable PCIe Channel Forwarding in BIOS of the GMKtec MiniPC
- `/etc/default/grub`:

```
GRUB_DEFAULT="Advanced options for Ubuntu>Ubuntu, with Linux 5.15.0-126-generic"
GRUB_TIMEOUT_STYLE=hidden
GRUB_TIMEOUT=10
GRUB_DISTRIBUTOR=`lsb_release -i -s 2> /dev/null || echo Debian`
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash modprobe.blacklist=thunderbolt pcie_ports=compat"
GRUB_CMDLINE_LINUX=""
```

## vLLM Ascend (Docker)

Use `quay.io/ascend/vllm-ascend:v0.19.1rc1-310p` to serve LLMs on the 310P NPU.

### Start container

```bash
bash docs/orange-pi/vllm-docker-run.sh
```

This mounts the Ascend NPU devices, driver libs, and `~/.cache` (for ModelScope model
weights) into the container with `--network host`.

### Serve a model

Inside the container, use `vllm-serve.sh`:

```bash
# Example: serve the 27B model
bash vllm-serve.sh Qwen/Qwen3___6-27B

# Example: serve the 35B-A3B MoE model
bash vllm-serve.sh Qwen/Qwen3___6-35B-A3B
```

The script sets `VLLM_USE_MODELSCOPE=True` and applies the required Ascend
compilation flags (`cudagraph_mode: none`, custom ops for rms_norm and
rotary_embedding, `fuse_norm_quant: false`).

### Download models

Models are cached via ModelScope. With `VLLM_USE_MODELSCOPE=True`, vLLM
auto-downloads on first serve. Alternatively, pre-download inside the container:

```bash
pip install modelscope
modelscope download --model Qwen/Qwen3___6-27B
```

### Benchmark

```bash
# Install requests if needed
pip install requests

# Benchmark a model (defaults to 35B-A3B on localhost:8000)
python3 vllm-bench.py [base-url] [model-name]
```

## Swap for Model Workloads

Large models (e.g. Baichuan-7B) need physical RAM + swap > 64GB during weight
conversion and inference. Use `swap-setup.sh` to provision a swap file:

```bash
# Create and enable 64G swap (default)
sudo bash docs/orange-pi/swap-setup.sh up

# Check current memory + swap state
sudo bash docs/orange-pi/swap-setup.sh status

# Release and remove when done
sudo bash docs/orange-pi/swap-setup.sh down
```

Override size or path:

```bash
sudo bash docs/orange-pi/swap-setup.sh up 32G                # custom size
SWAP_FILE=/mnt/data/swap sudo bash docs/orange-pi/swap-setup.sh up  # custom path
```
