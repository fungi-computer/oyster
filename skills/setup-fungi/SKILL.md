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
Finish with one useful result and the completed name and widget offers.

Setup is one flow: approved work → useful result → name card → widget approval →
finish. After the work or a name answer, continue with the next tool call in the
same turn. A progress summary is commentary, never the end of setup. End only
after step 5 is complete, or while a card is parked awaiting its answer; when
that answer arrives, resume at the next unfinished item.

## Start and resume

On resume, continue at the first unfinished step. A name answer goes straight to
step 5's rename/Keep handling, before file discovery or goal calls. The
discovery and arming below happen once, at the start of setup.

Inside `execute`, describe only operation paths that `forage.search` or
`forage.list` returned; a guessed path such as `files` fails as an error row
before the first card. `computers.<Name>.files.list` is the Computer's path.

First list Home's working folder with its `list` tool (`{path: "."}`), or your
attached Computer's `files.list({path: "."})`. Read `AGENTS.md` only if that
listing contains it, using `path: "AGENTS.md"`. Use that same relative path for
edits; the working folder is not the filesystem root. An absent `AGENTS.md` is
not read: the listing already checked whether it exists. Continue to goal arming
and the interview; create it only in approved step 3.

Before approved work, arm the existing Session goal so an accidental end of turn
resumes this checklist without a nudge. Describe `goal`, read
`env.goal.get_goal({})`, and, only when no goal is current, call
`env.goal.create_goal({objective: "Finish setting up for you, including your first useful result, a name card and widget approvals."})`.
Keep an existing goal; never replace or complete someone else's objective for
setup. Record a setup goal you created in step 3's progress after approval.
Until then, reuse it from this conversation; arming is complete after the goal
call. If goal tools are absent, continue the checklist directly.

A parked question or approval is a real wait; the goal runtime waits with it.
After the useful result, use a declarative transition such as "Your image is
ready." and make the name-card tool call in step 5 in this same turn. Put the
entire name question and its options inside that card. A goal continuation
repairs an interrupted checklist; it never turns a plain-text name question into
a valid offer. On continuation, use step 5's resume check and call the missing
card directly or continue after its answer. Complete the setup goal only after
step 5's offers and cleanup have finished; keep it active while any required
offer is pending.

## Rules

- Plain words. Say Agent, Computer, App, skill, schedule, Team or Home only at
  the moment you use that thing, with a one-sentence explanation.
- One new concept per message. Name what you did, never list features.
- Ask at most 3 cards in total, counting the "Do it?" plan and the name offer. A
  card is one `question.ask`; keep each short and specific, and batch a few
  questions into one card. Use options, the recommended one first. Free text is
  always allowed, and an option that lets them type their own answer is fine. Do
  not ask for the person's own name; their account already has it.
- Every decision is a `question.ask` card, including "Do it?". Never end a turn
  asking the person to reply with options in text.
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
- Media budget: at most ONE sample attempt across images and videos for the
  entire setup, including resumed turns. Make it only when the catalog/quote
  shows it is cheap and the approved plan includes it; otherwise save a useful
  prompt or brief as the first result. A failed, denied or expired generation
  spends that attempt. Never retry, switch models, or try the other medium. Say
  the cause once in plain words, then continue to the name and widget steps.
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

   For files on Home, group several in one direct `apply_patch` tool call with
   Add File blocks and Home-relative paths. Send the patch as tool data, keeping
   HTML, JavaScript backticks and `${...}` out of JavaScript source strings.
   This is a direct tool call, outside `execute`; never shell heredocs inside
   `execute`. Files are only ever written with `apply_patch`: never `cat >`,
   `printf >`, `tee`, `echo >` or a heredoc (`<<'EOF'`) through `execute`,
   `bash` or `exec`, not even as a fallback. If `apply_patch` fails, read its
   error, fix the patch (it must start with `*** Begin Patch`, give every file
   line a leading `+`, and end with `*** End Patch` on its own last line) and
   call `apply_patch` again. If this tool is unavailable, say file writing is
   blocked and continue to the offers in step 5.

   - Instructions. List the working folder again with `files.list({path: "."})`.
     When `AGENTS.md` is listed, read and edit `path: "AGENTS.md"` in place;
     when absent, create it now with the starter headings "About my person",
     "Keeping this file up to date" and temporary "First conversation" progress.
     Record any owned setup goal objective in that progress. Fill its "About my
     person" section (rename it "About <their name>") with their goal, the
     preferences they stated and how they want updates. Follow its "Keeping this
     file up to date" section from then on. Every line answers "would I get this
     wrong without it?". Then introduce instructions in one sentence: "I saved
     this in my instructions, so I'll remember it in every conversation. You can
     read or edit them from my menu → Instructions."
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
     - Prints: apply the Media budget above before calling
       `PRINTS.generateImage` or `PRINTS.generateVideo`. Record the attempt in
       Home's setup progress before calling, so a resumed turn cannot repeat it.
       Mark a keeper with `PRINTS.setFavorite` on its saved path and read them
       back with `PRINTS.listFavorites`. The library folder is chosen by the
       person in Prints, and no method lets you choose it, so do not search for
       one: if Prints says no library is selected, say so in one line and tell
       them to pick it in Prints.

