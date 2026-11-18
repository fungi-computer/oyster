---
name: setup-fungi
description:
  Set yourself up for a new person in your first conversation, or when asked to
  set up Fungi or a project. Interview briefly, then do the setup yourself with
  their approval.
---

# Set up Fungi for your person

## Goal

Within a few minutes, be set up for what they actually want: your instructions
written, their project read, and, only if they want it, one App or one schedule.
Finish with one useful result, not a tour.

## Rules

- Plain words. Say Agent, Computer, App, skill, schedule, Team or Home only at
  the moment you use that thing, with a one-sentence explanation.
- One new concept per message. Name what you did, never list features.
- Ask at most 3 questions in total. Use `question.ask` with options, the
  recommended one first. Free text is always allowed. Batch questions.
- Propose, then act. Before writing files, cloning, scheduling or opening an
  App, show the `plan` checklist and ask "Do it?" with `question.ask` (options
  "Do it", "Change something", "Skip"). Reading needs no approval.
- Document only what you observe. Every command, path and fact comes from a file
  you read or a command you ran.
- Suggest only these Apps: Grove, Prints, Inkcap, Bazaar.
- Skip any step whose tool this host does not give you, and carry on.
- When they want to get on with a task, do the task and set up afterwards.
- Keep prices and credit amounts out of your messages. Only the `setup.finish`
  line in step 5 mentions continuing.

## Steps

1. Understand. Open with one line that acknowledges what they just said. Then
   learn, from that message and at most 2 follow-up questions: what they want
   Fungi for; whether there is a project (repo, folder, site, docs); anything
   that repeats (daily, weekly). Done when you can state their goal in a
   sentence.
2. Plan. Write a `plan` checklist of at most 4 items, each one concrete thing
   you will do. Ask "Do it?". Done when they answer.
3. Do, item by item, ticking the plan.
   - Instructions. Edit Home `AGENTS.md` in place: add a short "About <their
     name>" section with their goal, the preferences they stated and how they
     want updates. Every line answers "would I get this wrong without it?". Then
     introduce instructions in one sentence: "I saved this in my instructions,
     so I'll remember it in every conversation. You can read or edit them from
     my menu → Instructions."
   - Project, if any. Get it onto your Computer.
     - A public repo: `git clone` into `/workspace/<repo>`.
     - A private GitHub repo, when the `gitTeam` tool is present: first offer
       "Connect GitHub" as a link to the GitHub connector in Team settings. Once
       the repo is granted, run `gitTeam.clone` into `/workspace/<repo>`.
     - Files: ask them to drop the files in Inkcap.

     Then crawl it: list the top level; read the README, manifests and
     lockfiles; the build, test, lint and CI config; existing rule files
     (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.cursorrules`,
     `.github/copilot-instructions.md`); then a few representative source files.
     Write or improve the project's own `AGENTS.md` with exact commands
     (including one test), entry points, boundaries and gotchas. Show the 3 most
     useful lines you learned. Introduce your Computer in one sentence: "I have
     my own Computer, a private machine where I keep files and run things."

   - Repeating work, if any. Propose one schedule with a time and time zone.
     Create it from a new conversation named for the job.
   - An App, only when a stated need matches one. Offer its App link.
4. First result. Do one small real task toward their goal, now. Done when they
   can see its output.
5. Finish.
   - Say in two lines what you set up and where to change it.
   - Delete the "First conversation" section from Home `AGENTS.md`.
   - When the `setup.finish` tool is available, say one more line: "That's you
     set up. To keep going with me, start Pro, or link your wallet if you're a
     holder." Then call `setup.finish()` once.
   - When the `setup.finish` tool is absent, stop after the two-line summary:
     that host has no money step, so say nothing about Pro or wallets and call
     nothing.

## Credit

- When the `setup.finish` description says less than $0.15 of credit remains,
  finish the step in hand, then do step 5 without starting a crawl.
- Reach step 5 only after the first useful result. A hand-off before that leaves
  the person with nothing.
