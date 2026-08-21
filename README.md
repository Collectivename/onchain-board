# Holder forum

Collective is a Solana app for tokens with a DAO. It puts a discussion board next to Trade and DAO: one forum per token, on-chain and for holders only.

The board runs on **MagicBlock Ephemeral Rollups (ER)**. That is the piece that makes a holder forum possible on Solana at all.

## The problem ER solves

A community on-chain decentralized board has to be two things at once

**It has to be real.** Fully on-chain, so a post is a signed Solana transaction in a PDA not a row in a company database. No admin key that can edit, delete, or fake a message. Holders-only enforced by the program, not by a server. Owned by the people who hold the mint

**It has to feel like a forum.** Post, reply, refresh, reply again. Near-zero cost, instant confirmation. because Nobody writes a second paragraph if the first one costs a trade.

it must be both , you can't just pick one:

| Approach | On-chain and community-owned | Cheap and fast enough to talk |
|---|---|---|
| Solana L1 for every post | Yes | No — settlement cost and latency per reply |
| Off-chain database | No — Collective owns and can rewrite it | Yes |
| Separate L2 / appchain | Partly — new asset, bridging, own trust set | Yes |
| **MagicBlock ER** | **Yes — same PDAs, same mint, same wallet** | **Yes** |

ER is the only option that does not force the trade. Forum accounts are ordinary Solana PDAs. They get **delegated once**, then the same program executes on the rollup for every post and comment. The holder signs. The program checks the real token balance. The cost and the confirmation feel like a social app.

## Why this is the right fit for Collective

- **Nothing is off-chain except the words.** Ids, titles, authors, counts, and the reply graph live in program accounts. Bodies go to Arweave, content-addressed and permanent. There is no database to trust and none to migrate.
- **The community owns it, provably.** The program requires a positive token balance to post. there is no operator key in the app that writes to the board.
- **Discussion sits beside governance.** The conversation that leads to a vote lives in the same place as the token and the DAO. That only works if the board is as cheap to use as a chat.
- **it is basically free to talk.** Only the first holder that should open the forum pays rent once. After that, posting is ER-cheap. No subscription, no infra bill, no per-message decision.
- **No new asset, no bridge.** Holders keep using the same wallet and the same mint. Delegation is a handoff, not a migration, and the base layer is still where rent, setup, and index commits settle.
- **A real workload, not a demo.** Nested reply trees, paged post and comment accounts, live feed refresh high-frequency PDA writes from an actual community.

With ER, the board is genuinely on-chain and still pleasant to use.

## How it is wired

Following MagicBlock's [Anchor ER path](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/anchor): `ephemeral-rollups-sdk` 0.16.2, `#[ephemeral]` on the program, `#[delegate]` on each PDA handed to the rollup, Magic Router as the live RPC.

**Handoff (Solana L1, once per token).**  
`Open forum` is one transaction: `initialize`, then `delegate_forum`, `delegate_treasury`, `delegate_post_page(0)`, `delegate_comment_page(0)`. Ownership moves to the Delegation Program. Later pages are opened on L1 and delegated the same way when a page fills.

**The board (ER via Magic Router).**  
`create_post` and `create_comment` run on the delegated accounts. The UI sends those transactions to Magic Router, not to Collective's main RPC. That is the daily traffic: feed, posts, comments, nested replies.

**Optional backup (commit on the ER).**  
`maybe_commit` uses `MagicIntentBundleBuilder`. The per-token commit treasury PDA pays; anyone can fund it. No operator key in env. What gets committed is the index (ids, titles, authors, counts). Bodies stay on Arweave because they are large and never change.

## In the app

1. First holder opens the board (L1 init + delegate).
2. Holders post and reply (ER, Magic Router).
3. Titles show immediately. Opening a thread loads the body from Arweave.

## Folder

| Path | Role |
|---|---|
| `programs/forum` | Anchor program: `#[ephemeral]`, `#[delegate]`, `MagicIntentBundleBuilder` |
| `packages/sdk` | L1 bootstrap, then Magic Router for live traffic |
| `packages/storage-turbo` | Arweave bodies (Turbo) |
| `packages/ui` | Board UI in Collective |

## Hosting

- `NEXT_PUBLIC_FORUM_PROGRAM_ID` — deployed program (`Eq1XL63knJE6UvdQJaWBTt2JrYzsgf3bdqafBkmb9XwG` on devnet)
- `NEXT_PUBLIC_MAGIC_ROUTER_URL` — Magic Router
- `NEXT_PUBLIC_ER_VALIDATOR` — optional; defaults to the Asia public validator
- `FORUM_ARWEAVE_JWK` — server-only Arweave upload key

Forum PDAs are derived from the mint. No Solana operator key in env.
