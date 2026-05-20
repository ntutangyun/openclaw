#!/bin/bash
# Serve a model via vllm-ascend (run inside the Docker container).
# The model path is the modelscope cache path under /root/.cache/modelscope/hub/models/.
#
# Usage:
#   bash vllm-serve.sh Qwen/Qwen3___6-35B-A3B [optional-extra-flags]

export VLLM_USE_MODELSCOPE=True

MODEL_REPO="${1:?Usage: $0 <modelscope-repo-path> [extra-vllm-args...]}"
shift

vllm serve "/root/.cache/modelscope/hub/models/${MODEL_REPO}" \
    --tensor-parallel-size 1 \
    --dtype float16 \
    --max-model-len 32768 \
    --compilation-config '{"cudagraph_mode": "none", "custom_ops":["none", "+rms_norm", "+rotary_embedding"]}' \
    --additional-config '{"ascend_compilation_config": {"fuse_norm_quant": false}}' \
    --served-model-name "${MODEL_REPO##*/}" \
    "$@"
