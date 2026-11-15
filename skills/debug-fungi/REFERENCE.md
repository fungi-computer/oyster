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

## A result that says `pending_approval`

For an App's generation call, `pending_approval` does not confirm that anything
was generated. Wait for the result to be delivered in the ordinary way. Do not
retry the approval to fetch the output.

## No Home

Home is your default Computer. When none is selected, or the selected Computer
is detached, only a person can choose one, with `/home <name>`. There is no
fallback Computer.
