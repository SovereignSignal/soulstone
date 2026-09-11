# Optional local Qwen baseline

This runs the unmodified Qwen3.8-27B UD-Q6_K model using Unsloth's installed llama.cpp Metal runtime. It is a text-only baseline for the Minecraft harness, with no fine-tuning yet. The vision projector is intentionally not downloaded: the harness currently supplies structured game observations.

- Public weights: [unsloth/Qwen3.8-27B-GGUF](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-UD-Q6_K.gguf), approximately 22 GB.
- SHA256: `c9c206812fbe4ac7b76a729e25928b63f2ae89d37f69da7a71c20aec763cd436`.
- Runtime: existing `~/.unsloth/llama.cpp/llama-server`, verified build b10698, Unsloth Metal arm64.
- API: `http://127.0.0.1:1235/v1/chat/completions`; model `minecraft-qwen3.8-27b-q6`.
- Context: 16,384 tokens; one request slot; thinking disabled for the first latency baseline. This is an explicit baseline choice, not the model's maximum capability.
- `profile.json` is compatible with the harness model-profile schema. Register it without activation to preserve the current selected model.
- Browser CORS is restricted to localhost. There is no authentication on this loopback-only endpoint. Other local applications can access it. No external inference service or API billing is involved.

From this directory:

```sh
sh download.sh
python3 service.py start
python3 service.py status
node smoke.mjs
python3 service.py stop
```

`download.sh` resumes interrupted downloads and checks the published SHA256. Start also checks the weight verification receipt. The server is a detached process that stays up after the invoking terminal exits, until stopped or the computer restarts. It is not a login item or scheduled service. `service.py stop` verifies the recorded PID's creation time before signalling only that process. Logs and PID state live in ignored `state/`; weights in ignored `weights/`; smoke receipts in ignored `results/`.

Starting the server never changes the app's active model or joins Minecraft. The two smoke cases call the actual model with the current harness JSON schema and validate its answers; they do not prove successful crafting or building in the world. Use the shared evaluation runner for broader comparisons.

## Training readiness

Installed components include Unsloth 2026.8.22, MLX 0.32.1, mlx-lm 0.31.3 and mlx-vlm 0.6.17. The installed `unsloth_zoo.mlx.trainer` contains `MLXTrainer`; its loader includes Qwen3.5 training fixes, and mlx-lm includes the `qwen3_5` architecture used by Qwen3.8. This is positive compatibility evidence, not an end-to-end training test.

The [current Qwen fine-tuning guide](https://unsloth.ai/docs/models/qwen3.8/train) still describes MLX training as forthcoming even though the local installation contains MLX training code. Verify one small adapter-training run against actual trainable weights before committing to a full run. These GGUF inference weights are not the training checkpoint. Training will need a compatible Hugging Face/MLX checkpoint and curated train/validation data. No adapter training or extra training-weight download is performed by these scripts.

Before training, compare this baseline with a frontier model on identical observations and held-out goals. Export only verified successful or corrected episodes, split by scenario/world, and retain failure traces for evaluation. Runtime recipes and version-specific block mechanics remain harness responsibilities.

## First observed baseline

The model downloaded completely (21,983,677,344 bytes) and matched the published SHA256. The Metal server passed both schema smoke cases. The short acquisition plan took 5.8 seconds; the 1,485-token construction response took 70.0 seconds, at roughly 22 generated tokens per second.

Semantic review failed the construction case: the reply claimed a shelter with an entrance, but its 75-block blueprint was a solid 5×5×3 cuboid. Schema validity is not task success. See ignored `results/inference-smoke.json` and `results/inference-manual-review.json` for the preserved responses and review. This baseline has not been trained.
