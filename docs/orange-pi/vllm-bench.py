#!/usr/bin/env python3
"""Quick streaming benchmark against a vLLM completions endpoint."""
import requests, json, sys, time

DEFAULT_BASE = "http://localhost:8000"
PROMPT = "Compare Wifi 6, Wifi 7 and Wifi 8"

def bench(base_url: str, model: str, max_tokens: int = 512):
    url = f"{base_url}/v1/completions"
    payload = {
        "model": model,
        "prompt": PROMPT,
        "stream": True,
        "max_tokens": max_tokens,
        "top_p": 0.95,
        "top_k": 50,
        "temperature": 0.6,
    }
    t0 = time.time()
    count = 0
    first_token = None

    resp = requests.post(url, json=payload, stream=True)
    for line in resp.iter_lines():
        if not line:
            continue
        text = line.decode("utf-8").removeprefix("data: ")
        if text == "[DONE]":
            break
        token = json.loads(text)["choices"][0]["text"]
        if first_token is None:
            first_token = time.time()
        sys.stdout.write(token)
        sys.stdout.flush()
        count += 1

    ttf = first_token - t0 if first_token else 0
    elapsed = time.time() - t0
    print()
    print(f"--- {model} ---")
    print(f"Tokens: {count}, TTFT: {ttf:.2f}s, Total: {elapsed:.2f}s, "
          f"Avg: {count/(elapsed - ttf):.1f} tok/s")

if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BASE
    model = sys.argv[2] if len(sys.argv) > 2 else "Qwen3___6-35B-A3B"
    bench(base, model)
