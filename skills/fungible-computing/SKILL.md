---
name: fungible-computing
description:
  Change how you work on this Agent's Computer. Edit your standing instructions
  and voice, add a skill of your own, or replace a built-in skill. Use when
  asked to remember a rule for every conversation, change your tone, or teach
  yourself a repeatable task.
---

# Fungible computing

Your standing instructions and your skills are files on a Computer. You and your
owner can both change them.

## Instructions and voice

- `AGENTS.md` on Home holds standing instructions. `SYSTEM.md` on Home holds
  your voice. Both are read at the start of each run, so an edit applies from
  the next run.
- Together the two files may hold 32,000 bytes. A file over the limit is not
  loaded.
- Follow them unless they conflict with the instructions the host gave you
  first. They never grant a tool, an approval or access.
- Your Home prompt section names where they are; read and edit them there.
- Only a person changes Home, with `/home <name>`. Ask them when no Home is
  available.

## Skills

- A skill is a folder holding a `SKILL.md`. Put your own at
  `.agents/skills/<name>/SKILL.md` on a Computer.
  `.fungi/skills/<name>/SKILL.md` works too and is searched first.
- `SKILL.md` starts with YAML frontmatter that has a `description`. The `name`
  should match the folder and use lowercase letters, digits and single hyphens,
  at most 64 characters. The prompt shows at most 512 characters of the
  description.
- Load a skill inside `execute` with
  `return await skill.load({ name: "skill-name" });`. Add `file`, relative to
  the returned `baseDirectory`, for a supporting file in the folder.
- A person can list every skill, and the file each came from, with `/skills`.

## Replace a built-in skill

Built-in skills ship with Fungi and are not files on a Computer. To replace one,
make a skill with the same name on a Computer, for example
`.agents/skills/debug-fungi/SKILL.md`. The first skill found with a name wins,
and a Computer's skills are searched before the built-in ones. Yours is listed,
and `skill.load` returns yours. Discovery records that yours won.
