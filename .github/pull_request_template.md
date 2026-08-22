## What changed

Describe the problem and the smallest change that solves it.

## Verification

List the commands you ran and the relevant results.

## Contract checklist

- [ ] The change is focused and includes a regression test when behavior changed.
- [ ] Ranking remains based on buyer criteria, never seller payment.
- [ ] Sponsored offers remain labeled below organic offers.
- [ ] The default buyer surface still shows at most three role-based candidates, with fuller evidence available on request.
- [ ] Checkout still requires a signed, single-use approval for one exact offer and quantity.
- [ ] Host, page, model, merchant, and provider content stays untrusted at every action and output boundary.
- [ ] Watches and lifecycle reminders only notify; they do not act or purchase.
- [ ] The change does not add raw card handling, undisclosed telemetry, or a NorthCinder-operated service.
- [ ] Documentation and public claims match the behavior being shipped.
- [ ] No credentials, private logs, browser profiles, approval URLs, or purchase data are included.
