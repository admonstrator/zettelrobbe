# Contributing

Thanks for being here. A few things up front, so we can skip the awkward parts.

## What this project is

Zettelrobbe is a hobby project. One person maintains it, in their spare time, for
free, and uses it daily for their own documents. That last part is the only quality
guarantee on offer: if it breaks, my own invoices go untagged.

What follows from that:

- **There is no support contract.** No SLA, no triage rotation, no promise that a
  given bug gets fixed at all.
- **I work on what I have energy for.** Sometimes that is the oldest open issue.
  More often it is whatever caught my interest that evening. Both are fine.
- **"No" and "not now" are real answers.** If something is out of scope or not
  worth the complexity, I would rather say so than leave it open forever.

None of this is a complaint. It is the shape of the thing, and knowing it up front
saves everyone some friction.

## How the code gets written

Openly: most of the code here is written with AI assistance, and has been from the
start. I am an IT architect by trade, not a JavaScript developer.

What that leaves me is the part that decides whether the software is any good: what it
should do and what it should not, which features get cut instead of built, whether a
diff actually solves the problem it claims to, and whether the result survives contact
with my own documents — which it gets every day, because this is what I file my own
paperwork with. Features have been removed from this project on that basis, not added.
The [README](README.md#how-this-is-built) and the [About page](https://zettelrob.be/about/) have more on this.

Two consequences worth knowing before you file an issue or send a PR:

- **Tests and commit messages carry more weight here than they might elsewhere.**
  When a machine writes the code, the review and the regression test are where the
  quality actually comes from. That is why there is a custom test suite, why a fix is
  expected to arrive with a test that fails without it, and why the commit body is
  the documentation rather than a changelog file. A report pointing at a missing test
  is fair criticism and I would rather have it than not.
- **AI is already doing the work.** "Let AI handle it" is the existing workflow rather
  than a suggestion. What it does not do on its own is notice that something is broken
  on your setup — that part is still yours, and it is the part I cannot do without.

AI-assisted contributions are welcome, for the obvious reason. You own what you submit
either way: if you cannot explain what your patch does and why, please hold off on the
PR. Commits made with an assistant carry a `Co-Authored-By` trailer here — keeping that
habit is appreciated, not required.

## Reporting a bug

The bug report template asks for what I actually need. The three that matter most:

- the **version**, and the commit if you have it,
- **exact steps** — what you clicked, in order,
- **what happened instead**, with the log lines around it.

A report with those three is genuinely valuable to me, whatever mood it arrives in.
A vague one is not — I cannot chase what I cannot reproduce.

If you are reporting that an earlier fix did not work, say what you still see and on
which version. "Still broken" on its own sends me back to look at something I may
already have looked at.

## Feedback on how the project is run

Suggestions about architecture, testing or process are welcome, and I act on the good
ones. Two things make them land:

- keep them separate from bug reports, so a broken thing gets fixed without waiting on
  a process discussion;
- phrase them as what you would do, not as what I failed to do.

## Pull requests

Please, genuinely: **open a PR.** It is the fastest path from "this annoys me" to
"this is fixed", and it is not a brush-off when I say it. Everyone is welcome, from
fellow vibe-coders to people who actually understand memory management.

What CI checks:

- ESLint, Prettier and stylelint on the files you changed,
- the offline test suite (`node scripts/run-tests.js --all`),
- an OpenAPI drift check — if you touched an endpoint, run
  `node scripts/regen-openapi.js` and commit the result.

Conventions: English everywhere — code, comments, commits, UI strings. Branches are
`{type}-{number}-{short-description}`. The commit body is the documentation; please do
not add changelog markdown files.

> Note: `npm test` starts the dev server. The tests run through
> `node scripts/run-tests.js --all`. Sorry about that.

## Tone

Assume good faith in both directions and we will be fine. I will tell you plainly when
something is not a bug, is not going to happen, or when I got it wrong — which happens.
Same plainness back, please.

This is a free project built by one person. That does not oblige you to be delighted
with it, and it does not oblige me to absorb everything. Mostly it means: the fastest
way to get something changed is to change it.
