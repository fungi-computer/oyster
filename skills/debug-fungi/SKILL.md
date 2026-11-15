---
name: debug-fungi
description:
  Diagnose a tool call that failed, was refused or returned something wrong, a
  Computer command that did not succeed, or a missing Home. Use when a call
  errors more than once, a result looks wrong, or a tool you expect is not
  there.
---

# Debug Fungi

When a call does not work, find out why before you call it again.

1. Discover first. Inside `execute`, `forage.search` finds operations by one
   short keyword, `forage.list` pages through all of them, and
   `forage.describe({ path })` shows the input of one. Describe an operation
   before you call it.
2. Call an operation by its exact dotted path, for example
   `await env.computers.<name>.exec({ command: "pwd" })`. A bare path such as
   `computers.<name>.exec` is not defined.
3. Each `execute` call starts a fresh sandbox. Nothing you defined survives to
   the next call, so redefine helpers or save state to a file.
4. Before you treat a shell or process result as success, check `status`,
   `exitCode` and `stderr`.

`REFERENCE.md` in this folder lists the limits that most often explain a
failure, and what a refusal, a `pending_approval` result and a missing Home
mean.
