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
- Ask at most 3 cards in total, counting the "Do it?" plan and the name offer. A
  card is one `question.ask`; keep each short and specific, and batch a few
  questions into one card. Use options, the recommended one first. Free text is
  always allowed, and an option that lets them type their own answer is fine. Do
  not ask for the person's own name; their account already has it.
- Propose, then act. Before writing files, cloning, scheduling or opening an
  App, show the `plan` checklist and ask "Do it?" with `question.ask` (options
  "Do it", "Change something", "Skip"). Reading needs no approval.
- Document only what you observe. Every command, path and fact comes from a file
  you read or a command you ran.
- Suggest only these Apps: Grove, Prints, Inkcap, Bazaar.
- Skip any step whose tool this host does not give you, and carry on.
- A build, install or test that fails or times out never ends setup: say what
  failed in one line, carry on, and still make every offer in step 5. A command
  result of `unknown` means it may still be running, so check again before
  calling it failed.
- When they want to get on with a task, do the task and set up afterwards.
- Keep prices and credit amounts out of your messages. Only the `setup.finish`
  line in step 5 mentions continuing.

## Steps

1. Understand. Open with one line that acknowledges what they just said. Then
   learn, from that message and at most 1 follow-up card: what they want Fungi
   for; whether there is a project (repo, folder, site, docs); anything that
   repeats (daily, weekly). Done when you can state their goal in a sentence.
2. Plan. Write a `plan` checklist of at most 4 items, each one concrete thing
   you will do. Ask "Do it?". Done when they answer.
3. Do, item by item, ticking the plan.
   - Instructions. First list your Computer's top folder, never read `AGENTS.md`
     blind. When it is listed, edit it in place; when it is not there yet, your
     Computer is still finishing its first start: carry on with the other items,
     come back to it before step 4, and if it is still missing create it with
     the same headings. Fill its "About my person" section (rename it "About
     <their name>") with their goal, the preferences they stated and how they
     want updates. Follow its "Keeping this file up to date" section from then
     on. Every line answers "would I get this wrong without it?". Then introduce
     instructions in one sentence: "I saved this in my instructions, so I'll
     remember it in every conversation. You can read or edit them from my menu →
     Instructions."
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
     - Prints: describe `PRINTS.generateImage` or `PRINTS.generateVideo`, then
       call it; mark a keeper with `PRINTS.setFavorite` on its saved path and
       read them back with `PRINTS.listFavorites`. The library folder is chosen
       by the person in Prints, and no method lets you choose it, so do not
       search for one: if Prints says no library is selected, say so in one line
       and tell them to pick it in Prints.
4. First result. Do one small real task toward their goal, now. Done when they
   can see its output.
5. Finish. Do every item below, in order. Do not end your turn before the name
   offer and the dashboard offer have each been asked, failed, or skipped. Even
   if part of setup is blocked, such as an App that is not ready, say so in your
   two lines and still make both offers. An answered card is final: do not ask
   it again in text.
   - Say in two lines what you set up and where to change it.
   - Offer a name, once (required). Ask with `question.ask`: "Keep <your name>"
     first, where your name is the one in your instructions ("Your name is …"),
     copied verbatim and never guessed, then two names you suggest that fit
     their goal; free text is always allowed. Ask the name only as a
     `question.ask` card, never in plain text. Wait for their pick: call
     `question.ask` without `mode`, never `mode: "continue"`, and make no
     dashboard call until they have picked. Ask it at most once in the whole
     conversation, even if you run step 5 again. Once they have picked, whether
     a new name or Keep, the name is settled: never ask it again, not even after
     an empty or interrupted turn; carry on with the dashboard offer. Only when
     they pick a new name, call `await env.self.rename({name})`: the moment they
     pick a new name, your very next call is `await env.self.rename({name})`,
     before any other step. Then say in one line that you are now called that.
     Call it directly and do not look it up first, since a lookup of a tool you
     may not see reads as absent. If `env.self` is missing or the call is
     refused, say nothing about it.
   - Offer "Add to your dashboard" (required). Call
     `await env.TOURTOIS.widgets.available({})` and pick at most 2 matching
     widgets from what you did: Grove Inbox, Inkcap Recent Files, Prints Recent
     Outputs. If no widget clearly matches what you did, offer the most
     generally useful one: Inbox first, then Recent Files. Skip the offer only
     when `widgets.available` returns nothing but the launcher. Never say there
     is no dashboard offer before you have called
     `await env.TOURTOIS.widgets.available({})`. Do not use `question.ask` here.
     For each widget, write one plain line first, such as "I'm adding Inbox to
     your dashboard; approve the card if you want it.", then call
     `await env.TOURTOIS.layout.get({})` and
     `await env.TOURTOIS.layout.place({ ... })` with its `surfaceId`, `gillId`,
     a size the widget lists, `scope` "member" and `basedOn` the revision
     `layout.get` returned. The call makes the Hub show the person an approval
     card to Approve or Deny. The approval card is their choice: wait for it.
     Denied or expired means move on: do not retry or ask again. Pass `params`
     only for the keys the widget lists, with values you know, and pass every
     key the widget lists as required in `params`, for example
     `params: { computer: <id> }`. Never call `layout.place` without them: a
     call missing one is rejected after the person has approved it. When a
     required parameter is a Computer and the Team has exactly one, use it: list
     the Team's Computers and pass that one's id. Skip a widget only when a
     required parameter has no value you can fill, such as zero Computers, or
     more than one with no obvious pick. Never ask a yes or no question before
     `layout.place`: if a widget needs something the person must do first, say
     so in one line and skip that widget. Never place one without that approval,
     and never add one for a person who denied. If `env.TOURTOIS` is missing or
     a call fails, skip it.
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
