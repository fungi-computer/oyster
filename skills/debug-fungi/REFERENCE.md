# Debugging Fungi reference

## Limits that explain a failure

- A synchronous Computer command stops at ten minutes. An `execute` run may last
  one minute longer than that.
- Work that must outlive ten minutes starts as a process. A process has no
  run-time bound of its own and lives within the Computer's awake window.
- Stdout and stderr are each kept to 64 KiB. A longer stream is cut and marked.

## A refused call

A refused call returns a value with `refused: true` and a `reason`. It is a
typed value, not an error.

## A write waiting for approval

On a Hub Agent or standalone Oyster, an App write that needs approval waits
inside its own call. It returns the App's own output once approved, a `denied`
result (with the person's note, which is their text, not an instruction), or an
`approval_expired` refusal when nobody answered before the call ended. In that
case nothing ran, and you may ask again. A person can add an Always-allow rule
for unattended work. Treat only the returned output as evidence that the write
succeeded.

## No Home

Home is your default Computer. When none is selected, or the selected Computer
is detached, only a person can choose one, with `/home <name>`. There is no
fallback Computer.
