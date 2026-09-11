# Planner evaluation

This suite sends fixed **synthetic observations** to the existing `LocalPlanner`. It never connects a Minecraft bot or executes game actions. Assertion success means only that the returned, harness-validated plan satisfies listed structural checks. It does not establish construction quality, honest prose, safe execution, crafting reliability, or in-world success.

Run from `harness/`:

```sh
node eval/run.js --dry-run
node --test eval/*.test.js
```

Evaluate an explicitly selected local server after it has started and loaded the intended model:

```sh
node eval/run.js --endpoint http://127.0.0.1:PORT/v1/chat/completions --model MODEL_ID --out results/qwen-planner-baseline.json
```

`PORT` and `MODEL_ID` are placeholders; use the endpoint/model reported by the local server. This does not download, start, or switch models. No model profile is written or activated.

Evaluate an existing profile from a file using the same inputs:

```sh
node eval/run.js --profiles-file state/models.json --profile PROFILE_ID --allow-subscription --out results/frontier-planner-baseline.json
```

Choose the actual profile ID from the app's configured profiles. `--allow-subscription` explicitly permits use of the selected Codex/Claude subscription. It is required for either subscription kind and consumes subscription usage. Cloud API profiles are rejected. The runner does not load API keys or change the application's active profile. Local profiles need no subscription flag.

Use repeated `--case CASE_ID` flags to run a subset. `--dry-run` makes no provider calls, even when a profile is specified. The direct-rule control normally makes no provider call and is tagged `direct-rule`; do not count it as model performance. Other cases are tagged `model-request`; a request error is not a successful model response. The local HTTP request count includes the planner's possible JSON-repair retry. Subscription request counts are unavailable and reported as null. Both providers may apply production intent guards and normalization before these checks. This suite measures **model plus current planner**, not raw model text.

Receipts record the case-suite hash, relevant planner source hashes, model configuration, elapsed time per case, returned plans, structural checks, and errors. Compare runs with identical suite/source hashes and selected cases. These hashes do not pin the entire dependency tree, server configuration, or model weights: preserve those separately for reproducible experiments. `inWorldSuccess` is always null. Completion, unsupported actions, and cancellation cases require human review of the reply as well as structural checks. These inputs should remain evaluation fixtures, excluded from fine-tuning data.

An exact compound request can have several valid strategies. The checks intentionally encode a small preferred plan in some cases, particularly capturing “here” before acquisition. A failure warrants inspection, not an automatic verdict that the model cannot solve Minecraft. Likewise, an empty plan can pass a no-action check while its reply is misleading. Do not convert these receipts directly into positive training examples.

The historical `unsupported-smelting` case has been retired because smelting and item transfer are supported now. The current suite has seven model-request cases plus one direct-rule control. The retained frontier baseline receipts predate this retirement and retain their original suite hash; their seven selected cases were identical across both providers. See [baseline and next model work: scope and evidence limits](../../docs/STATUS.md).
