#!/bin/bash
# Run vllm-ascend container on Ascend 310P NPU
# Requires: Ascend driver installed on host, model cache at ~/.cache/modelscope
#
# Usage:
#   bash vllm-docker-run.sh [shell]   # default: serve, pass 'shell' for interactive

IMAGE="${VLLM_ASCEND_IMAGE:-quay.io/ascend/vllm-ascend:v0.19.1rc1-310p}"
NAME="${VLLM_CONTAINER_NAME:-vllm-ascend}"

# Check if container already exists
if docker inspect "$NAME" >/dev/null 2>&1; then
    echo "Container $NAME already exists. Starting it..."
    docker start -ai "$NAME"
    exit $?
fi

# NPU devices required by Ascend
DEVICES=(
    --device /dev/davinci0
    --device /dev/davinci_manager
    --device /dev/devmm_svm
    --device /dev/hisi_hdc
)

# If a second NPU is present, add it
if [ -e /dev/davinci1 ]; then
    DEVICES+=(--device /dev/davinci1)
fi

docker run -it --rm \
    --network host \
    --name "$NAME" \
    "${DEVICES[@]}" \
    -v /etc/ascend_install.info:/etc/ascend_install.info \
    -v /usr/local/dcmi:/usr/local/dcmi \
    -v /usr/local/bin/npu-smi:/usr/local/bin/npu-smi \
    -v /usr/local/Ascend/driver/lib64/:/usr/local/Ascend/driver/lib64/ \
    -v /usr/local/Ascend/driver/version.info:/usr/local/Ascend/driver/version.info \
    -v "$HOME/.cache:/root/.cache" \
    -v "$PWD:/workspace" \
    -w /workspace \
    "$IMAGE" \
    "$@"
