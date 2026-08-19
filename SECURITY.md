# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability-reporting form:

<https://github.com/cinderline/northcinder/security/advisories/new>

Do not open a public issue for a vulnerability. Include the affected component, impact, minimal
reproduction steps, and a suggested fix when available. Remove credentials, personal data, private
logs, and real purchase information from the report.

## Sensitive material

Never submit:

- raw card data;
- store credentials, browser profiles, service keys, mandate keys, confirmation codes, or approval
  URLs;
- private audit, profile, order, or mail data; or
- an active exploit against a NorthCinder deployment you do not own or have permission to test.

## Supported code

Security fixes target the current `main` branch. Reproduce issues against the latest revision when
possible.

## Security boundary

NorthCinder's mandate gate, nonce ledger, loopback UI, file permissions, content-security policy, and
payload validation reduce risk but do not protect local files from another process the buyer runs
as the same OS user with arbitrary filesystem access. This is local computer isolation, not access
by a NorthCinder-operated host: there is no such host. A buyer can use separate OS accounts when they want
stronger isolation between their own AI application and their own NorthCinder process.
