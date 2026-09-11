#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p weights state results
if [ -f state/weights.json ]; then
  if python3 service.py verify; then exit 0; fi
fi
curl -fL --retry 4 --retry-delay 3 -C - --output weights/Qwen3.8-27B-UD-Q6_K.gguf \
  'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-Q6_K.gguf'
python3 service.py verify
