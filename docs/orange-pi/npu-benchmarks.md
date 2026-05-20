# Ascend 310P1 NPU LLM Benchmarks

Hardware: 2× Ascend 310P1, ~89 GB each, ~176 TOPS INT8 each.
Run on a single NPU with vLLM, single request (batch=1).

| Model | Avg Token/s |
|---|---|
| Qwen3:0.6B | 33 |
| Qwen3.5:0.8B | 17 |
| Qwen3.5:2B | 14 |
| Qwen3.5:4B | 9.3 |
| Qwen3.5:9B | 6.7 |
| Qwen3.6:27B | 2.6 |
| Qwen3.6:35B-A3B | 1.0 |

## Notes

- Effective memory bandwidth ~140 GB/s (calibrated from dense 27B at BF16).
- The 35B-A3B MoE score is bandwidth-limited, not compute-limited: MoE saves
  FLOPs but not memory, and expert routing at batch=1 turns sequential reads into
  scattered, non-contiguous access, roughly halving effective bandwidth.
- FP8 variants (e.g. Qwen3.6-27B-FP8) should ~double these speeds by halving
  the bytes read per token.
