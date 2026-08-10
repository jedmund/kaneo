# GitLab container pipeline

The root `.gitlab-ci.yml` validates the monorepo and builds the combined Kaneo
image from `Dockerfile.kaneo` with rootless BuildKit.

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
pipeline writes it to BuildKit's ephemeral registry configuration. Do not
disable TLS verification.

The deployment host should authenticate with a separate read-only deploy token
and pin the exact `${CI_COMMIT_SHA}` tag. The pipeline intentionally does not
publish `latest`.
