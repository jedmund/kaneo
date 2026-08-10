# GitLab container pipeline

The root `.gitlab-ci.yml` validates the monorepo and builds the combined Kaneo
image from `Dockerfile.kaneo` with an isolated BuildKit container launched
through the runner's Docker socket.

Merge request pipelines execute the complete container build but discard its
output. Default-branch and tag pipelines publish exactly one immutable image:

```text
${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA}
```

The job uses GitLab's predefined `CI_REGISTRY`, `CI_REGISTRY_IMAGE`,
`CI_REGISTRY_USER`, and `CI_REGISTRY_PASSWORD` variables. No long-lived
registry credential is required to publish from CI.

For a registry signed by a private certificate authority, configure
`REGISTRY_CA_CERT` as a protected file-type CI/CD variable containing the PEM
CA certificate. A regular variable containing the PEM is also supported. The
job installs it into the Docker CLI trust store before login and passes it to
the ephemeral BuildKit daemon with `--buildkitd-config`; Buildx copies the CA
into that daemon before it pushes. This follows Docker's
[registry certificate configuration](https://docs.docker.com/build/buildkit/configure/#setting-registry-certificates).
Do not disable TLS verification.

Because protected variables are exposed only to protected refs, protect the
default branch and every tag pattern that is allowed to publish an image.
Merge-request builds do not log in or push.

The deployment host should authenticate with a separate read-only deploy token
and pin the exact `${CI_COMMIT_SHA}` tag. The pipeline intentionally does not
publish `latest`.
