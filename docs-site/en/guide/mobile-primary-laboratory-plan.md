---
description: Experimental roadmap for primary-device registration and companion management.
---

# Mobile-primary laboratory plan

The target is a primary-device workflow: register an authorized lab number, validate the SMS code, persist credentials, connect and manage companions. This is a roadmap, not an available product capability. Implementation begins with the [isolated local lab](mobile-primary-local-lab.md).

The registration component must be researched and validated before exposing an SMS action. Do not invent provider endpoints, simulate success or bypass attestation, CAPTCHA or rate limits. Receiving an SMS alone does not establish that the full registration protocol is supported.

Keep initial registration separate from companion linking. Reuse existing application messaging, session ownership and webhook infrastructure; do not create concurrent runtimes for one account. Persist credentials and companion state securely. Administrative operations require authorization, idempotency and reconciliation after uncertain remote outcomes. Never place QR contents, OTPs or credentials in logs or dead-letter payloads.

Implementation gates:

1. F0: isolated infrastructure and authorized lab devices.
2. F1–F2: registration research, provider implementation and failure tests.
3. F3–F4: durable authentication, runtime recovery, scoped API and commands.
4. F5–F6: primary-device interface and companion linking by supported QR/code flows.
5. F7–F8: messaging compatibility, regression tests, documentation and security review.
6. F9: separately authorized VoIP and ephemeral-media investigation.

Use only lab numbers. Do not import production credentials or convert production sessions. Restoring local storage cannot undo registration/revocation already performed on WhatsApp. Do not promise support for every mobile platform until verified. The [full Portuguese plan](/guide/mobile-primary-laboratory-plan) contains the architecture, proposed contracts and test matrix.
