# Your shopping agent should work for you

A shopping agent makes choices on your behalf. The first question should be simple: who is it
working for?

NorthCinder starts from the buyer's brief. Price, required features, delivery, availability, trust,
and stated ethics preferences are the ranking inputs. Seller payment is not one of them. NorthCinder
does not sell sponsored placement. If a store says an offer is sponsored, or a local demo creates a
synthetic sponsored offer, that offer is labeled and placed below every organic result.

That promise is small enough to inspect. The ranking code is open, pure, and deterministic. Each
result includes machine-readable reasons. The client reruns the ranking locally and records the
result in a local audit trail. This makes the ranking deterministic and auditable. It does not make
every upstream catalog, sponsorship flag, or trust signal automatically true.

The same restraint applies to buying. A search is not permission to purchase. A watch is not
permission to purchase. Even a strong recommendation is not permission to purchase. NorthCinder
needs a separate, signed, single-use mandate for the exact offer and spending cap, approved by the
buyer out of band.

The project is built for people who want an agent they can inspect and operate on their own terms:
developers integrating MCP tools, privacy-conscious self-hosters, and buyers who would rather see
the tradeoff than accept a mysterious first answer. Adapters have different access requirements,
and NorthCinder reports unavailable or blocked stores instead of hiding incomplete coverage.

NorthCinder is published as software, not operated as a service. The repository owner does not run a
NorthCinder endpoint, issue client keys, collect buyer history, receive audit trails, or sit in the
checkout path. The buyer runs the code locally or deploys it on infrastructure they control. There
is no NorthCinder account, hosted control plane, subscription, affiliate stream, or seller-funded
placement. Publication is the handoff: the software keeps working without the repository owner's
availability or involvement.

The goal is not to ask people to trust another shopping brand. The goal is to make the important
parts checkable:

- what the agent considered;
- why one result came before another;
- whether sponsorship was disclosed;
- what the human actually approved; and
- what happened when checkout was attempted.

Shopping beyond the first answer means looking past the result most convenient for a platform and
asking which result fits the buyer's brief. NorthCinder exists to keep that question in the buyer's
hands.

The ranking and trust rules are executable, documented contracts. See
[`docs/RANKING.md`](./docs/RANKING.md), [`docs/TRUST.md`](./docs/TRUST.md), and the corresponding
source under [`packages/protocol`](./packages/protocol).
