ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE}
COPY --chmod=0555 check.mjs /opt/autocode/verifier/check
ENTRYPOINT ["/opt/autocode/verifier/check"]
