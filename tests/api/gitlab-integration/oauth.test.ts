import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitLabOAuthPkce,
  getGitLabOAuthConfig,
  gitLabOAuthCallbackHtml,
} from "../../../apps/api/src/gitlab-integration/oauth";

const savedEnvironment = {
  GITLAB_PUBLIC_URL: process.env.GITLAB_PUBLIC_URL,
  GITLAB_INTERNAL_URL: process.env.GITLAB_INTERNAL_URL,
  GITLAB_OAUTH_CLIENT_ID: process.env.GITLAB_OAUTH_CLIENT_ID,
  GITLAB_OAUTH_CLIENT_SECRET: process.env.GITLAB_OAUTH_CLIENT_SECRET,
  KANEO_API_URL: process.env.KANEO_API_URL,
  KANEO_CLIENT_URL: process.env.KANEO_CLIENT_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GitLab OAuth configuration", () => {
  it("uses the configured public origin, internal route, and callback", () => {
    process.env.GITLAB_PUBLIC_URL = "https://git.atelier.house/";
    process.env.GITLAB_INTERNAL_URL = "http://gitlab";
    process.env.GITLAB_OAUTH_CLIENT_ID = "client-id";
    process.env.GITLAB_OAUTH_CLIENT_SECRET = "client-secret";
    process.env.KANEO_API_URL = "https://kaneo.atelier.house/api/";
    process.env.KANEO_CLIENT_URL = "https://kaneo.atelier.house";

    expect(getGitLabOAuthConfig()).toEqual({
      publicUrl: "https://git.atelier.house",
      internalUrl: "http://gitlab",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri:
        "https://kaneo.atelier.house/api/gitlab-integration/oauth/callback",
      clientOrigin: "https://kaneo.atelier.house",
    });
  });

  it("fails closed when the server-owned OAuth app is incomplete", () => {
    delete process.env.GITLAB_OAUTH_CLIENT_SECRET;
    expect(() => getGitLabOAuthConfig()).toThrow(/not configured/);
  });
});

describe("GitLab OAuth PKCE", () => {
  it("creates one-time state and an RFC 7636 S256 verifier pair", () => {
    const first = createGitLabOAuthPkce();
    const second = createGitLabOAuthPkce();

    expect(first.state).not.toBe(second.state);
    expect(first.stateHash).not.toBe(first.state);
    expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(first.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.codeChallenge).toBe(
      createHash("sha256").update(first.codeVerifier).digest("base64url"),
    );
  });

  it("posts only a fixed status message back to the configured client", () => {
    process.env.KANEO_CLIENT_URL = "https://kaneo.atelier.house/settings";
    const html = gitLabOAuthCallbackHtml("success");
    expect(html).toContain('"type":"kaneo:gitlab-oauth"');
    expect(html).toContain('"status":"success"');
    expect(html).toContain('"https://kaneo.atelier.house"');
  });
});