4. First result. Do one small real task toward their goal, now. When they can
   see its output, immediately enter step 5 in this turn. If media is
   unavailable, a saved prompt or brief is the result; the media budget still
   applies.
5. Finish. Do every item below, in order. Do not end your turn before the name
   offer and the dashboard offer have each been asked, failed, or skipped. Even
   if part of setup is blocked, such as an App that is not ready, say so in your
   two lines and still make both offers. An answered card is final: do not ask
   it again in text.
   - Say in two lines what you set up and where to change it, then continue
     immediately to the name card tool call.
   - Resume check. Read your current name from your instructions, the answers
     and rename results already in this conversation, and Home's setup progress.
     If a name was picked (including Keep), or a rename already succeeded, the
     name is settled: skip the name card and rename call and proceed directly to
     widgets. A current name different from the starting name saved in setup
     progress also proves the rename happened. If a name card is still pending,
     wait on that same card instead of issuing a replacement. Plain text and an
     offered marker alone do not prove a card is waiting: without an actual name
     card call in this conversation, make that call now. A nudge, failure or
     interrupted turn resumes this checklist; it never restarts setup.
   - Offer a name, once (required). Never settle it yourself by saying you keep
     your name: the card is how they keep it. Before the first name card, save
     its offered status and your starting name under "First conversation" in
     Home `AGENTS.md`. Ask with `question.ask`: "Keep <your name>" first, where
     your name is the one in your instructions ("Your name is …"), copied
     verbatim and never guessed, then two names you suggest that fit their goal;
     free text is always allowed. In `execute`, bind `currentName` to that
     verbatim current name and choose `firstSuggestion` and `secondSuggestion`,
     then run the actual card call below. Your chat transition is a statement;
     the name question belongs inside this call:

     ```js
     return await env.question.ask({
       questions: [
         {
           id: "agent_name",
           header: "Name",
           question: "Choose a name for me",
           options: [
             {
               label: `Keep ${currentName}`,
               description: "Keep my current name.",
             },
             { label: firstSuggestion, description: "Use this name." },
             { label: secondSuggestion, description: "Use this name." },
           ],
         },
       ],
     });
     ```

     Ask the name only as a `question.ask` card, never in plain text. Wait for
     their pick: call `question.ask` without `mode`, never `mode: "continue"`,
     and make no dashboard call until they have picked. Ask it at most once in
     the whole conversation, even if you run step 5 again. Once they have
     picked, whether a new name or Keep, the name is settled: never ask it
     again, not even after an empty or interrupted turn; carry on with the
     dashboard offer. Only when they pick a new name, call
     `await env.self.rename({name})`: the moment they pick a new name, your very
     next call is `await env.self.rename({name})`, before any other step. Then
     say in one line that you are now called that. Call it directly and do not
     look it up first, since a lookup of a tool you may not see reads as absent.
     If `env.self` is missing or the call is refused, say nothing about it.
     After applying their pick, save the settled name (including Keep) in setup
     progress, then immediately call `await env.TOURTOIS.widgets.available({})`
     in this turn.

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
     required parameter is a Computer and the Team has exactly one, use the id
     from your instructions:
     `params: { computer: <the id from your instructions> }`. Skip a widget
     whose required Computer you cannot fill because the Team has none, or more
     than one. Skip a widget only when a required parameter has no value you can
     fill. Never ask a yes or no question before `layout.place`: if a widget
     needs something the person must do first, say so in one line and skip that
     widget. Never place one without that approval, and never add one for a
     person who denied. If `env.TOURTOIS` is missing or a call fails, skip it.
   - Delete the "First conversation" section from Home `AGENTS.md`.
   - When the `setup.finish` tool is available, say one more line: "That's you
     set up. To keep going with me, start Pro, or link your wallet if you're a
     holder." Then call `setup.finish()` once in your final `execute`. If you
     created the setup goal, that same invocation must first await
     `env.goal.update_goal({status: "complete", reason: "Useful result delivered; name and widget offers settled; setup progress cleaned up."})`,
     then await `env.setup.finish({})`. Keep the two calls together so the
     hand-off cannot leave the setup goal unfinished. Leave any other current
     goal alone.
   - When the `setup.finish` tool is absent, finish after the offers and cleanup
     above are complete. If you created the setup goal, your final tool call is
     `await env.goal.update_goal({status: "complete", reason: "Useful result delivered; name and widget offers settled; setup progress cleaned up."})`.
     Leave any other current goal alone. That host has no money step; say
     nothing about Pro or wallets. Its absence never skips the name card or
     widget approval.

## Credit

- When the `setup.finish` description says less than $0.15 of credit remains,
  finish the step in hand, then do step 5 without starting a crawl.
- Reach step 5 only after the first useful result. A hand-off before that leaves
  the person with nothing.
