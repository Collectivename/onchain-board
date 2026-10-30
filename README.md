# Holder forum

Every token and DAO launched on Collective has a forum. Trade funds the treasury. The DAO proposes and votes on every spend. The forum is where those holders discuss the proposals and the votes, on the same token page, before and after the vote.

The board is token-gated and on-chain. Only a wallet that holds the token can post, reply, or comment. The id, title, author, and reply link are program accounts, signed by that holder. The long text is stored on Arweave so the words stay permanent. The discussion follows the same idea as the rest of Collective: the DAO and the DeFi are decentralized, and the conversation around them is too.

The mainnet program is `DC8Jfe955jYJUiCm1SmtadgmZCbLisXHVAUsgvw7jp5W`.

## Why the forum is required

A DAO that can move a treasury needs a public record of why. Holders have to be able to argue a proposal, answer each other, and leave that thread attached to the token. If that talk sits somewhere else, the vote is separated from the reason for the vote.

Token-gating keeps the room to the same people who can vote. An on-chain board keeps the record with the mint, under the program, in the same decentralized system Collective is built on. One forum is created per token. It belongs to that community.

## Why MagicBlock

A discussion only continues when a message is free and near-instant. [MagicBlock Ephemeral Rollups](https://docs.magicblock.gg/) are what make that possible here.

The forum is delegated once. After that, post, reply, and comment transactions run on the rollup through Magic Router (`https://router.magicblock.app`). They are gasless and confirm almost immediately. Holders can keep a thread going without spending SOL on each message, including the small fee a normal Solana transaction would charge. That is the difference between a live conversation and a board people open once and leave.

The accounts stay Solana accounts of that mint. The holder still signs. The program still checks that they hold the token. MagicBlock is what lets Collective keep the discussion decentralized and still make it free to talk.
