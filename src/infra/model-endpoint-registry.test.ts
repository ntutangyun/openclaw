import { afterEach, describe, expect, it } from "vitest";
import {
  _resetModelEndpointRegistry,
  getRecentModelEndpoints,
  recordModelEndpoint,
} from "./model-endpoint-registry.js";

describe("model-endpoint-registry", () => {
  afterEach(() => _resetModelEndpointRegistry());

  it("records host:port from a URL, defaulting the port by scheme", () => {
    recordModelEndpoint("https://api.openai.com/v1/chat/completions", 1000);
    recordModelEndpoint("http://172.17.0.1:8000/v1/models", 1000);
    const eps = getRecentModelEndpoints(60_000, 1000);
    expect(eps).toContainEqual({ host: "api.openai.com", port: 443 });
    expect(eps).toContainEqual({ host: "172.17.0.1", port: 8000 });
  });

  it("dedupes repeated endpoints and ignores malformed URLs", () => {
    recordModelEndpoint("https://api.openai.com/v1", 1000);
    recordModelEndpoint("https://api.openai.com/v1/other", 1000);
    recordModelEndpoint("not a url", 1000);
    expect(getRecentModelEndpoints(60_000, 1000)).toEqual([{ host: "api.openai.com", port: 443 }]);
  });

  it("prunes entries older than the TTL", () => {
    recordModelEndpoint("http://localhost:8000/v1", 1000);
    expect(getRecentModelEndpoints(5000, 4000)).toHaveLength(1); // within TTL
    expect(getRecentModelEndpoints(5000, 7000)).toHaveLength(0); // expired (6s > 5s)
  });
});
